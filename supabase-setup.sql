-- ============================================================
--  EEM26 Selar Setup Training — Supabase Database Setup
--  Run this ONCE in: Dashboard → SQL Editor → New Query → Run
-- ============================================================

CREATE TABLE IF NOT EXISTS sessions (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  room_name   TEXT        NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT false,
  started_at  TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS participants (
  id                      UUID        PRIMARY KEY,
  session_id              UUID        REFERENCES sessions(id) ON DELETE CASCADE,
  name                    TEXT        NOT NULL,
  joined_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at                 TIMESTAMPTZ,
  is_active               BOOLEAN     NOT NULL DEFAULT true,
  has_speaking_permission BOOLEAN     NOT NULL DEFAULT false,
  has_raised_hand         BOOLEAN     NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_participants_session ON participants (session_id);

ALTER TABLE sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sessions_select" ON sessions;
CREATE POLICY "sessions_select" ON sessions FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "sessions_insert" ON sessions;
CREATE POLICY "sessions_insert" ON sessions FOR INSERT TO anon WITH CHECK (true);
DROP POLICY IF EXISTS "sessions_update" ON sessions;
CREATE POLICY "sessions_update" ON sessions FOR UPDATE TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "participants_select" ON participants;
CREATE POLICY "participants_select" ON participants FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "participants_insert" ON participants;
CREATE POLICY "participants_insert" ON participants FOR INSERT TO anon WITH CHECK (true);
DROP POLICY IF EXISTS "participants_update" ON participants;
CREATE POLICY "participants_update" ON participants FOR UPDATE TO anon USING (true) WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE participants;

-- Verify (should return 2 rows):
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('sessions','participants')
ORDER BY table_name;
