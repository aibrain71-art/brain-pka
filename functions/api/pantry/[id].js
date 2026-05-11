// Pantry single-item operations.
//   PUT    /api/pantry/:id    → update qty_value / qty_unit / item / notes
//                               body: any subset of those fields
//   DELETE /api/pantry/:id    → remove the row

import { normalizeItemKey } from '../../_lib/meal-aggregator.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPut({ env, params, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'invalid id' }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const fields = [];
  const values = [];
  if (typeof body.item === 'string') {
    fields.push('item = ?');
    values.push(body.item.slice(0, 200));
    // Re-normalize when display name changes — keeps key in sync
    fields.push('item_key = ?');
    values.push(normalizeItemKey(body.item));
  }
  if (body.qty_value !== undefined) {
    const v = Number.isFinite(parseFloat(body.qty_value)) ? parseFloat(body.qty_value) : null;
    fields.push('qty_value = ?'); values.push(v);
  }
  if (typeof body.qty_unit === 'string') {
    fields.push('qty_unit = ?'); values.push(body.qty_unit.slice(0, 24));
  }
  if (body.qty_unit === null) {
    fields.push('qty_unit = NULL');
  }
  if (typeof body.notes === 'string') {
    fields.push('notes = ?'); values.push(body.notes.slice(0, 500));
  }
  if (!fields.length) return json({ error: 'nothing to update' }, 400);
  fields.push('updated_at = CURRENT_TIMESTAMP');

  try {
    await env.DB.prepare('UPDATE pantry SET ' + fields.join(', ') + ' WHERE id = ?')
      .bind(...values, id).run();
    return json({ ok: true, updated_id: id });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

export async function onRequestDelete({ env, params }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'invalid id' }, 400);
  try {
    await env.DB.prepare('DELETE FROM pantry WHERE id = ?').bind(id).run();
    return json({ ok: true, deleted_id: id });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}
