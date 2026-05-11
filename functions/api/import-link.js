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

// ── YouTube: scrape transcript via the watch page ────────────
// YouTube doesn't expose transcripts via the public Data API on the free
// tier, but the watch-page HTML embeds ytInitialPlayerResponse which
// includes a captionTracks array. Each track has a baseUrl returning XML.
async function fetchYouTubeTranscript(videoId) {
  const watchUrl = 'https://www.youtube.com/watch?v=' + videoId;
  const html = await fetch(watchUrl, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de,en;q=0.7' } })
    .then(r => r.ok ? r.text() : null);
  if (!html) return { error: 'YouTube watch-page unreachable' };

  // Extract ytInitialPlayerResponse JS variable
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});/);
  if (!m) return { error: 'ytInitialPlayerResponse not found — page format changed?' };
  let data;
  try { data = JSON.parse(m[1]); }
  catch (e) { return { error: 'Could not parse ytInitialPlayerResponse: ' + e.message }; }

  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return { error: 'no_captions', message: 'Video hat keine Auto-Untertitel — kein Transkript verfügbar.' };
  }
  // Prefer German, then English, then first available
  const track = tracks.find(t => t.languageCode === 'de')
             || tracks.find(t => t.languageCode === 'en')
             || tracks[0];
  if (!track?.baseUrl) return { error: 'Caption track without baseUrl' };

  const xml = await fetch(track.baseUrl, { headers: { 'User-Agent': UA } })
    .then(r => r.ok ? r.text() : null);
  if (!xml) return { error: 'Caption XML unreachable' };

  // Parse <text start="6.5" dur="3.2">line</text> entries
  const entries = [];
  const rx = /<text[^>]*start="([^"]+)"[^>]*dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let mm;
  while ((mm = rx.exec(xml))) {
    const txt = mm[3]
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').trim();
    if (!txt) continue;
    entries.push({ start: parseFloat(mm[1]), duration: parseFloat(mm[2]), text: txt });
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

// ── Main handler ─────────────────────────────────────────────
export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  if (!env.DB) return json({ error: 'D1 binding env.DB missing' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const url = (body.url || '').trim();
  if (!url) return json({ error: 'url required' }, 400);
  if (!/^https?:\/\//i.test(url)) return json({ error: 'url must start with http:// or https://' }, 400);

  // Detect type
  const ytId = ytIdFromUrl(url);
  const kind = ytId ? 'youtube' : 'website';

  // Fetch source content
  let analysisInput;
  let sourceMeta = {};
  if (kind === 'youtube') {
    const [oembed, transcript] = await Promise.all([
      fetchYouTubeOEmbed(url),
      fetchYouTubeTranscript(ytId),
    ]);
    if (transcript.error === 'no_captions') {
      return json({ error: transcript.message }, 422);
    }
    if (transcript.error) {
      return json({ error: 'Transcript fetch failed: ' + transcript.error }, 502);
    }
    if (!transcript.entries || transcript.entries.length === 0) {
      return json({ error: 'Transcript empty — video may have only music or speech recognition failed.' }, 422);
    }
    analysisInput = {
      url, videoId: ytId, oembed,
      transcript: transcript.entries, language: transcript.language,
    };
    sourceMeta = {
      youtubeId: ytId,
      youtubeCreator: oembed?.author_name || null,
      youtubeCreatorUrl: oembed?.author_url || null,
      thumbnailUrl: oembed?.thumbnail_url || null,
      transcriptLanguage: transcript.language,
      transcript: transcript.entries,  // full transcript stored for the Tab UI
    };
  } else {
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
    });
  } catch (e) {
    return json({ error: 'D1 insert failed: ' + (e.message || e) }, 500);
  }
}

export async function onRequest({ request }) {
  return new Response('POST only', { status: 405, headers: { 'Allow': 'POST' } });
}
