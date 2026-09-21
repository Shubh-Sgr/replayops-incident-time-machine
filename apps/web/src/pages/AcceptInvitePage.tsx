import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, LoaderCircle, ShieldCheck, TriangleAlert } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const accept = useMutation({ mutationFn: () => api.acceptInvitation(token) });
  return <div className="mx-auto max-w-xl pt-8 sm:pt-16"><section className="surface-lined p-6 sm:p-8"><ShieldCheck className="h-8 w-8 text-accent" /><h1 className="mt-5 font-heading text-3xl font-semibold tracking-[-0.03em]">Join the response workspace</h1><p className="mt-3 text-sm leading-7 text-muted">The invitation is bound to your authenticated email and expires after seven days. Your assigned role is enforced by the API.</p>{!token && <p role="alert" className="mt-5 flex gap-2 rounded-control bg-danger/10 p-4 text-sm text-danger"><TriangleAlert className="h-4 w-4 shrink-0" />This link does not contain an invitation token.</p>}{accept.isSuccess ? <div className="mt-6 rounded-control bg-success/10 p-4"><p className="flex items-center gap-2 font-semibold text-success"><CheckCircle2 className="h-5 w-5" />Access granted</p><p className="mt-2 text-sm text-muted">You joined {accept.data.organizationName} as {accept.data.role}.</p><Link className="control-primary mt-4 inline-flex" to="/workspace">Open workspace</Link></div> : <button className="control-primary mt-6 inline-flex items-center gap-2" disabled={!token || accept.isPending} onClick={() => accept.mutate()}>{accept.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{accept.isPending ? "Validating invitation…" : "Accept invitation"}</button>}{accept.error && <p role="alert" className="mt-4 rounded-control bg-danger/10 p-4 text-sm text-danger">{accept.error.message}</p>}</section></div>;
}
