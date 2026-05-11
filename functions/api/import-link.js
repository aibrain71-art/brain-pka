// Cloudflare Pages Function — POST /api/import-link
// Body: { url: "https://..." }
//
// Pipeline:
//   1. Detect URL type (YouTube vs Website)
//   2. Fetch source content:
//        YouTube  → oEmbed (title/creator) + captionTracks (transcript)
//        Website  → page HTML + extract main text
//   3. Call Claude (anthropic-version: 2023-06-01) with a structured prompt
//      that returns title, preview, detailed, garden_type, topics[], sections[]
//   4. Transform sections[] into the existing Markdown-style full_summary
//      with "## Heading" + "- Bullet [(MM:SS)](url&t=Xs)" links
//   5. INSERT into D1 notes table with source_url / source_type / source_meta
//   6. Return the new note row to the client
//
// Failure modes the client must show:
//   - "No transcript available" — auto-captions are off on this video
//   - "URL not reachable" — site blocks Cloudflare's egress
//   - Claude errors propagated with hint

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || ('link-' + Date.now());
}

function ytIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null;
    if (u.hostname.includes('youtube.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      // shorts/{id}, embed/{id}, v/{id}
      const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([A-Za-z0-9_-]{6,})/);
      if (m) return m[1];
    }
    return null;
  } catch { return null; }
}

// ── YouTube: fetch oEmbed metadata ────────────────────────────
async function fetchYouTubeOEmbed(url) {
  try {
    const r = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(url) + '&format=json');
    if (!r.ok) return null;
    return await r.json();  // { title, author_name, author_url, thumbnail_url, ... }
  } catch { return null; }
}

// ── YouTube transcript fetch ─────────────────────────────────
// Multi-step strategy because Cloudflare Workers' egress IPs are often
// blocked by YouTube's anti-bot rules on the public watch page:
//
//   Attempt 1: Innertube API (the JSON endpoint that YouTube's own
//              web client uses). Usually NOT blocked because it's the
//              same endpoint a real browser hits.
//   Attempt 2: Watch-page HTML scrape (fallback, classic approach).
//   Attempt 3: Hand back a clear "this approach is blocked" message
//              so the user knows they can paste the transcript manually.
async function fetchYouTubeTranscript(videoId) {
  // ── Attempt 1: Innertube /youtubei/v1/player ──
  // This endpoint speaks JSON natively. Default keys for the WEB client
  // are publicly known (extracted from youtube.com's own JS bundles).
  let captionTracks = null;
  let attemptErrors = [];

  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': '2.20240101.00.00',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240101.00.00',
            hl: 'de',
            gl: 'CH',
          },
        },
      }),
    });
    if (r.ok) {
      const data = await r.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks) && tracks.length) captionTracks = tracks;
      else attemptErrors.push('Innertube: response has no captionTracks (video has no captions or is restricted)');
    } else {
      attemptErrors.push('Innertube HTTP ' + r.status);
    }
  } catch (e) {
    attemptErrors.push('Innertube error: ' + (e?.message || e));
  }

  // ── Attempt 2: classic watch-page HTML scrape ──
  if (!captionTracks) {
    try {
      const watchUrl = 'https://www.youtube.com/watch?v=' + videoId;
      const html = await fetch(watchUrl, {
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      }).then(r => r.ok ? r.text() : null);
      if (!html) {
        attemptErrors.push('Watch-page unreachable (Cloudflare egress likely blocked by YouTube)');
      } else {
        const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});/);
        if (m) {
          try {
            const data = JSON.parse(m[1]);
            const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            if (Array.isArray(tracks) && tracks.length) captionTracks = tracks;
            else attemptErrors.push('Watch-page: no captionTracks in ytInitialPlayerResponse');
          } catch (e) {
            attemptErrors.push('Watch-page JSON parse failed: ' + e.message);
          }
        } else {
          attemptErrors.push('Watch-page: ytInitialPlayerResponse not present (page format changed or bot block)');
        }
      }
    } catch (e) {
      attemptErrors.push('Watch-page fetch error: ' + (e?.message || e));
    }
  }

  if (!captionTracks) {
    return {
      error: 'transcript_unavailable',
      message: 'Transkript konnte nicht geladen werden. YouTube blockt Cloudflare-Server-Requests aktiv. Mögliche Ursachen: (1) Video hat keine Untertitel, (2) Video ist altersbeschränkt oder privat, (3) YouTube blockt unsere IP. Versuche bei Bedarf einen anderen Link oder warte ein paar Stunden.',
      diagnostics: attemptErrors,
    };
  }

  // Prefer German, then English, then first available
  const track = captionTracks.find(t => t.languageCode === 'de')
             || captionTracks.find(t => t.languageCode === 'en')
             || captionTracks[0];
  if (!track?.baseUrl) return { error: 'Caption track without baseUrl', diagnostics: attemptErrors };

  // Force XML format if the URL specifies something else (sometimes "json3")
  let captionUrl = track.baseUrl;
  if (captionUrl.includes('fmt=')) captionUrl = captionUrl.replace(/fmt=[^&]+/, 'fmt=srv3');
  else captionUrl = captionUrl + (captionUrl.includes('?') ? '&' : '?') + 'fmt=srv3';

  const xml = await fetch(captionUrl, { headers: { 'User-Agent': UA } })
    .then(r => r.ok ? r.text() : null);
  if (!xml) return { error: 'Caption XML unreachable', diagnostics: attemptErrors };

  // Parse <text start="6.5" dur="3.2">line</text> entries.
  // srv3 format also has timedTextLatestRenderer, but srv1/srv3 XML works the same here.
  const entries = [];
  const rx = /<text[^>]*\bstart="([^"]+)"[^>]*\bdur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let mm;
  while ((mm = rx.exec(xml))) {
    const txt = mm[3]
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').trim();
    if (!txt) continue;
    entries.push({ start: parseFloat(mm[1]), duration: parseFloat(mm[2]), text: txt });
  }
  if (entries.length === 0) {
    return { error: 'Transcript XML parsed but empty — caption format unknown', diagnostics: attemptErrors };
  }
  return { entries, language: track.languageCode || 'unknown' };
}

