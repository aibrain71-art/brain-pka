// Public read-only endpoint: GET /api/ideas
// Returns ideas from D1 (larry-db), newest first.

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
      'SELECT id, title, body, tags, status, created_at FROM ideas ORDER BY created_at DESC LIMIT ?'
    ).bind(limit).all();
    return new Response(JSON.stringify({ ok: true, count: rows.results.length, ideas: rows.results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
