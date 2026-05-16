// DELETE /api/notes/:id — hard-deletes a note from D1.
// All other CRUD lives in /api/notes.js (GET list + POST create).

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
    const before = await env.DB.prepare('SELECT title FROM notes WHERE id = ?').bind(id).first();
    if (!before) return json({ error: 'Note not found' }, 404);
    await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
    return json({ ok: true, deleted_id: id, deleted_title: before.title });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}
