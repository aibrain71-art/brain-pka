"""
Apply books-hybrid migration to Cloudflare D1 via REST API.
Bypasses wrangler (ARM64-broken on Windows) and the D1 web-console
(which has a 100KB single-statement limit).

Setup:
  $env:CLOUDFLARE_API_TOKEN  = "<token with D1:Edit scope>"
  $env:CLOUDFLARE_ACCOUNT_ID = "<your account id>"

Run:
  python apply_books_via_api.py

Idempotent: re-runs safe (uses CREATE IF NOT EXISTS / INSERT OR REPLACE).
"""
from __future__ import annotations
import os, re, sys, json
from pathlib import Path
from urllib import request, error

DB_ID = "9a27139f-af63-4fa2-8eb5-6c999ca86e7a"
ACCOUNT_ID = "3af0e1f1492b1d19c9553c418007ab04"  # hardcoded for owner; not a secret
BASE = Path(__file__).resolve().parent
FILES = [
    "schema-books.sql",
    "migration-people-authors.sql",
    "migration-books.sql",
    "migration-notes-books.sql",
]
BATCH_SIZE = 25  # statements per API call

def is_transaction_stmt(stmt: str) -> bool:
    """D1 rejects SQL transaction control. Drop them — D1 batches are atomic."""
    u = stmt.upper().strip().rstrip(";").strip()
    if u in ("BEGIN", "BEGIN TRANSACTION", "BEGIN DEFERRED TRANSACTION",
             "BEGIN IMMEDIATE TRANSACTION", "BEGIN EXCLUSIVE TRANSACTION",
             "COMMIT", "COMMIT TRANSACTION", "END", "END TRANSACTION",
             "ROLLBACK", "ROLLBACK TRANSACTION"):
        return True
    if u.startswith("SAVEPOINT ") or u.startswith("RELEASE ") or u.startswith("ROLLBACK TO "):
        return True
    return False

def split_statements(sql: str) -> list[str]:
    """Split SQL on `;` not inside single-quoted strings. Drop comments + transaction controls."""
    sql = re.sub(r"^\s*--.*$", "", sql, flags=re.MULTILINE)
    stmts = []
    cur = []
    in_str = False
    i = 0
    while i < len(sql):
        ch = sql[i]
        if in_str:
            cur.append(ch)
            if ch == "'":
                # SQL escapes single quotes by doubling them: 'O''Brien'
                if i + 1 < len(sql) and sql[i+1] == "'":
                    cur.append("'")
                    i += 2
                    continue
                in_str = False
        else:
            if ch == "'":
                in_str = True
                cur.append(ch)
            elif ch == ";":
                stmt = "".join(cur).strip()
                if stmt and not is_transaction_stmt(stmt):
                    stmts.append(stmt)
                cur = []
            else:
                cur.append(ch)
        i += 1
    last = "".join(cur).strip()
    if last and not is_transaction_stmt(last):
        stmts.append(last)
    return stmts

def execute(token: str, account_id: str, sql: str) -> dict:
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{DB_ID}/query"
    body = json.dumps({"sql": sql}).encode("utf-8")
    req = request.Request(url, data=body, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except error.HTTPError as e:
        return json.loads(e.read())


def is_forgivable_error(result: dict) -> bool:
    """True when the only errors in a failed result are idempotent ALTER errors
    (column already exists). Phase 4c added six additive ALTERs to
    schema-books.sql so re-runs would otherwise fail at those statements.

    D1 surfaces this as a generic SQLITE error with message like
    'duplicate column name: rating_count'. We forgive that one specifically.
    """
    # Collect every error-shaped message we can find.
    raw_errs: list[str] = []
    for e in result.get("errors") or []:
        if isinstance(e, dict):
            raw_errs.append((e.get("message") or "").lower())
        else:
            raw_errs.append(str(e).lower())
    for e in result.get("messages") or []:
        if isinstance(e, dict):
            raw_errs.append((e.get("message") or "").lower())
        else:
            raw_errs.append(str(e).lower())
    # If the API didn't put a structured error anywhere, treat as non-forgivable.
    if not raw_errs:
        return False
    return all("duplicate column name" in m for m in raw_errs)

def main():
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or ACCOUNT_ID
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        print("Cloudflare API Token wird gebraucht.")
        print("Falls noch nicht: https://dash.cloudflare.com/profile/api-tokens")
        print("Custom Token -> Account: D1: Edit -> Create")
        print()
        token = input("Token einfuegen + Enter: ").strip()
        if not token:
            print("Kein Token. Abbruch.")
            sys.exit(2)

    print(f"D1 database: {DB_ID}")
    print(f"Account:     {account_id}")
    print()

    total_ok, total_fail = 0, 0
    for fname in FILES:
        path = BASE / fname
        if not path.exists():
            print(f"SKIP {fname} (missing)")
            continue
        sql = path.read_text(encoding="utf-8")
        stmts = split_statements(sql)
        print(f"== {fname}: {len(stmts)} statements ==")
        for i in range(0, len(stmts), BATCH_SIZE):
            batch = stmts[i:i+BATCH_SIZE]
            payload = ";\n".join(batch) + ";"
            result = execute(token, account_id, payload)
            if result.get("success"):
                total_ok += len(batch)
                print(f"  batch {i+1:>4}-{i+len(batch):<4} OK")
            elif is_forgivable_error(result):
                # Idempotent schema ALTERs throw duplicate-column on re-runs.
                # Cloudflare aborts the whole batch, so we retry each stmt
                # individually and only count the non-duplicate failures.
                retry_ok, retry_skip, retry_fail = 0, 0, 0
                for stmt in batch:
                    r2 = execute(token, account_id, stmt + ";")
                    if r2.get("success"):
                        retry_ok += 1
                    elif is_forgivable_error(r2):
                        retry_skip += 1
                    else:
                        retry_fail += 1
                        errs = r2.get("errors", r2)
                        print(f"    stmt FAILED -- {errs}")
                total_ok += retry_ok
                total_fail += retry_fail
                print(
                    f"  batch {i+1:>4}-{i+len(batch):<4} "
                    f"OK={retry_ok} SKIP={retry_skip} FAIL={retry_fail} "
                    f"(retried after duplicate-column)"
                )
                if retry_fail:
                    sys.exit(1)
            else:
                total_fail += len(batch)
                errs = result.get("errors", result)
                print(f"  batch {i+1:>4}-{i+len(batch):<4} FAILED -- {errs}")
                sys.exit(1)

    print()
    print(f"DONE. Statements OK: {total_ok}, FAILED: {total_fail}")
    print("Verify with:")
    print('  SELECT COUNT(*) FROM books;                                -- expect 115')
    print('  SELECT COUNT(*) FROM notes WHERE note_type="book";         -- expect 115')
    print('  SELECT COUNT(*) FROM people WHERE role_context="Author";   -- expect 91')

if __name__ == "__main__":
    main()
