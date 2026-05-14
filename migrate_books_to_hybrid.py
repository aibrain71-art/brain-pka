"""
Phase 3a — Books → Hybrid (typed table + shadow-notes + people + topics).

Reads `books` from mypka.db and writes (idempotently):
  • one row per author in `people` (slug, full_name, role_context='Author')
  • one shadow `notes` row per book (slug=`book-<node_id>`, note_type='book',
    related_people=[author-slugs], related_topics=[genre-slug])
  • (topics are NOT a table — they live as JSON-arrays in notes.related_topics)

Idempotent: re-runs use INSERT OR IGNORE for people and INSERT OR REPLACE
for shadow-notes (so re-enrichment of a book updates the note body too).

Usage (local):
    python migrate_books_to_hybrid.py             # apply to mypka.db
    python migrate_books_to_hybrid.py --dry-run   # show counts, no writes
    python migrate_books_to_hybrid.py --emit-d1   # write D1 .sql files

Sync strategy:
This script doubles as the sync function. Call it at the end of every
`enrich_books.py` run (or any books-mutating job) to keep the shadow-notes
and author-people consistent with the canonical `books` table.

Author-string splitting rules:
  Separators (in priority order): " / ", "; ", ", ", " and ", " und ", " & ".
  Placeholders (filtered out, never become people):
    "Autor unbekannt", "Autor nicht eindeutig", "Autor/Hrsg. nicht erkennbar",
    and any author starting with "Autor" + non-letter.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).parent
LOCAL_DB = HERE / "mypka.db"
D1_SCHEMA_OUT = HERE / "schema-books.sql"           # always-safe schema file
D1_BOOKS_OUT = HERE / "migration-books.sql"         # books table data
D1_NOTES_OUT = HERE / "migration-notes-books.sql"   # shadow-notes data
D1_PEOPLE_OUT = HERE / "migration-people-authors.sql"  # author people data


# Phase 4c columns the enrich pipeline now writes. Added here (not in
# enrich_books.py) so any owner-side migration helper produces the same DDL
# regardless of which script ran first. Idempotent via PRAGMA-guarded loop.
PHASE4C_COLUMNS: list[tuple[str, str]] = [
    ("rating_count", "INTEGER"),
    ("format", "TEXT"),
    ("edition", "TEXT"),
    ("series_name", "TEXT"),
    ("series_position", "INTEGER"),
    ("categories", "TEXT"),  # JSON-array
    ("last_identify_ts", "INTEGER"),  # phase-4b camera rate-limit (unix epoch seconds)
]


def ensure_phase4c_columns(db: sqlite3.Connection) -> list[str]:
    """Add the phase-4c metadata columns to books if missing. Returns the list
    of columns that were actually added (for logging)."""
    cols = {row[1] for row in db.execute("PRAGMA table_info(books)").fetchall()}
    added: list[str] = []
    for name, typ in PHASE4C_COLUMNS:
        if name not in cols:
            db.execute(f"ALTER TABLE books ADD COLUMN {name} {typ}")
            added.append(name)
    if added:
        db.commit()
    return added


# ─── helpers ──────────────────────────────────────────────────────

# Order matters: longest/most-specific first so we don't fragment names.
# We split on whitespace-padded separators only, so "Aaron Smith / Jane Doe"
# splits but "TCP/IP" wouldn't (only " / " with spaces).
_SEPARATOR_RE = re.compile(r"\s*(?:/|;|,| and | und | & )\s*", re.IGNORECASE)

_PLACEHOLDER_RE = re.compile(
    r"^autor(\b|/|\s).*\b(unbekannt|nicht\s+eindeutig|nicht\s+erkennbar)",
    re.IGNORECASE,
)


def is_placeholder_author(s: str) -> bool:
    """True if the whole author string is a 'unknown author' placeholder."""
    s = s.strip()
    return bool(_PLACEHOLDER_RE.match(s))


def slugify(s: str) -> str:
    """Mirror of the JS slugify in functions/api/notes.js. ASCII-fold, lowercase,
    non-alphanum → hyphen, trim hyphens, max 80 chars."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s[:80]


