// Public read-only endpoint: GET /api/tasks
// Returns tasks from D1 (larry-db), open first then completed,
// ordered by priority/due_date within each group.

export async function onRequestGet({ env, request }) {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 binding env.DB missing' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 100, 1), 500);
  const status = url.searchParams.get('status');  // 'open' | 'done' | null=all

  try {
    let sql, stmt;
    if (status) {
      sql = 'SELECT id, title, details, status, priority, due_date, tags, created_at, completed_at FROM tasks WHERE status = ? ORDER BY priority ASC, due_date ASC, created_at ASC LIMIT ?';
      stmt = env.DB.prepare(sql).bind(status, limit);
    } else {
      sql = 'SELECT id, title, details, status, priority, due_date, tags, created_at, completed_at FROM tasks ORDER BY (status = \'open\') DESC, priority ASC, created_at DESC LIMIT ?';
      stmt = env.DB.prepare(sql).bind(limit);
    }
    const rows = await stmt.all();
    return new Response(JSON.stringify({ ok: true, count: rows.results.length, tasks: rows.results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
