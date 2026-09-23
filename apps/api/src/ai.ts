import { config } from "./config.js";
import type { SearchResult } from "./types.js";

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

export async function embedText(text: string): Promise<number[] | undefined> {
  const key = config.googleAiKey ?? config.openAiKey;
  if (!key) return undefined;
  const baseUrl = config.googleAiKey ? "https://generativelanguage.googleapis.com/v1beta/openai" : config.openAiBaseUrl;
  const model = config.googleAiKey ? config.googleEmbeddingModel : config.embeddingModel;
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input: text.slice(0, 8000), dimensions: 1536 })
  });
  if (!response.ok) return undefined;
  const data = await response.json() as { data?: Array<{ embedding: number[] }> };
  return data.data?.[0]?.embedding;
}

export async function answerQuestion(question: string, evidence: SearchResult[]) {
  const citations = evidence.slice(0, 4).map(({ incident }) => ({
    code: incident.code,
    title: redactSensitiveText(incident.title).text,
    incidentId: incident.id,
    eventIds: incident.events.slice(0, 5).map((event) => event.id),
    excerpt: redactSensitiveText(incident.events[0]?.title ?? incident.summary.slice(0, 140)).text
  }));
  const rawEvidence = evidence.slice(0, 4).map(({ incident }) => `${incident.code} ${incident.title}\n${incident.summary}\n${incident.events.slice(0, 5).map((event) => `[event:${event.id}] ${event.timestamp}: ${event.title} — ${event.detail}`).join("\n")}`).join("\n\n");
  const safeQuestion = redactSensitiveText(question);
  const safeEvidence = redactSensitiveText(rawEvidence);
  const redactions = safeQuestion.redactions + safeEvidence.redactions;
  const evidenceText = safeEvidence.text;
  const evidenceBoundary = evidence.length
    ? `${citations.length} incident record${citations.length === 1 ? "" : "s"} and ${citations.reduce((count, citation) => count + citation.eventIds.length, 0)} cited events`
    : "No matching incident evidence";
  const providerKey = config.googleAiKey ?? config.openAiKey;
  if (!providerKey) {
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
        answer: safeAnswer.text,
        citations, confidence: symptom && precursor ? 0.71 : 0.22, mode: "deterministic" as const, redactions: redactions + safeAnswer.redactions, evidenceBoundary
      };
    }
    const safeAnswer = redactSensitiveText(lead ? `The strongest available match is ${lead.code}. Its evidence suggests pressure began in ${lead.events[0]?.service ?? lead.service} before propagating to ${lead.service}. Review the highlighted events before accepting this as root cause; the demo assistant is operating without an external model.` : "No matching incident evidence was found. Add more timeline detail before drawing a causal conclusion.");
    return {
      answer: safeAnswer.text,
      citations, confidence: lead ? 0.63 : 0.18, mode: "deterministic" as const, redactions: redactions + safeAnswer.redactions, evidenceBoundary
    };
  }
  const providerBaseUrl = config.googleAiKey ? "https://generativelanguage.googleapis.com/v1beta/openai" : config.openAiBaseUrl;
  const providerModel = config.googleAiKey ? config.googleChatModel : config.chatModel;
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
  if (!response.ok) throw new Error("The configured AI provider did not return a successful response.");
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const safeAnswer = redactSensitiveText(data.choices?.[0]?.message?.content ?? "The assistant returned no text.");
  return { answer: safeAnswer.text, citations, confidence: Math.min(0.88, 0.45 + evidence.length * 0.09), mode: "provider" as const, redactions: redactions + safeAnswer.redactions, evidenceBoundary };
}
