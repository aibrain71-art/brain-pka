#!/usr/bin/env python3
"""Build manifest.json for the Recall Garden.

Walks PKM/Garden/, parses each .md file's YAML frontmatter,
extracts a one-paragraph preview and the first source URL,
and writes a single manifest JSON the journal app fetches at boot.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

GARDEN_ROOT = Path(__file__).parent
OUTPUT = GARDEN_ROOT / "manifest.json"

# Map Recall folder → display category for the journal-app
TYPE_LABELS = {
    "Person": "👤", "Persons": "👥", "Place": "🌍", "Product": "📦",
    "Software Application": "🖥️", "Book": "📚", "Book Series": "📚",
    "Concept": "💡", "Diet": "🥗", "Disease": "🩺", "Health": "💚",
    "Event": "📅", "Game": "🎮", "Movie": "🎬", "Movie Series": "🎬",
    "Music Album": "🎵", "Music Composition": "🎵", "Organization": "🏢",
    "Politics": "🗳️", "Prompt": "📝", "MasterPromp": "📝",
    "Relationships": "💞", "Science": "🔬", "Sports": "⚽",
    "TV Episode": "📺", "TV Series": "📺", "Visual Artwork": "🖼️",
    "Web Site": "🌐", "Work": "💼", "Article": "📰",
    "Business": "💼", "Education": "🎓", "Hobbies": "🎨",
    "Index": "📑", "Military": "⚔️", "Video Game Series": "🎮",
    "risk management": "⚖️",
}

YAML_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)
SRC_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
YT_RE = re.compile(r"(?:youtu\.be/|youtube\.com/(?:watch\?v=|shorts/|embed/))([A-Za-z0-9_-]{11})")
DATE_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})|"  # ISO
                     r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+"
                     r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+"
                     r"(\d{1,2})\s+(\d{4})")
MONTHS = {"Jan":1,"Feb":2,"Mar":3,"Apr":4,"May":5,"Jun":6,
          "Jul":7,"Aug":8,"Sep":9,"Oct":10,"Nov":11,"Dec":12}


def parse_yaml_lite(yaml_block: str) -> dict:
    """Tiny YAML parser for the keys Recall uses: title, tags (list), createdAt, updatedAt."""
    out = {}
    current_key = None
    for line in yaml_block.splitlines():
        if not line.strip():
            continue
        if line.startswith("  - ") and current_key == "tags":
            v = line[4:].strip().strip('"').strip("'")
            out.setdefault("tags", []).append(v)
            continue
        m = re.match(r"^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$", line)
        if m:
            k, v = m.group(1), m.group(2).strip()
            current_key = k
            if v == "":
                out[k] = []
            elif v.startswith('"') and v.endswith('"'):
                out[k] = v[1:-1]
            elif v == "[]":
                out[k] = []
            else:
                out[k] = v
    return out


def normalize_date(raw: str) -> str | None:
    """Extract YYYY-MM-DD from Recall's verbose date strings."""
    if not raw:
        return None
    m = DATE_RE.search(raw)
    if not m:
        return None
    if m.group(1):
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    mon, day, yr = m.group(4), m.group(5), m.group(6)
    return f"{yr}-{MONTHS[mon]:02d}-{int(day):02d}"


BOILERPLATE = {
    "detailed summary", "summary", "description", "notes", "overview", "content",
    "transcript", "main points", "key points",
}
TIMESTAMP_LINK = re.compile(r"\s*\[\(?\d+:\d+(?::\d+)?\)?\]\([^)]+\)\s*")
MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")


