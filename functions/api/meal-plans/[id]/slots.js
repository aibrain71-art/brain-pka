// Bulk slot updates for a meal plan.
//
//   PUT /api/meal-plans/:id/slots
//   body: { slots: [
//     { day_idx: 0-6, meal_type: 'breakfast'|'lunch'|'dinner',
//       recipe_id?: int|null, servings_override?: int|null, note?: string|null },
//     ...
//   ] }
//
// Slots are addressed by (plan_id, day_idx, meal_type). Each entry
// upserts the matching slot row. After the batch, we auto-resync the
// shopping_list with the aggregator helper — but only if the plan is
// active (otherwise drafting future weeks would clobber the current
// shopping list).

import { resyncShoppingForPlan } from '../../../_lib/meal-aggregator.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner']);

export async function onRequestPut({ env, params, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const planId = parseInt(params.id, 10);
  if (!Number.isInteger(planId) || planId <= 0) return json({ error: 'invalid id' }, 400);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const slots = Array.isArray(body.slots) ? body.slots : [];
  if (!slots.length) return json({ error: 'slots[] required' }, 400);
  if (slots.length > 50) return json({ error: 'too many slots in one request' }, 400);

  // Validate plan exists + load active-flag
  const plan = await env.DB.prepare('SELECT id, is_active FROM meal_plans WHERE id = ?').bind(planId).first();
  if (!plan) return json({ error: 'Plan not found' }, 404);

  // Build update statements. UPDATE per slot (we pre-created the 21
  // rows at plan-create time, so this is always a UPDATE not INSERT).
  const stmts = [];
  for (const s of slots) {
    if (!Number.isInteger(s.day_idx) || s.day_idx < 0 || s.day_idx > 6) {
      return json({ error: 'day_idx must be 0..6' }, 400);
    }
    if (!MEAL_TYPES.has(s.meal_type)) {
      return json({ error: "meal_type must be breakfast|lunch|dinner" }, 400);
    }
    const recipeId = Number.isInteger(s.recipe_id) ? s.recipe_id : null;
    const servings = Number.isInteger(s.servings_override) && s.servings_override > 0
      ? s.servings_override : null;
    const note = (s.note != null) ? String(s.note).slice(0, 500) : null;
    stmts.push(
      env.DB.prepare(
        `UPDATE meal_slots
           SET recipe_id = ?, servings_override = ?, note = ?, updated_at = CURRENT_TIMESTAMP
         WHERE plan_id = ? AND day_idx = ? AND meal_type = ?`
      ).bind(recipeId, servings, note, planId, s.day_idx, s.meal_type)
    );
  }
  // Touch the plan's updated_at so the UI can detect freshness
  stmts.push(env.DB.prepare('UPDATE meal_plans SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(planId));

  try {
    await env.DB.batch(stmts);
  } catch (e) {
    return json({ error: 'Slot update failed: ' + (e.message || e) }, 500);
  }

  // Auto-resync shopping_list — only for the active plan. Drafting a
  // future week shouldn't replace the current list.
  let resyncResult = null;
  if (plan.is_active) {
    try {
      resyncResult = await resyncShoppingForPlan(env, planId);
    } catch (e) {
      // Don't fail the whole request if resync errors — slot save itself
      // was successful. Just report the resync issue back.
      return json({ ok: true, updated_slots: slots.length, resync_error: String(e.message || e) });
    }
  }
  return json({
    ok: true,
    updated_slots: slots.length,
    resync_triggered: !!plan.is_active,
    shopping_items_after_resync: resyncResult?.count ?? null,
  });
}
