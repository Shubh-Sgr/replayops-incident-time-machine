import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** Destructive actions are admin-only on the API; hide their controls for everyone else. */
export function useIsAdmin() {
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 60_000 });
  return workspace.data?.role === "admin";
}
