// Public read-only endpoint: GET /api/books
// Returns the full books library from D1 (larry-db).
// Behind Cloudflare Access, so only the owner's email gets in.
//
// Query params:
//   limit   — max rows (default 500, capped at 1000). Library is ~115 today,
//             so the default already returns everything.
//   genre   — filter by genre_canonical (exact match, lowercased)
//   lang    — filter by language (exact match)
//
// The Phase 3b UI fetches once on landing-mount and filters client-side,
// so the params are here for future use / scripted callers, not the UI.

export async function onRequestGet({ env, request }) {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 binding env.DB missing' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get('limit'), 10) || 500, 1),
    1000,
  );
  const genre = (url.searchParams.get('genre') || '').trim().toLowerCase();
  const lang  = (url.searchParams.get('lang')  || '').trim();

  const where = [];
  const params = [];
  if (genre) { where.push('LOWER(genre_canonical) = ?'); params.push(genre); }
  if (lang)  { where.push('language = ?');                params.push(lang); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const sql =
    'SELECT node_id, title, author, publication_year, genre, genre_canonical, ' +
    'language, isbn, publisher, page_count, average_rating, purchase_link, ' +
    'cover_image_url, description, description_source, enriched_at, ' +
    'created_at, updated_at FROM books' +
    whereSql +
    ' ORDER BY title COLLATE NOCASE ASC LIMIT ?';
  params.push(limit);

  try {
    const rows = await env.DB.prepare(sql).bind(...params).all();
    return new Response(JSON.stringify({
      ok: true,
      count: rows.results.length,
      books: rows.results,
    }), {
      headers: {
        'Content-Type': 'application/json',
        // Edge cache short-lived; the dataset doesn't change between deploys.
        'Cache-Control': 'private, max-age=60',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
