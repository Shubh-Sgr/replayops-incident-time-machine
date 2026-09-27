export interface SemanticAuditEvent {
  action: string;
  targetType: string;
  targetId?: string;
  detail: Record<string, unknown>;
}

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

export function semanticAuditForRequest(method: string, path: string, bodyValue: unknown): SemanticAuditEvent | null {
  const body = bodyValue && typeof bodyValue === "object" ? bodyValue as Record<string, unknown> : {};
  const match = (pattern: RegExp) => path.match(pattern);
  let found: RegExpMatchArray | null;

  if (method === "POST" && path === "/incidents") return { action: "created investigation", targetType: "incident", detail: { title: text(body.title), service: text(body.service), environment: text(body.environment) } };
  if (method === "PATCH" && (found = match(/^\/incidents\/([^/]+)$/))) return { action: "updated investigation details", targetType: "incident", targetId: found[1], detail: { title: text(body.title), status: text(body.status), owner: text(body.owner) } };
  if (method === "DELETE" && (found = match(/^\/incidents\/([^/]+)$/))) return { action: "deleted investigation", targetType: "incident", targetId: found[1], detail: {} };
  if (method === "POST" && (found = match(/^\/incidents\/([^/]+)\/decisions$/))) return { action: "recorded investigation decision", targetType: "incident", targetId: found[1], detail: { title: text(body.title), kind: text(body.kind), status: text(body.status) } };
  if (method === "POST" && (found = match(/^\/incidents\/([^/]+)\/replays$/))) return { action: "calculated mitigation scenario", targetType: "incident", targetId: found[1], detail: {} };
  if (method === "POST" && (found = match(/^\/incidents\/([^/]+)\/events$/))) return { action: "added evidence observation", targetType: "incident", targetId: found[1], detail: { title: text(body.title), service: text(body.service), kind: text(body.kind) } };
  if (method === "PATCH" && (found = match(/^\/incidents\/([^/]+)\/events\/([^/]+)$/))) return { action: "corrected evidence observation", targetType: "incident-event", targetId: found[2], detail: { incidentId: found[1], title: text(body.title), correctionReason: text(body.correctionReason) } };
  if (method === "DELETE" && (found = match(/^\/incidents\/([^/]+)\/events\/([^/]+)$/))) return { action: "removed evidence observation", targetType: "incident-event", targetId: found[2], detail: { incidentId: found[1] } };
  if (method === "POST" && (found = match(/^\/incidents\/([^/]+)\/evidence-review$/))) return { action:"reviewed current evidence revision", targetType:"incident", targetId:found[1], detail:{} };
  if (method === "POST" && (found = match(/^\/incidents\/([^/]+)\/checks$/))) return { action:"created investigation check", targetType:"incident", targetId:found[1], detail:{title:text(body.title)} };
  if (method === "PATCH" && (found = match(/^\/incidents\/([^/]+)\/checks\/([^/]+)$/))) return { action:"recorded investigation check outcome", targetType:"investigation-check", targetId:found[2], detail:{incidentId:found[1],status:text(body.status)} };
  if (method === "POST" && (found = match(/^\/incidents\/([^/]+)\/proposals$/))) return { action:"created exact change proposal version", targetType:"incident", targetId:found[1], detail:{title:text(body.title)} };
  if (method === "POST" && (found = match(/^\/incidents\/([^/]+)\/validations$/))) return { action:"attached validation evidence", targetType:"incident", targetId:found[1], detail:{kind:text(body.kind),status:text(body.status)} };
  if (method === "POST" && (found = match(/^\/incidents\/([^/]+)\/proposals\/([^/]+)\/review-request$/))) return { action:"requested independent proposal review", targetType:"change-proposal", targetId:found[2], detail:{incidentId:found[1]} };
  if (method === "PATCH" && (found = match(/^\/incidents\/([^/]+)\/proposal-reviews\/([^/]+)$/))) return { action:`${text(body.status)??"recorded"} exact proposal review`, targetType:"proposal-review", targetId:found[2], detail:{incidentId:found[1]} };
  if (method === "POST" && (found = match(/^\/incidents\/([^/]+)\/recovery-criteria$/))) return { action:"versioned recovery criterion", targetType:"incident", targetId:found[1], detail:{kind:text(body.kind),name:text(body.name)} };
  if (method === "POST" && (found = match(/^\/incidents\/([^/]+)\/measurements$/))) return { action:"recorded typed recovery measurement", targetType:"incident", targetId:found[1], detail:{source:text(body.source),state:text(body.state)} };
  if (method === "POST" && /^\/incidents\/[^/]+\/lifecycle$/.test(path)) return null;

  if (method === "POST" && path === "/integrations") return { action: "created evidence source", targetType: "integration", detail: { name: text(body.name), provider: text(body.provider) } };
  if (method === "PATCH" && (found = match(/^\/integrations\/([^/]+)\/config$/))) return { action: "updated evidence source policy", targetType: "integration", targetId: found[1], detail: {} };
  if (method === "DELETE" && (found = match(/^\/integrations\/([^/]+)$/))) return { action: "removed evidence source", targetType: "integration", targetId: found[1], detail: {} };
  if (method === "POST" && (found = match(/^\/integrations\/([^/]+)\/test$/))) return { action: "verified evidence source with synthetic test", targetType: "integration", targetId: found[1], detail: { synthetic: true } };
  if (method === "POST" && (found = match(/^\/ingestion-queue\/([^/]+)\/retry$/))) return { action: "requeued failed evidence delivery", targetType: "ingestion-delivery", targetId: found[1], detail: {} };

  // These routes already write richer domain-specific audit records, or are personal UI state.
  if (/^\/notifications\//.test(path) || path === "/privacy-settings" || path === "/product-outcomes" || path === "/services" || path === "/incident-policy" || /^\/team\//.test(path) || /\/mitigations$/.test(path) || /^\/mitigations\//.test(path) || /\/hypothesis-tests$/.test(path) || /^\/hypothesis-tests\//.test(path) || /\/recovery$/.test(path) || /\/postmortem$/.test(path) || /\/comments$/.test(path) || /\/evidence-bundle$/.test(path) || /\/http-replays$/.test(path) || /^\/http-replays\//.test(path) || /\/events\/[^/]+\/move$/.test(path)) return null;

  return { action: "changed workspace data", targetType: "workspace", detail: {} };
}
