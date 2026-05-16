// DELETE /api/ideas/:id — hard-deletes an idea from D1.
// Mirrors the notes/[id].js pattern from PR #3.

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestDelete({ env, params }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'id required' }, 400);
  try {
    const before = await env.DB.prepare('SELECT title FROM ideas WHERE id = ?').bind(id).first();
    if (!before) return json({ error: 'Idea not found' }, 404);
    await env.DB.prepare('DELETE FROM ideas WHERE id = ?').bind(id).run();
    return json({ ok: true, deleted_id: id, deleted_title: before.title });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}
