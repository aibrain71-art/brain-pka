# Apply Phase-3a books-hybrid migration to Cloudflare D1 (brain-pka).
#
# Prereqs (one-time):
#   1. mypka.db has been migrated locally: `python migrate_books_to_hybrid.py`
#   2. D1 SQL files have been generated:   `python migrate_books_to_hybrid.py --emit-d1`
#   3. Wrangler is installed and authenticated: `wrangler whoami`
#
# Run order matters: schema → people → books → shadow-notes.
# (Notes reference people-slugs and books-node-ids, so those rows must exist first.)
#
# Usage:
#   .\apply-books-to-d1.ps1            # apply to remote
#   .\apply-books-to-d1.ps1 -DryRun    # show what would run, no execution
#   .\apply-books-to-d1.ps1 -Local     # apply to local D1 (wrangler --local)
#
# After running, verify in Cloudflare D1 dashboard:
# https://dash.cloudflare.com/?to=/:account/workers/d1

param(
    [switch]$DryRun,
    [switch]$Local
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$dbName = 'larry-db'
$flag   = if ($Local) { '--local' } else { '--remote' }

# Order: schema first, then reference data (people, books), then notes that
# reference both. INSERT OR IGNORE / INSERT OR REPLACE makes each step idempotent.
$steps = @(
    @{ name = 'schema-books';           file = 'schema-books.sql' }
    @{ name = 'people (authors)';       file = 'migration-people-authors.sql' }
    @{ name = 'books (data)';           file = 'migration-books.sql' }
    @{ name = 'notes (shadow-notes)';   file = 'migration-notes-books.sql' }
)

Write-Host ""
Write-Host "Phase 3a — books-hybrid → D1 ($dbName, $flag)" -ForegroundColor Cyan
Write-Host ""

foreach ($step in $steps) {
    $path = Join-Path $here $step.file
    if (-not (Test-Path $path)) {
        Write-Host "  MISSING: $($step.file)" -ForegroundColor Red
        Write-Host "  Run first: python migrate_books_to_hybrid.py --emit-d1"
        exit 1
    }
    Write-Host "  -> $($step.name)" -ForegroundColor Yellow
    $cmd = "wrangler d1 execute $dbName $flag --file `"$path`""
    if ($DryRun) {
        Write-Host "     (dry-run) $cmd"
    } else {
        Write-Host "     $cmd"
        & wrangler d1 execute $dbName $flag --file $path
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  FAILED at step: $($step.name)" -ForegroundColor Red
            exit $LASTEXITCODE
        }
    }
}

Write-Host ""
Write-Host "Done. Verify with:" -ForegroundColor Green
Write-Host "  wrangler d1 execute $dbName $flag --command `"SELECT COUNT(*) FROM books`""
Write-Host "  wrangler d1 execute $dbName $flag --command `"SELECT COUNT(*) FROM notes WHERE note_type='book'`""
Write-Host "  wrangler d1 execute $dbName $flag --command `"SELECT COUNT(*) FROM people WHERE role_context='Author'`""
Write-Host ""
Write-Host "Dashboard: https://dash.cloudflare.com/?to=/:account/workers/d1" -ForegroundColor Cyan
