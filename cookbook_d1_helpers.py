"""
Shared helpers for cookbook-related D1 REST-API scripts.

Used by:
  - categorize_recipes_via_api.py
  - ocr_cookbook_pdf.py

Pattern mirrors apply_books_via_api.py: interactive token prompt, hardcoded
account-id + database-id, urllib-based REST calls. No external HTTP deps.

D1 REST docs:
  https://developers.cloudflare.com/d1/platform/client-api/#run-a-query

Logical branch: recipe-categorize (no merge to main).
"""
from __future__ import annotations

import json
import os
import sys
from urllib import request, error

# Both hardcoded from apply_books_via_api.py — not secrets.
DB_ID = "9a27139f-af63-4fa2-8eb5-6c999ca86e7a"
ACCOUNT_ID = "3af0e1f1492b1d19c9553c418007ab04"

# Chunk-size for cookbook PDF re-upload. Mirrors functions/_lib/pdf-chunks.js
# (CHUNK_SIZE = 700 * 1024 base64 chars ≈ 525 KB binary per row).
CHUNK_SIZE = 700 * 1024


def prompt_token() -> str:
    """Interactive token prompt — mirrors apply_books_via_api.py exactly.

    Reads CLOUDFLARE_API_TOKEN env var first, falls back to interactive input.
    Exits with code 2 if no token is supplied. NEVER logs or echoes the token.
    """
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if token:
        return token.strip()
    print("Cloudflare API Token wird gebraucht.", flush=True)
    print("Falls noch nicht: https://dash.cloudflare.com/profile/api-tokens", flush=True)
    print("Custom Token -> Account: D1: Edit -> Create", flush=True)
    print(flush=True)
    token = input("Token einfuegen + Enter: ").strip()
    if not token:
        print("Kein Token. Abbruch.", flush=True)
        sys.exit(2)
    return token


def query_d1(token: str, sql: str, params: list | None = None) -> dict:
    """POST to D1 /query endpoint with optional parameter binding.

    Returns the parsed JSON response (dict with "success", "result", "errors").
    On HTTPError still parses + returns the body so callers can read .errors.
    """
    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
        f"/d1/database/{DB_ID}/query"
    )
    body: dict = {"sql": sql}
    if params is not None:
        body["params"] = params
    req = request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
    )
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())
    except error.HTTPError as e:
        # Parse the body so callers see structured errors instead of 4xx text
        try:
            return json.loads(e.read())
        except Exception:
            return {"success": False, "errors": [{"message": f"HTTP {e.code}"}]}


def rows(result: dict) -> list[dict]:
    """Extract result rows from a D1 REST response. Returns [] on failure."""
    if not result.get("success"):
        return []
    arr = result.get("result") or []
    if not arr:
        return []
    return arr[0].get("results") or []


def fail_with(msg: str, result: dict | None = None) -> None:
    """Print a friendly error + dump the D1 response, then exit(1)."""
    print(f"FEHLER: {msg}", flush=True)
    if result is not None:
        errs = result.get("errors") or result
        print(f"  D1-Antwort: {errs}", flush=True)
    sys.exit(1)


def pick_cookbook(token: str) -> dict:
    """List cookbooks; if only one, return it; else prompt for a pick.

    Returns the chosen cookbook dict with id, slug, title, pdf_size_kb,
    page_count.
    """
    res = query_d1(
        token,
        "SELECT id, slug, title, pdf_size_kb, page_count FROM cookbooks ORDER BY id",
    )
    cb_rows = rows(res)
    if not cb_rows:
        fail_with("Keine Cookbooks in D1 gefunden.", res)
    if len(cb_rows) == 1:
        cb = cb_rows[0]
        print(
            f"Cookbook: {cb['title']} (id={cb['id']}, "
            f"{cb.get('pdf_size_kb') or '?'} KB, "
            f"{cb.get('page_count') or '?'} Seiten)",
            flush=True,
        )
        return cb
    print("Mehrere Cookbooks gefunden:", flush=True)
    for i, cb in enumerate(cb_rows, start=1):
        print(
            f"  {i}: {cb['title']} (id={cb['id']}, "
            f"{cb.get('pdf_size_kb') or '?'} KB, "
            f"{cb.get('page_count') or '?'} Seiten)",
            flush=True,
        )
    while True:
        choice = input(f"Pick 1-{len(cb_rows)}: ").strip()
        if choice.isdigit() and 1 <= int(choice) <= len(cb_rows):
            return cb_rows[int(choice) - 1]
        print("Ungueltige Eingabe.", flush=True)


def download_cookbook_pdf(token: str, cookbook_id: int) -> bytes:
    """Reassemble a cookbook's PDF bytes from D1.

    Tries cookbook_chunks first (preferred). Falls back to the legacy
    cookbooks.pdf_b64 column for small old uploads. Returns raw PDF bytes.
    """
    import base64

    # Preferred path: chunked storage
    res = query_d1(
        token,
        "SELECT data_b64 FROM cookbook_chunks WHERE cookbook_id = ? ORDER BY idx ASC",
        [cookbook_id],
    )
    chunk_rows = rows(res)
    if chunk_rows:
        b64 = "".join(r["data_b64"] for r in chunk_rows)
        print(f"  PDF aus {len(chunk_rows)} Chunks zusammengesetzt.", flush=True)
        return base64.b64decode(b64)

    # Legacy path: single-row pdf_b64
    res = query_d1(
        token,
        "SELECT pdf_b64 FROM cookbooks WHERE id = ?",
        [cookbook_id],
    )
    legacy_rows = rows(res)
    if legacy_rows and legacy_rows[0].get("pdf_b64"):
        b64 = legacy_rows[0]["pdf_b64"]
        print("  PDF aus Legacy-Spalte cookbooks.pdf_b64 geladen.", flush=True)
        return base64.b64decode(b64)

    fail_with(f"Keine PDF-Daten fuer cookbook_id={cookbook_id} in D1 gefunden.")
    return b""  # unreachable, pleases type-checkers
