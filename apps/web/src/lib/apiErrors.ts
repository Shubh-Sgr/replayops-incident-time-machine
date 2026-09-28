/** An API failure that keeps the HTTP status and server request ID for correlation with API logs. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly requestId: string | null) {
    super(requestId ? `${message} (HTTP ${status} · request ${requestId})` : `${message} (HTTP ${status})`);
    this.name = "ApiError";
  }
}

/** Turns the API's error payload, including flattened Zod validation errors, into readable text. */
export function describeApiError(payload: unknown): string {
  const error = (payload as { error?: unknown } | null)?.error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const { formErrors = [], fieldErrors = {} } = error as { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> };
    const fields = Object.entries(fieldErrors).flatMap(([field, messages]) => (messages ?? []).map((message) => `${field}: ${message}`));
    const messages = [...formErrors, ...fields];
    if (messages.length) return `Invalid input — ${messages.join("; ")}`;
  }
  return "The request could not be completed.";
}
