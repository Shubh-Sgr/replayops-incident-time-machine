import { useId } from "react";
import type { DashboardData } from "../types";

export function EventVolumeChart({ data }: { data: DashboardData["eventVolume"] }) {
  const titleId = useId();
  const width = 760;
  const height = 168;
  const inset = 16;
  const max = Math.max(...data.flatMap((item) => [item.requests, item.errors]), 1);
  const point = (value: number, index: number) => {
    const x = inset + (index / Math.max(data.length - 1, 1)) * (width - inset * 2);
    const y = height - inset - (value / max) * (height - inset * 2);
    return `${x},${y}`;
  };
  const requests = data.map((item, index) => point(item.requests, index)).join(" ");
  const errors = data.map((item, index) => point(item.errors, index)).join(" ");

  return (
    <figure>
      <svg className="h-44 w-full overflow-visible" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} preserveAspectRatio="none">
        <title id={titleId}>Request and error event volume during the selected incident</title>
        {Array.from({ length: 5 }).map((_, index) => {
          const y = inset + index * ((height - inset * 2) / 4);
          return <line key={y} x1={inset} x2={width - inset} y1={y} y2={y} stroke="oklch(var(--line))" strokeWidth="1" />;
        })}
        <polyline points={requests} fill="none" stroke="oklch(var(--trace))" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        <polyline points={errors} fill="none" stroke="oklch(var(--danger))" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        {data.map((item, index) => {
          const [x, y] = point(item.errors, index).split(",").map(Number);
          return <circle key={item.time} cx={x} cy={y} r="3.5" fill="oklch(var(--panel))" stroke="oklch(var(--danger))" strokeWidth="2" />;
        })}
      </svg>
      <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <span className="flex gap-4">
          <span className="inline-flex items-center gap-1.5"><i className="h-0.5 w-4 bg-info" /> Requests</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-0.5 w-4 bg-danger" /> Errors</span>
        </span>
        <span className="measurement-number">{data[0]?.time}—{data.at(-1)?.time} UTC · Synthetic demo data</span>
      </figcaption>
    </figure>
  );
}
