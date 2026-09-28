import { describe, expect, it } from "vitest";
import { ApiError, describeApiError } from "./apiErrors";

describe("API error formatting", () => {
  it("renders flattened validation errors instead of [object Object]", () => {
    const payload = { error: { formErrors: [], fieldErrors: { title: ["String must contain at least 4 character(s)"], startedAt: ["Invalid datetime"] } } };
    expect(describeApiError(payload)).toBe("Invalid input — title: String must contain at least 4 character(s); startedAt: Invalid datetime");
  });

  it("keeps plain messages and falls back when the payload is empty", () => {
    expect(describeApiError({ error: "Incident not found." })).toBe("Incident not found.");
    expect(describeApiError(null)).toBe("The request could not be completed.");
  });

  it("includes status and request ID for log correlation", () => {
    const error = new ApiError("Incident not found.", 404, "req-123");
    expect(error.message).toBe("Incident not found. (HTTP 404 · request req-123)");
    expect(error.status).toBe(404);
  });
});
