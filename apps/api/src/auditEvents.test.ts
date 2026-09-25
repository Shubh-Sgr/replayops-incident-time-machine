import { describe, expect, it } from "vitest";
import { semanticAuditForRequest } from "./auditEvents.js";

describe("semantic route audit events", () => {
  it("describes the user event without exposing an API route", () => {
    expect(semanticAuditForRequest("POST", "/integrations/source-1/test", {})).toEqual({
      action: "verified evidence source with synthetic test",
      targetType: "integration",
      targetId: "source-1",
      detail: { synthetic: true }
    });
    expect(semanticAuditForRequest("PATCH", "/incidents/inc-1842", { status: "monitoring", owner: "Maya Chen" })).toEqual({
      action: "updated investigation details",
      targetType: "incident",
      targetId: "inc-1842",
      detail: { title: undefined, status: "monitoring", owner: "Maya Chen" }
    });
  });

  it("does not duplicate routes that already emit richer audit events", () => {
    expect(semanticAuditForRequest("POST", "/incidents/inc-1842/hypothesis-tests", {})).toBeNull();
    expect(semanticAuditForRequest("PATCH", "/privacy-settings", {})).toBeNull();
    expect(semanticAuditForRequest("PATCH", "/notifications/notice-1", {})).toBeNull();
  });
});