def split_authors(author_str: str) -> list[str]:
    """Split a books.author cell into individual author names. Empty list for
    placeholders or unparseable input."""
    if not author_str:
        return []
    s = author_str.strip()
    if not s or is_placeholder_author(s):
        return []
    parts = _SEPARATOR_RE.split(s)
    cleaned = []
    for p in parts:
        p = p.strip().strip(",.;/")
        if not p or is_placeholder_author(p):
            continue
        # Trailing role-tag like "(Hrsg.)" — strip parens-blocks
        p = re.sub(r"\s*\([^)]*\)\s*$", "", p).strip()
        if not p:
            continue
        cleaned.append(p)
    return cleaned


def sql_quote(v) -> str:
    """Escape a value for inline SQL output. Returns 'NULL' for None."""
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


# ─── main migration ──────────────────────────────────────────────


def collect_authors(db: sqlite3.Connection) -> dict[str, str]:
    """Return {slug: full_name} for every distinct, non-placeholder author."""
    out: dict[str, str] = {}
    rows = db.execute(
        "SELECT DISTINCT author FROM books WHERE author IS NOT NULL"
    ).fetchall()
    for (raw,) in rows:
        for name in split_authors(raw):
            slug = slugify(name)
            if not slug:
                continue
            # First-seen full_name wins; people-merging is an Owner task later.
            out.setdefault(slug, name)
    return out


def book_to_note(book: sqlite3.Row, author_slug_map: dict[str, str]) -> dict:
    """Build the shadow-note row for one book."""
    author_slugs = []
    if book["author"]:
        for name in split_authors(book["author"]):
            slug = slugify(name)
            if slug:
                author_slugs.append(slug)

    # Every book-note carries three topic tags:
    #   - "buch"             — universal container (links all 114 books in graph)
    #   - "genre"            — universal genre container
    #   - "<specific-genre>" — the specific genre slug (e.g. "comics", "thriller")
    topic_slugs: list[str] = ["buch", "genre"]
    if book["genre_canonical"]:
        gslug = slugify(book["genre_canonical"])
        if gslug and gslug not in topic_slugs:
            topic_slugs.append(gslug)

    return {
        "slug": f"book-{book['node_id']}",
        "title": book["title"],
        "body": book["description"] or "",
        "note_type": "book",
        "related_people": json.dumps(author_slugs, ensure_ascii=False),
        "related_topics": json.dumps(topic_slugs, ensure_ascii=False),
        "source_journal_id": None,
        "created_at": book["created_at"],
    }


