"""
Categorize cookbook recipes by parsing the cookbook's PDF index (Seiten 406-419)
and writing notes.related_topics for matched recipes.

Pipeline:
  1. Cookbook waehlen (oder einzig vorhandenes nehmen)
  2. PDF aus D1 holen (cookbook_chunks oder legacy pdf_b64)
  3. Index parsen (Seiten 406-419), Patterns wie "R0100 - R0108: Getraenke"
     → mapping recipe-nummer-range -> kategorie
  4. Alle notes mit note_type='recipe' holen, slug-nummer extrahieren,
     Kategorie matchen
  5. notes.related_topics als JSON setzen:
       ["rezept", "kategorie", "<spezifische-kategorie>"]
     Bei Recipes ohne Match: ["rezept", "kategorie"] (ohne spezifische)
  6. Report drucken

Tooling:
  - pdfplumber zuerst (Text-Layer-Extraction)
  - pytesseract als Fallback bei textlosem (gescanntem) PDF
  - Falls beide fehlen: klare Installations-Anweisung + exit(2)

CLI:
  python categorize_recipes_via_api.py            # default: --dry-run
  python categorize_recipes_via_api.py --dry-run  # zeigt 5 Sample-UPDATEs, schreibt nicht
  python categorize_recipes_via_api.py --apply    # fuehrt UPDATEs echt aus

Logical branch: recipe-categorize (no merge to main).
"""
from __future__ import annotations

import argparse
import io
import json
import re
import sys
from collections import Counter
from pathlib import Path

from cookbook_d1_helpers import (
    download_cookbook_pdf,
    pick_cookbook,
    prompt_token,
    query_d1,
    rows,
    fail_with,
)

HERE = Path(__file__).resolve().parent
INDEX_START_PAGE = 406  # 1-based, inclusive
INDEX_END_PAGE = 419    # 1-based, inclusive

# Index-pattern variants (German cookbook): "R0100 - R0108: Getraenke"
# Tolerant: dash/en-dash, optional spaces, optional colon/period.
# Recipe-nummer-range erkennt zwei R-Nummern.
INDEX_RANGE_RE = re.compile(
    r"R\s*(\d{3,5})\s*[-–—]\s*R\s*(\d{3,5})\s*[:\.–]?\s*(.+?)\s*$",
    re.IGNORECASE,
)
# Fallback for single-recipe lines: "R0123: Apfelkuchen" (without category-range)
# We deliberately do NOT use these for category mapping — they're per-recipe,
# not per-category. Kept here so future logic can extend if needed.

# Slugify a category name into a related_topics tag (ASCII-lowercase, hyphens).
_TAG_RE = re.compile(r"[^a-z0-9]+")


def slugify_category(s: str) -> str:
    import unicodedata

    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower().strip()
    s = _TAG_RE.sub("-", s).strip("-")
    return s[:60]


def extract_text_pdfplumber(pdf_bytes: bytes, page_range: tuple[int, int]) -> str:
    """Return text from the given 1-based inclusive page range using pdfplumber.

    Returns "" if pdfplumber isn't available — caller falls back to OCR.
    """
    try:
        import pdfplumber  # type: ignore
    except ImportError:
        return ""
    out = []
    start_0, end_0 = page_range[0] - 1, page_range[1] - 1
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        npages = len(pdf.pages)
        first = max(0, start_0)
        last = min(npages - 1, end_0)
        for i in range(first, last + 1):
            try:
                t = pdf.pages[i].extract_text() or ""
            except Exception:
                t = ""
            out.append(t)
    return "\n".join(out)


def extract_text_ocr(pdf_bytes: bytes, page_range: tuple[int, int]) -> str:
    """OCR-fallback using pdf2image + pytesseract. Returns "" if libs missing.

    Note: requires Tesseract.exe installed system-wide with 'German' language.
    """
    try:
        import pytesseract  # type: ignore
        from pdf2image import convert_from_bytes  # type: ignore
    except ImportError:
        return ""
    pages = convert_from_bytes(
        pdf_bytes,
        first_page=page_range[0],
        last_page=page_range[1],
        dpi=300,
    )
    out = []
    for img in pages:
        try:
            t = pytesseract.image_to_string(img, lang="deu")
        except Exception as e:
            print(f"  OCR-Warnung: {e}", flush=True)
            t = ""
        out.append(t)
    return "\n".join(out)


def print_tooling_help_and_exit() -> None:
    print("", flush=True)
    print("FEHLER: Konnte den Index nicht parsen.", flush=True)
    print("Weder pdfplumber noch pytesseract+pdf2image sind verfuegbar,", flush=True)
    print("oder der Index hat keinen Text-Layer und OCR fehlt.", flush=True)
    print("", flush=True)
    print("Installation:", flush=True)
    print("  pip install pdfplumber", flush=True)
    print("  pip install pytesseract pdf2image", flush=True)
    print("", flush=True)
    print("Plus Tesseract.exe + Poppler (Windows):", flush=True)
    print("  Tesseract: https://github.com/UB-Mannheim/tesseract/wiki", flush=True)
    print("             (im Installer 'German' Language Pack ankreuzen!)", flush=True)
    print("  Poppler:   https://github.com/oschwartz10612/poppler-windows/releases", flush=True)
    print("             (entpacken + bin/ in PATH legen)", flush=True)
    print("", flush=True)
    sys.exit(2)


