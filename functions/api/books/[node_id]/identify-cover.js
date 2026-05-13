// POST /api/books/:node_id/identify-cover
// Phase 4b: camera-based cover identification using Claude Sonnet 4.6 vision.
//
// Flow:
//   1. Decode owner photo (base64 JSON body).
//   2. Rate-limit: max 1 call/minute per book via D1 `last_identify_ts`.
//   3. Vision-Call #1: extract metadata (title/author/ISBN/publisher/...) from photo.
//   4. Cover-Cascade: ISBN → Google Books → OpenLibrary → Amazon-ISBN10. Collect candidates.
//   5. Vision-Call #2 (only if >=2 candidates): pick the candidate that matches the photo.
//   6. If a candidate wins → set cover_image_url to that URL.
//      If no candidate matches → resize the owner photo and upload to R2; use that URL.
//   7. Persist via D1 UPDATE; return {ok, new_cover_url, source, confidence}.
//
// Owner-setup pre-checks: env.COVERS (R2 binding) and env.ANTHROPIC_API_KEY must exist.
// Both 503 with a clear error if missing — Devon-friendly so Larry can hand them to
// the owner one-shot.

const RATE_LIMIT_SECONDS = 60;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;   // 8 MB hard ceiling (browser upload guard)
const VISION_MODEL_DEFAULT = 'claude-sonnet-4-6';