// ── Website: fetch + extract main text ───────────────────────
// Minimal readability — strip script/style/nav/footer/aside and join the
// text content of body. Keeps headings + paragraphs. Not as smart as full
// Readability.js but good enough for most articles.
async function fetchWebsiteContent(url) {
  let html;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de,en;q=0.7' } });
    if (!r.ok) return { error: 'Site returned HTTP ' + r.status };
    html = await r.text();
  } catch (e) {
    return { error: 'Fetch failed: ' + (e.message || e) };
  }

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : null;

  // Extract OG description if present (more accurate than first paragraph)
  const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  const description = ogDescMatch ? ogDescMatch[1] : null;

  // Strip noise tags
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
  // Collapse all tags to spaces, decode common entities
  body = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();

  // Cap at 20k chars so Claude doesn't get a 5MB blob from cookie pages
  if (body.length > 20000) body = body.slice(0, 20000) + '\n\n[…content truncated to 20k chars…]';

  return { title, description, text: body };
}

// ── Claude: structured analysis ─────────────────────────────
async function analyseWithClaude(env, kind, payload) {
  // payload depends on kind:
  //   youtube  → { url, videoId, oembed, transcript: [{start, text}], language }
  //   website  → { url, title, description, text }
  const today = new Date().toISOString().slice(0, 10);

  let userText;
  if (kind === 'youtube') {
    const transcriptText = payload.transcript
      .map(e => `[${e.start.toFixed(1)}s] ${e.text}`)
      .join('\n');
    userText = [
      `YouTube-Video Import. URL: ${payload.url}`,
      `Titel laut YouTube: ${payload.oembed?.title || '(unknown)'}`,
      `Creator: ${payload.oembed?.author_name || '(unknown)'}`,
      `Sprache des Transkripts: ${payload.language}`,
      ``,
      `Volles Auto-Transkript (jede Zeile = ein Caption-Chunk mit Sekunden-Timestamp):`,
      transcriptText,
    ].join('\n');
  } else {
    userText = [
      `Website-Import. URL: ${payload.url}`,
      `<title>: ${payload.title || '(no title tag)'}`,
      `og:description: ${payload.description || '(none)'}`,
      ``,
      `Bereinigter Body-Text (Skripte/Nav/Footer entfernt):`,
      payload.text,
    ].join('\n');
  }

  const system = `Du analysierst importierte Inhalte (YouTube-Videos oder Webseiten) für die persönliche Wissensbank des Nutzers. Sprache der Ausgabe: **Deutsch**.

Liefere AUSSCHLIESSLICH ein einzelnes JSON-Objekt mit dieser Struktur:

{
  "title": "Polierter Titel (max 80 Zeichen, auf Deutsch wenn der Inhalt deutsch ist, sonst Originaltitel beibehalten)",
  "preview": "Kurze Einleitung, max 200 Zeichen, ein Satz",
  "detailed": "Ausführlichere Beschreibung, ca 400-600 Zeichen, 2-3 Sätze, sagt klar worum es geht",
  "garden_type": "Eine von: Business, Article, Book, Health, Tech, Politics, Science, History, Philosophy, Lifestyle, Finance, Education, Other",
  "topics": ["hierarchische pfade kleinbuchstaben mit slashes, z.B. business/leadership oder health/nutrition. 2-5 Tags."],
  "sections": [
    {
      "heading": "Section-Überschrift auf Deutsch (Sentence-Case)",
      "bullets": [
        ${kind === 'youtube' ? '{ "text": "Aussage als ganzer Satz auf Deutsch, paraphrasiert nicht wörtlich zitiert, ~50-200 Zeichen", "seconds": 6 }' : '{ "text": "Aussage als ganzer Satz auf Deutsch, paraphrasiert" }'}
      ]
    }
  ]
}

Regeln:
- ${kind === 'youtube' ? 'Bei YouTube IMMER "seconds" pro Bullet — nimm den Start-Timestamp der Caption-Zeile in der die Aussage beginnt.' : 'Bei Websites KEIN seconds-Feld.'}
- 4-8 Sections insgesamt, jede Section 2-5 Bullets.
- Bullets sind paraphrasiert (eigene Worte), nicht 1:1 zitiert.
- garden_type strikt eine der vorgegebenen Optionen.
- topics: hierarchische Slugs in Kleinbuchstaben, mit '/' getrennt, ohne Umlaute (ae/oe/ue/ss).
- Falls Inhalt englisch ist, übersetze die Bullets und Headings auf Deutsch (paraphrasiert).
- KEINE Erklärung vor oder nach dem JSON, KEIN \`\`\`json-Block — nur das pure JSON.

Heute: ${today}`;

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      system,
      messages: [{ role: 'user', content: userText }],
      max_tokens: 4096,
    }),
  });
  if (!r.ok) {
    const errBody = await r.text();
    throw new Error('Claude ' + r.status + ': ' + errBody.slice(0, 300));
  }
  const data = await r.json();
  const txt = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  // Tolerant JSON parse: strip ``` blocks if present, find first/last brace
  let jsonStr = txt;
  if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  const a = jsonStr.indexOf('{');
  const b = jsonStr.lastIndexOf('}');
  if (a >= 0 && b > a) jsonStr = jsonStr.slice(a, b + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    throw new Error('Claude returned non-JSON: ' + txt.slice(0, 300));
  }
}

