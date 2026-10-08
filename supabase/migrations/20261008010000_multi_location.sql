-- v2: multi-location. Every row belongs to a location (location_id); each location has its own
-- numbering (bonuri, rapoarte Z) like each physical cash register does. Tables were empty at this point.

drop table if exists public.z_reports, public.voids, public.receipts, public.calls, public.order_lines,
  public.orders, public.guests, public.sessions, public.pos_meta cascade;

create table public.locations (
  id text primary key,
  name text not null,
  cui text not null,
  address text not null,
  created_at timestamptz not null default now()
);

-- seq counters, cumulative total, staff (PIN hashes), menu overrides — per location
create table public.pos_meta (
  location_id text not null references public.locations (id),
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (location_id, key)
);

create table public.sessions (
  location_id text not null references public.locations (id),
  id text not null,
  table_id text not null,
  kind text not null default 'table' check (kind in ('table', 'takeaway', 'delivery')),
  label text,
  customer jsonb, -- doar pentru pachet/livrare: nume, telefon, adresă (anonimizate după retenție)
  waiter_id text,
  status text not null check (status in ('open', 'closed')),
  merged_into text,
  opened_at timestamptz not null,
  closed_at timestamptz,
  primary key (location_id, id)
);
create index sessions_open_idx on public.sessions (location_id) where status = 'open';
create index sessions_closed_idx on public.sessions (location_id, closed_at);

create table public.guests (
  location_id text not null,
  id text not null,
  session_id text not null,
  name text not null,
  color text not null,
  joined_at timestamptz not null,
  anonymized boolean not null default false,
  primary key (location_id, id),
  foreign key (location_id, session_id) references public.sessions (location_id, id) on delete cascade
);
create index guests_session_idx on public.guests (location_id, session_id);

create table public.orders (
  location_id text not null,
  id text not null,
  session_id text not null,
  guest_id text not null,
  status text not null check (status in ('new', 'accepted', 'served', 'rejected')),
  source text not null default 'guest' check (source in ('guest', 'pos')),
  staff_id text,
  created_at timestamptz not null,
  primary key (location_id, id),
  foreign key (location_id, session_id) references public.sessions (location_id, id) on delete cascade
);
create index orders_session_idx on public.orders (location_id, session_id);

create table public.order_lines (
  location_id text not null,
  id text not null,
  order_id text not null,
  guest_id text not null,
  item_id text not null,
  name text not null,
  category text not null,
  station text not null default 'kitchen',
  qty integer not null check (qty > 0),
  unit_price integer not null, -- bani, TVA inclus
  vat_code text not null,
  discount_pct integer not null default 0 check (discount_pct between 0 and 100),
  note text not null default '',
  voided boolean not null default false,
  void_reason text not null default '',
  ready boolean not null default false,
  receipt_no integer,
  position integer not null default 0,
  primary key (location_id, id),
  foreign key (location_id, order_id) references public.orders (location_id, id) on delete cascade
);
create index order_lines_order_idx on public.order_lines (location_id, order_id);

create table public.calls (
  location_id text not null,
  id text not null,
  session_id text not null,
  type text not null check (type in ('waiter', 'bill')),
  created_at timestamptz not null,
  ack boolean not null default false,
  primary key (location_id, id),
  foreign key (location_id, session_id) references public.sessions (location_id, id) on delete cascade
);

-- Documente de încasare. Fără date personale: doar ID-uri anonime de client și CIF-ul firmei clientului.
create table public.receipts (
  location_id text not null references public.locations (id),
  no integer not null,
  type text not null default 'sale' check (type in ('sale', 'refund')),
  ref_no integer,
  reason text not null default '',
  session_id text not null,
  table_id text not null,
  staff_id text,
  payments jsonb not null,
  change integer not null default 0,
  tip integer not null default 0,
  cif text not null default '',
  gross integer not null,
  discount integer not null default 0,
  total integer not null,
  vat jsonb not null,
  lines jsonb not null,
  guest_ids text[] not null default '{}',
  z_no integer,
  created_at timestamptz not null,
  primary key (location_id, no)
);
create index receipts_created_idx on public.receipts (location_id, created_at);
create index receipts_unreported_idx on public.receipts (location_id) where z_no is null;

create table public.voids (
  location_id text not null references public.locations (id),
  line_id text not null,
  session_id text not null,
  table_id text not null,
  name text not null,
  qty integer not null,
  total integer not null,
  reason text not null default '',
  staff_id text,
  z_no integer,
  created_at timestamptz not null,
  primary key (location_id, line_id)
);

create table public.cash_moves (
  location_id text not null references public.locations (id),
  id text not null,
  type text not null check (type in ('in', 'out')),
  amount integer not null check (amount > 0),
  reason text not null default '',
  staff_id text,
  z_no integer,
  created_at timestamptz not null,
  primary key (location_id, id)
);

create table public.z_reports (
  location_id text not null references public.locations (id),
  no integer not null,
  generated_at timestamptz not null,
  total integer not null,
  report jsonb not null,
  primary key (location_id, no)
);

-- Rapoarte consolidate pe toate locațiile (pentru management / BI).
create view public.daily_sales with (security_invoker = true) as
  select location_id,
         (created_at at time zone 'Europe/Bucharest')::date as day,
         count(*) filter (where type = 'sale') as receipts,
         sum(total) as total,
         sum(tip) as tips,
         sum(discount) as discounts
  from public.receipts
  group by 1, 2;

alter table public.locations enable row level security;
alter table public.pos_meta enable row level security;
alter table public.sessions enable row level security;
alter table public.guests enable row level security;
alter table public.orders enable row level security;
alter table public.order_lines enable row level security;
alter table public.calls enable row level security;
alter table public.receipts enable row level security;
alter table public.voids enable row level security;
alter table public.cash_moves enable row level security;
alter table public.z_reports enable row level security;

revoke all on all tables in schema public from anon, authenticated;
