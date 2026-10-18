-- Live classroom registry used by the "classroom" Edge Function.
-- RLS is on with no policies: only the function (service role) can touch these.
create table if not exists public.lv_rooms (
  name              text primary key,
  open              boolean     not null default false,
  locked            boolean     not null default false,
  title             text        not null default '',
  host_data_session text,
  banned            jsonb       not null default '[]'::jsonb,
  started_at        timestamptz,
  updated_at        timestamptz not null default now()
);

create table if not exists public.lv_attendees (
  id           bigint generated always as identity primary key,
  room         text        not null references public.lv_rooms(name) on delete cascade,
  identity     text        not null,
  name         text        not null,
  data_session text        not null,
  created_at   timestamptz not null default now()
);

create index if not exists lv_attendees_room_id on public.lv_attendees (room, id);

alter table public.lv_rooms     enable row level security;
alter table public.lv_attendees enable row level security;
