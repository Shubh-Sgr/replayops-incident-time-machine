import { createClient } from "@supabase/supabase-js";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

export interface AuthenticatedRequest extends Request {
  user?: { id: string; email?: string; demo?: boolean };
}

const supabase = config.supabaseUrl && config.supabaseAnonKey
  ? createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (config.demoMode && (!supabase || token === "demo-session")) {
    req.user = { id: "00000000-0000-4000-8000-000000000001", email: "operator@replayops.dev", demo: true };
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
