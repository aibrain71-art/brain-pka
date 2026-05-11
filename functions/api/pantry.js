// Pantry (Vorratsschrank) — what's already on hand at home.
// The aggregator subtracts pantry stock from generated shopping lists.
//
//   GET  /api/pantry           → list everything (newest first)
//   POST /api/pantry           → add manual item:
//                                { item, qty_value?, qty_unit?, notes? }
//                                Returns existing row if item_key already exists
//                                (upsert via item_key).
//
// Single-item updates/deletes live in /api/pantry/[id].js.

import { normalizeItemKey } from '../_lib/meal-aggregator.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  try {
    const rows = await env.DB.prepare(
      'SELECT id, item, item_key, qty_value, qty_unit, notes, source, updated_at FROM pantry ORDER BY updated_at DESC'
    ).all();
    return json({ ok: true, count: rows.results.length, items: rows.results });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const item = (body.item || '').trim();
  if (!item) return json({ error: 'item required' }, 400);
  const itemKey = normalizeItemKey(item);
  if (!itemKey) return json({ error: 'item normalized to empty key' }, 400);

  const qtyValue = Number.isFinite(parseFloat(body.qty_value)) ? parseFloat(body.qty_value) : null;
  const qtyUnit = body.qty_unit ? String(body.qty_unit).slice(0, 24) : null;
  const notes = body.notes ? String(body.notes).slice(0, 500) : null;

  try {
    // UPSERT via item_key — add qty if existing, insert if new
    const r = await env.DB.prepare(
      `INSERT INTO pantry (item, item_key, qty_value, qty_unit, notes, source)
       VALUES (?, ?, ?, ?, ?, 'manual')
       ON CONFLICT(item_key) DO UPDATE SET
         qty_value = COALESCE(pantry.qty_value, 0) + COALESCE(excluded.qty_value, 0),
         qty_unit = COALESCE(pantry.qty_unit, excluded.qty_unit),
         notes = COALESCE(excluded.notes, pantry.notes),
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, item, item_key, qty_value, qty_unit, notes, source`
    ).bind(item.slice(0, 200), itemKey, qtyValue, qtyUnit, notes).first();
    return json({ ok: true, item: r });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}
