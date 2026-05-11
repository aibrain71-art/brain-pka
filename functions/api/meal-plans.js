// Meal plans — list + create.
//   GET  /api/meal-plans                 → all plans (newest first)
//   GET  /api/meal-plans?active=1        → only the currently-active plan
//   POST /api/meal-plans                 → create a new plan with 21 empty slots
//                                          body: { week_start: 'YYYY-MM-DD',
//                                                  title?, default_servings?,
//                                                  is_active? }
//
// Single-plan operations live in /api/meal-plans/[id].js.
// Slot operations live in /api/meal-plans/[id]/slots.js.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const url = new URL(request.url);
  const onlyActive = url.searchParams.get('active') === '1';
  try {
    const sql = onlyActive
      ? "SELECT id, title, week_start, default_servings, is_active, created_at, updated_at FROM meal_plans WHERE is_active = 1 ORDER BY week_start DESC LIMIT 1"
      : "SELECT id, title, week_start, default_servings, is_active, created_at, updated_at FROM meal_plans ORDER BY is_active DESC, week_start DESC";
    const rows = await env.DB.prepare(sql).all();
    return json({ ok: true, count: rows.results.length, plans: rows.results });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const weekStart = String(body.week_start || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return json({ error: 'week_start required (YYYY-MM-DD)' }, 400);
  }
  const title = body.title ? String(body.title).slice(0, 100) : null;
  const defaultServings = Number.isInteger(body.default_servings) && body.default_servings > 0
    ? body.default_servings
    : 2;
  const isActive = body.is_active ? 1 : 0;

  try {
    // If activating, demote any other active plan first
    if (isActive) {
      await env.DB.prepare('UPDATE meal_plans SET is_active = 0 WHERE is_active = 1').run();
    }
    const insert = await env.DB.prepare(
      'INSERT INTO meal_plans (title, week_start, default_servings, is_active) VALUES (?, ?, ?, ?)'
    ).bind(title, weekStart, defaultServings, isActive).run();
    const planId = insert.meta?.last_row_id;
    if (!planId) throw new Error('Plan insert returned no id');

    // Pre-create the 21 empty slots so PUT-by-key is a simple update.
    const meals = ['breakfast', 'lunch', 'dinner'];
    const stmts = [];
    for (let day = 0; day < 7; day++) {
      for (const meal of meals) {
        stmts.push(env.DB.prepare(
          'INSERT INTO meal_slots (plan_id, day_idx, meal_type) VALUES (?, ?, ?)'
        ).bind(planId, day, meal));
      }
    }
    await env.DB.batch(stmts);
    return json({ ok: true, id: planId, week_start: weekStart, is_active: isActive });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}