// ────────────────────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────────────────────
export async function onRequestPost({ env, params, request }) {
  // Owner setup pre-checks — fail fast, helpful messages.
  if (!env.DB) {
    return jsonError(500, 'D1 binding env.DB missing — contact Larry');
  }
  if (!env.COVERS) {
    return jsonError(
      503,
      'R2 bucket binding env.COVERS missing. ' +
      'Owner-setup: create R2 bucket "brain-pka-covers" in the Cloudflare dashboard ' +
      '(see https://dash.cloudflare.com/?to=/:account/r2/overview) and redeploy.',
    );
  }
  if (!env.ANTHROPIC_API_KEY) {
    return jsonError(
      503,
      'env.ANTHROPIC_API_KEY missing. ' +
      'Owner-setup: add ANTHROPIC_API_KEY as Encrypted variable in CF-Pages ' +
      '(see https://dash.cloudflare.com/?to=/:account/pages/view/brain-pka/settings/environment-variables) ' +
      'and redeploy.',
    );
  }

  const nodeId = String(params.node_id || '').trim();
  if (!nodeId) return jsonError(400, 'node_id required');

  // Parse + validate body.
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'invalid JSON body');
  }
  const imageDataUrl = body?.image;
  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    return jsonError(400, 'body.image must be a data:image/* base64 data URL');
  }
  const { mediaType, base64, bytes } = parseDataUrl(imageDataUrl);
  if (!mediaType || !base64) {
    return jsonError(400, 'malformed data URL');
  }
  if (bytes > MAX_PHOTO_BYTES) {
    return jsonError(413, `photo too large (${bytes} bytes, max ${MAX_PHOTO_BYTES})`);
  }

  // Fetch book row + apply rate-limit.
  const book = await env.DB
    .prepare('SELECT node_id, title, author, isbn, last_identify_ts FROM books WHERE node_id = ?')
    .bind(nodeId).first();
  if (!book) return jsonError(404, `book not found: ${nodeId}`);

  const now = Math.floor(Date.now() / 1000);
  if (book.last_identify_ts && (now - book.last_identify_ts) < RATE_LIMIT_SECONDS) {
    const waitSec = RATE_LIMIT_SECONDS - (now - book.last_identify_ts);
    return jsonError(429, `rate-limited — retry in ${waitSec}s`, { retry_after: waitSec });
  }

  // Stamp the rate-limit BEFORE the slow path so concurrent requests are blocked
  // even on long-running vision calls.
  await env.DB
    .prepare('UPDATE books SET last_identify_ts = ? WHERE node_id = ?')
    .bind(now, nodeId).run();

  const visionModel = env.MODEL_VISION || VISION_MODEL_DEFAULT;

  try {
    // ── Vision-Call #1 — extract metadata from the owner photo
    const meta = await extractMetadataFromPhoto(env.ANTHROPIC_API_KEY, visionModel, mediaType, base64, book);

    // ── Cover-Cascade — collect candidate cover URLs
    const candidates = await runCoverCascade(meta, book);

    // ── Decision matrix
    let chosen = null;       // { url, source }
    let confidence = 'fallback';

    if (candidates.length === 1) {
      chosen = candidates[0];
      confidence = 'single-candidate';
    } else if (candidates.length >= 2) {
      // Vision-Call #2 — let Claude pick the candidate that matches the photo
      const matchIdx = await pickMatchingCover(
        env.ANTHROPIC_API_KEY, visionModel, mediaType, base64, candidates,
      );
      if (matchIdx != null && matchIdx >= 0 && matchIdx < candidates.length) {
        chosen = candidates[matchIdx];
        confidence = 'vision-matched';
      } else {
        // Claude says "none" — fall through to owner-photo R2 upload.
        chosen = null;
      }
    }

    let finalUrl, finalSource;
    if (chosen) {
      finalUrl = chosen.url;
      finalSource = chosen.source;
    } else {
      // No candidate matched (or cascade returned 0) → store the owner photo in R2.
      const r2Url = await uploadOwnerPhotoToR2(env, nodeId, mediaType, base64);
      finalUrl = r2Url;
      finalSource = 'owner-photo';
      confidence = 'fallback';
    }

    // Persist
    await env.DB
      .prepare('UPDATE books SET cover_image_url = ?, updated_at = datetime(\'now\') WHERE node_id = ?')
      .bind(finalUrl, nodeId).run();

    return jsonOk({
      ok: true,
      new_cover_url: finalUrl,
      source: finalSource,
      confidence,
      candidates_considered: candidates.length,
      extracted_metadata: meta,
    });
  } catch (err) {
    // Console.error for CF tail logs; user gets a clean message.
    console.error('[identify-cover] error', err);
    return jsonError(500, `identify-cover failed: ${err.message || String(err)}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Vision-Call #1 — extract metadata from owner photo
// ────────────────────────────────────────────────────────────────────────────
async function extractMetadataFromPhoto(apiKey, model, mediaType, base64, fallbackBook) {
  const systemPrompt =
    'Du bist ein Assistent, der Buch-Cover analysiert. ' +
    'Antworte ausschliesslich mit gültigem JSON, ohne erklärenden Text und ohne Code-Fences.';

  const userText =
    'Extrahiere aus diesem Buch-Cover-Foto die folgenden Felder. ' +
    'Gib NUR ein JSON-Objekt zurück mit diesen Keys (Strings oder null wenn unklar/nicht sichtbar):\n' +
    '  - title: Buchtitel\n' +
    '  - author: Autor(en) (kombiniert, kommagetrennt falls mehrere)\n' +
    '  - isbn: ISBN-10 oder ISBN-13 falls sichtbar (nur Ziffern, ohne Bindestriche), sonst null\n' +
    '  - publisher: Verlag\n' +
    '  - edition: Auflage (z.B. "2. Auflage")\n' +
    '  - language: Sprache als ISO-639-1 Code ("de", "en", "fr", ...)\n' +
    '\nWenn du dir bei einem Feld unsicher bist, gib null zurück. Kein Raten.';

  const response = await callAnthropicMessages(apiKey, {
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: userText },
      ],
    }],
  });

  const text = extractTextFromMessage(response);
  let parsed;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch {
    // If Claude returned malformed JSON, fall back to the book row.
    parsed = {};
  }

  return {
    title: nonEmpty(parsed.title) || fallbackBook.title || null,
    author: nonEmpty(parsed.author) || fallbackBook.author || null,
    isbn: cleanIsbn(parsed.isbn) || cleanIsbn(fallbackBook.isbn) || null,
    publisher: nonEmpty(parsed.publisher) || null,
    edition: nonEmpty(parsed.edition) || null,
    language: nonEmpty(parsed.language) || null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Cover-Cascade — collect candidate URLs
// ────────────────────────────────────────────────────────────────────────────
async function runCoverCascade(meta, book) {
  const candidates = [];
  const isbn = cleanIsbn(meta.isbn) || cleanIsbn(book.isbn);

  // 1. Amazon-ISBN10 (largest scan, no API needed). Only works when ISBN is/contains an ISBN-10.
  if (isbn) {
    const isbn10 = isbnToIsbn10(isbn);
    if (isbn10) {
      // Amazon's _SL700_ pattern returns ~700px scans for most catalog items.
      candidates.push({
        url: `https://images-na.ssl-images-amazon.com/images/P/${isbn10}.01._SL700_.jpg`,
        source: 'amazon_isbn10',
      });
    }
  }

  // 2. Google Books — fast, generous, has thumbnail + small + medium variants.
  if (isbn) {
    try {
      const gb = await fetchJsonWithTimeout(
        `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`,
        4000,
      );
      const item = gb?.items?.[0];
      const links = item?.volumeInfo?.imageLinks || {};
      // Prefer the largest variant Google offers.
      const url = links.extraLarge || links.large || links.medium || links.thumbnail || links.smallThumbnail;
      if (url) {
        // Force HTTPS + drop edge=curl artifacts.
        const clean = url.replace(/^http:/, 'https:').replace(/&edge=curl/g, '');
        candidates.push({ url: clean, source: 'google_books' });
      }
    } catch (e) {
      console.warn('[cascade] google_books failed', e.message);
    }
  }

  // 3. OpenLibrary — covers by ISBN. Returns 1x1 pixel if not found, so we filter by size.
  if (isbn) {
    const olUrl = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
    try {
      const ok = await headCheckImage(olUrl, 2000);
      if (ok) candidates.push({ url: olUrl, source: 'openlibrary' });
    } catch (e) {
      console.warn('[cascade] openlibrary failed', e.message);
    }
  }

  // 4. (TODO Phase 4c: Springer + Amazon-DE-Scrape — both need HTML parsing
  //     which we skip on Workers to stay under CPU limit. Cascade falls back
  //     to owner-photo upload if none of 1-3 produced a match.)

  return candidates;
}

