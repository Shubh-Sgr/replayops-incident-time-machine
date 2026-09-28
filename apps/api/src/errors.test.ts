import { describe, expect, it } from "vitest";
import { HttpError, notFound, statusForError } from "./errors.js";

describe("statusForError", () => {
  it("keeps typed and body-parser statuses, defaulting unknown failures to 500", () => {
    expect(statusForError(notFound("Missing"))).toBe(404);
    expect(statusForError(new HttpError(409, "Conflict"))).toBe(409);
    expect(statusForError(Object.assign(new SyntaxError("Unexpected token"), { status: 400, type: "entity.parse.failed" }))).toBe(400);
    expect(statusForError(new Error("boom"))).toBe(500);
    expect(statusForError({ status: 200 })).toBe(500);
  });
});
