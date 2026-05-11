// Public endpoint: GET /api/notes (list) + POST /api/notes (create)
// Both routes are behind Cloudflare Access, so only the user's email
// gets in. POST is used by the fullscreen markdown editor — voice
// creation still goes through /api/chat's create_note tool.

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || ('note-' + Date.now());
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return new Response(JSON.stringify({ error: 'D1 binding env.DB missing' }), {
    status: 500, headers: { 'Content-Type': 'application/json' },
  });
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  const title = (body.title || '').trim().slice(0, 200);
  const text  = typeof body.body === 'string' ? body.body : '';
  if (!title) return new Response(JSON.stringify({ error: 'title required' }), {
    status: 400, headers: { 'Content-Type': 'application/json' },
  });
  if (!text.trim()) return new Response(JSON.stringify({ error: 'body required' }), {
    status: 400, headers: { 'Content-Type': 'application/json' },
  });
  const slug = slugify(title) + '-' + Date.now().toString(36);
  const note_type = body.note_type || 'note';
  const tags = Array.isArray(body.tags) ? body.tags.join(',')
             : (typeof body.tags === 'string' ? body.tags : '');
  try {
    const r = await env.DB.prepare(
      'INSERT INTO notes (slug, title, body, note_type, related_topics) VALUES (?, ?, ?, ?, ?)'
    ).bind(slug, title, text, note_type, tags).run();
    return new Response(JSON.stringify({ ok: true, id: r.meta?.last_row_id, slug, title }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'D1 insert failed: ' + (e.message || e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}

export async function onRequestGet({ env, request }) {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 binding env.DB missing' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 100, 1), 500);

  try {
    const rows = await env.DB.prepare(
      'SELECT id, slug, title, body, note_type, related_topics, source_url, source_type, source_meta, full_summary, garden_type, created_at FROM notes ORDER BY created_at DESC LIMIT ?'
    ).bind(limit).all();
    return new Response(JSON.stringify({ ok: true, count: rows.results.length, notes: rows.results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
