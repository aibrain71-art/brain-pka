// Blood-pressure tracking endpoint.
//   GET    /api/blood-pressure                → recent 200
//   GET    /api/blood-pressure?range=day|week|month|year
//                                              filtered by taken_at
//   POST   /api/blood-pressure                 add one
//           Body: { systolic, diastolic, pulse?, taken_at?, source?,
//                   device?, body_position?, arm?, mood?, notes?,
//                   irregular_heartbeat? }
//   DELETE /api/blood-pressure?id=N            remove single
//
// Classification follows AHA categories (Normal/Elevated/Stage 1/
// Stage 2/Crisis), computed server-side so all clients see the same
// labels.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function classifyBP(sys, dia) {
  if (sys >= 180 || dia >= 120) return 'Crisis';
  if (sys >= 140 || dia >= 90)  return 'Hypertension Stage 2';
  if (sys >= 130 || dia >= 80)  return 'Hypertension Stage 1';
  if (sys >= 120 && dia < 80)   return 'Elevated';
  if (sys < 120 && dia < 80)    return 'Normal';
  return 'Unknown';
}

export async function onRequestGet({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const url = new URL(request.url);
  const range = url.searchParams.get('range');
  let whereSql = '';
  const params = [];
  if (range === 'day')   { whereSql = "WHERE taken_at >= datetime('now', '-1 day')"; }
  else if (range === 'week')  { whereSql = "WHERE taken_at >= datetime('now', '-7 days')"; }
  else if (range === 'month') { whereSql = "WHERE taken_at >= datetime('now', '-30 days')"; }
  else if (range === 'year')  { whereSql = "WHERE taken_at >= datetime('now', '-365 days')"; }
  try {
    const rows = await env.DB.prepare(
      'SELECT id, systolic, diastolic, pulse, taken_at, source, device, body_position, arm, mood, notes, irregular_heartbeat, classification FROM blood_pressure ' +
      whereSql + ' ORDER BY taken_at DESC LIMIT 500'
    ).bind(...params).all();
    const items = rows.results || [];
    // Stats: average, target-range %, day/night split, recent classifications
    const stats = computeStats(items);
    return json({ ok: true, count: items.length, items, stats });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

function computeStats(items) {
  if (!items.length) return { count: 0 };
  let sumSys = 0, sumDia = 0, sumPulse = 0, pulseN = 0;
  let dayCount = 0, dayS = 0, dayD = 0;
  let nightCount = 0, nightS = 0, nightD = 0;
  let inTarget = 0;
  const classCount = {};
  for (const r of items) {
    sumSys += r.systolic; sumDia += r.diastolic;
    if (r.pulse) { sumPulse += r.pulse; pulseN++; }
    if (r.systolic < 135 && r.diastolic < 85) inTarget++;
    const h = new Date(r.taken_at).getHours();
    if (h >= 6 && h < 22) { dayCount++; dayS += r.systolic; dayD += r.diastolic; }
    else { nightCount++; nightS += r.systolic; nightD += r.diastolic; }
    if (r.classification) classCount[r.classification] = (classCount[r.classification] || 0) + 1;
  }
  return {
    count: items.length,
    avg_systolic: Math.round(sumSys / items.length),
    avg_diastolic: Math.round(sumDia / items.length),
    avg_pulse: pulseN ? Math.round(sumPulse / pulseN) : null,
    target_pct: Math.round(inTarget / items.length * 100),
    day_avg:   dayCount   ? { systolic: Math.round(dayS/dayCount),     diastolic: Math.round(dayD/dayCount),     n: dayCount } : null,
    night_avg: nightCount ? { systolic: Math.round(nightS/nightCount), diastolic: Math.round(nightD/nightCount), n: nightCount } : null,
    class_counts: classCount,
  };
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const sys = parseInt(body.systolic, 10);
  const dia = parseInt(body.diastolic, 10);
  if (!Number.isInteger(sys) || sys < 50 || sys > 260) return json({ error: 'systolic must be 50-260' }, 400);
  if (!Number.isInteger(dia) || dia < 30 || dia > 180) return json({ error: 'diastolic must be 30-180' }, 400);
  const pulse = Number.isInteger(parseInt(body.pulse, 10)) ? parseInt(body.pulse, 10) : null;
  const taken_at = body.taken_at && typeof body.taken_at === 'string'
    ? body.taken_at
    : new Date().toISOString();
  const classification = classifyBP(sys, dia);
  try {
    const r = await env.DB.prepare(
      'INSERT INTO blood_pressure (systolic, diastolic, pulse, taken_at, source, device, body_position, arm, mood, notes, irregular_heartbeat, classification) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      sys, dia, pulse, taken_at,
      body.source || 'manual',
      body.device || null,
      body.body_position || null,
      body.arm || null,
      body.mood || null,
      body.notes || null,
      body.irregular_heartbeat ? 1 : 0,
      classification,
    ).run();
    return json({ ok: true, id: r.meta?.last_row_id, systolic: sys, diastolic: dia, pulse, classification });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

export async function onRequestDelete({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'id required' }, 400);
  try {
    await env.DB.prepare('DELETE FROM blood_pressure WHERE id = ?').bind(id).run();
    return json({ ok: true, deleted_id: id });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}
