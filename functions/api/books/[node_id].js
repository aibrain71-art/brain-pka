// Public read-only endpoint: GET /api/books/:node_id
// Returns a single book row from D1 (larry-db).
// Behind Cloudflare Access.
//
// Lives in its own route file (not /api/books?id=…) so the response stays
// flat: { ok, book } instead of a list wrapper, and the URL is bookmarkable.

export async function onRequestGet({ env, params }) {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 binding env.DB missing' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  const nodeId = String(params.node_id || '').trim();
  if (!nodeId) {
    return new Response(JSON.stringify({ error: 'node_id required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const sql =
    'SELECT node_id, title, author, publication_year, genre, genre_canonical, ' +
    'language, isbn, publisher, page_count, average_rating, purchase_link, ' +
    'cover_image_url, description, description_source, enriched_at, ' +
    'created_at, updated_at FROM books WHERE node_id = ?';

  try {
    const row = await env.DB.prepare(sql).bind(nodeId).first();
    if (!row) {
      return new Response(JSON.stringify({ error: 'book not found', node_id: nodeId }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, book: row }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=60',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
