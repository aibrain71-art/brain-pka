// Public read-only endpoint: GET /api/notes
// Returns the user's notes from D1 (larry-db). Used by the browser UI
// to populate the entries list so notes created via voice show up after
// reload. Behind Cloudflare Access, so only the user's email gets in.

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
