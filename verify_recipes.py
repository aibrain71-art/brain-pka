"""Verify: alle Kochbuch-Rezepte aus dem PDF-Index sind als Notes in D1?

Vergleicht:
  - R-Nummern aus dem PDF-Index (Seiten 406-419)
  - vs. slugs in notes WHERE note_type='recipe'

Output: missing (im PDF aber nicht in D1) + extras (in D1 aber nicht im PDF).
"""
from __future__ import annotations
import os, re, sys
from pathlib import Path

import pdfplumber

from cookbook_d1_helpers import prompt_token, query_d1, rows
from categorize_recipes_via_api import parse_index, build_recipe_num_to_category

PDF = Path(__file__).resolve().parent / "cookbook-1.pdf"
INDEX_PAGES = (406, 419)
_RNUM_RE = re.compile(r"r0*(\d+)", re.IGNORECASE)


def extract_num(s: str) -> int | None:
    if not s:
        return None
    m = _RNUM_RE.search(s)
    return int(m.group(1)) if m else None


def main() -> int:
    if not PDF.exists():
        print(f"FEHLER: {PDF.name} nicht gefunden. Erst categorize_recipes_via_api.py laufen lassen (lädt das PDF lokal).")
        return 2

    # 1) Index aus PDF parsen
    with pdfplumber.open(PDF) as pdf:
        text = "\n".join((pdf.pages[n].extract_text() or "") for n in range(INDEX_PAGES[0] - 1, INDEX_PAGES[1]))
    ranges = parse_index(text)
    num_to_cat = build_recipe_num_to_category(ranges)
    pdf_nums = set(num_to_cat.keys())
    print(f"PDF index:  {len(pdf_nums)} unique R-Nummern (Seiten {INDEX_PAGES[0]}-{INDEX_PAGES[1]})")

    # 2) D1 query
    token = prompt_token()
    res = query_d1(token, "SELECT slug, title FROM notes WHERE note_type='recipe' ORDER BY slug")
    recipes = rows(res)
    d1_data = []
    for r in recipes:
        num = extract_num(r["slug"]) or extract_num(r.get("title") or "")
        d1_data.append((num, r["slug"], r.get("title") or ""))
    d1_nums = {n for n, _, _ in d1_data if n is not None}
    d1_unmatched_slugs = [(slug, title) for n, slug, title in d1_data if n is None]
    print(f"D1 notes:   {len(recipes)} recipe-notes, davon {len(d1_nums)} mit erkennbarer R-Nummer + {len(d1_unmatched_slugs)} ohne R-Nummer im Slug")

    # 3) Vergleich
    missing = pdf_nums - d1_nums                       # im PDF, nicht in D1
    extras  = d1_nums - pdf_nums                       # in D1, aber nicht im PDF-Index
    common  = pdf_nums & d1_nums

    print(f"\n----- Bilanz -----")
    print(f"  Beide:           {len(common):>4}")
    print(f"  Nur PDF (missing in D1):  {len(missing):>4}")
    print(f"  Nur D1  (nicht im PDF):   {len(extras):>4}")

    if missing:
        print(f"\nFehlende R-Nummern (im PDF, nicht als Note in D1):")
        for n in sorted(missing):
            print(f"  R{n:04d} → {num_to_cat.get(n, '?')}")

    if extras:
        print(f"\nExtra D1-Notes (R-Nummern nicht im PDF-Index):")
        for n in sorted(extras):
            # Show title/slug for context
            ctx = next(((slug, title) for nx, slug, title in d1_data if nx == n), None)
            if ctx:
                print(f"  R{n:04d}: slug={ctx[0]}, title={ctx[1][:60]}")

    if d1_unmatched_slugs:
        print(f"\nD1 recipe-notes ohne R-Nummer im Slug ({len(d1_unmatched_slugs)} Stueck — manuell prüfen):")
        for slug, title in d1_unmatched_slugs[:20]:
            print(f"  slug={slug}, title={title[:60]}")
        if len(d1_unmatched_slugs) > 20:
            print(f"  ... +{len(d1_unmatched_slugs)-20} weitere.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
