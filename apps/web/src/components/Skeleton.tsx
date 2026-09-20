import { cn } from "../lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-control bg-line/50", className)} />;
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-label="Loading dashboard">
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-[380px] w-full rounded-panel" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-72 rounded-panel" />
        <Skeleton className="h-72 rounded-panel" />
      </div>
    </div>
  );
}
