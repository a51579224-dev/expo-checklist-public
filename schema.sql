-- Supabase(Postgres) SQL Editor에서 한 번만 실행하면 됩니다.
create extension if not exists pgcrypto;

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  start_date text default '',
  end_date text default '',
  location text default '',
  booth_count text default '',
  categories jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists events_slug_idx on events (slug);
