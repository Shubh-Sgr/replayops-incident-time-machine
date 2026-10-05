-- Exception grouping looks up the first sighting of a fingerprint across a workspace.
create index if not exists incident_events_exception_fingerprint_idx
  on public.incident_events ((metadata->'exception'->>'fingerprint'))
  where metadata ? 'exception';
create index if not exists ingestion_signals_exception_fingerprint_idx
  on public.ingestion_signals ((metadata->'exception'->>'fingerprint'))
  where metadata ? 'exception';
