-- Schema for newpos. The Node server is the only client (uses the secret/service_role key).
-- RLS is enabled with NO policies: anon/authenticated roles have no access (GDPR: no public exposure).

create table public.pos_meta (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.sessions (
  id text primary key,
  table_id text not null,
  status text not null check (status in ('open', 'closed')),
  opened_at timestamptz not null,
  closed_at timestamptz
);
create index sessions_open_idx on public.sessions (status) where status = 'open';

-- Date personale minime: doar un prenume/pseudonim, anonimizat automat după perioada de retenție.
create table public.guests (
  id text primary key,
  session_id text not null references public.sessions (id) on delete cascade,
  name text not null,
  color text not null,
  joined_at timestamptz not null,
  anonymized boolean not null default false
);
create index guests_session_idx on public.guests (session_id);

create table public.orders (
  id text primary key,
  session_id text not null references public.sessions (id) on delete cascade,
  guest_id text not null references public.guests (id) on delete cascade,
  status text not null check (status in ('new', 'accepted', 'served', 'rejected')),
  created_at timestamptz not null
);
create index orders_session_idx on public.orders (session_id);
create index orders_guest_idx on public.orders (guest_id);

create table public.order_lines (
  id text primary key,
  order_id text not null references public.orders (id) on delete cascade,
  item_id text not null,
  name text not null,
  category text not null,
  qty integer not null check (qty > 0),
  unit_price integer not null, -- bani, TVA inclus
  vat_code text not null,
  note text not null default '',
  voided boolean not null default false,
  receipt_no integer,
  position integer not null default 0
);
create index order_lines_order_idx on public.order_lines (order_id);

create table public.calls (
  id text primary key,
  session_id text not null references public.sessions (id) on delete cascade,
  type text not null check (type in ('waiter', 'bill')),
  created_at timestamptz not null,
  ack boolean not null default false
);
create index calls_session_idx on public.calls (session_id);

-- Documente de încasare (note de plată). Nu conțin date personale (doar ID-uri anonime și CIF firmă).
create table public.receipts (
  no integer primary key,
  session_id text not null references public.sessions (id),
  table_id text not null,
  method text not null check (method in ('cash', 'card', 'meal')),
  cif text not null default '',
  total integer not null,
  vat jsonb not null,
  lines jsonb not null,
  guest_ids text[] not null default '{}',
  z_no integer,
  created_at timestamptz not null
);
create index receipts_session_idx on public.receipts (session_id);
create index receipts_unreported_idx on public.receipts (no) where z_no is null;

create table public.voids (
  line_id text primary key,
  session_id text not null references public.sessions (id),
  table_id text not null,
  name text not null,
  qty integer not null,
  total integer not null,
  z_no integer,
  created_at timestamptz not null
);
create index voids_session_idx on public.voids (session_id);

create table public.z_reports (
  no integer primary key,
  generated_at timestamptz not null,
  total integer not null,
  report jsonb not null
);

alter table public.pos_meta enable row level security;
alter table public.sessions enable row level security;
alter table public.guests enable row level security;
alter table public.orders enable row level security;
alter table public.order_lines enable row level security;
alter table public.calls enable row level security;
alter table public.receipts enable row level security;
alter table public.voids enable row level security;
alter table public.z_reports enable row level security;

revoke all on all tables in schema public from anon, authenticated;