def _meaningful_chunks(body: str):
    """Yield cleaned text fragments (one per bullet or paragraph), in document order.

    Skips boilerplate, ## Sources section, and frontmatter delimiters. Strips
    timestamp links and inline markdown link syntax.
    """
    for chunk in body.split("\n\n"):
        chunk = chunk.strip()
        if not chunk or chunk.startswith("---"):
            continue
        if chunk.lower() in BOILERPLATE:
            continue
        if chunk.lower().startswith("## sources") or chunk.lower().startswith("##sources"):
            return  # stop scanning
        # Strip leading header line(s)
        if chunk.startswith("##"):
            parts = chunk.split("\n", 1)
            if len(parts) < 2:
                continue
            chunk = parts[1].strip()
            if not chunk:
                continue
        # Bullet list: yield each bullet
        if chunk.startswith(("- ", "* ")):
            for line in chunk.split("\n"):
                line = line.strip()
                if not line.startswith(("- ", "* ")):
                    continue
                cleaned = line.lstrip("-* ").strip()
                cleaned = TIMESTAMP_LINK.sub(" ", cleaned)
                cleaned = MD_LINK.sub(r"\1", cleaned)
                cleaned = re.sub(r"\s+", " ", cleaned).strip()
                if cleaned:
                    yield cleaned
            continue
        # Plain paragraph
        cleaned = TIMESTAMP_LINK.sub(" ", chunk)
        cleaned = MD_LINK.sub(r"\1", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if cleaned:
            yield cleaned


def first_paragraph(body: str, max_len: int = 240) -> str:
    """Short preview — the first meaningful sentence/bullet."""
    for c in _meaningful_chunks(body):
        return c[: max_len - 1].rstrip() + "…" if len(c) > max_len else c
    return ""


def detailed_summary(body: str, max_total: int = 700, per_chunk_max: int = 240, target_chunks: int = 3) -> str:
    """Richer summary — first ~3 bullets/paragraphs joined with paragraph breaks.

    Useful for the 'Detailzusammenfassung' card so it has more substance than
    the one-liner preview.
    """
    parts = []
    total = 0
    for c in _meaningful_chunks(body):
        if len(c) > per_chunk_max:
            c = c[: per_chunk_max - 1].rstrip() + "…"
        parts.append(c)
        total += len(c)
        if len(parts) >= target_chunks or total >= max_total:
            break
    return "\n\n".join(parts)


def first_source(body: str) -> str | None:
    src_section = re.search(r"##\s*Sources?\s*\n(.*?)(?:\n##|\Z)", body, re.DOTALL)
    if not src_section:
        return None
    m = SRC_RE.search(src_section.group(1))
    return m.group(2) if m else None


def extract_youtube_id(*texts: str) -> str | None:
    for t in texts:
        if not t:
            continue
        m = YT_RE.search(t)
        if m:
            return m.group(1)
    return None


# ── Wikipedia thumbnail fetcher (cached) ───────────────────────
WIKI_CACHE_FILE = GARDEN_ROOT / "wiki-thumbs-cache.json"
WIKI_URL_RE = re.compile(r"https?://([a-z]{2,3})\.wikipedia\.org/wiki/([^#?]+)")


def load_wiki_cache() -> dict:
    try:
        return json.loads(WIKI_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_wiki_cache(cache: dict) -> None:
    WIKI_CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch_wikipedia_thumbnail(wiki_url: str, cache: dict, delay: float = 0.08) -> str | None:
    """Return the page's thumbnail URL via the Wikipedia REST summary API.
    Cached on disk so repeat builds don't re-fetch.
    Returns None if no thumbnail or page not found."""
    if wiki_url in cache:
        return cache[wiki_url]
    m = WIKI_URL_RE.match(wiki_url)
    if not m:
        cache[wiki_url] = None
        return None
    lang, page = m.group(1), m.group(2)
    api = f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{page}"
    try:
        req = urllib.request.Request(api, headers={"User-Agent": "PKM-Garden-Builder/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        thumb = (data.get("thumbnail") or {}).get("source")
        cache[wiki_url] = thumb
    except Exception:
        cache[wiki_url] = None
    if delay:
        time.sleep(delay)
    return cache.get(wiki_url)


# ── Official website fetcher (Wikidata P856) ───────────────────
WIKI_WEBSITE_CACHE_FILE = GARDEN_ROOT / "wiki-websites-cache.json"


def load_website_cache() -> dict:
    try:
        return json.loads(WIKI_WEBSITE_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_website_cache(cache: dict) -> None:
    WIKI_WEBSITE_CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def _safe_url(url):
    """Make a URL ASCII-safe (URL-encode any non-ASCII chars in path/query)."""
    try:
        from urllib.parse import urlsplit, urlunsplit, quote
        parts = urlsplit(url)
        # Re-encode path and query so umlauts → %C3%BC etc.
        path = quote(parts.path, safe='/:@')
        query = quote(parts.query, safe='=&:/')
        return urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))
    except Exception:
        return url


def _fetch_json(url, retries=4, base_delay=1.5):
    """Fetch JSON with retry on 429 / transient errors. Honors Retry-After."""
    last_err = None
    safe = _safe_url(url)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(safe, headers={"User-Agent": "PKM-Garden-Builder/1.0 (research notebook)"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            last_err = e
            try:
                from urllib.error import HTTPError
                if isinstance(e, HTTPError) and e.code in (429, 500, 502, 503, 504):
                    retry_after = 0
                    try:
                        retry_after = int(e.headers.get("Retry-After", "0"))
                    except Exception:
                        pass
                    wait = max(retry_after, base_delay * (2 ** attempt))
                    time.sleep(wait)
                    continue
            except Exception:
                pass
            time.sleep(base_delay * (attempt + 1))
            continue
    raise last_err


# ── Book metadata fetcher (Wikidata: author, date, language, ISBN) ─────
WIKI_BOOKS_CACHE_FILE = GARDEN_ROOT / "wiki-books-cache.json"


def load_books_cache() -> dict:
    try:
        return json.loads(WIKI_BOOKS_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_books_cache(cache: dict) -> None:
    WIKI_BOOKS_CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


# ── YouTube creator fetcher (oEmbed — no API key needed) ──────
YT_CREATORS_CACHE_FILE = GARDEN_ROOT / "yt-creators-cache.json"


def load_yt_cache() -> dict:
    try:
        return json.loads(YT_CREATORS_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_yt_cache(cache: dict) -> None:
    YT_CREATORS_CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch_youtube_creator(yt_id: str, cache: dict, delay: float = 0.15) -> dict | None:
    """Use YouTube oEmbed to get the channel/creator name + URL for a video."""
    if yt_id in cache:
        return cache[yt_id]
    api = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={yt_id}&format=json"
    info = None
    try:
        data = _fetch_json(api)
        info = {
            "name": data.get("author_name"),
            "url": data.get("author_url"),
            "videoTitle": data.get("title"),
        }
    except Exception:
        info = None
    cache[yt_id] = info
    if delay:
        time.sleep(delay)
    return info


WIKI_MOVIES_CACHE_FILE = GARDEN_ROOT / "wiki-movies-cache.json"


def load_movies_cache() -> dict:
    try:
        return json.loads(WIKI_MOVIES_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_movies_cache(cache: dict) -> None:
    WIKI_MOVIES_CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch_movie_poster(wiki_url: str, cache: dict, delay: float = 0.5) -> str | None:
    """Return the movie/TV-show poster URL via Wikipedia → Wikidata (P18 image).
    The Wikipedia summary thumbnail is unreliable for films (often a screenshot
    or studio logo); P18 is the canonical "main image" claim and almost always
    holds the theatrical / DVD poster. Returned URL is a Commons FilePath
    thumbnail rendered at width=300."""
    if wiki_url in cache:
        return cache[wiki_url]
    m = WIKI_URL_RE.match(wiki_url)
    if not m:
        cache[wiki_url] = None
        return None
    lang, page = m.group(1), m.group(2)
    poster = None
    try:
        # 1) Wikipedia → Wikidata QID
        api1 = f"https://{lang}.wikipedia.org/w/api.php?action=query&prop=pageprops&titles={page}&format=json&redirects=1"
        data = _fetch_json(api1)
        qid = None
        for p in (data.get("query", {}).get("pages", {}) or {}).values():
            qid = (p.get("pageprops") or {}).get("wikibase_item")
            if qid:
                break
        if not qid:
            cache[wiki_url] = None
            return None

        # 2) Pull P18 (image) from Wikidata
        api2 = f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
        wd = _fetch_json(api2)
        entity = (wd.get("entities") or {}).get(qid) or {}
        claims = entity.get("claims") or {}
        p18 = claims.get("P18") or []
        if p18:
            v = (p18[0].get("mainsnak") or {}).get("datavalue", {}).get("value")
            if isinstance(v, str) and v:
                from urllib.parse import quote
                fn = quote(v.replace(" ", "_"))
                poster = f"https://commons.wikimedia.org/wiki/Special:FilePath/{fn}?width=300"
    except Exception as e:
        print(f"    ! movie poster {page[:40]}: {type(e).__name__}: {str(e)[:60]}")
    cache[wiki_url] = poster
    if delay:
        time.sleep(delay)
    return poster


def fetch_book_metadata(wiki_url: str, cache: dict, delay: float = 0.6) -> dict | None:
    """Fetch author, publication date, language, ISBN-10/13 for a book via
    Wikipedia → Wikidata. Resolves linked QIDs (author, language) to labels."""
    if wiki_url in cache:
        return cache[wiki_url]
    m = WIKI_URL_RE.match(wiki_url)
    if not m:
        cache[wiki_url] = None
        return None
    lang, page = m.group(1), m.group(2)
    meta = {}
    try:
        # 1) Wikipedia → Wikidata QID
        api1 = f"https://{lang}.wikipedia.org/w/api.php?action=query&prop=pageprops&titles={page}&format=json&redirects=1"
        data = _fetch_json(api1)
        qid = None
        for p in (data.get("query", {}).get("pages", {}) or {}).values():
            qid = (p.get("pageprops") or {}).get("wikibase_item")
            if qid:
                break
        if not qid:
            cache[wiki_url] = None
            return None

        # 2) Fetch entity claims from Wikidata
        api2 = f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
        wd = _fetch_json(api2)
        entity = (wd.get("entities") or {}).get(qid) or {}
        claims = entity.get("claims") or {}

        def first_value(prop):
            cs = claims.get(prop) or []
            if not cs:
                return None
            return (cs[0].get("mainsnak") or {}).get("datavalue", {}).get("value")

        # ISBN
        isbn13 = first_value("P212")
        isbn10 = first_value("P957")
        # Publication date — comes as {"time": "+2018-03-15T00:00:00Z", ...}
        pubdate_raw = first_value("P577")
        pubdate = None
        if isinstance(pubdate_raw, dict):
            t = (pubdate_raw.get("time") or "").lstrip("+")
            if len(t) >= 10:
                pubdate = t[:10]
            elif len(t) >= 4:
                pubdate = t[:4]

        # Linked QIDs that need label resolution
        author_qids = []
        for c in claims.get("P50") or []:
            v = (c.get("mainsnak") or {}).get("datavalue", {}).get("value")
            if isinstance(v, dict) and "id" in v:
                author_qids.append(v["id"])
        lang_qid = None
        for c in claims.get("P407") or []:
            v = (c.get("mainsnak") or {}).get("datavalue", {}).get("value")
            if isinstance(v, dict) and "id" in v:
                lang_qid = v["id"]
                break
        genre_qids = []
        for c in (claims.get("P136") or [])[:3]:
            v = (c.get("mainsnak") or {}).get("datavalue", {}).get("value")
            if isinstance(v, dict) and "id" in v:
                genre_qids.append(v["id"])

        all_qids = set(author_qids) | ({lang_qid} if lang_qid else set()) | set(genre_qids)
        labels = {}
        if all_qids:
            api3 = f"https://www.wikidata.org/w/api.php?action=wbgetentities&ids={'|'.join(all_qids)}&props=labels&languages=de|en|fr&format=json"
            ld = _fetch_json(api3)
            for q, ent in (ld.get("entities") or {}).items():
                lab = ent.get("labels") or {}
                labels[q] = (lab.get("de") or lab.get("en") or lab.get("fr") or {}).get("value")

        if author_qids:
            meta["authors"] = [labels.get(q) for q in author_qids if labels.get(q)]
        if lang_qid:
            meta["language"] = labels.get(lang_qid)
        if genre_qids:
            meta["genres"] = [labels.get(q) for q in genre_qids if labels.get(q)]
        if pubdate:
            meta["publishedDate"] = pubdate
        if isbn13:
            meta["isbn13"] = isbn13
        if isbn10:
            meta["isbn10"] = isbn10
    except Exception as e:
        # Cache nothing on hard failure so retries can happen later
        print(f"    ! book meta {page[:40]}: {type(e).__name__}: {str(e)[:60]}")
        meta = None
    cache[wiki_url] = meta if meta else None
    if delay:
        time.sleep(delay)
    return cache.get(wiki_url)


def fetch_official_website(wiki_url: str, cache: dict, delay: float = 0.25) -> str | None:
    """Look up the entity's official website (Wikidata property P856) via the
    Wikipedia title → wikidata QID → entity claims chain. Cached on disk."""
    if wiki_url in cache:
        return cache[wiki_url]
    m = WIKI_URL_RE.match(wiki_url)
    if not m:
        cache[wiki_url] = None
        return None
    lang, page = m.group(1), m.group(2)
    website = None
    try:
        # 1) Wikipedia → Wikidata QID
        api1 = f"https://{lang}.wikipedia.org/w/api.php?action=query&prop=pageprops&titles={page}&format=json&redirects=1"
        data = _fetch_json(api1)
        qid = None
        for p in (data.get("query", {}).get("pages", {}) or {}).values():
            qid = (p.get("pageprops") or {}).get("wikibase_item")
            if qid:
                break
        # 2) Wikidata → P856
        if qid:
            api2 = f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
            wd = _fetch_json(api2)
            entity = (wd.get("entities") or {}).get(qid) or {}
            claims = (entity.get("claims") or {}).get("P856") or []
            if claims:
                val = (claims[0].get("mainsnak") or {}).get("datavalue", {}).get("value")
                if isinstance(val, str):
                    website = val
    except Exception as e:
        # Surface first 80 chars of the URL + error class so we can spot patterns
        print(f"    ! {page[:50]} failed: {type(e).__name__}: {str(e)[:80]}")
    cache[wiki_url] = website
    if delay:
        time.sleep(delay)
    return website


def folder_type(rel_path: Path) -> tuple[str, str]:
    """Return (type, icon) — top-level folder is the type, root files are 'Note'.
    Auto-generated orphan stubs in _auto/ are treated as Notes too."""
    parts = rel_path.parts
    if len(parts) <= 1:
        return "Note", "📝"
    t = parts[0]
    if t == "_auto":
        return "Note", "🤖"   # auto-generated reference stub
    return t, TYPE_LABELS.get(t, "📄")


def main():
    entries = []
    skipped = 0
    next_id = 1000  # IDs above any existing journal entry id
    # Walk regular files first, then auto-generated orphan stubs in _auto/.
    # Keeping _auto last means existing entries keep stable ids across rebuilds
    # — only the new stubs get fresh ids appended at the end.
    _all_paths = sorted(GARDEN_ROOT.rglob("*.md"))
    _auto_paths = [p for p in _all_paths if "_auto" in p.parts]
    _normal_paths = [p for p in _all_paths if "_auto" not in p.parts]
    for path in _normal_paths + _auto_paths:
        if path.name == "build-manifest.py":
            continue
        if path.name == "README.md":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except Exception as e:
            skipped += 1
            continue
        m = YAML_RE.match(text)
        if not m:
            # Loose file with no frontmatter — synthesize
            yaml = {}
            body = text
        else:
            yaml = parse_yaml_lite(m.group(1))
            body = m.group(2)

        rel = path.relative_to(GARDEN_ROOT)
        entry_type, icon = folder_type(rel)
        title = yaml.get("title") or path.stem
        tags = yaml.get("tags") or []
        if isinstance(tags, str):
            tags = [tags]
        # normalize tags: lowercase, slug-ish
        norm_tags = []
        for t in tags:
            slug = re.sub(r"\s+", "-", t.strip().lower())
            if slug:
                norm_tags.append(slug)
        # Always include the entity-type as a tag
        type_slug = re.sub(r"\s+", "-", entry_type.lower())
        if type_slug not in norm_tags:
            norm_tags.append(type_slug)

        date = normalize_date(yaml.get("createdAt", "")) or "2026-05-07"
        preview = first_paragraph(body)
        detailed = detailed_summary(body)
        source_url = first_source(body)
        yt_id = extract_youtube_id(source_url, body)
        if not preview:
            if yt_id:
                preview = "🎬 YouTube-Video — öffne den Eintrag für Details."
            elif source_url and "wikipedia" in source_url:
                preview = f"📖 Wikipedia: {title}"
            elif source_url:
                from urllib.parse import urlparse
                host = urlparse(source_url).hostname or "Quelle"
                preview = f"🔗 {host}"
            else:
                preview = f"{entry_type} — keine Beschreibung."
        if not detailed:
            detailed = preview

        entry = {
            "id": next_id,
            "date": date,
            "title": title,
            "type": "garden",
            "icon": "▶️" if yt_id else icon,  # video icon when YT, else type emoji
            "garden_type": entry_type,
            "preview": preview,
            "detailed": detailed,
            "topics": norm_tags,
            "mdPath": "Garden/" + rel.as_posix(),
            "sourceUrl": source_url,
        }
        if yt_id:
            entry["youtubeId"] = yt_id
        entries.append(entry)
        next_id += 1

    # ── Second pass: fetch Wikipedia portraits/logos/photos for all
    # entries whose source is a Wikipedia page. Uses a persistent cache so
    # repeat builds don't hit the network. ──────────────────────────────────
    wiki_cache = load_wiki_cache()
    print(f"  fetching Wikipedia thumbnails (cache has {len(wiki_cache)} entries)…")
    fetched = 0
    skipped = 0
    candidates = [e for e in entries if e.get("sourceUrl") and "wikipedia.org" in (e.get("sourceUrl") or "")]
    print(f"  {len(candidates)} entries with Wikipedia source")
    for i, entry in enumerate(candidates):
        url = entry["sourceUrl"]
        cached = url in wiki_cache
        thumb = fetch_wikipedia_thumbnail(url, wiki_cache)
        if thumb:
            entry["portraitUrl"] = thumb
            fetched += 1
        if not cached:
            # Periodic save so partial progress is preserved on crash
            if (i + 1) % 50 == 0:
                save_wiki_cache(wiki_cache)
                print(f"    progress: {i+1}/{len(candidates)} ({fetched} portraits so far)")
        else:
            skipped += 1
    save_wiki_cache(wiki_cache)
    print(f"  portraits attached: {fetched} (cached: {skipped}, total cache: {len(wiki_cache)})")

    # ── Website pass (Wikidata P856): only for organization-shaped types ──
    ORG_TYPES = {"Organization", "Business", "Software Application", "Web Site", "Education"}
    web_cache = load_website_cache()
    print(f"  fetching official websites (cache has {len(web_cache)} entries)…")
    org_candidates = [
        e for e in entries
        if e.get("garden_type") in ORG_TYPES
        and e.get("sourceUrl")
        and "wikipedia.org" in e["sourceUrl"]
    ]
    print(f"  {len(org_candidates)} org-type entries to check")
    web_fetched = 0
    for i, entry in enumerate(org_candidates):
        cached = entry["sourceUrl"] in web_cache
        url = fetch_official_website(entry["sourceUrl"], web_cache)
        if url:
            entry["websiteUrl"] = url
            web_fetched += 1
        if not cached and (i + 1) % 50 == 0:
            save_website_cache(web_cache)
            print(f"    progress: {i+1}/{len(org_candidates)} ({web_fetched} websites so far)")
    save_website_cache(web_cache)
    print(f"  websites attached: {web_fetched}")

    # ── Book metadata pass (Wikidata: author, date, language, ISBN) ───────
    BOOK_TYPES = {"Book", "Book Series"}
    books_cache = load_books_cache()
    print(f"  fetching book metadata (cache has {len(books_cache)} entries)…")
    book_candidates = [
        e for e in entries
        if e.get("garden_type") in BOOK_TYPES
        and e.get("sourceUrl")
        and "wikipedia.org" in e["sourceUrl"]
    ]
    print(f"  {len(book_candidates)} book entries to check")
    book_attached = 0
    for i, entry in enumerate(book_candidates):
        meta = fetch_book_metadata(entry["sourceUrl"], books_cache)
        if meta:
            entry["bookMeta"] = meta
            book_attached += 1
        if (i + 1) % 25 == 0:
            save_books_cache(books_cache)
            print(f"    progress: {i+1}/{len(book_candidates)} ({book_attached} attached)")
    save_books_cache(books_cache)
    print(f"  book metadata attached: {book_attached}")

    # ── Movie / TV poster pass (Wikidata P18 → Commons FilePath) ──────
    # Analogous to the book pass: fetch the canonical poster image so the
    # card icon shows the DVD/theatrical artwork instead of whatever
    # Wikipedia happened to put in its summary thumbnail.
    MOVIE_TYPES = {"Movie", "Movie Series", "TV Series", "TV Episode"}
    movies_cache = load_movies_cache()
    print(f"  fetching movie posters (cache has {len(movies_cache)} entries)…")
    movie_candidates = [
        e for e in entries
        if e.get("garden_type") in MOVIE_TYPES
        and e.get("sourceUrl")
        and "wikipedia.org" in e["sourceUrl"]
    ]
    print(f"  {len(movie_candidates)} movie/TV entries to check")
    movie_attached = 0
    for i, entry in enumerate(movie_candidates):
        poster = fetch_movie_poster(entry["sourceUrl"], movies_cache)
        if poster:
            # Override portraitUrl — P18 is more reliable than the summary thumb
            entry["portraitUrl"] = poster
            movie_attached += 1
        if (i + 1) % 25 == 0:
            save_movies_cache(movies_cache)
            print(f"    progress: {i+1}/{len(movie_candidates)} ({movie_attached} attached)")
    save_movies_cache(movies_cache)
    print(f"  movie posters attached: {movie_attached}")

    # ── YouTube creator pass (via oEmbed) ──────
    yt_cache = load_yt_cache()
    print(f"  fetching YouTube creators (cache has {len(yt_cache)} entries)…")
    yt_candidates = [e for e in entries if e.get("youtubeId")]
    print(f"  {len(yt_candidates)} YouTube videos to check")
    yt_attached = 0
    for i, entry in enumerate(yt_candidates):
        info = fetch_youtube_creator(entry["youtubeId"], yt_cache)
        if info and info.get("name"):
            entry["youtubeCreator"] = info["name"]
            if info.get("url"):
                entry["youtubeCreatorUrl"] = info["url"]
            yt_attached += 1
        if (i + 1) % 50 == 0:
            save_yt_cache(yt_cache)
            print(f"    progress: {i+1}/{len(yt_candidates)} ({yt_attached} attached)")
    save_yt_cache(yt_cache)
    print(f"  YouTube creators attached: {yt_attached}")

    # ── Cross-card entity mentions from each body ──────
    # Scan every card's body (full transcript) and find which OTHER Garden
    # titles appear. Stored as `extractedEntities: [id, ...]` on each entry.
    print(f"  scanning {len(entries)} bodies for cross-references…")
    by_title = {}
    for e in entries:
        t = (e["title"] or "").lower().strip()
        if len(t) >= 4:
            by_title.setdefault(t, []).append(e)

    sorted_titles = sorted(by_title.keys(), key=len, reverse=True)
    if sorted_titles:
        big_pattern = re.compile(
            r"\b(" + "|".join(re.escape(t) for t in sorted_titles) + r")\b",
            re.IGNORECASE,
        )
        cross_count = 0
        for entry in entries:
            rel = Path(entry["mdPath"][len("Garden/"):])
            try:
                text = (GARDEN_ROOT / rel).read_text(encoding="utf-8")
            except Exception:
                continue
            m = YAML_RE.match(text)
            body = m.group(2) if m else text
            body_lower = body.lower()
            self_title = (entry["title"] or "").lower().strip()
            found_ids = []
            seen = set()
            for match in big_pattern.finditer(body_lower):
                t = match.group(1).lower()
                if t == self_title or t in seen:
                    continue
                refs = by_title.get(t, [])
                if not refs:
                    continue
                # Pick the first matching card
                ref = refs[0]
                if ref["id"] == entry["id"]:
                    continue
                seen.add(t)
                found_ids.append(ref["id"])
                if len(found_ids) >= 60:  # cap to keep manifest reasonable
                    break
            if found_ids:
                entry["extractedEntities"] = found_ids
                cross_count += 1
        print(f"  {cross_count} entries got cross-card references")

    # ── Orphan-detection + stub-note generation ──────────────────────────
    # Goal: every Person / Organization / Place must be mentioned in at least
    # one notice. If no other entry references them (no backlinks), write a
    # synthetic "Wissen:<title>" markdown stub into PKM/Garden/_auto/ that
    # contains a Wikipedia-derived summary. The next manifest rebuild picks it
    # up and the cross-reference pass then connects the orphan into the graph.
    new_stubs = generate_orphan_stubs(entries)

    OUTPUT.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"OK: {len(entries)} entries written to {OUTPUT.name}")
    if skipped:
        print(f"  ({skipped} skipped due to read errors)")
    if new_stubs:
        print(f"")
        print(f"  → {new_stubs} Stub-Notizen generiert für sonst-verwaiste Entitäten.")
        print(f"  → Nächster Build hängt sie als reguläre Karten in den Garten ein.")
        print(f"  → Re-run: python {Path(__file__).name}")


# ────────────────────────────────────────────────────────────────────
# Orphan handling — Wikipedia-fetcher + stub markdown writer
# ────────────────────────────────────────────────────────────────────
ORPHAN_TYPES = {"Person", "Persons", "Organization", "Place"}
ORPHAN_DIR = GARDEN_ROOT / "_auto"


def fetch_wiki_full_extract(wiki_url: str) -> dict | None:
    """Fetch summary + full plaintext extract for a Wikipedia article. Returns
    {short, description, full, thumbnail, url} or None on failure."""
    m = WIKI_URL_RE.match(wiki_url)
    if not m:
        return None
    lang, page = m.group(1), m.group(2)
    out = {}
    try:
        # Summary endpoint (short extract + thumbnail + description)
        sum_data = _fetch_json(f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{page}")
        out["short"] = sum_data.get("extract", "") or ""
        out["description"] = sum_data.get("description", "") or ""
        out["thumbnail"] = (sum_data.get("thumbnail") or {}).get("source") or ""
        out["url"] = ((sum_data.get("content_urls") or {}).get("desktop") or {}).get("page") or wiki_url
        # Full plain-text extract via action=query
        ext_data = _fetch_json(
            f"https://{lang}.wikipedia.org/w/api.php"
            f"?action=query&prop=extracts&explaintext&titles={page}&format=json&redirects=1"
        )
        pages = (ext_data.get("query") or {}).get("pages") or {}
        first = next(iter(pages.values()), {}) if pages else {}
        out["full"] = (first.get("extract") or "")[:5000]   # cap so stubs stay manageable
        return out
    except Exception as e:
        print(f"    ! orphan fetch {page[:40]}: {type(e).__name__}: {str(e)[:80]}")
        return None


def generate_orphan_stubs(entries: list) -> int:
    """For every Person/Org/Place not referenced by any other entry, fetch
    its Wikipedia content and write a stub markdown into PKM/Garden/_auto/.
    Returns the number of NEW stubs written this run."""
    # Build the set of ids referenced by anyone else
    referenced = set()
    for e in entries:
        for ref_id in (e.get("extractedEntities") or []):
            referenced.add(ref_id)
    # Filter to orphans that have a Wikipedia source we can use
    orphans = [
        e for e in entries
        if e.get("garden_type") in ORPHAN_TYPES
        and e.get("id") not in referenced
        and e.get("sourceUrl") and "wikipedia.org" in (e.get("sourceUrl") or "")
    ]
    if not orphans:
        return 0
    print(f"  {len(orphans)} verwaiste Entitäten gefunden — generiere Stubs…")
    ORPHAN_DIR.mkdir(exist_ok=True)
    written = 0
    for i, orph in enumerate(orphans):
        # Stable filename based on entry id so re-runs don't duplicate
        slug = re.sub(r"[^\w\-]+", "-", (orph.get("title") or "").lower()).strip("-")[:80]
        fname = f"orphan-{orph['id']}-{slug or 'entity'}.md"
        fpath = ORPHAN_DIR / fname
        if fpath.exists():
            continue
        data = fetch_wiki_full_extract(orph["sourceUrl"])
        if not data or not (data.get("short") or data.get("full")):
            print(f"    ! kein Wikipedia-Inhalt für „{orph.get('title')}" — übersprungen")
            time.sleep(0.4)
            continue
        # Build a journal-style markdown body. Including the orphan's title
        # in the H1 + body text means the next cross-ref scan will connect
        # this stub back to the orphan card automatically.
        title = orph.get("title") or "Unbekannt"
        gtype = orph.get("garden_type") or "Entity"
        today = datetime.now().strftime("%Y-%m-%d")
        body = (
            f"---\n"
            f"title: \"Wissen: {title}\"\n"
            f"tags:\n"
            f"  - auto\n"
            f"  - {gtype.lower()}\n"
            f"  - reference\n"
            f"createdAt: \"{today}T00:00:00.000Z\"\n"
            f"updatedAt: \"{today}T00:00:00.000Z\"\n"
            f"---\n\n"
            f"# {title}\n\n"
            f"*{data.get('description', '')}*\n\n"
            f"## Kurzfassung\n\n{(data.get('short') or '').strip()}\n\n"
            f"## Detailzusammenfassung\n\n{(data.get('full') or '').strip()[:1500]}\n\n"
            f"## Vollbeschreibung\n\n{(data.get('full') or '').strip()}\n\n"
            f"## Quelle\n\n- [{title} auf Wikipedia]({data.get('url', orph['sourceUrl'])})\n\n"
            f"---\n\n"
            f"*Auto-generiert beim Manifest-Build, da {title} ({gtype}) "
            f"in keiner anderen Notiz erwähnt war. Diese Stub-Notiz hält die Verbindung "
            f"in der Wissens-Datenbank lebendig.*\n"
        )
        try:
            fpath.write_text(body, encoding="utf-8")
            written += 1
            if (i + 1) % 5 == 0:
                print(f"    progress: {i+1}/{len(orphans)} ({written} geschrieben)")
        except Exception as e:
            print(f"    ! write fail {fname}: {e}")
        time.sleep(0.6)  # rate-limit Wikipedia
    print(f"  ✓ {written} neue Stubs in {ORPHAN_DIR.relative_to(GARDEN_ROOT.parent)}/")
    return written


if __name__ == "__main__":
    main()
