"""Apply Hugo's audit decisions (Owner-approved 2026-05-14).

Decisions:
- 2: delete Zebra/Algebra duplicate (keep one, drop the other)
- 3: mark "Operational Risk" as Market Risk Analysis Vol III
- 5: flag 6 unfindable books as needs-manual-upload

Idempotent re-runs safe.
"""
import sqlite3
from pathlib import Path

DB = Path(r"C:\Users\cools\OneDrive - Familie Heiniger\Dokumente & Verträge - Documents\General\my-ai-team\PKM\mypka.db")
conn = sqlite3.connect(DB)
c = conn.cursor()

# Decision 2: Zebra-Algebra-Duplikat — keep HQqA2_9lzZih, delete Q2ai5IUOExuJ
ZEBRA_KEEP = "HQqA2_9lzZih"
ZEBRA_DROP = "Q2ai5IUOExuJ"
c.execute("DELETE FROM books WHERE node_id=?", (ZEBRA_DROP,))
print(f"[2] Zebra duplicate dropped: node_id={ZEBRA_DROP} (kept {ZEBRA_KEEP})")

# Also clean up shadow note + people links for the dropped row
c.execute("DELETE FROM notes WHERE slug=?", (f"book-{ZEBRA_DROP}",))
print(f"    Shadow note book-{ZEBRA_DROP} dropped")

# Decision 3: Operational Risk (VMht1W7sF133) = Market Risk Analysis Vol III
OP_RISK = "VMht1W7sF133"
c.execute("""
    UPDATE books SET
        series_name='Market Risk Analysis',
        series_position=3,
        updated_at=datetime('now')
    WHERE node_id=?""", (OP_RISK,))
print(f"[3] Operational Risk → Market Risk Analysis Vol III (node_id={OP_RISK})")

# Decision 5: flag 6 unfindable as needs-manual-upload
MANUAL_UPLOAD = [
    "UWsoKaP8FZ_c",   # Kitsch ist Geschmackssache — Anja Weber
    "AKs8bwhz5wpq",   # Sovereign Risk Analysis
    "syn_e4f4f2d38a43",  # Soldaten aus dem Dunkel
    "ep9EIV_oOCNU",   # Das Buch vom guten Benehmen
    "oKpgBrrX81Zm",   # Der Präzisions-Luftkrieg
    "hnkX_PtrznDy",   # Orientierungslaufen
]
# Plus MasterClass Tony Buzon if it has a node_id (search by title)
extra = c.execute("SELECT node_id FROM books WHERE title LIKE '%MasterClass%Buzon%' OR title LIKE '%Buzan%'").fetchall()
for row in extra:
    if row[0] not in MANUAL_UPLOAD:
        MANUAL_UPLOAD.append(row[0])

for nid in MANUAL_UPLOAD:
    c.execute("""
        UPDATE books SET
            description_source='needs-manual-upload',
            updated_at=datetime('now')
        WHERE node_id=?""", (nid,))
print(f"[5] Flagged {len(MANUAL_UPLOAD)} books as needs-manual-upload")

conn.commit()

# Verify
print("\nFinal state:")
n_books = c.execute("SELECT COUNT(*) FROM books").fetchone()[0]
print(f"  books total: {n_books}")
n_market_risk = c.execute("SELECT COUNT(*) FROM books WHERE series_name='Market Risk Analysis'").fetchone()[0]
print(f"  Market Risk Analysis: {n_market_risk}")
n_manual = c.execute("SELECT COUNT(*) FROM books WHERE description_source='needs-manual-upload'").fetchone()[0]
print(f"  needs-manual-upload: {n_manual}")

conn.close()
