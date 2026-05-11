// Cookbooks endpoint — store + retrieve whole cookbook PDFs.
//   GET  /api/cookbooks            → list all (no pdf_b64, just metadata)
//   GET  /api/cookbooks?id=N&full=1 → single book WITH pdf_b64 reassembled
//   POST /api/cookbooks            → upload new { title, author, source,
//                                     servings_base, pdf_b64, chapters? }
//   DELETE /api/cookbooks?id=N     → remove (incl. all chunks)
//
// PDFs are stored CHUNKED in cookbook_chunks (700 KB pieces) because
// D1 caps each TEXT cell at ~1 MB. 2-3 MB PDFs that crashed the single-
// column approach now split into 3-5 chunks transparently.

import { saveCookbookChunks, loadCookbookB64, deleteCookbookChunks } from '../_lib/pdf-chunks.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || ('cookbook-' + Date.now());
}

export async function onRequestGet({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id'), 10);
  const full = url.searchParams.get('full') === '1';
  try {
    if (Number.isInteger(id) && id > 0) {
      const row = await env.DB.prepare(
        'SELECT id, slug, title, author, description, pdf_size_kb, page_count, chapters_json, source, logo_url, servings_base, created_at FROM cookbooks WHERE id = ?'
      ).bind(id).first();
      if (!row) return json({ error: 'Not found' }, 404);
      let chapters = null;
      try { chapters = row.chapters_json ? JSON.parse(row.chapters_json) : null; } catch(_) {}
      // Reassemble PDF bytes from chunks only when full=1 is requested
      // (the viewer + extractor need it; the list view does not).
      let pdf_b64 = null;
      if (full) pdf_b64 = await loadCookbookB64(env, id);
      return json({ ok: true, cookbook: { ...row, chapters, pdf_b64 } });
    }
    const rows = await env.DB.prepare(
      'SELECT id, slug, title, author, description, pdf_size_kb, page_count, source, logo_url, servings_base, created_at FROM cookbooks ORDER BY title COLLATE NOCASE ASC'
    ).all();
    return json({ ok: true, count: rows.results.length, cookbooks: rows.results });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const title = (body.title || '').trim();
  if (!title) return json({ error: 'title required' }, 400);
  const pdf_b64 = typeof body.pdf_b64 === 'string' ? body.pdf_b64 : '';
  if (!pdf_b64) return json({ error: 'pdf_b64 required' }, 400);
  // Total size cap — 25 MB base64 (~18 MB PDF). Each row is now small
  // because we chunk, so the limit is governed by total D1 storage.
  if (pdf_b64.length > 25_000_000) return json({ error: 'PDF too large (max ~18MB).' }, 413);
  const pdf_size_kb = Math.round(pdf_b64.length * 0.75 / 1024);

  const slug = slugify(title) + '-' + Date.now().toString(36);
  const chapters = Array.isArray(body.chapters) ? body.chapters : null;
  try {
    // INSERT the metadata row first WITHOUT the PDF body (legacy pdf_b64
    // column stays NULL); then chunk-write the actual bytes.
    const r = await env.DB.prepare(
      'INSERT INTO cookbooks (slug, title, author, description, pdf_size_kb, page_count, chapters_json, source, logo_url, servings_base) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      slug, title,
      body.author || null,
      body.description || null,
      pdf_size_kb,
      Number.isInteger(body.page_count) ? body.page_count : null,
      chapters ? JSON.stringify(chapters) : null,
      body.source || null,
      body.logo_url || null,
      Number.isInteger(body.servings_base) ? body.servings_base : 4,
    ).run();
    const newId = r.meta?.last_row_id;
    if (!newId) throw new Error('Could not get inserted cookbook id');
    const chunkCount = await saveCookbookChunks(env, newId, pdf_b64);
    return json({ ok: true, id: newId, slug, title, pdf_size_kb, chunks: chunkCount });
  } catch (e) {
    return json({ error: 'D1 insert failed: ' + (e.message || e) }, 500);
  }
}

export async function onRequestDelete({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'id required' }, 400);
  try {
    await deleteCookbookChunks(env, id);
    await env.DB.prepare('DELETE FROM cookbooks WHERE id = ?').bind(id).run();
    return json({ ok: true, deleted_id: id });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}