// ── Markdown summary builder ─────────────────────────────────
// Transforms Claude's sections[] into the existing Garden style:
//   ## Heading
//   - Bullet text [(MM:SS)](url&t=Xs)
function buildFullSummary(sections, kind, sourceUrl) {
  const fmtSec = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    return (h > 0 ? String(h).padStart(2,'0') + ':' : '') +
           String(m).padStart(2,'0') + ':' + String(ss).padStart(2,'0');
  };
  const out = [];
  for (const sec of (sections || [])) {
    if (!sec?.heading || !Array.isArray(sec.bullets)) continue;
    out.push('## ' + sec.heading);
    for (const b of sec.bullets) {
      if (!b?.text) continue;
      if (kind === 'youtube' && typeof b.seconds === 'number' && sourceUrl) {
        const label = fmtSec(b.seconds);
        const linkUrl = sourceUrl + (sourceUrl.includes('?') ? '&' : '?') + 't=' + Math.floor(b.seconds) + 's';
        out.push('- ' + b.text.trim() + ' [(' + label + ')](' + linkUrl + ')');
      } else {
        out.push('- ' + b.text.trim());
      }
    }
    out.push('');
  }
  return out.join('\n').trim();
}

// ── Parser for a manually-pasted YouTube transcript ──────────
// YouTube's "Show transcript" button emits one of two formats:
//   format A — alternating timestamp / text lines:
//     0:00
//     Erster Satz
//     0:05
//     Zweiter Satz
//   format B — "MM:SS  Text" on one line (rarer)
// We accept both. If no recognisable timestamps are found, the whole
// blob becomes a single zero-timestamp entry (better than nothing —
// Claude still gets the content, just without per-line stops).
function parseManualTranscript(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const entries = [];
  const tsRe = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
  const inlineRe = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.+)$/;
  let i = 0;
  while (i < lines.length) {
    let m = inlineRe.exec(lines[i]);
    if (m) {
      const seconds = m[3]
        ? parseInt(m[1],10)*3600 + parseInt(m[2],10)*60 + parseInt(m[3],10)
        : parseInt(m[1],10)*60 + parseInt(m[2],10);
      entries.push({ start: seconds, duration: 0, text: m[4] });
      i++;
      continue;
    }
    m = tsRe.exec(lines[i]);
    if (m && i + 1 < lines.length) {
      const seconds = m[3]
        ? parseInt(m[1],10)*3600 + parseInt(m[2],10)*60 + parseInt(m[3],10)
        : parseInt(m[1],10)*60 + parseInt(m[2],10);
      entries.push({ start: seconds, duration: 0, text: lines[i+1] });
      i += 2;
      continue;
    }
    i++;
  }
  if (entries.length === 0 && text.trim().length > 20) {
    entries.push({ start: 0, duration: 0, text: text.trim() });
  }
  return entries;
}

