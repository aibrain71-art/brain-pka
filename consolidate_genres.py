# Run only after Larry approves the mapping with the Owner.
# Apply:   python consolidate_genres.py --apply
# Preview: python consolidate_genres.py            (dry-run, default)
#
# Phase 3b — genre consolidation.
#
# Today's `books.genre_canonical` column has ~34 distinct values, many of
# which are siblings ("finance/economics" vs "economics" vs "business &
# economics" vs "finance/investment" — all the same shelf in real life).
# The UI's genre filter is too noisy as a result. This script applies
# Larry's proposed consolidation (34 → 17 buckets) by rewriting
# genre_canonical via the GENRE_CANONICAL mapping below. The original
# `genre` column is left untouched so the raw label survives.
#
# Idempotent: re-running maps already-canonical values to themselves
# (because every value in the dict's RHS appears as a key too).
#
# After --apply, you should re-run:
#   python migrate_books_to_hybrid.py --emit-d1
#   pwsh ./apply-books-to-d1.ps1
# to push the new related_topics into D1 (the shadow-notes' related_topics
# array is built from genre_canonical).
#
# Status: mapping pending Owner approval. The dict below is Larry's
# proposal — adjust freely before --apply.

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
DEFAULT_DB = HERE / "mypka.db"


# Mapping: raw genre_canonical (lowercased) → consolidated canonical.
# Anything not in this map is left untouched so the dry-run report
# surfaces it for the Owner to decide.
GENRE_CANONICAL = {
    'non-fiction': 'non-fiction',
    'comics': 'comics', 'comic': 'comics',
    'thriller': 'thriller', 'techno thriller': 'thriller', 'military fiction': 'thriller',
    'finance': 'finance', 'finance/economics': 'finance', 'economics': 'finance',
    'business & economics': 'finance', 'business/economics': 'finance',
    'finance/investment': 'finance', 'technical analysis': 'finance',
    'science': 'science', 'non fiction, science': 'science',
    'science, education, humor': 'science', 'mathematics': 'science',
    'history': 'history', 'military history': 'history', 'aviation history': 'history',
    'business': 'business', 'business strategy': 'business',
    'business/personal development': 'business',
    'biography': 'biography',
    "children's literature": "children's-literature",
    'reference': 'reference', 'manners and etiquette': 'reference',
    'self-help': 'self-help',
    'health': 'health',
    'mythology': 'mythology',
    'political science': 'political-science',
    'legal': 'legal',
    'sports': 'sports',
    'horror': 'horror',
    'military': 'history',  # militärische Sachbücher → history
}


def normalize_key(s: str) -> str:
    """Lowercased, whitespace-collapsed lookup key. Matches the dict's RHS style."""
    return ' '.join((s or '').lower().split())


def plan(db_path: Path) -> list[tuple[str, str, int]]:
    """Return a list of (current_canonical, proposed_canonical, row_count)
    for every distinct current value. row_count is how many books carry it."""
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT genre_canonical, COUNT(*) AS n FROM books "
            "WHERE genre_canonical IS NOT NULL "
            "GROUP BY genre_canonical ORDER BY n DESC, genre_canonical ASC"
        ).fetchall()
    finally:
        conn.close()
    plan_rows = []
    for current, n in rows:
        proposed = GENRE_CANONICAL.get(normalize_key(current), current)  # unmapped → keep
        plan_rows.append((current, proposed, n))
    return plan_rows


def apply(db_path: Path) -> dict:
    """Rewrite genre_canonical in-place. Returns a stats dict."""
    conn = sqlite3.connect(db_path)
    stats = {'updated_rows': 0, 'distinct_before': 0, 'distinct_after': 0, 'unmapped': []}
    try:
        # snapshot for "before" count
        before = conn.execute(
            "SELECT COUNT(DISTINCT genre_canonical) FROM books WHERE genre_canonical IS NOT NULL"
        ).fetchone()[0]
        stats['distinct_before'] = before

        rows = conn.execute(
            "SELECT node_id, genre_canonical FROM books WHERE genre_canonical IS NOT NULL"
        ).fetchall()
        for node_id, current in rows:
            target = GENRE_CANONICAL.get(normalize_key(current))
            if target is None:
                stats['unmapped'].append(current)
                continue
            if target != current:
                conn.execute(
                    "UPDATE books SET genre_canonical = ?, updated_at = datetime('now') "
                    "WHERE node_id = ?",
                    (target, node_id),
                )
                stats['updated_rows'] += 1
        conn.commit()

        after = conn.execute(
            "SELECT COUNT(DISTINCT genre_canonical) FROM books WHERE genre_canonical IS NOT NULL"
        ).fetchone()[0]
        stats['distinct_after'] = after
    finally:
        conn.close()
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description="Consolidate books.genre_canonical (34 → 17).")
    ap.add_argument("--apply", action="store_true",
                    help="Actually write to the DB. Without this flag the script is a dry-run.")
    ap.add_argument("--db", default=str(DEFAULT_DB), help="Path to mypka.db. Default: PKM/mypka.db")
    args = ap.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        sys.stderr.write(f"ERROR: db not found: {db_path}\n")
        return 2

    if not args.apply:
        # Dry-run: print the plan and exit.
        print(f"DRY-RUN — no writes. DB: {db_path}")
        print(f"Mapping size: {len(GENRE_CANONICAL)} entries")
        print()
        print(f"{'current':<40}  {'→':^3}  {'proposed':<28}  {'rows':>4}")
        print('-' * 84)
        proposed_distinct = set()
        unmapped = []
        for current, proposed, n in plan(db_path):
            mark = '' if proposed != current else '·'
            print(f"{(current or '<NULL>'):<40}  {'→':^3}  {proposed:<28}  {n:>4} {mark}")
            proposed_distinct.add(proposed)
            if normalize_key(current) not in GENRE_CANONICAL:
                unmapped.append(current)
        print()
        print(f"After consolidation: {len(proposed_distinct)} distinct canonical values.")
        if unmapped:
            print(f"Unmapped (kept as-is): {len(unmapped)}")
            for u in unmapped:
                print(f"  - {u}")
        print()
        print("To apply: python consolidate_genres.py --apply")
        return 0

    # --apply: write
    stats = apply(db_path)
    print(f"Applied. distinct_before={stats['distinct_before']} "
          f"distinct_after={stats['distinct_after']} "
          f"updated_rows={stats['updated_rows']}")
    if stats['unmapped']:
        print(f"  Unmapped (skipped): {len(stats['unmapped'])}")
        for u in sorted(set(stats['unmapped'])):
            print(f"    - {u}")
    print()
    print("Next steps (manual):")
    print("  python migrate_books_to_hybrid.py --emit-d1")
    print("  pwsh ./apply-books-to-d1.ps1")
    return 0


if __name__ == "__main__":
    sys.exit(main())