def apply_local(db: sqlite3.Connection, dry_run: bool = False) -> dict:
    """Apply the hybrid migration to the local SQLite DB. Returns stats."""
    # Make sure the phase-4c metadata columns exist before we read/write any
    # books row. ALTERing on dry-run is fine — it's idempotent and the writes
    # below are still gated on dry_run.
    if not dry_run:
        ensure_phase4c_columns(db)
    authors = collect_authors(db)

    if dry_run:
        sys.stderr.write(f"[dry-run] would insert {len(authors)} people\n")
    else:
        for slug, full_name in authors.items():
            db.execute(
                "INSERT OR IGNORE INTO people (slug, full_name, role_context) "
                "VALUES (?, ?, ?)",
                (slug, full_name, "Author"),
            )

    books = db.execute(
        "SELECT node_id, title, author, description, genre_canonical, created_at "
        "FROM books"
    ).fetchall()

    shadow_count = 0
    for book in books:
        note = book_to_note(book, authors)
        if dry_run:
            shadow_count += 1
            continue
        # INSERT OR REPLACE keyed on slug — note: slug is UNIQUE, id is PK and
        # auto-increments. Replace path: delete old by slug, insert new.
        existing = db.execute(
            "SELECT id FROM notes WHERE slug = ?", (note["slug"],)
        ).fetchone()
        if existing:
            db.execute(
                "UPDATE notes SET title=?, body=?, note_type=?, "
                "related_people=?, related_topics=?, source_journal_id=?, "
                "created_at=? WHERE slug=?",
                (
                    note["title"],
                    note["body"],
                    note["note_type"],
                    note["related_people"],
                    note["related_topics"],
                    note["source_journal_id"],
                    note["created_at"],
                    note["slug"],
                ),
            )
        else:
            db.execute(
                "INSERT INTO notes (slug, title, body, note_type, "
                "related_people, related_topics, source_journal_id, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    note["slug"],
                    note["title"],
                    note["body"],
                    note["note_type"],
                    note["related_people"],
                    note["related_topics"],
                    note["source_journal_id"],
                    note["created_at"],
                ),
            )
        shadow_count += 1

    if not dry_run:
        db.commit()

    # Distinct genres (topic-slugs implicit via JSON array, no table)
    topics = {
        slugify(r[0])
        for r in db.execute(
            "SELECT DISTINCT genre_canonical FROM books "
            "WHERE genre_canonical IS NOT NULL"
        )
        if slugify(r[0])
    }

    return {
        "books": len(books),
        "shadow_notes": shadow_count,
        "authors_people": len(authors),
        "topics_distinct": len(topics),
    }


