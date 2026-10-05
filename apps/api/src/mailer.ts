import { config } from "./config.js";
import type { WorkspaceRole } from "./types.js";

export interface InvitationEmailInput {
  invitationId: string;
  to: string;
  role: WorkspaceRole;
  organizationName: string;
  invitedBy: string;
  inviteUrl: string;
}

export interface InvitationDelivery {
  status: "sent" | "manual" | "failed";
  providerMessageId?: string;
  error?: string;
}

interface MailerOptions {
  apiKey?: string;
  from?: string;
  fetchImpl?: typeof fetch;
}

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;"
})[character] ?? character);

export async function sendInvitationEmail(input: InvitationEmailInput, options: MailerOptions = {}): Promise<InvitationDelivery> {
  const apiKey = options.apiKey ?? config.resendApiKey;
  const from = options.from ?? config.inviteFromEmail;
  if (!apiKey || !from) return { status: "manual" };

  const organizationName = escapeHtml(input.organizationName);
  const invitedBy = escapeHtml(input.invitedBy);
  const role = escapeHtml(input.role);
  const inviteUrl = escapeHtml(input.inviteUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `replayops-invitation/${input.invitationId}`
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: `Join ${input.organizationName} on ReplayOps`,
        text: `${input.invitedBy} invited you to join ${input.organizationName} as ${input.role}. Accept this invitation within seven days: ${input.inviteUrl}`,
        html: `<!doctype html><html><body style="margin:0;background:#eef2f5;color:#25313d;font-family:Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:32px 20px"><div style="background:#f9fbfc;border:1px solid #c9d4dc;border-radius:14px;padding:28px"><p style="margin:0 0 20px;color:#647584;font-size:13px">REPLAYOPS · TEAM ACCESS</p><h1 style="margin:0;font-size:26px;line-height:1.2">Join ${organizationName}</h1><p style="margin:16px 0 0;line-height:1.6">${invitedBy} invited you to join the incident-response workspace as <strong>${role}</strong>.</p><a href="${inviteUrl}" style="display:inline-block;margin-top:24px;padding:12px 18px;border-radius:10px;background:#e66b32;color:#251c18;text-decoration:none;font-weight:700">Accept invitation</a><p style="margin:24px 0 0;color:#647584;font-size:13px;line-height:1.6">This email-bound link expires in seven days. If the button does not work, copy this URL:<br><span style="overflow-wrap:anywhere">${inviteUrl}</span></p></div></div></body></html>`,
        tags: [{ name: "category", value: "team_invitation" }]
      }),
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      return { status: "failed", error: `Email provider rejected the request (HTTP ${response.status}). Copy and share the invitation link instead.` };
    }

    const payload = await response.json() as { id?: string };
    return { status: "sent", providerMessageId: payload.id };
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be reached";
    return { status: "failed", error: `Email provider ${reason}. Copy and share the invitation link instead.` };
  }
}

export interface AlertEmailInput { to: string[]; subject: string; text: string; heading: string; lines: string[]; linkUrl: string; linkLabel: string; idempotencyKey: string }

export const alertEmailConfigured = () => Boolean(config.resendApiKey && config.inviteFromEmail);

/** Incident alert email through the same free Resend account used for invitations. */
export async function sendAlertEmail(input: AlertEmailInput, options: MailerOptions = {}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = options.apiKey ?? config.resendApiKey;
  const from = options.from ?? config.inviteFromEmail;
  if (!apiKey || !from) return { ok: false, error: "Email isn't configured on the API. Set RESEND_API_KEY and INVITE_FROM_EMAIL." };
  const html = `<!doctype html><html><body style="margin:0;background:#eef2f5;color:#25313d;font-family:Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:28px 20px"><div style="background:#f9fbfc;border:1px solid #c9d4dc;border-radius:14px;padding:24px"><p style="margin:0 0 14px;color:#647584;font-size:13px">REPLAYOPS · INCIDENT ALERT</p><h1 style="margin:0;font-size:22px;line-height:1.3">${escapeHtml(input.heading)}</h1>${input.lines.map((line) => `<p style="margin:12px 0 0;line-height:1.55">${escapeHtml(line)}</p>`).join("")}<a href="${escapeHtml(input.linkUrl)}" style="display:inline-block;margin-top:20px;padding:11px 16px;border-radius:10px;background:#e66b32;color:#251c18;text-decoration:none;font-weight:700">${escapeHtml(input.linkLabel)}</a></div></div></body></html>`;
  try {
    const response = await (options.fetchImpl ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({ from, to: input.to, subject: input.subject, text: input.text, html, tags: [{ name: "category", value: "incident_alert" }] }),
      signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) return { ok: true };
    const detail = await response.text().catch(() => "");
    return { ok: false, error: `Email provider rejected the alert (HTTP ${response.status})${detail ? `: ${detail.slice(0, 160)}` : ""}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === "TimeoutError" ? "Email provider timed out." : "Email provider could not be reached." };
  }
}
