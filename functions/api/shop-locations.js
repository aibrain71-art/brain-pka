// Shop-locations endpoint — read-only list of supermarkets we monitor
// for GPS-triggered shopping list popups. Geofencing happens client-side
// (Geolocation API + Haversine distance check) so we just expose the
// list of points + radii.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  try {
    const rows = await env.DB.prepare(
      'SELECT id, name, chain, address, lat, lng, radius_m, active FROM shop_locations WHERE active = 1 ORDER BY chain, name'
    ).all();
    return json({ ok: true, count: rows.results.length, shops: rows.results });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}
