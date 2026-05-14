"""Translate non-German book descriptions to German via Anthropic Claude.
Idempotent: skips books that already have German description.

Setup (once per session):
  $env:ANTHROPIC_API_KEY = "sk-ant-..."

Run:
  python translate_descriptions.py
  python translate_descriptions.py --dry-run   # see what would change
"""
from __future__ import annotations
import os, sys, json, sqlite3, argparse
from pathlib import Path
from urllib import request, error

DB = Path(r"C:\Users\cools\OneDrive - Familie Heiniger\Dokumente & Verträge - Documents\General\my-ai-team\PKM\mypka.db")
MODEL = "claude-sonnet-4-6"
API = "https://api.anthropic.com/v1/messages"
BATCH_SIZE = 1  # one book per API call — avoids unescaped-quote JSON breakage

DE_MARKERS = (' und ', ' der ', ' die ', ' das ', ' ein ', ' eine ', ' ist ', ' wird ',
              ' sich ', ' nicht ', ' oder ', ' mit ', ' bei ', ' fuer ', ' für ', ' auch ', ' wie ')
EN_MARKERS = (' the ', ' and ', ' is ', ' of ', ' to ', ' in ', ' with ', ' for ', ' as ', ' by ', ' that ')

def is_german(text: str) -> bool:
    t = ' ' + text.lower() + ' '
    de = sum(1 for m in DE_MARKERS if m in t)
    en = sum(1 for m in EN_MARKERS if m in t)
    return de > en

def call_claude(api_key: str, books: list[dict]) -> dict[str, str]:
    """Send a batch to Claude. Returns {node_id: translated_description}."""
    items = "\n\n".join([
        f"[{b['node_id']}] Titel: {b['title']} — Autor: {b['author'] or '?'}\nBeschreibung (en): {b['description']}"
        for b in books
    ])
    prompt = (
        "Übersetze die folgenden englischen Buchbeschreibungen ins Deutsche. "
        "Bewahre Stil und Tonfall. Halte die Länge ähnlich (nicht aufblähen, nicht kürzen). "
        "Verwende natürliches Hochdeutsch (kein Schweizerdeutsch, keine Anglizismen wo Deutsch existiert). "
        "Bewahre den Buchtitel im Original (z.B. 'Swiss Made'), übersetze nur den Beschreibungstext.\n\n"
        "**WICHTIG für gültiges JSON:** Verwende im Beschreibungstext AUSSCHLIESSLICH französische "
        "Guillemets («...») oder einfache Anführungszeichen ('...') für Zitate und Hervorhebungen. "
        "Verwende NIEMALS gerade doppelte Anführungszeichen (\") oder deutsche Anführungszeichen («„...\"»). "
        "Beispiel: «Die Kunst des Krieges» statt \"Die Kunst des Krieges\".\n\n"
        f"{items}\n\n"
        "Antworte als JSON-Objekt mit der Form: {\"node_id_1\": \"deutsche Übersetzung\", ...}. "
        "Nur das JSON, kein zusätzlicher Text."
    )
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 8000,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")
    req = request.Request(API, data=body, method="POST")
    req.add_header("x-api-key", api_key)
    req.add_header("anthropic-version", "2023-06-01")
    req.add_header("Content-Type", "application/json")
    try:
        with request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
    except error.HTTPError as e:
        print(f"  HTTP {e.code} error: {e.read().decode()[:500]}")
        return {}
    except Exception as e:
        print(f"  Network error: {type(e).__name__}: {e}")
        return {}
    # Defensive extraction
    if "error" in data:
        print(f"  API error: {data['error']}")
        return {}
    if "content" not in data or not data["content"]:
        print(f"  Unexpected response shape: {json.dumps(data)[:500]}")
        return {}
    text = data["content"][0].get("text", "").strip()
    if not text:
        print(f"  Empty text in response")
        return {}
    # Strip markdown fences if Claude added them
    if text.startswith("```"):
        # Split on first ``` and take after, then drop any trailing ```
        parts = text.split("```")
        if len(parts) >= 2:
            text = parts[1]
            if text.startswith("json"):
                text = text[4:].lstrip()
            # Remove trailing closing fence
            if text.endswith("```"):
                text = text[:-3].rstrip()
    try:
        result = json.loads(text)
        print(f"  Parsed {len(result)} translations from batch")
        return result
    except json.JSONDecodeError as e:
        print(f"  JSON parse failed: {e}")
        print(f"  Raw (first 400 chars): {text[:400]}")
        return {}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ANTHROPIC_API_KEY nicht gesetzt.")
        print("Holst du dir bei https://console.anthropic.com/settings/keys")
        api_key = input("Key einfuegen + Enter: ").strip()
        if not api_key:
            sys.exit(2)

    conn = sqlite3.connect(DB)
    c = conn.cursor()
    rows = c.execute("SELECT node_id, title, author, description FROM books WHERE description IS NOT NULL").fetchall()
    todo = [{"node_id": r[0], "title": r[1], "author": r[2], "description": r[3]}
            for r in rows if not is_german(r[3])]
    print(f"Found {len(todo)} non-German descriptions out of {len(rows)} total")
    if args.dry_run:
        for b in todo[:5]:
            print(f"  • {b['title']}: {b['description'][:80]}…")
        print("... (dry-run, no DB writes)")
        return

    updated = 0
    for i in range(0, len(todo), BATCH_SIZE):
        batch = todo[i:i+BATCH_SIZE]
        print(f"\nBatch {i+1}-{i+len(batch)}/{len(todo)} (Claude…)", flush=True)
        translations = call_claude(api_key, batch)
        for b in batch:
            tr = translations.get(b["node_id"])
            if not tr:
                print(f"  ✗ {b['title']}: no translation")
                continue
            c.execute(
                "UPDATE books SET description=?, description_source='claude-translated-de', updated_at=datetime('now') WHERE node_id=?",
                (tr, b["node_id"]),
            )
            updated += 1
            print(f"  ✓ {b['title']}: {tr[:60]}…")
        conn.commit()

    print(f"\nDONE. Translated: {updated}/{len(todo)}")
    conn.close()

if __name__ == "__main__":
    main()
