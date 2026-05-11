// Cookbooks endpoint — store + retrieve whole cookbook PDFs.
//   GET  /api/cookbooks            → list all (no pdf_b64, just metadata)
//   GET  /api/cookbooks?id=N&full=1 → single book WITH pdf_b64 for viewer
//   POST /api/cookbooks            → upload new { title, author, source,
//                                     servings_base, pdf_b64, chapters? }
//   DELETE /api/cookbooks?id=N     → remove
//
// PDFs are stored as base64 in the cookbooks.pdf_b64 column for now.
// Works fine up to ~10MB which covers most personal cookbooks. Larger
// books should be moved to R2 in a follow-up.

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
      const cols = full
        ? 'id, slug, title, author, description, pdf_b64, pdf_size_kb, page_count, chapters_json, source, logo_url, servings_base, created_at'
        : 'id, slug, title, author, description, pdf_size_kb, page_count, chapters_json, source, logo_url, servings_base, created_at';
      const row = await env.DB.prepare('SELECT ' + cols + ' FROM cookbooks WHERE id = ?').bind(id).first();
      if (!row) return json({ error: 'Not found' }, 404);
      let chapters = null;
      try { chapters = row.chapters_json ? JSON.parse(row.chapters_json) : null; } catch(_) {}
      return json({ ok: true, cookbook: { ...row, chapters } });
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
  // Sane size cap — D1 row limit is 1MB but we'll allow ~25MB base64 (~18MB PDF)
  if (pdf_b64.length > 25_000_000) return json({ error: 'PDF too large (max ~18MB). Move to R2 for bigger.' }, 413);
  const pdf_size_kb = Math.round(pdf_b64.length * 0.75 / 1024);

  const slug = slugify(title) + '-' + Date.now().toString(36);
  const chapters = Array.isArray(body.chapters) ? body.chapters : null;
  try {
    const r = await env.DB.prepare(
      'INSERT INTO cookbooks (slug, title, author, description, pdf_b64, pdf_size_kb, page_count, chapters_json, source, logo_url, servings_base) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      slug, title,
      body.author || null,
      body.description || null,
      pdf_b64, pdf_size_kb,
      Number.isInteger(body.page_count) ? body.page_count : null,
      chapters ? JSON.stringify(chapters) : null,
      body.source || null,
      body.logo_url || null,
      Number.isInteger(body.servings_base) ? body.servings_base : 4,
    ).run();
    return json({ ok: true, id: r.meta?.last_row_id, slug, title, pdf_size_kb });
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
    await env.DB.prepare('DELETE FROM cookbooks WHERE id = ?').bind(id).run();
    return json({ ok: true, deleted_id: id });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}