# Owner-supplied recipe-number prefix → category map.
# Each prefix groups 100 R-numbers: R01XX = Getränke, R02XX = Suppen, etc.
# Categories without an MVS counterpart in owner's library are simply omitted.
R_PREFIX_TO_CATEGORY: dict[int, str] = {
    1:  "Getränke",
    2:  "Suppen",
    3:  "Saucen",
    4:  "Fleisch",
    5:  "Fischgerichte",
    6:  "Stärkebeilage",
    7:  "Gemüse",
    8:  "Salate",
    9:  "Nebenmahlzeiten",
    10: "Eintöpfe",
    11: "Teige und Süssspeisen",
    24: "MVS Fleischgerichte",
    26: "MVS Stärkebeilagen",   # gap (R25 = MVS Fischgerichte, doesn't exist per owner)
    27: "MVS Gemüse",
    29: "MVS Nebenmahlzeiten",
    30: "MVS Eintöpfe",
}


def _num_to_category(num: int) -> str | None:
    """Map an R-number (e.g. 419, 2412) to its category via its prefix."""
    prefix = num // 100
    return R_PREFIX_TO_CATEGORY.get(prefix)


# Alphabetical-index entry, e.g.
# "Rindfleisch Stroganoff . . . . . . . 136 . . . . . . . R0419"
_INDEX_ENTRY_RE = re.compile(r".+?\s+(\d{1,4})\s+[\s.]+R(\d{4})\s*$")


