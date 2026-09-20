insert into organizations (id, name, slug)
values ('10000000-0000-4000-8000-000000000001', 'Northstar Commerce', 'northstar-commerce')
on conflict (slug) do nothing;

insert into incidents (id, organization_id, code, title, summary, service, severity, status, owner, started_at)
values (
  '20000000-0000-4000-8000-000000001842',
  '10000000-0000-4000-8000-000000000001',
  'ROP-1842',
  'Checkout retries amplified inventory latency',
  'A delayed inventory replica triggered synchronized checkout retries and elevated payment authorization latency.',
  'checkout-api',
  'critical',
  'identified',
  'Maya Chen',
  '2026-09-20T05:41:12Z'
)
on conflict (code) do nothing;
