import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => [{ address: host === "rebind.example.com" ? "10.0.0.5" : "93.184.216.34", family: 4 }])
}));

const { alertService, ntfyRequest, parseRecipients, signAlertBody } = await import("./alerts.js");
const { sendAlertEmail } = await import("./mailer.js");
const admin = "00000000-0000-4000-8000-000000000001";
const incident = { id: "inc-7", code: "AUTO-7", title: "Payments failing", service: "payments-api", environment: "production", severity: "critical" as const, status: "investigating" };

afterEach(() => vi.unstubAllGlobals());

describe("alert delivery", () => {
  it("posts signed webhooks and Slack messages only to matching destinations", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => { calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) }); return new Response("ok", { status: 200 }); }));
    const hook = await alertService.create(admin, "operator@replayops.dev", { name: "Ops hook", kind: "webhook", url: "https://ops.example.com/replayops", events: ["opened"], minSeverity: "high" });
    const slack = await alertService.create(admin, "operator@replayops.dev", { name: "#incidents", kind: "slack", url: "https://hooks.slack.com/services/T/B/secret", events: ["resolved"], minSeverity: "low" });

    await alertService.dispatch("demo-organization", { type: "opened", incident });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ops.example.com/replayops");
    expect(calls[0]!.headers["x-replayops-signature"]).toBe(signAlertBody(hook.id, calls[0]!.body));
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ event: "incident.opened", incident: { code: "AUTO-7" } });

    await alertService.dispatch("demo-organization", { type: "resolved", incident: { ...incident, status: "resolved" }, actor: "operator@replayops.dev" });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]!.body).text).toContain("Incident resolved");

    const listed = await alertService.list(admin);
    expect(listed.find((item) => item.id === slack.id)?.lastStatus).toBe("delivered");
    expect(JSON.stringify(listed)).not.toContain("secret\"");
    await alertService.remove(admin, "operator@replayops.dev", hook.id);
    await alertService.remove(admin, "operator@replayops.dev", slack.id);
  });

  it("refuses to send when a public name resolves to a private address", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const channel = await alertService.create(admin, "operator@replayops.dev", { name: "Rebind", kind: "webhook", url: "https://rebind.example.com/hook", events: ["opened"], minSeverity: "low" });
    const result = await alertService.test(admin, "operator@replayops.dev", channel.id);
    expect(result.delivered).toBe(false);
    expect(result.lastError).toMatch(/private network/);
    expect(fetchSpy).not.toHaveBeenCalled();
    await alertService.remove(admin, "operator@replayops.dev", channel.id);
  });

  it("never throws from dispatch, even when a destination is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection reset"); }));
    const channel = await alertService.create(admin, "operator@replayops.dev", { name: "Down", kind: "webhook", url: "https://down.example.com/hook", events: ["opened"], minSeverity: "low" });
    await expect(alertService.dispatch("demo-organization", { type: "opened", incident })).resolves.toBeUndefined();
    expect((await alertService.list(admin)).find((item) => item.id === channel.id)).toMatchObject({ lastStatus: "failed", lastError: "connection reset" });
    await alertService.remove(admin, "operator@replayops.dev", channel.id);
  });

  it("sends phone push to ntfy with an urgent priority for critical incidents", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => { calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) }); return new Response("{}", { status: 200 }); }));
    const channel = await alertService.create(admin, "operator@replayops.dev", { name: "My phone", kind: "ntfy", url: "https://ntfy.sh/replayops-team-x7k2", events: ["opened"], minSeverity: "low" });
    expect(channel.target).toBe("ntfy.sh/…x7k2");
    await alertService.dispatch("demo-organization", { type: "opened", incident });
    expect(calls[0]).toMatchObject({ url: "https://ntfy.sh/replayops-team-x7k2", headers: { Priority: "urgent", Title: "Incident opened: AUTO-7 Payments failing" } });
    expect(calls[0]!.headers.Click).toMatch(/\/incidents\/inc-7$/);
    expect(calls[0]!.body).toContain("payments-api · production · severity critical");
    await alertService.remove(admin, "operator@replayops.dev", channel.id);
  });

  it("explains clearly when email is not configured on the server", async () => {
    const channel = await alertService.create(admin, "operator@replayops.dev", { name: "On-call email", kind: "email", url: "oncall@example.com, Lead@Example.com", events: ["opened"], minSeverity: "low" });
    expect(channel.target).toBe("oncall@example.com, lead@example.com");
    const result = await alertService.test(admin, "operator@replayops.dev", channel.id);
    expect(result.lastError).toMatch(/RESEND_API_KEY/);
    await alertService.remove(admin, "operator@replayops.dev", channel.id);
  });
});

describe("email and push formatting", () => {
  it("validates recipient lists", () => {
    expect(parseRecipients("a@x.io; b@y.io a@x.io")).toEqual(["a@x.io", "b@y.io"]);
    expect(() => parseRecipients("not-an-email")).toThrow(/not a valid email/);
    expect(() => parseRecipients("")).toThrow(/at least one/);
  });

  it("keeps ntfy titles header-safe", () => {
    const push = ntfyRequest({ type: "resolved", incident: { ...incident, title: "Paiements échoués 💥" } });
    expect(push.headers.Title).toBe("Incident resolved: AUTO-7 Paiements echoues");
    expect(push.headers.Priority).toBe("default");
  });

  it("sends alert email through Resend with an idempotency key", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const sent = await sendAlertEmail({ to: ["a@x.io"], subject: "s", text: "t", heading: "<b>h</b>", lines: ["l"], linkUrl: "https://app/x", linkLabel: "Open", idempotencyKey: "k1" }, { apiKey: "re_test", from: "alerts@x.io", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(sent.ok).toBe(true);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("k1");
    expect(JSON.parse(String(init.body)).html).toContain("&lt;b&gt;h&lt;/b&gt;");
  });
});
