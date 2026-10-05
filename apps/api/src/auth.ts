import { createClient } from "@supabase/supabase-js";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { apiTokenService, isApiToken, type ApiTokenPrincipal } from "./apiTokens.js";

export interface AuthenticatedRequest extends Request {
  user?: { id: string; email?: string; demo?: boolean; token?: ApiTokenPrincipal };
}

const supabase = config.supabaseUrl && config.supabaseAnonKey
  ? createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const DEMO_OPERATOR = { id: "00000000-0000-4000-8000-000000000001", email: "operator@replayops.dev", demo: true } as const;

export function decodeDemoSessionToken(token: string | undefined) {
  if (token === "demo-session") return DEMO_OPERATOR;
  if (!token?.startsWith("demo-session.")) return null;
  try {
    const encoded = token.slice("demo-session.".length);
    if (!encoded || encoded.length > 1024) return null;
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { id?: unknown; email?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.email !== "string" || !parsed.email.includes("@")) return null;
    return { id: parsed.id, email: parsed.email.trim().toLowerCase(), demo: true as const };
  } catch {
    return null;
  }
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (isApiToken(token)) {
    const principal = await apiTokenService.verify(token!).catch(() => null);
    if (!principal) { res.status(401).json({ error: "This API token is invalid, revoked, or expired." }); return; }
    req.user = { id: principal.id, email: `${principal.name} (API token)`, token: principal };
    next();
    return;
  }
  // Demo tokens are unsigned, so they are only honoured by the in-memory demo API. With a real database
  // they would let anyone who knows a member's user ID act as that member.
  const demoUser = config.demoMode && !config.databaseUrl ? decodeDemoSessionToken(token) : null;
  if (demoUser && (!supabase || token?.startsWith("demo-session"))) {
    req.user = demoUser;
    next();
    return;
  }
  if (!token || !supabase) {
    res.status(401).json({ error: "Authentication is required." });
    return;
  }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: "Your session is invalid or has expired." });
    return;
  }
  req.user = { id: data.user.id, email: data.user.email };
  next();
}
