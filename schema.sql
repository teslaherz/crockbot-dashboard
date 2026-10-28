-- Applied automatically on the first request (CREATE TABLE IF NOT EXISTS).
-- You can also run it yourself:
--   npx wrangler d1 execute crockbot-dashboard-db --remote --file=schema.sql

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
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_results_pinned_created ON results (pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_bot ON results (bot_name);
