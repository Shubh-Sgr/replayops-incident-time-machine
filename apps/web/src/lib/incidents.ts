import type { IncidentDraft } from "../components/IncidentEditor";
import type { Incident } from "../types";
import { api } from "./api";

/** Creates an incident from the simple form; a pasted link becomes its first piece of evidence. */
export async function createIncidentFromDraft({ intakeLink, ...draft }: IncidentDraft) {
  const created = await api.createIncident({ ...draft, status: "investigating", resolvedAt: null });
  if (intakeLink) await api.createEvent(created.id, { timestamp: draft.startedAt, service: draft.service, kind: "alert", title: "Linked alert or dashboard", detail: `Opened from ${intakeLink}.`, impactScore: 65, provenance: "manual", evidenceState: "active", metadata: { sourceUrl: intakeLink, intake: true } });
  return created;
}

export const isOpen = (incident: Pick<Incident, "status">) => incident.status === "investigating" || incident.status === "identified";
/** An incident nobody has picked up yet: auto-opened, or created without an owner. */
export const isUnowned = (incident: Pick<Incident, "owner">) => !incident.owner || ["automation", "unassigned"].includes(incident.owner.toLowerCase());
/** A connector self-test (POST /integrations/:id/test) is not a real delivery. */
export const isSelfTest = (externalId: string) => externalId.startsWith("test-");