// ────────────────────────────────────────────────────────────────────────────
// Vision-Call #2 — multi-image cover match
// ────────────────────────────────────────────────────────────────────────────
async function pickMatchingCover(apiKey, model, ownerMediaType, ownerBase64, candidates) {
  // Build a single user message: owner photo first, then each candidate as a URL image.
  const content = [
    { type: 'image', source: { type: 'base64', media_type: ownerMediaType, data: ownerBase64 } },
    {
      type: 'text',
      text:
        'Das erste Bild ist ein Foto eines Buch-Covers (vom Besitzer aufgenommen). ' +
        'Die folgenden Bilder sind Cover-Kandidaten aus Online-Quellen. ' +
        'Bestimme, welches der Kandidaten-Cover dasselbe Buch in derselben Ausgabe zeigt ' +
        'wie das Owner-Foto (gleiches Titel-Layout, gleiche Typografie, gleiche Farben). ' +
        'Antworte AUSSCHLIESSLICH mit einer einzigen Zahl (0-basierter Index des Kandidaten) ' +
        'oder dem Wort "none" wenn KEIN Kandidat passt. Keine Erklärung, kein JSON.',
    },
  ];
  candidates.forEach((cand, i) => {
    content.push({ type: 'text', text: `Kandidat ${i}:` });
    content.push({ type: 'image', source: { type: 'url', url: cand.url } });
  });

  const response = await callAnthropicMessages(apiKey, {
    model,
    max_tokens: 16,
    messages: [{ role: 'user', content }],
  });

  const text = extractTextFromMessage(response).trim().toLowerCase();
  if (text === 'none' || text === '"none"') return null;
  const m = text.match(/\d+/);
  if (!m) return null;
  const idx = parseInt(m[0], 10);
  return Number.isFinite(idx) ? idx : null;
}

// ────────────────────────────────────────────────────────────────────────────
// R2 fallback — owner-photo upload
// ────────────────────────────────────────────────────────────────────────────
async function uploadOwnerPhotoToR2(env, nodeId, mediaType, base64) {
  const bytes = base64ToBytes(base64);
  const ext = mediaType === 'image/png' ? 'png' : 'jpg';
  const key = `owner/${nodeId}/${Date.now()}.${ext}`;
  await env.COVERS.put(key, bytes, {
    httpMetadata: { contentType: mediaType, cacheControl: 'public, max-age=31536000' },
  });
  // Public URL: requires bucket to have a public-access domain configured.
  // Convention: env.COVERS_PUBLIC_BASE override, else generic dev URL fallback.
  const base = env.COVERS_PUBLIC_BASE || 'https://covers.brain-pka.workers.dev';
  return `${base.replace(/\/$/, '')}/${key}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Anthropic Messages API call (raw HTTP — CF Workers don't ship the SDK)
// ────────────────────────────────────────────────────────────────────────────
async function callAnthropicMessages(apiKey, payload) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
  }
  return res.json();
}

function extractTextFromMessage(msg) {
  if (!msg?.content) return '';
  for (const block of msg.content) {
    if (block.type === 'text') return block.text || '';
  }
  return '';
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────
function parseDataUrl(dataUrl) {
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) return {};
  const base64 = m[2].replace(/\s/g, '');
  const bytes = Math.floor(base64.length * 0.75);
  return { mediaType: m[1], base64, bytes };
}

function base64ToBytes(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function stripJsonFences(text) {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  return t.trim();
}

function nonEmpty(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
}

function cleanIsbn(v) {
  if (!v) return null;
  const digits = String(v).replace(/[^\dXx]/g, '').toUpperCase();
  if (digits.length === 10 || digits.length === 13) return digits;
  return null;
}

function isbnToIsbn10(isbn) {
  if (!isbn) return null;
  if (isbn.length === 10) return isbn;
  if (isbn.length !== 13 || !isbn.startsWith('978')) return null;
  // Convert ISBN-13 (978-prefix only) to ISBN-10.
  const body = isbn.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(body[i], 10) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  const checkChar = check === 10 ? 'X' : String(check);
  return body + checkChar;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

async function headCheckImage(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    if (!res.ok) return false;
    // OpenLibrary returns 1×1 placeholder for missing covers. content-length < 1KB heuristic.
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    return len > 1024;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function jsonOk(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function jsonError(status, message, extra = {}) {
  return new Response(JSON.stringify({ ok: false, error: message, ...extra }), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
