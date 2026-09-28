/**
 * An error that carries the HTTP status it should produce. Services throw these for
 * expected failures (missing records, conflicts, permissions) so the API responds with
 * an accurate 4xx instead of masking them as a 500 server fault.
 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
export const forbidden = (message: string) => new HttpError(403, message);
export const badRequest = (message: string) => new HttpError(400, message);

/** Resolves the HTTP status for any thrown value, including body-parser errors that set `status`. */
export function statusForError(error: unknown) {
  const status = typeof error === "object" && error !== null ? Number((error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode) : NaN;
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
}
