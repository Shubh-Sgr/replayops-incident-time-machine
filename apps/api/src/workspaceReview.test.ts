import { describe, expect, it } from "vitest";
import { mitigationReviewPermission } from "./workspace.js";

describe("mitigation review policy", () => {
  it("requires an independent administrator for approval", () => {
    expect(mitigationReviewPermission({ requestedBy:"requester@example.com", actor:"reviewer@example.com", role:"admin", status:"approved", stale:false }).allowed).toBe(true);
    expect(mitigationReviewPermission({ requestedBy:"requester@example.com", actor:"requester@example.com", role:"admin", status:"approved", stale:false }).allowed).toBe(false);
    expect(mitigationReviewPermission({ requestedBy:"requester@example.com", actor:"responder@example.com", role:"responder", status:"approved", stale:false }).allowed).toBe(false);
  });

  it("blocks stale approval but lets the requester withdraw", () => {
    expect(mitigationReviewPermission({ requestedBy:"requester@example.com", actor:"reviewer@example.com", role:"admin", status:"approved", stale:true }).allowed).toBe(false);
    const withdrawal = mitigationReviewPermission({ requestedBy:"requester@example.com", actor:"requester@example.com", role:"responder", status:"rejected", stale:true });
    expect(withdrawal.allowed).toBe(true);
    expect(withdrawal.action).toBe("withdrew mitigation request");
  });
});
