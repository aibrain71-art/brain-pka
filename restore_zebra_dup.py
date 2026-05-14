"""Restore the Zebra-Algebra duplicate from the phase4c backup.
Owner has TWO physical copies — both belong in the library.
"""
import sqlite3
from pathlib import Path

CUR = Path(r"C:\Users\cools\OneDrive - Familie Heiniger\Dokumente & Verträge - Documents\General\my-ai-team\PKM\mypka.db")
BAK = Path(r"C:\Users\cools\OneDrive - Familie Heiniger\Dokumente & Verträge - Documents\General\my-ai-team\PKM\mypka.db.bak-phase4c")

ZEBRA_DROP = "Q2ai5IUOExuJ"

bak = sqlite3.connect(BAK)
bak_cols = [r[1] for r in bak.execute("PRAGMA table_info(books)")]
bak_row = bak.execute(f"SELECT * FROM books WHERE node_id=?", (ZEBRA_DROP,)).fetchone()
bak.close()

if not bak_row:
    print(f"ERROR: {ZEBRA_DROP} not found in backup")
    raise SystemExit(1)

print(f"Found in backup: node_id={ZEBRA_DROP}")
print(f"  title={bak_row[bak_cols.index('title')]}")
print(f"  author={bak_row[bak_cols.index('author')]}")

cur = sqlite3.connect(CUR)
cur_cols = [r[1] for r in cur.execute("PRAGMA table_info(books)")]

# Map backup row to current schema (current has extra phase-4c columns, backup may not)
values = []
for col in cur_cols:
    if col in bak_cols:
        values.append(bak_row[bak_cols.index(col)])
    else:
        values.append(None)

placeholders = ", ".join(["?"] * len(cur_cols))
col_list = ", ".join(cur_cols)
cur.execute(f"INSERT OR REPLACE INTO books ({col_list}) VALUES ({placeholders})", values)
cur.commit()

n = cur.execute("SELECT COUNT(*) FROM books").fetchone()[0]
print(f"\nbooks total: {n} (should be 115)")
cur.close()
