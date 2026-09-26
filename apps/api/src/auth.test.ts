import { describe, expect, it } from "vitest";
import { decodeDemoSessionToken } from "./auth.js";

describe("demo session identity", () => {
  it("keeps the legacy operator token working", () => {
    expect(decodeDemoSessionToken("demo-session")?.email).toBe("operator@replayops.dev");
  });

  it("decodes an independent reviewer identity", () => {
    const payload = Buffer.from(JSON.stringify({ id:"00000000-0000-4000-8000-000000000002", email:"reviewer@replayops.dev" })).toString("base64url");
    expect(decodeDemoSessionToken(`demo-session.${payload}`)).toMatchObject({ id:"00000000-0000-4000-8000-000000000002", email:"reviewer@replayops.dev", demo:true });
  });

  it("rejects malformed payloads", () => {
    expect(decodeDemoSessionToken("demo-session.not-json")).toBeNull();
  });
});
