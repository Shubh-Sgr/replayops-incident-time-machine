import type { Session, User } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { demoModeEnabled, supabase } from "../lib/supabase";

interface AuthUser {
  id: string;
  email: string;
  name: string;
  demo?: boolean;
}

interface LocalAccount extends AuthUser {
  passwordHash: string;
  passwordSalt: string;
}

interface AuthResult {
  message?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  demoAvailable: boolean;
  signIn(email: string, password: string): Promise<AuthResult>;
  signUp(name: string, email: string, password: string): Promise<AuthResult>;
  signInWithGithub(): Promise<void>;
  enterDemo(): void;
  signOut(): Promise<void>;
}

export const TEST_CREDENTIALS = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "operator@replayops.dev",
  password: "ReplayOps!2026",
  name: "Maya Chen"
} as const;

export const REVIEWER_CREDENTIALS = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "reviewer@replayops.dev",
  password: "ReplayOps!2026",
  name: "Alex Rivera"
} as const;

const DEMO_PERSONAS = [TEST_CREDENTIALS, REVIEWER_CREDENTIALS] as const;

const LOCAL_ACCOUNTS_KEY = "replayops-local-accounts";
const LOCAL_SESSION_KEY = "replayops-local-session";
const DEMO_SESSION_KEY = "replayops-demo-session";
const AuthContext = createContext<AuthContextValue | null>(null);

function mapUser(user: User): AuthUser {
  return {
    id: user.id,
    email: user.email ?? "unknown@replayops.dev",
    name: String(user.user_metadata.full_name ?? user.user_metadata.name ?? user.email?.split("@")[0] ?? "Operator")
  };
}

function readLocalAccounts(): LocalAccount[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_ACCOUNTS_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is LocalAccount => {
      if (!item || typeof item !== "object") return false;
      const account = item as Partial<LocalAccount>;
      return [account.id, account.email, account.name, account.passwordHash, account.passwordSalt].every((value) => typeof value === "string");
    }) : [];
  } catch {
    return [];
  }
}

function readLocalSession(): AuthUser | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_SESSION_KEY) ?? "null") as Partial<AuthUser> | null;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.email !== "string" || typeof parsed.name !== "string") return null;
    return { id: parsed.id, email: parsed.email, name: parsed.name, demo: true };
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let value = "";
  bytes.forEach((byte) => { value += String.fromCharCode(byte); });
  return window.btoa(value);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(window.atob(value), (character) => character.charCodeAt(0));
}

async function derivePasswordHash(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const stableSalt = new Uint8Array(salt);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: stableSalt, iterations: 120_000, hash: "SHA-256" }, key, 256);
  return bytesToBase64(new Uint8Array(bits));
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [localUser, setLocalUser] = useState<AuthUser | null>(() => {
    const existing = readLocalSession();
    if (existing) return existing;
    return localStorage.getItem(DEMO_SESSION_KEY) === "true"
      ? { id: TEST_CREDENTIALS.id, email: TEST_CREDENTIALS.email, name: TEST_CREDENTIALS.name, demo: true }
      : null;
  });
  const [loading, setLoading] = useState(Boolean(supabase));

  const persistLocalUser = (user: AuthUser) => {
    localStorage.setItem(DEMO_SESSION_KEY, "true");
    localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(user));
    setLocalUser({ ...user, demo: true });
  };

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user: localUser ?? (session?.user ? mapUser(session.user) : null),
    loading,
    demoAvailable: demoModeEnabled,
    async signIn(email, password) {
      const normalizedEmail = normalizeEmail(email);
      const persona = DEMO_PERSONAS.find((candidate) => candidate.email === normalizedEmail && candidate.password === password);
      if (demoModeEnabled && persona) {
        persistLocalUser({ id: persona.id, email: persona.email, name: persona.name, demo: true });
        return {};
      }

      if (demoModeEnabled) {
        const account = readLocalAccounts().find((candidate) => candidate.email === normalizedEmail);
        if (account) {
          const passwordHash = await derivePasswordHash(password, base64ToBytes(account.passwordSalt));
          if (passwordHash !== account.passwordHash) throw new Error("The password does not match this local test account.");
          persistLocalUser({ id: account.id, email: account.email, name: account.name, demo: true });
          return {};
        }
      }

      if (!supabase) throw new Error("No account matches those credentials. Create a local test account or use the supplied test credentials.");
      const { error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
      if (error) throw new Error(error.message);
      return {};
    },
    async signUp(name, email, password) {
      const normalizedEmail = normalizeEmail(email);
      const trimmedName = name.trim();

      if (supabase) {
        const { data, error } = await supabase.auth.signUp({ email: normalizedEmail, password, options: { data: { full_name: trimmedName } } });
        if (error) throw new Error(error.message);
        return data.session
          ? { message: "Account created. Your private workspace is ready." }
          : { message: "Account created. Check your email to confirm your address, then sign in." };
      }

      if (!demoModeEnabled) throw new Error("Account creation requires Supabase configuration in this environment.");
      const accounts = readLocalAccounts();
      if (DEMO_PERSONAS.some((persona) => persona.email === normalizedEmail) || accounts.some((account) => account.email === normalizedEmail)) {
        throw new Error("An account already exists for this email. Sign in instead.");
      }

      const salt = crypto.getRandomValues(new Uint8Array(16));
      const account: LocalAccount = {
        id: crypto.randomUUID(),
        email: normalizedEmail,
        name: trimmedName,
        demo: true,
        passwordSalt: bytesToBase64(salt),
        passwordHash: await derivePasswordHash(password, salt)
      };
      localStorage.setItem(LOCAL_ACCOUNTS_KEY, JSON.stringify([...accounts, account]));
      persistLocalUser(account);
      return { message: "Local test account created. It is stored only in this browser." };
    },
    async signInWithGithub() {
      if (!supabase) throw new Error("GitHub login becomes available after Supabase is connected during deployment.");
      const { error } = await supabase.auth.signInWithOAuth({ provider: "github", options: { redirectTo: window.location.origin } });
      if (error) throw new Error(error.message);
    },
    enterDemo() {
      persistLocalUser({ id: TEST_CREDENTIALS.id, email: TEST_CREDENTIALS.email, name: TEST_CREDENTIALS.name, demo: true });
    },
    async signOut() {
      localStorage.removeItem(DEMO_SESSION_KEY);
      localStorage.removeItem(LOCAL_SESSION_KEY);
      setLocalUser(null);
      if (supabase) await supabase.auth.signOut();
    }
  }), [localUser, loading, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider.");
  return context;
}
