-- Classroom settings kept in Supabase Vault (encrypted at rest). Secrets are
-- named lv_<setting>, e.g. lv_cf_sfu_app_token. Only the service role (used
-- by the classroom Edge Function) may read them.
create or replace function public.lv_config()
returns json
language sql
security definer
set search_path = ''
as $$
  select coalesce(json_object_agg(name, decrypted_secret), '{}'::json)
  from vault.decrypted_secrets
  where name like 'lv\_%';
$$;

revoke all on function public.lv_config() from public, anon, authenticated;
grant execute on function public.lv_config() to service_role;
