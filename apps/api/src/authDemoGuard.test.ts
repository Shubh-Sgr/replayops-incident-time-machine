import { describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({ config: { demoMode: true, databaseUrl: "postgres://db.example.com/replayops", supabaseUrl: undefined, supabaseAnonKey: undefined } }));
const { requireAuth } = await import("./auth.js");

describe("demo sessions with a real database", () => {
  it("rejects unsigned demo tokens so nobody can impersonate a member by user ID", async () => {
    const forged = `demo-session.${Buffer.from(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", email: "admin@example.com" })).toString("base64url")}`;
    const res = { statusCode: 200, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { this.body = value; return this; } };
    const next = vi.fn();
    const req = { headers: { authorization: `Bearer ${forged}` } } as Parameters<typeof requireAuth>[0];
    await requireAuth(req, res as unknown as Parameters<typeof requireAuth>[1], next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(req.user).toBeUndefined();
  });
});
