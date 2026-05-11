// Single meal-plan resource.
//   GET    /api/meal-plans/:id        → plan header + 21 slots embedded
//                                       (each slot: { day_idx, meal_type,
//                                       recipe_id, recipe_title, servings_override,
//                                       note })
//   PUT    /api/meal-plans/:id        → update header fields (title, week_start,
//                                       default_servings, is_active). If
//                                       is_active flips to 1, demotes others
//                                       AND re-syncs shopping. If default_servings
//                                       changes, re-syncs too.
//   DELETE /api/meal-plans/:id        → delete plan (slots cascade) + clean up
//                                       this plan's shopping_list rows

import { resyncShoppingForPlan } from '../../_lib/meal-aggregator.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet({ env, params }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const planId = parseInt(params.id, 10);
  if (!Number.isInteger(planId) || planId <= 0) return json({ error: 'invalid id' }, 400);
  try {
    const plan = await env.DB.prepare(
      'SELECT id, title, week_start, default_servings, is_active, created_at, updated_at FROM meal_plans WHERE id = ?'
    ).bind(planId).first();
    if (!plan) return json({ error: 'Plan not found' }, 404);

    // Slots + recipe titles in one query (LEFT JOIN so empty slots stay)
    const slotsRes = await env.DB.prepare(
      `SELECT s.day_idx, s.meal_type, s.recipe_id, s.servings_override, s.note,
              n.title AS recipe_title
         FROM meal_slots s
         LEFT JOIN notes n ON n.id = s.recipe_id AND n.note_type = 'recipe'
        WHERE s.plan_id = ?
        ORDER BY s.day_idx ASC,
                 CASE s.meal_type WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 WHEN 'dinner' THEN 2 ELSE 3 END`
    ).bind(planId).all();
    return json({ ok: true, plan: { ...plan, slots: slotsRes.results || [] } });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

export async function onRequestPut({ env, params, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const planId = parseInt(params.id, 10);
  if (!Number.isInteger(planId) || planId <= 0) return json({ error: 'invalid id' }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const fields = [];
  const values = [];
  let shouldResync = false;
  let activating = false;

  if (typeof body.title === 'string') {
    fields.push('title = ?');
    values.push(body.title.slice(0, 100));
  }
  if (typeof body.week_start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.week_start)) {
    fields.push('week_start = ?');
    values.push(body.week_start);
  }
  if (Number.isInteger(body.default_servings) && body.default_servings > 0) {
    fields.push('default_servings = ?');
    values.push(body.default_servings);
    shouldResync = true;
  }
  if (body.is_active !== undefined) {
    const flag = body.is_active ? 1 : 0;
    fields.push('is_active = ?');
    values.push(flag);
    if (flag === 1) activating = true;
  }
  if (!fields.length) return json({ error: 'nothing to update' }, 400);
  fields.push('updated_at = CURRENT_TIMESTAMP');

  try {
    // If activating, demote any other active plan in the same tx as the update.
    const stmts = [];
    if (activating) {
      stmts.push(env.DB.prepare('UPDATE meal_plans SET is_active = 0 WHERE id != ? AND is_active = 1').bind(planId));
    }
    stmts.push(
      env.DB.prepare('UPDATE meal_plans SET ' + fields.join(', ') + ' WHERE id = ?').bind(...values, planId)
    );
    await env.DB.batch(stmts);

    if (shouldResync || activating) {
      try { await resyncShoppingForPlan(env, planId); }
      catch (e) { return json({ ok: true, updated_id: planId, resync_error: String(e.message || e) }); }
    }
    return json({ ok: true, updated_id: planId });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

export async function onRequestDelete({ env, params }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const planId = parseInt(params.id, 10);
  if (!Number.isInteger(planId) || planId <= 0) return json({ error: 'invalid id' }, 400);
  try {
    // Clean up plan-tagged shopping_list rows (only open ones — keep done
    // items as historical record).
    const marker = 'plan:' + planId;
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM shopping_list WHERE status='open' AND (notes = ? OR notes LIKE ?)"
      ).bind(marker, marker + '|%'),
      env.DB.prepare('DELETE FROM meal_plans WHERE id = ?').bind(planId), // slots cascade
    ]);
    return json({ ok: true, deleted_id: planId });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}
