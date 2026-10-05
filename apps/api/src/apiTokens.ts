import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { config } from "./config.js";
import { notFound } from "./errors.js";
import type { WorkspaceRole } from "./types.js";
import { workspaceService } from "./workspace.js";

export type ApiTokenRole = Extract<WorkspaceRole, "viewer" | "responder">;
export interface ApiToken { id: string; name: string; role: ApiTokenRole; prefix: string; createdByEmail: string | null; createdAt: string; expiresAt: string | null; lastUsedAt: string | null }
export interface ApiTokenPrincipal { id: string; name: string; role: ApiTokenRole; organizationId: string }

type Row = Record<string, unknown>;
type StoredToken = ApiToken & { organizationId: string; tokenHash: string; revokedAt: string | null };

export const TOKEN_PREFIX = "rpo_";
export const isApiToken = (value: string | undefined) => Boolean(value?.startsWith(TOKEN_PREFIX));
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newTokenSecret = () => `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

/**
 * Writes an API token may make. Everything else (connectors, team, alerts, privacy, workspaces) needs a
 * person: those tables reference real accounts, and they change who can see or receive what.
 */
const tokenWritablePaths = [
  /^\/incidents$/, /^\/incidents\/[^/]+$/, /^\/incidents\/[^/]+\/events$/, /^\/incidents\/[^/]+\/comments$/,
  /^\/incidents\/[^/]+\/lifecycle$/, /^\/incidents\/[^/]+\/checks(\/[^/]+)?$/, /^\/incidents\/[^/]+\/measurements$/,
  /^\/search$/, /^\/assistant$/
];
export function tokenMayWrite(method: string, path: string) {
  if (method === "DELETE") return false;
  return tokenWritablePaths.some((pattern) => pattern.test(path));
}

const mapRow = (row: Row): StoredToken => ({
  id: String(row.id), organizationId: String(row.organization_id), name: String(row.name), role: row.role as ApiTokenRole, prefix: String(row.prefix),
  tokenHash: String(row.token_hash), createdByEmail: row.created_by_email ? String(row.created_by_email) : null,
  createdAt: new Date(String(row.created_at)).toISOString(), expiresAt: row.expires_at ? new Date(String(row.expires_at)).toISOString() : null,
  lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)).toISOString() : null, revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : null
});
const publicView = ({ organizationId: _org, tokenHash: _hash, revokedAt: _revoked, ...token }: StoredToken): ApiToken => token;

class ApiTokenService {
  private pool?: Pool;
  private memory: StoredToken[] = [];

  constructor() {
    if (config.databaseUrl) this.pool = new Pool({ connectionString: config.databaseUrl, ssl: config.databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }, max: 2 });
  }

  async list(userId: string) {
    const context = await workspaceService.assertRole(userId, ["admin"]);
    if (!this.pool) return this.memory.filter((item) => item.organizationId === context.organizationId && !item.revokedAt).map(publicView);
    const result = await this.pool.query(`select * from replayops_internal.api_tokens where organization_id=$1 and revoked_at is null order by created_at desc`, [context.organizationId]);
    return (result.rows as Row[]).map((row) => publicView(mapRow(row)));
  }

  /** Returns the secret exactly once; only its hash is kept. */
  async create(userId: string, actor: string, input: { name: string; role: ApiTokenRole; expiresInDays: number | null }) {
    const context = await workspaceService.assertRole(userId, ["admin"]);
    const secret = newTokenSecret();
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString() : null;
    let stored: StoredToken;
    if (!this.pool) {
      stored = { id: randomUUID(), organizationId: context.organizationId, name: input.name, role: input.role, prefix: secret.slice(0, 10), tokenHash: hashToken(secret), createdByEmail: actor, createdAt: new Date().toISOString(), expiresAt, lastUsedAt: null, revokedAt: null };
      this.memory.push(stored);
    } else {
      const result = await this.pool.query(`insert into replayops_internal.api_tokens(organization_id,name,role,token_hash,prefix,created_by,created_by_email,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [context.organizationId, input.name, input.role, hashToken(secret), secret.slice(0, 10), userId, actor, expiresAt]);
      stored = mapRow(result.rows[0] as Row);
    }
    await workspaceService.audit(userId, actor, "created API token", "api-token", stored.id, { name: input.name, role: input.role, prefix: stored.prefix, expiresAt });
    return { ...publicView(stored), token: secret };
  }

  async revoke(userId: string, actor: string, id: string) {
    const context = await workspaceService.assertRole(userId, ["admin"]);
    let name: string | undefined;
    if (!this.pool) {
      const found = this.memory.find((item) => item.id === id && item.organizationId === context.organizationId && !item.revokedAt);
      if (found) { found.revokedAt = new Date().toISOString(); name = found.name; }
    } else {
      const result = await this.pool.query(`update replayops_internal.api_tokens set revoked_at=now() where id::text=$2 and organization_id=$1 and revoked_at is null returning name`, [context.organizationId, id]);
      name = result.rows[0] ? String((result.rows[0] as Row).name) : undefined;
    }
    if (!name) throw notFound("API token not found.");
    await workspaceService.audit(userId, actor, "revoked API token", "api-token", id, { name });
  }

  /** Resolves a presented secret to its principal, or null when unknown, revoked, or expired. */
  async verify(secret: string): Promise<ApiTokenPrincipal | null> {
    const hash = hashToken(secret);
    if (!this.pool) {
      const found = this.memory.find((item) => item.tokenHash === hash && !item.revokedAt && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()));
      if (found) found.lastUsedAt = new Date().toISOString();
      return found ? { id: found.id, name: found.name, role: found.role, organizationId: found.organizationId } : null;
    }
    const result = await this.pool.query(`select * from replayops_internal.api_tokens where token_hash=$1 and revoked_at is null and (expires_at is null or expires_at > now())`, [hash]);
    const row = result.rows[0] as Row | undefined;
    if (!row) return null;
    const token = mapRow(row);
    if (!token.lastUsedAt || Date.now() - Date.parse(token.lastUsedAt) > 60_000) void this.pool.query(`update replayops_internal.api_tokens set last_used_at=now() where id=$1`, [token.id]).catch(() => undefined);
    return { id: token.id, name: token.name, role: token.role, organizationId: token.organizationId };
  }
}

export const apiTokenService = new ApiTokenService();
