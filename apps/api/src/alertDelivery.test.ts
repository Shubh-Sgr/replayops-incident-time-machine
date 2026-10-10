import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => [{ address: host === "rebind.example.com" ? "10.0.0.5" : "93.184.216.34", family: 4 }])
}));

const { alertService, describeDeliveryError, ntfyRequest, parseRecipients, signAlertBody } = await import("./alerts.js");
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

describe("delivery retries", () => {
  const networkError = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code }) });

  it("explains undici's opaque fetch failures", () => {
    expect(describeDeliveryError(networkError("ECONNRESET"))).toEqual({ message: "Connection reset by the destination. (ECONNRESET)", retryable: true });
    expect(describeDeliveryError(new TypeError("fetch failed"))).toEqual({ message: "Network error: the request did not complete.", retryable: true });
    expect(describeDeliveryError(networkError("ENOTFOUND")).retryable).toBe(false);
  });

  it("retries a network blip and records the delivery", async () => {
    alertService.retryDelaysMs = [0, 0];
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls += 1; if (calls < 3) throw networkError("ECONNRESET"); return new Response("{}", { status: 200 }); }));
    const channel = await alertService.create(admin, "operator@replayops.dev", { name: "Flaky phone", kind: "ntfy", url: "https://ntfy.sh/replayops-flaky-1", events: ["resolved"], minSeverity: "low" });
    await alertService.dispatch("demo-organization", { type: "resolved", incident });
    expect(calls).toBe(3);
    expect((await alertService.list(admin)).find((item) => item.id === channel.id)).toMatchObject({ lastStatus: "delivered", lastError: null });
    await alertService.remove(admin, "operator@replayops.dev", channel.id);
  });

  it("does not retry a destination that rejects the request", async () => {
    alertService.retryDelaysMs = [0, 0];
    const fetchSpy = vi.fn(async () => new Response("bad topic", { status: 400 }));
    vi.stubGlobal("fetch", fetchSpy);
    const channel = await alertService.create(admin, "operator@replayops.dev", { name: "Bad", kind: "ntfy", url: "https://ntfy.sh/replayops-bad-1", events: ["resolved"], minSeverity: "low" });
    await alertService.dispatch("demo-organization", { type: "resolved", incident });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await alertService.list(admin)).find((item) => item.id === channel.id)?.lastError).toBe("400 bad topic");
    await alertService.remove(admin, "operator@replayops.dev", channel.id);
  });

  it("keeps a failed alert in the outbox and delivers it on a later round", async () => {
    alertService.retryDelaysMs = [0, 0];
    let up = false;
    const calls: Array<Record<string, string>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init: RequestInit) => { calls.push(init.headers as Record<string, string>); return up ? new Response("{}", { status: 200 }) : new Response("unavailable", { status: 503 }); }));
    const channel = await alertService.create(admin, "operator@replayops.dev", { name: "Flaky hook", kind: "webhook", url: "https://flaky.example.com/hook", events: ["opened"], minSeverity: "low" });
    await alertService.dispatch("demo-organization", { type: "opened", incident });
    expect(calls).toHaveLength(3);
    const [waiting] = await alertService.pendingAlerts();
    expect(waiting).toMatchObject({ channelId: channel.id, attempts: 1, status: "pending" });
    expect((await alertService.list(admin)).find((item) => item.id === channel.id)?.lastError).toMatch(/503 .*Retrying at/);

    // Not due yet: nothing is sent.
    expect(await alertService.processOutbox()).toBe(0);
    up = true;
    expect(await alertService.processOutbox(20, new Date(Date.now() + 31_000))).toBe(1);
    expect(await alertService.pendingAlerts()).toEqual([]);
    expect((await alertService.list(admin)).find((item) => item.id === channel.id)).toMatchObject({ lastStatus: "delivered", lastError: null });
    // Every round carries the same delivery ID, so a receiver can drop duplicates.
    expect(new Set(calls.map((headers) => headers["x-replayops-delivery"])).size).toBe(1);
    await alertService.remove(admin, "operator@replayops.dev", channel.id);
  });

  it("gives up after the last round and says so on the destination", async () => {
    alertService.retryDelaysMs = [0, 0];
    const delays = alertService.outboxDelaysMs;
    alertService.outboxDelaysMs = [1_000];
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
      const channel = await alertService.create(admin, "operator@replayops.dev", { name: "Dead hook", kind: "webhook", url: "https://dead.example.com/hook", events: ["opened"], minSeverity: "low" });
      await alertService.dispatch("demo-organization", { type: "opened", incident });
      expect(await alertService.processOutbox(20, new Date(Date.now() + 2_000))).toBe(1);
      expect(await alertService.pendingAlerts()).toEqual([]);
      expect((await alertService.list(admin)).find((item) => item.id === channel.id)?.lastError).toMatch(/Gave up after 2 delivery rounds/);
      await alertService.remove(admin, "operator@replayops.dev", channel.id);
    } finally {
      alertService.outboxDelaysMs = delays;
    }
  });

  it("picks up an alert a crashed server left mid-send", async () => {
    alertService.retryDelaysMs = [0, 0];
    let release: () => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = () => resolve(new Response("{}", { status: 200 })); })));
    const channel = await alertService.create(admin, "operator@replayops.dev", { name: "Crash hook", kind: "webhook", url: "https://crash.example.com/hook", events: ["opened"], minSeverity: "low" });
    void alertService.dispatch("demo-organization", { type: "opened", incident });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The send never finishes (the server "died"). After the 2-minute lease, the next round takes it over.
    expect((await alertService.pendingAlerts())[0]).toMatchObject({ status: "sending" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    expect(await alertService.processOutbox(20, new Date(Date.now() + 121_000))).toBe(1);
    expect(await alertService.pendingAlerts()).toEqual([]);
    release();
    await alertService.remove(admin, "operator@replayops.dev", channel.id);
  });

  it("drains alerts already in flight before shutdown", async () => {
    alertService.retryDelaysMs = [0, 0];
    let finished = false;
    vi.stubGlobal("fetch", vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); finished = true; return new Response("{}", { status: 200 }); }));
    const channel = await alertService.create(admin, "operator@replayops.dev", { name: "Slow", kind: "ntfy", url: "https://ntfy.sh/replayops-slow-1", events: ["opened"], minSeverity: "low" });
    void alertService.dispatch("demo-organization", { type: "opened", incident });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await alertService.drain(1_000);
    expect(finished).toBe(true);
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
