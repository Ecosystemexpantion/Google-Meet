-- ============================================================
--  EEM26 Selar Setup Training — Supabase Database Setup
--  Run this ONCE in your Supabase SQL editor:
--  Dashboard → SQL Editor → New Query → paste → Run
-- ============================================================

-- ── sessions table ──────────────────────────────────────────
-- One row per training session. The host creates/activates it.
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  room_name   TEXT        NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT false,
  started_at  TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── participants table ───────────────────────────────────────
-- One row per student per session.
CREATE TABLE IF NOT EXISTS participants (
  id                      UUID        PRIMARY KEY,  -- generated client-side
  session_id              UUID        REFERENCES sessions(id) ON DELETE CASCADE,
  name                    TEXT        NOT NULL,
  joined_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at                 TIMESTAMPTZ,
  is_active               BOOLEAN     NOT NULL DEFAULT true,
  has_speaking_permission BOOLEAN     NOT NULL DEFAULT false,
  has_raised_hand         BOOLEAN     NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_participants_session
  ON participants (session_id);

-- ── Row Level Security ───────────────────────────────────────
-- The anon key is safe to expose publicly (standard Supabase pattern).
-- All actual "security" is at the application layer: the host panel
-- requires a SHA-256 password match before any writes happen.

ALTER TABLE sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;

-- Sessions: anyone can read; anyone can write
-- (host writes protected by client-side password gate)
DROP POLICY IF EXISTS "sessions_select" ON sessions;
CREATE POLICY "sessions_select"
  ON sessions FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "sessions_insert" ON sessions;
CREATE POLICY "sessions_insert"
  ON sessions FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "sessions_update" ON sessions;
CREATE POLICY "sessions_update"
  ON sessions FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- Participants: anyone can read, insert, or update
DROP POLICY IF EXISTS "participants_select" ON participants;
CREATE POLICY "participants_select"
  ON participants FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "participants_insert" ON participants;
CREATE POLICY "participants_insert"
  ON participants FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "participants_update" ON participants;
CREATE POLICY "participants_update"
  ON participants FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- ── Realtime ─────────────────────────────────────────────────
-- Enable Postgres Changes replication on both tables.
-- You also need to enable Realtime in the Supabase dashboard:
--   Database → Replication → supabase_realtime → add both tables

ALTER PUBLICATION supabase_realtime ADD TABLE sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE participants;

-- ── Verify ───────────────────────────────────────────────────
-- After running, confirm:
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('sessions', 'participants')
ORDER BY table_name;
-- Expected: 2 rows (participants, sessions)
