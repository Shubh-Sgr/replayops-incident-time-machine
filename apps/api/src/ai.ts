import { config } from "./config.js";
import type { Incident, IncidentDiagnosis, IncidentEvent, SearchResult } from "./types.js";

const sensitivePatterns = [
  /\b(?:sk|pk|api)[-_][a-z0-9_-]{16,}\b/gi,
  /\bgh[pousr]_[a-z0-9]{20,}\b/gi,
  /\bBearer\s+[a-z0-9._~+\/-]+=*/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
];

export function redactSensitiveText(input: string) {
  let redactions = 0;
  const text = sensitivePatterns.reduce((value, pattern) => value.replace(pattern, () => {
    redactions += 1;
    return "[REDACTED]";
  }), input);
  return { text, redactions };
}

export async function embedText(text: string, externalAllowed = true): Promise<number[] | undefined> {
  if (!externalAllowed) return undefined;
  const key = config.googleAiKey ?? config.openAiKey;
  if (!key) return undefined;
  const safeText = redactSensitiveText(text).text;
  const baseUrl = config.googleAiKey ? "https://generativelanguage.googleapis.com/v1beta/openai" : config.openAiBaseUrl;
  const model = config.googleAiKey ? config.googleEmbeddingModel : config.embeddingModel;
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input: safeText.slice(0, 8000), dimensions: 1536 })
  });
  if (!response.ok) return undefined;
  const data = await response.json() as { data?: Array<{ embedding: number[] }> };
  return data.data?.[0]?.embedding;
}

type AssistantIntent = "challenge" | "next-test" | "changes" | "explain";

// Buttons send a leading instruction ("Challenge…", "Propose…falsification test"); classify on that, not the whole prompt.
export function assistantIntent(question: string): AssistantIntent {
  const lead = question.split(/[.?!\n]/)[0] ?? question;
  if (/challenge|contradict|adversarial|disconfirm/i.test(lead)) return "challenge";
  if (/next test|falsif|what should i (test|check)|suggest/i.test(lead)) return "next-test";
  if (/what changed|summari[sz]e|changes/i.test(lead)) return "changes";
  return "explain";
}

const clock = (timestamp: string) => `${timestamp.slice(11, 19)} UTC`;
const cite = (event: IncidentEvent | undefined) => event ? `[${clock(event.timestamp)} ${event.service}: ${event.title}]` : "";

// Deterministic, incident-scoped answer built from the same diagnosis the workbench shows.
export function scopedDeterministicAnswer(question: string, incident: Incident, diagnosis: IncidentDiagnosis) {
  const events = [...incident.events].filter((event) => event.evidenceState !== "excluded").sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const symptom = events.find((event) => event.id === diagnosis.symptomEventId);
  const precursor = events.find((event) => event.id === diagnosis.changeCandidates[0]?.eventId);
  const peak = events.reduce<IncidentEvent | undefined>((highest, event) => !highest || event.impactScore > highest.impactScore ? event : highest, undefined);
  const recovery = [...events].reverse().find((event) => event.kind === "recovery");
  const changes = events.filter((event) => event.kind === "deploy" || /config|feature flag|schema|migration|release/i.test(`${event.title} ${event.detail}`));
  const leading = diagnosis.hypotheses.find((hypothesis) => hypothesis.state !== "disproved");
  const gaps = diagnosis.evidenceGaps.slice(0, 2).join(" ");
  const intent = assistantIntent(question);
  let answer: string;
  let cited: IncidentEvent[];
  if (!events.length) {
    answer = "No active evidence is attached to this investigation. Add a timestamped symptom and at least one earlier observation before asking for an explanation.";
    cited = [];
  } else if (intent === "challenge") {
    const hasContext = events.some((event) => Object.keys(event.metadata ?? {}).some((key) => /^(trace|span|request)_?id$/i.test(key)));
    answer = precursor && symptom && precursor.id !== symptom.id
      ? `Strongest challenge: ${cite(precursor)} precedes ${cite(symptom)}, but ${hasContext ? "the retained trace context has not yet been inspected end to end" : "no trace or request ID shows the same requests crossed both"}. Downgrade the explanation if healthy ${symptom.service} requests show the same ${precursor.service} condition, or if failures began before it. Upgrade it only when correlated failing requests diverge at ${precursor.service}.`
      : `There is no earlier precursor to challenge: the first recorded observation is also the first high-impact symptom ${cite(symptom ?? events[0])}. Add a pre-symptom baseline or a healthy control cohort.`;
    cited = [precursor, symptom].filter((event): event is IncidentEvent => Boolean(event));
  } else if (intent === "next-test") {
    answer = `${diagnosis.nextAction.label}: ${diagnosis.nextAction.reason}${leading ? ` This tests “${leading.title}” (currently ${leading.state}).` : ""}${leading?.safeAction && !diagnosis.nextAction.reason.includes(leading.safeAction) ? ` Safe bounded action if confirmed: ${leading.safeAction}` : ""}${gaps ? ` Missing evidence that would sharpen the test: ${gaps}` : ""}`;
    cited = [precursor, symptom].filter((event): event is IncidentEvent => Boolean(event));
  } else if (intent === "changes") {
    const latest = events.slice(-3);
    answer = `${changes.length ? `Recorded changes: ${changes.map(cite).join(", ")}.` : "No deployment, configuration, flag, or schema change is recorded in this investigation."} Latest evidence: ${latest.map(cite).join(", ")}. ${recovery ? `Recovery was observed ${cite(recovery)}.` : "No recovery observation is recorded yet."} Evidence revision ${incident.evidenceRevision ?? incident.updatedAt}.`;
    cited = [...changes, ...latest];
  } else {
    answer = `Sequence: first observation ${cite(events[0])}${precursor && precursor.id !== events[0]?.id ? `, strongest precursor ${cite(precursor)}` : ""}${symptom ? `, first high-impact symptom ${cite(symptom)}` : ""}${peak && peak.id !== symptom?.id ? `, peak impact ${cite(peak)}` : ""}${recovery ? `, recovery ${cite(recovery)}` : ", no recovery recorded yet"}. Services in order: ${diagnosis.servicePath.join(" → ")}. ${diagnosis.currentExplanation}${gaps ? ` Unknowns: ${gaps}` : ""}`;
    cited = [events[0], precursor, symptom, peak, recovery].filter((event): event is IncidentEvent => Boolean(event));
  }
  const uniqueCited = [...new Map(cited.map((event) => [event.id, event])).values()];
  return { answer, eventIds: uniqueCited.map((event) => event.id), confidence: Math.max(0.2, Math.min(0.85, diagnosis.causalConfidence / 100)) };
}

