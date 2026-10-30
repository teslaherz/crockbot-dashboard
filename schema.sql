-- Target schema for a new D1 database.
-- The Worker applies this itself on the first request: one statement per
-- prepare().run(), then guarded ALTER TABLE for databases that already have
-- `results` without the chat columns. Do not rely on exec() with several
-- statements; production D1 rejects that.
--
-- Safe to re-run on a new database (IF NOT EXISTS). On a legacy database,
-- let the Worker add columns before applying the bot_slug index, or just
-- open the dashboard once and skip this file.

CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  bot_name TEXT NOT NULL DEFAULT 'Grokbot',
  bot_id TEXT DEFAULT '',
  category TEXT DEFAULT 'general',
  summary TEXT DEFAULT '',
  content_md TEXT NOT NULL,
  pinned INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'bot',
  task TEXT DEFAULT '',
  meta TEXT DEFAULT '',
  bot_slug TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS bots (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  emoji TEXT DEFAULT '',
  color TEXT DEFAULT '',
  description TEXT DEFAULT '',
  customized INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_results_pinned_created ON results (pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_bot ON results (bot_name);
CREATE INDEX IF NOT EXISTS idx_results_bot_slug_created ON results (bot_slug, created_at DESC, id DESC);

-- Legacy columns the Worker adds when missing (SQLite has no ADD COLUMN IF NOT EXISTS):
--   ALTER TABLE results ADD COLUMN role TEXT NOT NULL DEFAULT 'bot';
--   ALTER TABLE results ADD COLUMN task TEXT DEFAULT '';
--   ALTER TABLE results ADD COLUMN meta TEXT DEFAULT '';
--   ALTER TABLE results ADD COLUMN bot_slug TEXT DEFAULT '';
