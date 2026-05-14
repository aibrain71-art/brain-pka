#!/usr/bin/env python3
"""
build_sw.py — Stamp the PKA service worker with a unique version at deploy-time.

Why this exists
---------------
Service workers cache aggressively. The browser only re-fetches a cached asset
when the SW's cache-key (here: the `VERSION` constant inside service-worker.js)
changes. Historically the owner had to hand-bump v119 -> v120 -> v121 on every
significant push, which is fragile and easy to forget.

This script replaces the literal token `__SW_VERSION__` inside
`service-worker.js` with a deploy-unique string, so every push to Cloudflare
Pages produces a fresh SW that automatically invalidates the old cache.

Version source (highest priority first)
---------------------------------------
1. `CF_PAGES_COMMIT_SHA`  — set by Cloudflare Pages during build.
2. `GITHUB_SHA`           — set by GitHub Actions (in case of fallback build).
3. `git rev-parse HEAD`   — for local dev builds.
4. UTC timestamp          — last-resort fallback (when neither env nor git work).

The final version string is always prefixed with `pka-` to keep the legacy
naming convention (matches the existing `pka-v120` cache-key format).

Idempotency
-----------
- Reads `service-worker.js`, replaces `__SW_VERSION__` in-place.
- If the placeholder is not present (already stamped), the script is a no-op
  and logs a warning — it does not overwrite an already-stamped version.
- If the placeholder appears more than once (e.g. accidentally re-introduced
  into a comment), the script exits 1 with a clear error.
- Exit code is 0 on success, 1 on hard error (missing file, unwritable, etc.).

Owner setup (Cloudflare Pages dashboard, one-time)
--------------------------------------------------
  Project: brain-pka -> Settings -> Builds & deployments -> Build configuration
    Framework preset:    None
    Build command:       python build_sw.py
    Build output dir:    .   (unchanged — wrangler.toml: pages_build_output_dir = ".")
    Root directory:      PKM   (unchanged)
  Save. From the next push to `main` onward, every deploy stamps a unique
  `pka-<commit-sha>` cache key into the SW. No more manual version bumps.

  Cloudflare's Pages build image already includes Python 3 — no extra setup.
  If `python` resolves to py2, change the command to `python3 build_sw.py`.
"""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SW_FILE = Path(__file__).parent / "service-worker.js"
PLACEHOLDER = "__SW_VERSION__"


def resolve_version() -> tuple[str, str]:
    """Return (version_string, source_label) using the priority order above."""
    cf_sha = os.environ.get("CF_PAGES_COMMIT_SHA")
    if cf_sha:
        return f"pka-{cf_sha[:7]}", "CF_PAGES_COMMIT_SHA"

    gh_sha = os.environ.get("GITHUB_SHA")
    if gh_sha:
        return f"pka-{gh_sha[:7]}", "GITHUB_SHA"

    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short=7", "HEAD"],
            cwd=SW_FILE.parent,
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
        sha = result.stdout.strip()
        if sha:
            return f"pka-{sha}", "git rev-parse HEAD"
    except (subprocess.SubprocessError, FileNotFoundError):
        pass

    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"pka-{ts}", "UTC timestamp fallback"


def main() -> int:
    if not SW_FILE.exists():
        print(f"[build_sw] ERROR: {SW_FILE} not found", file=sys.stderr)
        return 1

    content = SW_FILE.read_text(encoding="utf-8")

    occurrences = content.count(PLACEHOLDER)
    if occurrences == 0:
        print(
            f"[build_sw] WARNING: placeholder '{PLACEHOLDER}' not found in "
            f"{SW_FILE.name}. The SW may already be stamped — skipping.",
            file=sys.stderr,
        )
        return 0
    if occurrences > 1:
        print(
            f"[build_sw] ERROR: placeholder '{PLACEHOLDER}' appears "
            f"{occurrences}x in {SW_FILE.name}. Expected exactly 1 (the "
            f"`const VERSION` line). Remove stray occurrences before deploy.",
            file=sys.stderr,
        )
        return 1

    version, source = resolve_version()
    new_content = content.replace(PLACEHOLDER, version)
    SW_FILE.write_text(new_content, encoding="utf-8")

    print(f"[build_sw] stamped service-worker.js with VERSION = '{version}'")
    print(f"[build_sw] source: {source}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
