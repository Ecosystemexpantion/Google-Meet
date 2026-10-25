-- Class reminders: browsers that asked to be reminded about a scheduled class
-- (Web Push subscriptions). Only the Edge Function touches it.
create table if not exists public.lv_reminders (
  id         bigserial   primary key,
  event_id   text        not null references public.lv_events (id) on delete cascade,
  endpoint   text        not null,
  p256dh     text        not null,
  auth       text        not null,
  name       text        not null default '',
  sent       text[]      not null default '{}',   -- 'day', 'hour', 'soon', 'live'
  created_at timestamptz not null default now(),
  unique (event_id, endpoint)
);

alter table public.lv_reminders enable row level security;

-- Every minute, ask the classroom function to send whatever reminders are due.
-- It checks lv_cron_secret (Vault) so nobody else can trigger sends.
-- (lv_cron_secret is created below; the push keys by the function itself.)
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('lv-reminders') where exists (select 1 from cron.job where jobname = 'lv-reminders');
select cron.schedule('lv-reminders', '* * * * *', $$
  select net.http_post(
    url := 'https://leqizarzgfpiriknpnxw.supabase.co/functions/v1/classroom',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'action', 'remind-run',
      'secret', (select decrypted_secret from vault.decrypted_secrets where name = 'lv_cron_secret')
    ),
    timeout_milliseconds := 55000
  );
$$);

-- The cron secret is made here and never leaves the database.
select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'lv_cron_secret')
where not exists (select 1 from vault.secrets where name = 'lv_cron_secret');

-- The push (VAPID) key pair is made by the Edge Function the first time it is
-- needed and kept in Vault through this function; whichever call stores first
-- wins and every call gets the stored pair back.
create or replace function public.lv_init_vapid(pub text, priv text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from vault.secrets where name = 'lv_vapid_private') then
    perform vault.create_secret(priv, 'lv_vapid_private');
    perform vault.create_secret(pub, 'lv_vapid_public');
  end if;
  return (select json_object_agg(name, decrypted_secret) from vault.decrypted_secrets
          where name in ('lv_vapid_public', 'lv_vapid_private'));
end;
$$;

revoke all on function public.lv_init_vapid(text, text) from public, anon, authenticated;
grant execute on function public.lv_init_vapid(text, text) to service_role;
