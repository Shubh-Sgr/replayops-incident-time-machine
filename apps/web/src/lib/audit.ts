import type { AuditEntry } from "../types";

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const sentence = (value: string) => `${value.charAt(0).toUpperCase()}${value.slice(1).replaceAll("_", " ")}`;

function legacyRouteAction(action: string) {
  const match = action.match(/^(POST|PATCH|PUT|DELETE) (\/.+)$/);
  if (!match) return null;
  const method = match[1]!;
  const path = match[2]!;
  if (method === "POST" && path === "/incidents") return "Created investigation";
  if (method === "PATCH" && /^\/incidents\/[^/]+$/.test(path)) return "Updated investigation details";
  if (method === "DELETE" && /^\/incidents\/[^/]+$/.test(path)) return "Deleted investigation";
  if (/\/events\/[^/]+\/move$/.test(path)) return "Moved evidence to another investigation";
  if (method === "POST" && /\/events$/.test(path)) return "Added evidence observation";
  if (method === "PATCH" && /\/events\/[^/]+$/.test(path)) return "Corrected evidence observation";
  if (method === "POST" && /\/replays$/.test(path)) return "Calculated mitigation scenario";
  if (method === "POST" && path === "/integrations") return "Created evidence source";
  if (/\/integrations\/[^/]+\/test$/.test(path)) return "Verified evidence source with synthetic test";
  if (/\/integrations\/[^/]+\/config$/.test(path)) return "Updated evidence source policy";
  if (method === "DELETE" && /^\/integrations\/[^/]+$/.test(path)) return "Removed evidence source";
  if (/\/ingestion-queue\/[^/]+\/retry$/.test(path)) return "Requeued failed evidence delivery";
  return "Changed workspace data";
}

export function presentAuditEntry(entry: AuditEntry) {
  const detail = entry.detail ?? {};
  const legacyTitle = legacyRouteAction(entry.action);
  const title = legacyTitle ?? sentence(entry.action.replace(/^\[product-outcome\]\s*/, ""));
  const namedTarget = text(detail.title) ?? text(detail.name) ?? text(detail.email);
  const status = text(detail.status);
  const role = text(detail.role);
  const provider = text(detail.provider);
  const service = text(detail.service);
  const assignee = text(detail.assignee);

  let description = namedTarget ? `“${namedTarget}”` : "";
  if (provider) description = `${description ? `${description} · ` : ""}${sentence(provider)} source`;
  if (service) description = `${description ? `${description} · ` : ""}${service}`;
  if (status) description = `${description ? `${description} · ` : ""}Result: ${sentence(status)}`;
  if (role) description = `${description ? `${description} · ` : ""}Role: ${sentence(role)}`;
  if (assignee) description = `${description ? `${description} · ` : ""}Assigned to ${assignee}`;
  if (!description && detail.synthetic === true) description = "A labeled synthetic delivery checked the complete ingestion path.";
  if (!description) description = title.includes("policy") || title.includes("Privacy") ? "Workspace operating controls were changed." : "The completed action was recorded for accountability.";

  return { title, description };
}
