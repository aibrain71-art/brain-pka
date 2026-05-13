-- D1 schema for books table — Phase 3 hybrid model.
-- Run once before any books-related migration. Idempotent (IF NOT EXISTS).

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