def emit_d1(db: sqlite3.Connection, stats: dict) -> dict:
    """Write the four D1 .sql files. schema-books.sql is committed; the three
    migration-*.sql files are data-only and gitignored."""

    # ── 1. schema-books.sql (committed)
    schema_sql = """-- D1 schema for books table — Phase 3 hybrid model + Phase 4c metadata.
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
    last_identify_ts INTEGER,
    purchase_link    TEXT,
    cover_image_url  TEXT,
    description      TEXT,
    description_source TEXT DEFAULT 'original',
    enriched_at      TEXT,
    created_at       TEXT DEFAULT (datetime('now')),
    updated_at       TEXT DEFAULT (datetime('now'))
);

-- Phase 4c additive ALTERs — MUST run BEFORE CREATE INDEX on series_name
-- so existing Phase-3 D1 instances get the column added first.
-- apply_books_via_api.py catches & forgives 'duplicate column' on re-runs.
ALTER TABLE books ADD COLUMN rating_count INTEGER;
ALTER TABLE books ADD COLUMN format TEXT;
ALTER TABLE books ADD COLUMN edition TEXT;
ALTER TABLE books ADD COLUMN series_name TEXT;
ALTER TABLE books ADD COLUMN series_position INTEGER;
ALTER TABLE books ADD COLUMN categories TEXT;
ALTER TABLE books ADD COLUMN last_identify_ts INTEGER;

CREATE INDEX IF NOT EXISTS idx_books_genre_canonical ON books(genre_canonical);
CREATE INDEX IF NOT EXISTS idx_books_language        ON books(language);
CREATE INDEX IF NOT EXISTS idx_books_author          ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_series_name     ON books(series_name);
"""
    D1_SCHEMA_OUT.write_text(schema_sql, encoding="utf-8")

    # ── 2. migration-books.sql (data)
    # Phase 4c added rating_count/format/edition/series_name/series_position/
    # categories. Older local DBs may not have those columns yet — make sure
    # the ALTERs ran (idempotent) before selecting.
    ensure_phase4c_columns(db)
    rows = db.execute(
        "SELECT node_id, title, author, publication_year, genre, "
        "genre_canonical, language, isbn, publisher, page_count, "
        "average_rating, rating_count, format, edition, series_name, "
        "series_position, categories, purchase_link, cover_image_url, "
        "description, description_source, enriched_at, created_at, updated_at "
        "FROM books"
    ).fetchall()

    book_lines = [
        "-- Auto-generated by migrate_books_to_hybrid.py --emit-d1",
        f"-- {len(rows)} books from mypka.db (Phase 4c schema)",
        "BEGIN TRANSACTION;",
    ]
    for r in rows:
        book_lines.append(
            "INSERT OR REPLACE INTO books "
            "(node_id, title, author, publication_year, genre, genre_canonical, "
            "language, isbn, publisher, page_count, average_rating, rating_count, "
            "format, edition, series_name, series_position, categories, "
            "purchase_link, cover_image_url, description, description_source, "
            "enriched_at, created_at, updated_at) VALUES ("
            + ", ".join(sql_quote(c) for c in r)
            + ");"
        )
    book_lines.append("COMMIT;\n")
    D1_BOOKS_OUT.write_text("\n".join(book_lines), encoding="utf-8")

    # ── 3. migration-people-authors.sql
    authors = collect_authors(db)
    people_lines = [
        "-- Auto-generated by migrate_books_to_hybrid.py --emit-d1",
        f"-- {len(authors)} authors → people",
        "BEGIN TRANSACTION;",
    ]
    for slug, full_name in sorted(authors.items()):
        people_lines.append(
            "INSERT OR IGNORE INTO people (slug, full_name, role_context) "
            f"VALUES ({sql_quote(slug)}, {sql_quote(full_name)}, 'Author');"
        )
    people_lines.append("COMMIT;\n")
    D1_PEOPLE_OUT.write_text("\n".join(people_lines), encoding="utf-8")

    # ── 4. migration-notes-books.sql (shadow-notes)
    books = db.execute(
        "SELECT node_id, title, author, description, genre_canonical, created_at "
        "FROM books"
    ).fetchall()
    notes_lines = [
        "-- Auto-generated by migrate_books_to_hybrid.py --emit-d1",
        f"-- {len(books)} shadow-notes (note_type='book')",
        "BEGIN TRANSACTION;",
    ]
    for book in books:
        note = book_to_note(book, authors)
        # Use INSERT OR REPLACE keyed on slug (slug is UNIQUE in D1 too).
        # Body/title may change on re-enrichment — replace keeps things consistent.
        notes_lines.append(
            "INSERT OR REPLACE INTO notes "
            "(slug, title, body, note_type, related_people, related_topics, "
            "source_journal_id, created_at) VALUES ("
            f"{sql_quote(note['slug'])}, {sql_quote(note['title'])}, "
            f"{sql_quote(note['body'])}, {sql_quote(note['note_type'])}, "
            f"{sql_quote(note['related_people'])}, "
            f"{sql_quote(note['related_topics'])}, "
            f"{sql_quote(note['source_journal_id'])}, "
            f"{sql_quote(note['created_at'])});"
        )
    notes_lines.append("COMMIT;\n")
    D1_NOTES_OUT.write_text("\n".join(notes_lines), encoding="utf-8")

    return {
        "schema": str(D1_SCHEMA_OUT),
        "books": str(D1_BOOKS_OUT),
        "people": str(D1_PEOPLE_OUT),
        "notes": str(D1_NOTES_OUT),
        "stats": stats,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="no writes, print counts only")
    ap.add_argument("--emit-d1", action="store_true", help="also write D1 .sql files")
    args = ap.parse_args()

    if not LOCAL_DB.exists():
        sys.stderr.write(f"ERROR: {LOCAL_DB} not found\n")
        return 1

    db = sqlite3.connect(LOCAL_DB)
    db.row_factory = sqlite3.Row
    try:
        stats = apply_local(db, dry_run=args.dry_run)
        sys.stderr.write(
            f"[local] books={stats['books']} "
            f"shadow_notes={stats['shadow_notes']} "
            f"authors_people={stats['authors_people']} "
            f"topics_distinct={stats['topics_distinct']}\n"
        )

        if args.emit_d1:
            out = emit_d1(db, stats)
            sys.stderr.write("[d1] wrote:\n")
            for k, v in out.items():
                if k != "stats":
                    sys.stderr.write(f"  {k}: {v}\n")
    finally:
        db.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
