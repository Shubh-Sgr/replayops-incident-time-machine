import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

const NEW_WORKSPACE = "__new";

/** Everything you see is scoped to one workspace; switching resets every cached query to the new one. */
export function WorkspaceSwitcher({ onSwitched }: { onSwitched?: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces, staleTime: 60_000 });
  const done = async () => { await queryClient.resetQueries(); navigate("/"); onSwitched?.(); };
  const switchTo = useMutation({ mutationFn: api.switchWorkspace, onSuccess: done });
  const create = useMutation({ mutationFn: api.createWorkspace, onSuccess: done });
  const active = workspaces.data?.find((item) => item.active);
  const busy = switchTo.isPending || create.isPending;
  const choose = (value: string) => {
    if (value !== NEW_WORKSPACE) { if (value !== active?.organizationId) switchTo.mutate(value); return; }
    const name = window.prompt("Name the new workspace (for example, a team or product):")?.trim();
    if (name && name.length >= 2) create.mutate(name);
  };
  if (!workspaces.data) return null;
  return <div className="mt-6 px-1">
    <label className="block text-xs font-semibold text-muted" htmlFor="workspace-switcher">Workspace</label>
    <div className="relative mt-1.5">
      <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <select id="workspace-switcher" className="field !pl-9 text-sm font-semibold" value={active?.organizationId ?? ""} disabled={busy} onChange={(event) => choose(event.target.value)}>
        {workspaces.data.map((item) => <option key={item.organizationId} value={item.organizationId}>{item.organizationName} · {item.role}</option>)}
        <option value={NEW_WORKSPACE}>+ New workspace…</option>
      </select>
    </div>
    {(switchTo.error ?? create.error) && <p role="alert" className="mt-1.5 text-xs text-danger">{(switchTo.error ?? create.error)!.message}</p>}
  </div>;
}
