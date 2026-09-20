import { config } from "./config.js";
import type { SearchResult } from "./types.js";

export async function embedText(text: string): Promise<number[] | undefined> {
  if (!config.openAiKey) return undefined;
  const response = await fetch(`${config.openAiBaseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.openAiKey}` },
    body: JSON.stringify({ model: config.embeddingModel, input: text.slice(0, 8000) })
  });
  if (!response.ok) return undefined;
  const data = await response.json() as { data?: Array<{ embedding: number[] }> };
  return data.data?.[0]?.embedding;
}

export async function answerQuestion(question: string, evidence: SearchResult[]) {
  const citations = evidence.slice(0, 4).map(({ incident }) => ({ code: incident.code, title: incident.title, incidentId: incident.id }));
  const evidenceText = evidence.slice(0, 4).map(({ incident }) => `${incident.code} ${incident.title}\n${incident.summary}\n${incident.events.slice(0, 5).map((event) => `${event.timestamp}: ${event.title} — ${event.detail}`).join("\n")}`).join("\n\n");
  if (!config.openAiKey) {
    const lead = evidence[0]?.incident;
    if (lead && /adversarial|challenge|disconfirm|falsif/i.test(question)) {
      const events = [...lead.events].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
      const symptom = events.find((event) => event.kind === "alert" && event.impactScore >= 65) ?? events.find((event) => event.impactScore >= 65) ?? events[0];
      const precursor = [...events].reverse().find((event) => symptom && event.timestamp < symptom.timestamp && !["alert", "action", "recovery"].includes(event.kind)) ?? events[0];
      const hasContext = events.some((event) => Object.keys(event.metadata ?? {}).some((key) => /^(trace|span|request)_?id$/i.test(key)));
      return {
        answer: symptom && precursor
          ? `Strongest challenge: ${precursor.title} occurs before ${symptom.title}, but ${hasContext ? "the available correlation context has not yet been inspected end to end" : "no trace or request ID proves the same requests crossed both events"}. Falsify it by comparing slow and healthy ${symptom.service} requests in the same window and finding their first divergent dependency span. I would downgrade this hypothesis if healthy requests show the same ${precursor.service} condition, or if affected requests begin failing before that condition; I would upgrade it only when correlated failing requests diverge there.`
          : "There is not enough ordered evidence to challenge this claim safely. Add a timestamped precursor, a customer-visible symptom, and a healthy control sample.",
        citations, confidence: symptom && precursor ? 0.71 : 0.22, mode: "deterministic" as const
      };
    }
    return {
      answer: lead ? `The strongest available match is ${lead.code}. Its evidence suggests pressure began in ${lead.events[0]?.service ?? lead.service} before propagating to ${lead.service}. Review the highlighted events before accepting this as root cause; the demo assistant is operating without an external model.` : "No matching incident evidence was found. Add more timeline detail before drawing a causal conclusion.",
      citations, confidence: lead ? 0.63 : 0.18, mode: "deterministic" as const
    };
  }
  const response = await fetch(`${config.openAiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.openAiKey}` },
    body: JSON.stringify({
      model: config.chatModel, temperature: 0.2,
      messages: [
        { role: "system", content: "You are ReplayOps. Use only supplied evidence, separate observation from hypothesis, cite incident codes, state uncertainty, and stay under 180 words." },
        { role: "user", content: `Question: ${question}\n\nEvidence:\n${evidenceText || "No matching evidence."}` }
      ]
    })
  });
  if (!response.ok) throw new Error("The configured AI provider did not return a successful response.");
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return { answer: data.choices?.[0]?.message?.content ?? "The assistant returned no text.", citations, confidence: Math.min(0.88, 0.45 + evidence.length * 0.09), mode: "provider" as const };
}
