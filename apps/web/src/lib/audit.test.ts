import { describe, expect, it } from "vitest";
import { presentAuditEntry } from "./audit";

describe("audit event presentation", () => {
  const base = { id: "audit-1", actor: "maya@example.com", targetType: "api-route", targetId: "uuid-value", createdAt: "2026-09-25T10:00:00.000Z" };

  it("converts historical API records into user events", () => {
    const value = presentAuditEntry({ ...base, action: "POST /integrations/source-1/test", detail: {} });
    expect(value.title).toBe("Verified evidence source with synthetic test");
    expect(value.title).not.toContain("POST");
    expect(value.description).not.toContain("uuid-value");
  });

  it("shows meaningful event context instead of object identifiers", () => {
    expect(presentAuditEntry({ ...base, action: "created invitation", targetType: "invitation", detail: { email: "responder@example.com", role: "responder" } })).toEqual({
      title: "Created invitation",
      description: "“responder@example.com” · Role: Responder"
    });
  });
});