// ── Main handler ─────────────────────────────────────────────
export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  if (!env.DB) return json({ error: 'D1 binding env.DB missing' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const url = (body.url || '').trim();
  if (!url) return json({ error: 'url required' }, 400);
  if (!/^https?:\/\//i.test(url)) return json({ error: 'url must start with http:// or https://' }, 400);

  const manualTranscript = typeof body.manual_transcript === 'string' ? body.manual_transcript : null;
  const saveAsBookmark = body.save_as_bookmark === true;

  // Detect type
  const ytId = ytIdFromUrl(url);
  const kind = ytId ? 'youtube' : 'website';

  // ── Bookmark-only path: skip transcript + Claude entirely ──
  if (saveAsBookmark) {
    let oembed = null;
    if (kind === 'youtube') oembed = await fetchYouTubeOEmbed(url);
    const title = (oembed?.title || url).slice(0, 200);
    const slug  = slugify(title) + '-' + Date.now().toString(36);
    const meta = {
      isBookmark: true,
      youtubeId: ytId || null,
      youtubeCreator: oembed?.author_name || null,
      youtubeCreatorUrl: oembed?.author_url || null,
      thumbnailUrl: oembed?.thumbnail_url || null,
    };
    const placeholderBody = '📖 Lesezeichen — kein Transkript verarbeitet. Inhalt kann später ergänzt werden indem das Transkript manuell eingefügt wird.';
    try {
      const r = await env.DB.prepare(
        'INSERT INTO notes (slug, title, body, note_type, source_url, source_type, source_meta, garden_type) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(slug, title, placeholderBody, 'bookmark', url, kind, JSON.stringify(meta), 'Bookmark').run();
      return json({
        ok: true,
        kind: 'bookmark',
        id: r.meta?.last_row_id, slug, title,
        message: 'Lesezeichen gespeichert (ohne Zusammenfassung).',
      });
    } catch (e) {
      return json({ error: 'D1 insert failed: ' + (e.message || e) }, 500);
    }
  }

  // ── Standard path: fetch transcript (auto OR manual), analyse, save ──
  let analysisInput;
  let sourceMeta = {};
  if (kind === 'youtube') {
    const oembed = await fetchYouTubeOEmbed(url);
    let transcriptEntries = null;
    let transcriptLang = 'unknown';
    let diagnostics = [];

    if (manualTranscript) {
      // User pasted transcript → parse + skip the auto-fetch entirely.
      transcriptEntries = parseManualTranscript(manualTranscript);
      transcriptLang = 'manual';
      if (transcriptEntries.length === 0) {
        return json({ error: 'Eingefügtes Transkript konnte nicht geparst werden (zu kurz / falsches Format).' }, 400);
      }
    } else {
      // Auto-fetch path
      const t = await fetchYouTubeTranscript(ytId);
      if (t.error) {
        // Surface the failure WITH metadata so the client can offer
        // "manual paste" / "save as bookmark" choices to the user.
        return json({
          status: 'transcript_unavailable',
          error: t.message || 'Transkript nicht verfügbar.',
          oembed: oembed ? {
            title: oembed.title,
            author_name: oembed.author_name,
            author_url: oembed.author_url,
            thumbnail_url: oembed.thumbnail_url,
          } : null,
          videoId: ytId,
          url,
          diagnostics: t.diagnostics || [],
        }, 422);
      }
      transcriptEntries = t.entries;
      transcriptLang = t.language || 'unknown';
    }

    if (!transcriptEntries || transcriptEntries.length === 0) {
      return json({ error: 'Transcript empty.' }, 422);
    }

    analysisInput = {
      url, videoId: ytId, oembed,
      transcript: transcriptEntries, language: transcriptLang,
    };
    sourceMeta = {
      youtubeId: ytId,
      youtubeCreator: oembed?.author_name || null,
      youtubeCreatorUrl: oembed?.author_url || null,
      thumbnailUrl: oembed?.thumbnail_url || null,
      transcriptLanguage: transcriptLang,
      transcript: transcriptEntries,
      transcriptSource: manualTranscript ? 'manual_paste' : 'auto_fetch',
    };
  } else {
    // Website import — same path as before
    const site = await fetchWebsiteContent(url);
    if (site.error) return json({ error: 'Website fetch failed: ' + site.error }, 502);
    analysisInput = { url, ...site };
    sourceMeta = { websiteTitle: site.title || null, websiteDescription: site.description || null };
  }

  // Run Claude analysis
  let analysis;
  try { analysis = await analyseWithClaude(env, kind, analysisInput); }
  catch (e) { return json({ error: 'Analysis failed: ' + (e.message || e) }, 502); }

  // Build the long-form markdown summary with timestamp links
  const full_summary = buildFullSummary(analysis.sections, kind, url);

  // Insert into D1
  const title = (analysis.title || analysisInput.oembed?.title || analysisInput.title || 'Untitled').slice(0, 200);
  const slug  = slugify(title) + '-' + Date.now().toString(36);
  const preview  = analysis.preview  || '';
  const detailed = analysis.detailed || '';
  const garden_type = analysis.garden_type || (kind === 'youtube' ? 'Video' : 'Article');
  const tags = Array.isArray(analysis.topics) ? analysis.topics.join(',') : '';

  try {
    const r = await env.DB.prepare(
      'INSERT INTO notes (slug, title, body, note_type, related_topics, source_url, source_type, source_meta, full_summary, garden_type) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      slug, title, detailed, kind, tags,
      url, kind, JSON.stringify(sourceMeta), full_summary, garden_type
    ).run();
    return json({
      ok: true,
      id: r.meta?.last_row_id,
      slug, title, preview, detailed, garden_type, topics: analysis.topics || [],
      sections_count: (analysis.sections || []).length,
      kind,
      transcript_source: manualTranscript ? 'manual_paste' : 'auto_fetch',
    });
  } catch (e) {
    return json({ error: 'D1 insert failed: ' + (e.message || e) }, 500);
  }
}

export async function onRequest({ request }) {
  return new Response('POST only', { status: 405, headers: { 'Allow': 'POST' } });
}
