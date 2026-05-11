// Per-recipe image setter.
//   POST /api/recipes/set-image
//   Body: { id, image_url, image_credit? }
// Updates source_meta.image_url + image_credit on a recipe note so
// the cookbook UI shows that image in the hero strip.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'id required' }, 400);
  const imageUrl = (body.image_url || '').trim();
  // Allow clearing the image by passing an empty string
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    return json({ error: 'image_url must be a public http(s) URL' }, 400);
  }
  const credit = body.image_credit ? String(body.image_credit).slice(0, 200) : null;

  try {
    const row = await env.DB.prepare(
      "SELECT source_meta FROM notes WHERE id = ? AND note_type = 'recipe'"
    ).bind(id).first();
    if (!row) return json({ error: 'Recipe not found' }, 404);
    let meta = {};
    try { meta = row.source_meta ? JSON.parse(row.source_meta) : {}; } catch (_) {}
    if (imageUrl) {
      meta.image_url = imageUrl;
      meta.image_credit = credit;
    } else {
      delete meta.image_url;
      delete meta.image_credit;
    }
    await env.DB.prepare("UPDATE notes SET source_meta = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(JSON.stringify(meta), id).run();
    return json({ ok: true, id, image_url: meta.image_url || null });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

export async function onRequest({ request }) {
  return new Response('POST only', { status: 405, headers: { 'Allow': 'POST' } });
}
