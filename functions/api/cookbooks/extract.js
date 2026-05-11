// Bulk recipe extraction: takes a cookbook (PDF stored as chunks in
// cookbook_chunks), reassembles the binary, SPLITS into ≤95-page
// sub-PDFs with pdf-lib (Anthropic caps at 100 pages per request),
// sends each chunk to Claude as a `document` attachment, asks for
// recipes as a JSON array, merges + inserts.
//
// POST /api/cookbooks/extract?id=N
// Body: { max_recipes?: number, dry_run?: boolean,
//         start_chunk?: number, max_chunks?: number }

import { loadCookbookB64 } from '../../_lib/pdf-chunks.js';
import { PDFDocument } from 'pdf-lib';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const PAGES_PER_CHUNK = 95;  // Anthropic limit is 100; leave safety margin

// Decode base64 → Uint8Array (Workers don't have Buffer)
function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
// Encode Uint8Array → base64 (chunked to avoid stack overflow)
function bytesToB64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Split a PDF binary into chunks of N pages, return [{ startPage,
// endPage, b64 }] — startPage/endPage are 1-based, inclusive.
async function splitPdfIntoChunks(pdfBytes, pagesPerChunk) {
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const total = src.getPageCount();
  const chunks = [];
  for (let start = 0; start < total; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, total);
    const sub = await PDFDocument.create();
    const indices = [];
    for (let i = start; i < end; i++) indices.push(i);
    const copied = await sub.copyPages(src, indices);
    copied.forEach(p => sub.addPage(p));
    const bytes = await sub.save();
    chunks.push({ startPage: start + 1, endPage: end, b64: bytesToB64(bytes) });
  }
  return { totalPages: total, chunks };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || ('recipe-' + Date.now());
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

  const url = new URL(request.url);
  const cookbookId = parseInt(url.searchParams.get('id'), 10);
  if (!Number.isInteger(cookbookId) || cookbookId <= 0) return json({ error: 'id query param required' }, 400);

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const maxRecipes = Math.min(Math.max(parseInt(body.max_recipes, 10) || 200, 1), 500);
  const dryRun = body.dry_run === true;
  const startChunk = Math.max(0, parseInt(body.start_chunk, 10) || 0);
  const maxChunks = Math.max(1, Math.min(20, parseInt(body.max_chunks, 10) || 3));

  // Load the cookbook metadata + reassemble PDF bytes from chunks
  const book = await env.DB.prepare(
    'SELECT id, title, source, servings_base FROM cookbooks WHERE id = ?'
  ).bind(cookbookId).first();
  if (!book) return json({ error: 'Cookbook not found' }, 404);
  const fullB64 = await loadCookbookB64(env, cookbookId);
  if (!fullB64) return json({ error: 'Cookbook has no PDF body (no chunks)' }, 400);

  // Split into ≤95-page sub-PDFs because Anthropic limits 100 pages.
  let pdfChunks;
  try {
    const pdfBytes = b64ToBytes(fullB64);
    const splitResult = await splitPdfIntoChunks(pdfBytes, PAGES_PER_CHUNK);
    pdfChunks = splitResult.chunks;
    if (pdfChunks.length === 1) {
      // Whole PDF fits — same path as before, no need to mention chunking
    }
  } catch (e) {
    return json({ error: 'PDF splitting failed: ' + (e.message || e) }, 500);
  }

  const baseServings = book.servings_base || 100;
  const sourceLabel = book.source || book.title;

  const system = `Du extrahierst ALLE Rezepte aus einem Kochbuch-PDF und gibst sie als JSON-Array zurück. Sprache: **Deutsch**.

Antwort EXAKT in dieser Form (KEIN Text drumherum, KEIN \`\`\`json-Block — pures JSON-Array):

[
  {
    "title": "Knapper Rezept-Titel (max 80 Zeichen)",
    "page": 23,
    "preview": "Kurze 1-Satz-Einleitung max 200 Zeichen",
    "detailed": "Beschreibung 300-600 Zeichen, 2-3 Sätze, worum es geht",
    "garden_type": "Recipe",
    "topics": ["military","suppe","hauptgang"],
    "recipe": {
      "servings": ${baseServings},
      "total_minutes": 60,
      "prep_minutes": 15,
      "cook_minutes": 45,
      "location": "Herd, Backofen",
      "equipment": ["Topf 50L","Schöpfkelle"],
      "ingredients": ["10 kg Kartoffeln","5 kg Zwiebeln","30 l Wasser","Salz nach Bedarf"],
      "steps": ["Kartoffeln schälen und würfeln","Zwiebeln klein hacken","Alles in Wasser geben und 30 Min kochen"],
      "calories_per_serving": null,
      "protein_g": null,
      "carbs_g": null,
      "fat_g": null,
      "tags": ["suppe","gemüse"],
      "notes": "Optionale Anmerkungen / Variationen"
    }
  }
]

WICHTIGE REGELN:
- ALLE Rezepte aus dem Dokument extrahieren (bis max ${maxRecipes}).
- "servings" pro Rezept ist die Basis-Personenzahl wie im Original (für Militärküchen-Bücher ist das typischerweise ${baseServings}).
- "page" = PDF-Seitenzahl des Rezepts (1-basiert).
- ingredients[] PFLICHT: ganze Zeilen wie "10 kg Kartoffeln", "Salz nach Bedarf". Nicht in Komponenten zerlegen.
- steps[] PFLICHT: Zubereitungsschritte als ganze Sätze.
- Nährwerte: nur wenn im Original explizit angegeben — sonst null.
- KEIN Index, KEINE Inhaltsverzeichnis-Einträge, KEINE Kapitel-Überschriften ohne Rezept-Inhalt.
- Wenn das Dokument KEINE Rezepte enthält oder unleserlich ist: leeres Array [] zurückgeben.
- Antwort startet mit [ und endet mit ]. Sonst NICHTS.`;

  // Process the requested chunk range (default: chunks startChunk
  // through startChunk+maxChunks-1). Cloudflare Pages free tier has a
  // ~30s CPU limit so we cap at a few chunks per call. The browser
  // calls this endpoint repeatedly with start_chunk advancing until
  // all chunks are done.
  const chunkRange = pdfChunks.slice(startChunk, startChunk + maxChunks);
  const allParsedRecipes = [];
  const chunkResults = [];

  for (let ci = 0; ci < chunkRange.length; ci++) {
    const chunk = chunkRange[ci];
    const chunkLabel = `Seiten ${chunk.startPage}-${chunk.endPage}`;
    const userText = `Extrahiere alle Rezepte aus diesem PDF-Ausschnitt (${chunkLabel} des Originals). Quelle: "${sourceLabel}". Basis-Personenzahl: ${baseServings}. WICHTIG: "page" in deiner Antwort = die ORIGINAL-Seitenzahl im Gesamt-PDF (also addiere ${chunk.startPage - 1} zur Seite innerhalb dieses Chunks).`;
    let apiRes;
    try {
      apiRes = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          system,
          max_tokens: 16384,
          messages: [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: chunk.b64 } },
              { type: 'text', text: userText },
            ],
          }],
        }),
      });
    } catch (e) {
      chunkResults.push({ chunk: startChunk + ci, error: 'Request failed: ' + (e.message || e) });
      continue;
    }
    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      chunkResults.push({ chunk: startChunk + ci, error: 'HTTP ' + apiRes.status + ': ' + errBody.slice(0, 200) });
      continue;
    }
    const data = await apiRes.json();
    const txt = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    let jsonStr = txt;
    if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
    const a = jsonStr.indexOf('[');
    const b = jsonStr.lastIndexOf(']');
    if (a >= 0 && b > a) jsonStr = jsonStr.slice(a, b + 1);
    let parsed;
    try { parsed = JSON.parse(jsonStr); }
    catch (e) {
      chunkResults.push({ chunk: startChunk + ci, error: 'non-JSON: ' + txt.slice(0, 200) });
      continue;
    }
    if (!Array.isArray(parsed)) {
      chunkResults.push({ chunk: startChunk + ci, error: 'not an array' });
      continue;
    }
    chunkResults.push({ chunk: startChunk + ci, pages: chunkLabel, recipes_found: parsed.length });
    for (const r of parsed) allParsedRecipes.push(r);
    if (allParsedRecipes.length >= maxRecipes) break;
  }

  const hasMore = (startChunk + chunkRange.length) < pdfChunks.length;
  const nextChunk = hasMore ? (startChunk + chunkRange.length) : null;

  if (dryRun) {
    return json({
      ok: true, dry_run: true,
      total_chunks: pdfChunks.length,
      processed_chunks: chunkRange.length,
      next_chunk: nextChunk,
      extracted: allParsedRecipes.length,
      recipes: allParsedRecipes.slice(0, 10).map(r => ({ title: r.title, page: r.page })),
      chunk_results: chunkResults,
    });
  }

  if (allParsedRecipes.length === 0) {
    return json({
      ok: true,
      total_chunks: pdfChunks.length,
      processed_chunks: chunkRange.length,
      next_chunk: nextChunk,
      extracted: 0, inserted: 0,
      message: 'No recipes found in this chunk range.',
      chunk_results: chunkResults,
    });
  }

  const parsed = allParsedRecipes.slice(0, maxRecipes);

  // Insert each recipe
  const insertedIds = [];
  const errors = [];
  for (const r of parsed.slice(0, maxRecipes)) {
    if (!r?.title || !r.recipe?.ingredients?.length || !r.recipe?.steps?.length) {
      errors.push({ title: r?.title, reason: 'Missing required fields' });
      continue;
    }
    const recipe = {
      servings:      Number.isInteger(r.recipe.servings)      ? r.recipe.servings      : baseServings,
      total_minutes: Number.isInteger(r.recipe.total_minutes) ? r.recipe.total_minutes : null,
      prep_minutes:  Number.isInteger(r.recipe.prep_minutes)  ? r.recipe.prep_minutes  : null,
      cook_minutes:  Number.isInteger(r.recipe.cook_minutes)  ? r.recipe.cook_minutes  : null,
      location:      typeof r.recipe.location === 'string'   ? r.recipe.location      : null,
      equipment:     Array.isArray(r.recipe.equipment) ? r.recipe.equipment.filter(Boolean) : [],
      ingredients:   r.recipe.ingredients.filter(Boolean),
      steps:         r.recipe.steps.filter(Boolean),
      calories_per_serving: Number.isInteger(r.recipe.calories_per_serving) ? r.recipe.calories_per_serving : null,
      protein_g:     Number.isInteger(r.recipe.protein_g) ? r.recipe.protein_g : null,
      carbs_g:       Number.isInteger(r.recipe.carbs_g) ? r.recipe.carbs_g : null,
      fat_g:         Number.isInteger(r.recipe.fat_g) ? r.recipe.fat_g : null,
      tags:          Array.isArray(r.recipe.tags) ? r.recipe.tags.filter(Boolean) : [],
      notes:         typeof r.recipe.notes === 'string' ? r.recipe.notes : '',
    };
    const meta = {
      recipe,
      cookbook_id: book.id,
      cookbook_title: book.title,
      cookbook_page: Number.isInteger(r.page) ? r.page : null,
    };
    const bodyParts = [];
    bodyParts.push(`Aus „${book.title}" (S. ${meta.cookbook_page || '?'}). Basis: ${recipe.servings} Personen.`);
    if (recipe.total_minutes) bodyParts.push(`Gesamtzeit: ${recipe.total_minutes} Min.`);
    if (recipe.location) bodyParts.push(`Wo: ${recipe.location}.`);
    if (recipe.equipment.length) bodyParts.push(`Geräte: ${recipe.equipment.join(', ')}.`);
    bodyParts.push('', 'Zutaten:');
    recipe.ingredients.forEach(i => bodyParts.push('  • ' + i));
    bodyParts.push('', 'Zubereitung:');
    recipe.steps.forEach((s, i) => bodyParts.push((i + 1) + '. ' + s));
    if (recipe.notes) { bodyParts.push('', 'Notizen: ' + recipe.notes); }
    const bodyText = bodyParts.join('\n');
    const slug = slugify(r.title) + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random()*1000);
    const tags = Array.isArray(r.topics) ? r.topics.join(',') : '';

    try {
      const ins = await env.DB.prepare(
        'INSERT INTO notes (slug, title, body, note_type, related_topics, source_meta, garden_type, cookbook_id, cookbook_page, servings_base) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        slug, r.title, bodyText, 'recipe', tags,
        JSON.stringify(meta), 'Recipe',
        book.id, meta.cookbook_page, baseServings
      ).run();
      insertedIds.push(ins.meta?.last_row_id);
    } catch (e) {
      errors.push({ title: r.title, reason: e.message || String(e) });
    }
  }

  return json({
    ok: true,
    cookbook_id: book.id,
    cookbook_title: book.title,
    total_chunks: pdfChunks.length,
    processed_chunks: chunkRange.length,
    next_chunk: nextChunk,
    extracted: parsed.length,
    inserted: insertedIds.length,
    errors,
    sample: parsed.slice(0, 3).map(r => ({ title: r.title, page: r.page, servings: r.recipe?.servings })),
    chunk_results: chunkResults,
  });
}

export async function onRequest({ request }) {
  return new Response('POST only', { status: 405, headers: { 'Allow': 'POST' } });
}
