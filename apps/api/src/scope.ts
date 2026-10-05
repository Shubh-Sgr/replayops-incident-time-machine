/**
 * Request-scoping memberships: one row per user, for their active workspace only (see migration 007).
 * Queries that answer "which workspace is this request about?" read this view, never organization_members.
 */
export const MEMBERSHIPS = "replayops_internal.active_memberships";
