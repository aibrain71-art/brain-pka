"""
Apply Pax's cover audit corrections to mypka.db.
Reads cover-audit-100books.json, applies UPDATEs for action='update' rows.
Idempotent: re-runs are safe.
"""
from __future__ import annotations
import json, sqlite3
from pathlib import Path

JSON_PATH = Path(r"C:\Users\cools\OneDrive - Familie Heiniger\Dokumente & Verträge - Documents\General\my-ai-team\Deliverables\books-cover-audit-2026-05-13\cover-audit-100books.json")
DB = Path(r"C:\Users\cools\OneDrive - Familie Heiniger\Dokumente & Verträge - Documents\General\my-ai-team\PKM\mypka.db")

def main():
    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    print(f"Loaded {len(data)} records from Pax audit")

    conn = sqlite3.connect(DB)
    c = conn.cursor()

    updated = 0
    fields_touched = {"cover_image_url": 0, "isbn": 0, "author": 0, "publisher": 0, "publication_year": 0, "description": 0}

    for r in data:
        action = r.get("action")
        if action != "update":
            continue
        node_id = r.get("node_id")
        after = r.get("after") or {}
        if not after:
            continue

        sets = []
        vals = []
        for col in ("cover_image_url", "isbn", "author", "publisher", "publication_year", "description"):
            val = after.get(col)
            if val is not None and val != "":
                sets.append(f"{col}=?")
                vals.append(val)
                fields_touched[col] += 1

        if not sets:
            continue

        sets.append("updated_at=datetime('now')")
        # If we changed cover or description: mark source
        if "cover_image_url" in [s.split("=")[0] for s in sets] or "description" in [s.split("=")[0] for s in sets]:
            cs = after.get("cover_source")
            if cs:
                sets.append("description_source=?")
                vals.append(f"pax-audit-{cs}")

        vals.append(node_id)
        sql = f"UPDATE books SET {', '.join(sets)} WHERE node_id=?"
        c.execute(sql, vals)
        if c.rowcount > 0:
            updated += 1

    conn.commit()
    conn.close()

    print(f"\nApplied UPDATE on {updated} books")
    print("Fields touched (counts):")
    for k, v in sorted(fields_touched.items(), key=lambda x: -x[1]):
        if v:
            print(f"  {k:<20} {v}")

if __name__ == "__main__":
    main()
