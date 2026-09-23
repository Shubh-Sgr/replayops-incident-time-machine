import { describe, expect, it, vi } from "vitest";
import { sendInvitationEmail } from "./mailer.js";

const input = {
  invitationId: "invite-123",
  to: "responder@example.com",
  role: "responder" as const,
  organizationName: "Reliability & Safety",
  invitedBy: "admin@example.com",
  inviteUrl: "https://replayops.example/accept-invite?token=secret"
};

describe("invitation email delivery", () => {
  it("uses manual delivery when email is not configured", async () => {
    await expect(sendInvitationEmail(input, { apiKey: "", from: "" })).resolves.toEqual({ status: "manual" });
  });

  it("sends an idempotent email and escapes HTML content", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, request?: RequestInit) => {
      expect(request?.headers).toMatchObject({ "Idempotency-Key": "replayops-invitation/invite-123" });
      const body = JSON.parse(String(request?.body)) as { html: string; to: string[] };
      expect(body.to).toEqual(["responder@example.com"]);
      expect(body.html).toContain("Reliability &amp; Safety");
      return new Response(JSON.stringify({ id: "email-456" }), { status: 200 });
    }) as typeof fetch;

    await expect(sendInvitationEmail(input, { apiKey: "re_test", from: "ReplayOps <invite@example.com>", fetchImpl })).resolves.toEqual({ status: "sent", providerMessageId: "email-456" });
  });

  it("keeps the copy-link fallback when the provider rejects delivery", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    const result = await sendInvitationEmail(input, { apiKey: "re_test", from: "ReplayOps <invite@example.com>", fetchImpl });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("HTTP 403");
  });
});