export async function answerQuestion(question: string, evidence: SearchResult[], externalAllowed = true, scope?: { incident: Incident; diagnosis: IncidentDiagnosis }) {
  const scoped = scope ? scopedDeterministicAnswer(question, scope.incident, scope.diagnosis) : undefined;
  const citations = evidence.slice(0, 4).map(({ incident }) => {
    const eventIds = scoped && incident.id === scope?.incident.id ? scoped.eventIds : incident.events.slice(0, 5).map((event) => event.id);
    return {
      code: incident.code,
      title: redactSensitiveText(incident.title).text,
      incidentId: incident.id,
      eventIds,
      events: eventIds.map((id) => incident.events.find((event) => event.id === id)).filter((event): event is IncidentEvent => Boolean(event)).map((event) => ({ id: event.id, title: redactSensitiveText(event.title).text, service: event.service, timestamp: event.timestamp })),
      excerpt: redactSensitiveText(incident.events[0]?.title ?? incident.summary.slice(0, 140)).text
    };
  });
  const scopedEvidence = scope
    ? `${scope.incident.code} ${scope.incident.title}\n${scope.incident.summary}\nService path: ${scope.diagnosis.servicePath.join(" -> ")}\nCurrent explanation: ${scope.diagnosis.currentExplanation}\nKnown gaps: ${scope.diagnosis.evidenceGaps.join(" ")}\n${[...scope.incident.events].filter((event) => event.evidenceState !== "excluded").sort((left, right) => left.timestamp.localeCompare(right.timestamp)).slice(0, 40).map((event) => `[event:${event.id}] ${event.timestamp} ${event.service} ${event.kind}: ${event.title} — ${event.detail}`).join("\n")}`
    : "";
  const rawEvidence = [scopedEvidence, ...evidence.slice(0, 4).filter(({ incident }) => incident.id !== scope?.incident.id).map(({ incident }) => `${incident.code} ${incident.title}\n${incident.summary}\n${incident.events.slice(0, 5).map((event) => `[event:${event.id}] ${event.timestamp}: ${event.title} — ${event.detail}`).join("\n")}`)].filter(Boolean).join("\n\n");
  const safeQuestion = redactSensitiveText(question);
  const safeEvidence = redactSensitiveText(rawEvidence);
  const redactions = safeQuestion.redactions + safeEvidence.redactions;
  const evidenceText = safeEvidence.text;
  const evidenceBoundary = evidence.length
    ? `${citations.length} incident record${citations.length === 1 ? "" : "s"} and ${citations.reduce((count, citation) => count + citation.eventIds.length, 0)} cited events`
    : "No matching incident evidence";
  const deterministicAnswer = (providerError?: string) => {
    if (scoped) {
      const safeAnswer = redactSensitiveText(scoped.answer);
      return {
        answer: safeAnswer.text, citations, confidence: scoped.confidence, mode: "deterministic" as const,
        redactions: redactions + safeAnswer.redactions, evidenceBoundary, ...(providerError ? { providerError } : {})
      };
    }
    const lead = evidence[0]?.incident;
    if (lead && /adversarial|challenge|disconfirm|falsif/i.test(question)) {
      const events = [...lead.events].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
      const symptom = events.find((event) => event.kind === "alert" && event.impactScore >= 65) ?? events.find((event) => event.impactScore >= 65) ?? events[0];
      const precursor = [...events].reverse().find((event) => symptom && event.timestamp < symptom.timestamp && !["alert", "action", "recovery"].includes(event.kind)) ?? events[0];
      const hasContext = events.some((event) => Object.keys(event.metadata ?? {}).some((key) => /^(trace|span|request)_?id$/i.test(key)));
      const safeAnswer = redactSensitiveText(symptom && precursor
        ? `Strongest challenge: ${precursor.title} occurs before ${symptom.title}, but ${hasContext ? "the available correlation context has not yet been inspected end to end" : "no trace or request ID proves the same requests crossed both events"}. Falsify it by comparing slow and healthy ${symptom.service} requests in the same window and finding their first divergent dependency span. I would downgrade this hypothesis if healthy requests show the same ${precursor.service} condition, or if affected requests begin failing before that condition; I would upgrade it only when correlated failing requests diverge there.`
        : "There is not enough ordered evidence to challenge this claim safely. Add a timestamped precursor, a customer-visible symptom, and a healthy control sample.");
      return {
        answer: safeAnswer.text, citations, confidence: symptom && precursor ? 0.71 : 0.22, mode: "deterministic" as const,
        redactions: redactions + safeAnswer.redactions, evidenceBoundary, ...(providerError ? { providerError } : {})
      };
    }
    const safeAnswer = redactSensitiveText(lead ? `The strongest available match is ${lead.code}. Its evidence suggests pressure began in ${lead.events[0]?.service ?? lead.service} before propagating to ${lead.service}. Review the highlighted events before accepting this as root cause; the assistant is using deterministic analysis because an external model is unavailable.` : "No matching incident evidence was found. Add more timeline detail before drawing a causal conclusion.");
    return {
      answer: safeAnswer.text, citations, confidence: lead ? 0.63 : 0.18, mode: "deterministic" as const,
      redactions: redactions + safeAnswer.redactions, evidenceBoundary, ...(providerError ? { providerError } : {})
    };
  };
  const providerKey = externalAllowed ? config.googleAiKey ?? config.openAiKey : undefined;
  if (!providerKey) return deterministicAnswer();
  const providerBaseUrl = config.googleAiKey ? "https://generativelanguage.googleapis.com/v1beta/openai" : config.openAiBaseUrl;
  const providerModels = config.googleAiKey
    ? [...new Set([config.googleChatModel, "gemini-3.6-flash", "gemini-3-flash-preview"])]
    : [config.chatModel];
  const failures: string[] = [];
  for (const providerModel of providerModels) {
    try {
      const response = await fetch(`${providerBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerKey}` },
        body: JSON.stringify({
          model: providerModel, temperature: 0.2,
          messages: [
            { role: "system", content: "You are ReplayOps. Use only supplied evidence, separate observation from hypothesis, cite incident codes, state uncertainty, and stay under 180 words." },
            { role: "user", content: `Question: ${safeQuestion.text}\n\nEvidence:\n${evidenceText || "No matching evidence."}` }
          ]
        })
      });
      if (!response.ok) {
        const safeProviderError = redactSensitiveText((await response.text()).slice(0, 600)).text;
        failures.push(`${providerModel}: HTTP ${response.status}`);
        console.warn(`AI provider request failed for ${providerModel} with HTTP ${response.status}: ${safeProviderError}`);
        if ([401, 403].includes(response.status)) break;
        continue;
      }
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const safeAnswer = redactSensitiveText(data.choices?.[0]?.message?.content ?? "The assistant returned no text.");
      return {
        answer: safeAnswer.text, citations, confidence: Math.min(0.88, 0.45 + evidence.length * 0.09), mode: "provider" as const,
        providerModel, redactions: redactions + safeAnswer.redactions, evidenceBoundary
      };
    } catch (error) {
      failures.push(`${providerModel}: network failure`);
      console.warn(`AI provider request failed for ${providerModel}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  return deterministicAnswer(`Gemini was unavailable (${failures.join("; ")}). Deterministic evidence analysis was used instead.`);
}
