"""Apply Pax's 3 cover-swap fixes (Hugo-decision-1).
Each pair had two books sharing one cover URL — only ONE per pair needs the fix.
"""
import sqlite3
from pathlib import Path

DB = Path(r"C:\Users\cools\OneDrive - Familie Heiniger\Dokumente & Verträge - Documents\General\my-ai-team\PKM\mypka.db")

SWAPS = [
    # node_id, new_cover_url, new_isbn, new_source
    ("icxsCAz7jkI2",
     "https://images-na.ssl-images-amazon.com/images/P/0470998016.01.LZZZZZZZ.jpg",
     "9780470998014",
     "pax-audit-amazon_isbn10"),
    ("pbulTk6fZIUD",
     "https://images-na.ssl-images-amazon.com/images/P/3906009262.01.LZZZZZZZ.jpg",
     "9783906009261",
     "pax-audit-amazon_isbn10"),
    ("ZSU3ip4wncWj",
     "https://pictures.abebooks.com/isbn/9783850122641-de-300.jpg",
     "9783850122641",
     "pax-audit-abebooks"),
]

conn = sqlite3.connect(DB)
c = conn.cursor()
for nid, cover, isbn, source in SWAPS:
    c.execute("""
        UPDATE books SET
            cover_image_url=?,
            isbn=COALESCE(?, isbn),
            description_source=?,
            updated_at=datetime('now')
        WHERE node_id=?""", (cover, isbn, source, nid))
    print(f"  {nid}: cover updated ({source})")
conn.commit()
print(f"\nApplied {len(SWAPS)} cover swaps.")
conn.close()
