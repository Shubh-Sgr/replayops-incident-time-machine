-- Per-source secret rotation: the connector token is derived from the source ID and this version, so bumping it
-- invalidates only that source's old token. Version 0 keeps the original token for existing sources.
alter table integrations add column if not exists token_version integer not null default 0;
