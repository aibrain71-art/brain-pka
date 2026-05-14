"""Apply Hugo's series-tagging UPDATEs (Phase 4 audit).
Asterix (15), für Dummies (8), in 30 Sekunden (5), Market Risk Analysis (3).
Idempotent: re-runs safe (sets the same values).
"""
import sqlite3
from pathlib import Path

DB = Path(r"C:\Users\cools\OneDrive - Familie Heiniger\Dokumente & Verträge - Documents\General\my-ai-team\PKM\mypka.db")

ASTERIX = [
    ("5OHLK-KDZ9Ki", 1), ("2hh--Og3q9fv", 2), ("TuoSvF9I02nC", 3),
    ("kkk1HBojmskY", 4), ("6AnG_8qIYOlH", 5), ("btPNMnQoOSAd", 6),
    ("JTUjGHtjP1wt", 7), ("eSgKQhWjw32U", 8), ("SwIsBM75fayl", 9),
    ("mUp8I_aYmrZc", 10), ("xkSMYYrKT3qK", 11), ("jmf10yuvIDs8", 12),
    ("qAeCHMkgVvlV", 13), ("dD8moanDvduC", 14), ("GAXhU10xJi0-", 15),
]

DUMMIES = ["fh8gVaj1Wcxo", "raSRTUkjjLrZ", "ocTmmscYYc87", "E5uENuxFdwOr",
           "syn_6bc7a4389671", "vT4kARjSbiAc", "klOfBdC281sw", "DOU7tony9Fgo"]

IN_30_SEC = ["syn_b7c33e0b423d", "syn_2971171ded6f", "_RJbVN6pdtaI",
             "syn_24509925f484", "syn_ce9e5dcf9490"]

MARKET_RISK = [("9tZ0Ed7kAv7r", 1), ("icxsCAz7jkI2", 2), ("0ILKr91IJxYr", 4)]

conn = sqlite3.connect(DB)
c = conn.cursor()

for nid, pos in ASTERIX:
    c.execute("UPDATE books SET series_name=?, series_position=?, updated_at=datetime('now') WHERE node_id=?",
              ("Asterix – Gesamtausgabe", pos, nid))
for nid in DUMMIES:
    c.execute("UPDATE books SET series_name=?, updated_at=datetime('now') WHERE node_id=?",
              ("… für Dummies", nid))
for nid in IN_30_SEC:
    c.execute("UPDATE books SET series_name=?, updated_at=datetime('now') WHERE node_id=?",
              ("… in 30 Sekunden", nid))
for nid, pos in MARKET_RISK:
    c.execute("UPDATE books SET series_name=?, series_position=?, updated_at=datetime('now') WHERE node_id=?",
              ("Market Risk Analysis", pos, nid))

conn.commit()

# Verify
print("series_name population:")
for row in c.execute("SELECT series_name, COUNT(*) FROM books GROUP BY series_name ORDER BY 2 DESC"):
    print(f"  {row[1]:>3}  {row[0] or '(none)'}")

conn.close()
