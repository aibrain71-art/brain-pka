-- D1 schema for books table — Phase 3 hybrid model + Phase 4c metadata.
-- Run once before any books-related migration. Idempotent (IF NOT EXISTS).
--
-- Phase 4c added 6 extra metadata columns (rating_count, format, edition,
-- series_name, series_position, categories). For a fresh D1 they ship in the
-- CREATE TABLE below. For an existing D1 they are added via the ALTER
-- statements at the bottom — each wrapped so re-runs are safe.

CREATE TABLE IF NOT EXISTS books (
    node_id          TEXT PRIMARY KEY,
    title            TEXT NOT NULL,
    author           TEXT,
    publication_year INTEGER,
    genre            TEXT,
    genre_canonical  TEXT,
    language         TEXT,
    isbn             TEXT,
    publisher        TEXT,
    page_count       INTEGER,
    average_rating   REAL,
    rating_count     INTEGER,
    format           TEXT,
    edition          TEXT,
    series_name      TEXT,
    series_position  INTEGER,
    categories       TEXT,
    purchase_link    TEXT,
    cover_image_url  TEXT,
    description      TEXT,
    description_source TEXT DEFAULT 'original',
    enriched_at      TEXT,
    created_at       TEXT DEFAULT (datetime('now')),
    updated_at       TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_books_genre_canonical ON books(genre_canonical);
CREATE INDEX IF NOT EXISTS idx_books_language        ON books(language);
CREATE INDEX IF NOT EXISTS idx_books_author          ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_series_name     ON books(series_name);

-- Phase 4c additive ALTERs — needed when migrating an existing D1 instance
-- that already has the phase-3 books table. D1 ignores duplicate-column
-- errors per-statement, so the apply_books_via_api.py runner just keeps
-- going. apply_books_via_api.py also catches and forgives the 'duplicate
-- column' error code so repeated runs stay green.
ALTER TABLE books ADD COLUMN rating_count INTEGER;
ALTER TABLE books ADD COLUMN format TEXT;
ALTER TABLE books ADD COLUMN edition TEXT;
ALTER TABLE books ADD COLUMN series_name TEXT;
ALTER TABLE books ADD COLUMN series_position INTEGER;
ALTER TABLE books ADD COLUMN categories TEXT;

-- Phase 4b: camera-based cover identification rate-limit. Stores the
-- Unix-epoch (seconds) of the most recent /identify-cover call so the
-- endpoint can throttle to max 1 call/minute per book without an extra
-- KV/Durable-Object dependency.
ALTER TABLE books ADD COLUMN last_identify_ts INTEGER;
