-- Phone screen sharing via the EEM26 Cast Android app: the app reports the
-- tracks it publishes here (with a heartbeat); the presenter page picks them up.
alter table public.lv_rooms add column if not exists cast_info jsonb;