def parse_index(text: str) -> list[tuple[int, int, str]]:
    """Parse the alphabetical recipe index into (num, num, category) tuples.

    Each line in the index looks like "<title>  <page>  R<NNNN>". We only
    need the R-number — its 2-digit prefix dictates the category via
    R_PREFIX_TO_CATEGORY (page numbers are A6-format and not reliable).
    The (num, num, cat) tuple shape is kept so build_recipe_num_to_category()
    works unchanged.
    """
    out: list[tuple[int, int, str]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _INDEX_ENTRY_RE.match(line)
        if not m:
            continue
        rnum = int(m.group(2))
        cat = _num_to_category(rnum)
        if cat:
            out.append((rnum, rnum, cat))
    return out


def build_recipe_num_to_category(
    ranges: list[tuple[int, int, str]],
) -> dict[int, str]:
    """Expand index ranges into a per-number lookup.

    Later ranges win on overlap (so the cookbook's last word is authoritative).
    """
    lookup: dict[int, str] = {}
    for a, b, cat in ranges:
        lo, hi = min(a, b), max(a, b)
        for n in range(lo, hi + 1):
            lookup[n] = cat
    return lookup


_RECIPE_NUM_FROM_SLUG_RE = re.compile(r"r0*(\d+)", re.IGNORECASE)


def extract_recipe_num(slug: str, title: str) -> int | None:
    """Heuristic: find an R-number in slug first, then title.

    Slug examples: 'r0123-apfelkuchen', 'recipe-r0007-kafi'
    Title examples: 'R0123 Apfelkuchen', 'Apfelkuchen (R 123)'
    """
    for s in (slug or "", title or ""):
        m = _RECIPE_NUM_FROM_SLUG_RE.search(s)
        if m:
            try:
                return int(m.group(1))
            except ValueError:
                continue
    return None


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Categorize cookbook recipes via D1 REST API."
    )
    g = ap.add_mutually_exclusive_group()
    g.add_argument(
        "--dry-run",
        action="store_true",
        help="Zeigt nur Sample-UPDATEs, schreibt nicht (default).",
    )
    g.add_argument(
        "--apply",
        action="store_true",
        help="Fuehrt UPDATEs echt aus.",
    )
    args = ap.parse_args()
    apply_mode = bool(args.apply)
    # default = dry-run
    if not apply_mode and not args.dry_run:
        print("Modus: --dry-run (default). Mit --apply schreiben.", flush=True)

    token = prompt_token()

    print("", flush=True)
    print("Schritt 1/6: Cookbook waehlen", flush=True)
    cb = pick_cookbook(token)
    cb_id = cb["id"]

    print("", flush=True)
    print("Schritt 2/6: PDF aus D1 holen", flush=True)
    pdf_bytes = download_cookbook_pdf(token, cb_id)
    local_pdf = HERE / f"cookbook-{cb_id}.pdf"
    local_pdf.write_bytes(pdf_bytes)
    print(f"  Lokal gespeichert: {local_pdf} ({len(pdf_bytes)//1024} KB)", flush=True)

    print("", flush=True)
    print(
        f"Schritt 3/6: Index parsen (Seiten {INDEX_START_PAGE}-{INDEX_END_PAGE})",
        flush=True,
    )
    text = extract_text_pdfplumber(pdf_bytes, (INDEX_START_PAGE, INDEX_END_PAGE))
    if not text.strip():
        print("  pdfplumber leer -> versuche OCR (pytesseract+pdf2image)...", flush=True)
        text = extract_text_ocr(pdf_bytes, (INDEX_START_PAGE, INDEX_END_PAGE))
    if not text.strip():
        print_tooling_help_and_exit()
    ranges = parse_index(text)
    if not ranges:
        print("  WARNUNG: kein einziger Index-Eintrag matchte das Regex.", flush=True)
        print("  Erste 500 Zeichen extrahierter Text fuer Debugging:", flush=True)
        print("  " + text[:500].replace("\n", "\n  "), flush=True)
        return 1
    print(f"  {len(ranges)} Index-Eintraege erkannt. Beispiel:", flush=True)
    for r in ranges[:5]:
        print(f"    R{r[0]:04d} - R{r[1]:04d}: {r[2]}", flush=True)

    num_to_category = build_recipe_num_to_category(ranges)
    print(f"  -> {len(num_to_category)} R-Nummern abgedeckt.", flush=True)

    print("", flush=True)
    print("Schritt 4/6: Rezept-Notes aus D1 holen", flush=True)
    res = query_d1(
        token,
        "SELECT slug, title, related_topics FROM notes "
        "WHERE note_type='recipe' ORDER BY slug",
    )
    if not res.get("success"):
        fail_with("Konnte recipe-notes nicht laden.", res)
    recipes = rows(res)
    print(f"  {len(recipes)} Rezept-Notes gefunden.", flush=True)

    print("", flush=True)
    print("Schritt 5/6: Matching + UPDATE-Vorbereitung", flush=True)
    matched = 0
    unmatched: list[tuple[str, str]] = []
    updates: list[tuple[str, str]] = []  # (new_related_topics_json, slug)
    cat_counter: Counter[str] = Counter()

    for r in recipes:
        slug = r["slug"]
        title = r.get("title") or ""
        num = extract_recipe_num(slug, title)
        cat = num_to_category.get(num) if num is not None else None
        if cat:
            cat_tag = slugify_category(cat)
            tags = ["rezept", "kategorie", cat_tag]
            cat_counter[cat] += 1
            matched += 1
        else:
            tags = ["rezept", "kategorie"]
            unmatched.append((slug, title))
        updates.append((json.dumps(tags, ensure_ascii=False), slug))

    print(f"  Mit Kategorie: {matched}", flush=True)
    print(f"  Ohne Match:    {len(unmatched)}", flush=True)

    # Show 5 sample UPDATEs
    print("", flush=True)
    print("  Sample UPDATEs (erste 5):", flush=True)
    for new_json, slug in updates[:5]:
        print(f"    {slug:40s} -> {new_json}", flush=True)

    if not apply_mode:
        print("", flush=True)
        print("Schritt 6/6: Report (DRY-RUN, kein Schreiben)", flush=True)
        print(f"  Erfolgreich gematcht:    {matched}", flush=True)
        print(f"  Ohne Kategorie-Match:    {len(unmatched)}", flush=True)
        if unmatched:
            print("", flush=True)
            print("  Ungematchte (max 10):", flush=True)
            for slug, title in unmatched[:10]:
                print(f"    {slug:40s}  {title}", flush=True)
        print("", flush=True)
        print("  Top 5 Kategorien:", flush=True)
        for cat, n in cat_counter.most_common(5):
            print(f"    {n:4d}  {cat}", flush=True)
        print("", flush=True)
        print("Zum Schreiben erneut starten mit:", flush=True)
        print("  python categorize_recipes_via_api.py --apply", flush=True)
        return 0

    # APPLY MODE: execute UPDATEs in batches
    print("", flush=True)
    print(f"Schritt 6/6: UPDATEs ausfuehren ({len(updates)} rows)", flush=True)
    BATCH = 50
    ok, fail = 0, 0
    for i in range(0, len(updates), BATCH):
        batch = updates[i : i + BATCH]
        # D1 supports one statement per query when using params; we run them
        # individually for safety (related_topics JSON may contain quotes).
        for new_json, slug in batch:
            res = query_d1(
                token,
                "UPDATE notes SET related_topics = ? WHERE slug = ?",
                [new_json, slug],
            )
            if res.get("success"):
                ok += 1
            else:
                fail += 1
                errs = res.get("errors") or res
                print(f"  FAIL {slug}: {errs}", flush=True)
                if fail >= 5:
                    print("  Zu viele Fehler. Abbruch.", flush=True)
                    return 1
        print(f"  Batch {i+1:>4}-{i+len(batch):<4} done (running OK={ok} FAIL={fail})", flush=True)

    print("", flush=True)
    print("DONE.", flush=True)
    print(f"  Erfolgreich:       {ok}", flush=True)
    print(f"  Fehlgeschlagen:    {fail}", flush=True)
    print(f"  Mit Kategorie:     {matched}", flush=True)
    print(f"  Ohne Match:        {len(unmatched)}", flush=True)
    print("", flush=True)
    print("  Top 5 Kategorien:", flush=True)
    for cat, n in cat_counter.most_common(5):
        print(f"    {n:4d}  {cat}", flush=True)
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
