"""Dry-test the new parse_index against the live PDF."""
import pdfplumber
from pathlib import Path
from categorize_recipes_via_api import parse_index, build_recipe_num_to_category
from collections import Counter

pdf_path = Path(r"C:\Users\cools\OneDrive - Familie Heiniger\Dokumente & Verträge - Documents\General\my-ai-team\PKM\cookbook-1.pdf")

with pdfplumber.open(pdf_path) as pdf:
    text = "\n".join((pdf.pages[n].extract_text() or "") for n in range(405, 420))

ranges = parse_index(text)
print(f"Parsed {len(ranges)} index entries.")

num_to_cat = build_recipe_num_to_category(ranges)
print(f"\nUnique recipe-nums: {len(num_to_cat)}")
print(f"\nCategory distribution:")
cnt = Counter(num_to_cat.values())
for cat, n in cnt.most_common():
    print(f"  {cat:<30} {n:>3}")

print(f"\nSample 10 (R-num → category):")
for n in sorted(num_to_cat.keys())[:10]:
    print(f"  R{n:04d} → {num_to_cat[n]}")
print(f"\nLast 10:")
for n in sorted(num_to_cat.keys())[-10:]:
    print(f"  R{n:04d} → {num_to_cat[n]}")
