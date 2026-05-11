-- D1 schema for Larry's voice-accessible knowledge store.
-- Mirrors PKM/mypka.db where the user already has data
-- (notes, journal, people) and adds two new types Larry can create
-- via voice (tasks, ideas).
--
-- Apply with:
--   wrangler d1 execute larry-db --remote --file schema.sql

-- ─── notes ─────────────────────────────────────────────────────
-- Free-form notes captured via voice. note_type lets Larry tag
-- whether it's a generic note, a recipe, a quote, etc.
CREATE TABLE IF NOT EXISTS notes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT UNIQUE,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  note_type       TEXT DEFAULT 'note',     -- 'note' | 'quote' | 'recipe' | 'reference'
  related_people  TEXT,                    -- comma-separated person slugs
  related_topics  TEXT,                    -- comma-separated topic tags
  source_journal_id INTEGER,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_type    ON notes(note_type);

-- ─── journal ───────────────────────────────────────────────────
-- Daily journal entries — what the user did, felt, observed.
-- mood is a free-form short label ('focused', 'tired', 'curious').
CREATE TABLE IF NOT EXISTS journal (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date        TEXT NOT NULL,           -- 'YYYY-MM-DD'
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  mood              TEXT,
  source            TEXT DEFAULT 'voice',    -- 'voice' | 'manual' | 'import'
  related_people    TEXT,
  related_topics    TEXT,
  related_projects  TEXT,
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_journal_date    ON journal(entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_created ON journal(created_at DESC);

-- ─── people / kontakte ─────────────────────────────────────────
-- Lightweight contact list — full_name, what role they play in the
-- user's life, freeform notes. Mirrors mypka.db people table.
CREATE TABLE IF NOT EXISTS people (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT UNIQUE,
  full_name     TEXT NOT NULL,
  known_as      TEXT,
  role_context  TEXT,
  notes         TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_people_slug ON people(slug);

-- ─── tasks ─────────────────────────────────────────────────────
-- Action items Larry captures from voice. priority 1=urgent..4=low.
-- status flows: open → in_progress → done | abandoned.
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  details     TEXT,
  status      TEXT DEFAULT 'open',          -- 'open' | 'in_progress' | 'done' | 'abandoned'
  priority    INTEGER DEFAULT 3,            -- 1=urgent, 2=high, 3=normal, 4=low
  due_date    TEXT,                         -- 'YYYY-MM-DD' or NULL
  tags        TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

-- ─── ideas ─────────────────────────────────────────────────────
-- Half-baked thoughts, side-project sparks. Separate from notes so
-- "all my open ideas" is one query, not a filtered tag search.
CREATE TABLE IF NOT EXISTS ideas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  body        TEXT,
  tags        TEXT,
  status      TEXT DEFAULT 'spark',         -- 'spark' | 'developing' | 'shipped' | 'shelved'
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ideas_created ON ideas(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_status  ON ideas(status);
