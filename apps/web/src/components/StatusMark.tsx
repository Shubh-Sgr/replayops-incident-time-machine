import { AlertTriangle, CheckCircle2, CircleDot, Clock3, Radar } from "lucide-react";
import type { IncidentStatus, Severity } from "../types";
import { cn } from "../lib/utils";

const severityStyles: Record<Severity, string> = {
  critical: "bg-danger/14 text-danger",
  high: "bg-warning/16 text-warning",
  medium: "bg-info/13 text-info",
  low: "bg-success/13 text-success"
};

const statusStyles: Record<IncidentStatus, string> = {
  investigating: "bg-danger/12 text-danger",
  identified: "bg-warning/14 text-warning",
  monitoring: "bg-info/12 text-info",
  resolved: "bg-success/12 text-success"
};

export function SeverityMark({ value }: { value: Severity }) {
  const Icon = value === "critical" ? AlertTriangle : CircleDot;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold capitalize", severityStyles[value])}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {value}
    </span>
  );
}

/** Plain names for the lifecycle: Open → Fixed (watching for recovery) → Resolved. */
export const statusLabel: Record<IncidentStatus, string> = { investigating: "Open", identified: "Cause found", monitoring: "Fixed", resolved: "Resolved" };

export function StatusMark({ value }: { value: IncidentStatus }) {
  const Icon = value === "resolved" ? CheckCircle2 : value === "monitoring" ? Radar : Clock3;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold", statusStyles[value])} title={value === "monitoring" ? "Fixed — watching to confirm it stays fixed" : undefined}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {statusLabel[value]}
    </span>
  );
}
