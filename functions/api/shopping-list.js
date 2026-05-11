// Shopping list endpoint.
//   GET    /api/shopping-list                 → all items (open first)
//   GET    /api/shopping-list?status=open|done
//   POST   /api/shopping-list                 → add item { item, qty_value?, qty_unit?, recipe_id?, recipe_title?, notes? }
//   POST   /api/shopping-list?bulk=1          → add many in one tx { items: [{ item, qty, unit, recipe_id?, recipe_title? }, …] }
//   PUT    /api/shopping-list?id=N            → update status / qty
//                                               When status flips to 'done',
//                                               auto-upserts the item into pantry
//                                               (meal-planning feature).
//   DELETE /api/shopping-list?id=N            → remove single
//   DELETE /api/shopping-list?clear=done      → remove all done

import { normalizeItemKey } from '../_lib/meal-aggregator.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  try {
    let rows;
    if (status === 'open' || status === 'done') {
      rows = await env.DB.prepare(
        'SELECT id, item, qty_value, qty_unit, source_recipe_id, source_recipe_title, notes, status, priority, added_at, done_at FROM shopping_list WHERE status = ? ORDER BY added_at DESC'
      ).bind(status).all();
    } else {
      rows = await env.DB.prepare(
        'SELECT id, item, qty_value, qty_unit, source_recipe_id, source_recipe_title, notes, status, priority, added_at, done_at FROM shopping_list ORDER BY (status = \'open\') DESC, added_at DESC'
      ).all();
    }
    return json({ ok: true, count: rows.results.length, items: rows.results });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const url = new URL(request.url);

  // Bulk insert path — used by "Add recipe ingredients to shopping list"
  if (url.searchParams.get('bulk') === '1') {
    const items = Array.isArray(body.items) ? body.items.filter(i => i && i.item) : [];
    if (!items.length) return json({ error: 'items[] required' }, 400);
    if (items.length > 200) return json({ error: 'too many items at once' }, 400);
    try {
      const stmts = items.map(it => env.DB.prepare(
        'INSERT INTO shopping_list (item, qty_value, qty_unit, source_recipe_id, source_recipe_title, notes, priority) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        String(it.item).slice(0, 200),
        Number.isFinite(parseFloat(it.qty_value)) ? parseFloat(it.qty_value) : null,
        it.qty_unit ? String(it.qty_unit).slice(0, 24) : null,
        Number.isInteger(it.recipe_id) ? it.recipe_id : null,
        it.recipe_title ? String(it.recipe_title).slice(0, 200) : null,
        it.notes ? String(it.notes).slice(0, 500) : null,
        Number.isInteger(it.priority) ? it.priority : 3,
      ));
      const results = await env.DB.batch(stmts);
      return json({ ok: true, added: results.length });
    } catch (e) {
      return json({ error: 'Bulk insert failed: ' + (e.message || e) }, 500);
    }
  }

  // Single insert
  const item = (body.item || '').trim();
  if (!item) return json({ error: 'item required' }, 400);
  try {
    const r = await env.DB.prepare(
      'INSERT INTO shopping_list (item, qty_value, qty_unit, source_recipe_id, source_recipe_title, notes, priority) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      item.slice(0, 200),
      Number.isFinite(parseFloat(body.qty_value)) ? parseFloat(body.qty_value) : null,
      body.qty_unit ? String(body.qty_unit).slice(0, 24) : null,
      Number.isInteger(body.source_recipe_id) ? body.source_recipe_id : null,
      body.source_recipe_title ? String(body.source_recipe_title).slice(0, 200) : null,
      body.notes ? String(body.notes).slice(0, 500) : null,
      Number.isInteger(body.priority) ? body.priority : 3,
    ).run();
    return json({ ok: true, id: r.meta?.last_row_id, item });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

export async function onRequestPut({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'id required' }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const fields = [];
  const values = [];
  if (typeof body.status === 'string') {
    fields.push('status = ?'); values.push(body.status);
    if (body.status === 'done') { fields.push("done_at = CURRENT_TIMESTAMP"); }
    else { fields.push('done_at = NULL'); }
  }
  if (typeof body.item === 'string')      { fields.push('item = ?');      values.push(body.item.slice(0,200)); }
  if (body.qty_value != null)             { fields.push('qty_value = ?'); values.push(parseFloat(body.qty_value)); }
  if (typeof body.qty_unit === 'string')  { fields.push('qty_unit = ?');  values.push(body.qty_unit.slice(0,24)); }
  if (typeof body.notes === 'string')     { fields.push('notes = ?');     values.push(body.notes.slice(0,500)); }
  if (Number.isInteger(body.priority))    { fields.push('priority = ?'); values.push(body.priority); }
  if (!fields.length) return json({ error: 'nothing to update' }, 400);
  try {
    await env.DB.prepare('UPDATE shopping_list SET ' + fields.join(', ') + ' WHERE id = ?')
      .bind(...values, id).run();

    // ─── Pantry auto-upsert hook ─────────────────────────────────
    // When an item is marked 'done', drop it into pantry so the
    // meal-plan aggregator can subtract it from future shopping
    // lists. Best-effort — if the pantry table doesn't exist (schema
    // not applied) or the upsert fails, we silently swallow it so
    // the main UPDATE response stays intact.
    let pantryUpdated = false;
    if (body.status === 'done') {
      try {
        const row = await env.DB.prepare(
          'SELECT item, qty_value, qty_unit FROM shopping_list WHERE id = ?'
        ).bind(id).first();
        if (row?.item) {
          const itemKey = normalizeItemKey(row.item);
          if (itemKey) {
            await env.DB.prepare(
              // NULL-preserving qty addition: NULL means "vorhanden, Menge
              // egal" — once a row is NULL, adding more NULL or anything
              // else must keep it NULL (don't accidentally collapse to 0).
              `INSERT INTO pantry (item, item_key, qty_value, qty_unit, source)
                 VALUES (?, ?, ?, ?, 'auto-shopping')
                 ON CONFLICT(item_key) DO UPDATE SET
                   qty_value = CASE
                     WHEN pantry.qty_value IS NULL OR excluded.qty_value IS NULL THEN NULL
                     ELSE pantry.qty_value + excluded.qty_value END,
                   qty_unit = COALESCE(pantry.qty_unit, excluded.qty_unit),
                   updated_at = CURRENT_TIMESTAMP`
            ).bind(
              String(row.item).slice(0, 200),
              itemKey,
              Number.isFinite(row.qty_value) ? row.qty_value : null,
              row.qty_unit ? String(row.qty_unit).slice(0, 24) : null
            ).run();
            pantryUpdated = true;
          }
        }
      } catch (_) { /* pantry table missing or row malformed — ignore */ }
    }
    return json({ ok: true, updated_id: id, pantry_updated: pantryUpdated });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

export async function onRequestDelete({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const url = new URL(request.url);
  if (url.searchParams.get('clear') === 'done') {
    try {
      const r = await env.DB.prepare("DELETE FROM shopping_list WHERE status = 'done'").run();
      return json({ ok: true, cleared: r.meta?.changes || 0 });
    } catch (e) { return json({ error: e.message }, 500); }
  }
  const id = parseInt(url.searchParams.get('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'id required' }, 400);
  try {
    await env.DB.prepare('DELETE FROM shopping_list WHERE id = ?').bind(id).run();
    return json({ ok: true, deleted_id: id });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}
