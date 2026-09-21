import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "./ai.js";

describe("AI evidence protection", () => {
  it("redacts credentials, bearer tokens, email addresses, and IP addresses before provider calls", () => {
    const result = redactSensitiveText("token=super-secret-value Bearer abc.def.ghi operator@example.com called 10.24.8.19");
    expect(result.text).not.toContain("super-secret-value");
    expect(result.text).not.toContain("abc.def.ghi");
    expect(result.text).not.toContain("operator@example.com");
    expect(result.text).not.toContain("10.24.8.19");
    expect(result.redactions).toBe(4);
  });

  it("does not alter ordinary incident evidence", () => {
    const result = redactSensitiveText("checkout-api latency reached 2800ms after release 2026.09.21");
    expect(result.redactions).toBe(0);
    expect(result.text).toContain("checkout-api latency");
  });
});
