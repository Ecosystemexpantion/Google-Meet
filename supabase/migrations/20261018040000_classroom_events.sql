-- Scheduled classes: each has a shareable page (class.html?e=<id>) with a
-- countdown, and its own live room. Only the Edge Function touches it.
create table if not exists public.lv_events (
  id           text        primary key,
  title        text        not null,
  description  text        not null default '',
  starts_at    timestamptz not null,
  duration_min integer     not null default 60,
  room         text        not null unique,
  created_at   timestamptz not null default now()
);

create index if not exists lv_events_starts on public.lv_events (starts_at);

alter table public.lv_events enable row level security;
