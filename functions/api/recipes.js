// Public read-only endpoint: GET /api/recipes
// Returns all recipe notes (note_type='recipe') with their structured
// recipe data parsed out of source_meta.recipe. Used by cookbook.html
// to render the cookbook view.

export async function onRequestGet({ env }) {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 binding env.DB missing' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const rows = await env.DB.prepare(
      "SELECT id, slug, title, body, related_topics, source_meta, created_at FROM notes WHERE note_type = 'recipe' ORDER BY title COLLATE NOCASE ASC"
    ).all();
    const recipes = (rows.results || []).map(row => {
      let recipe = null;
      try {
        const meta = row.source_meta ? JSON.parse(row.source_meta) : null;
        recipe = meta?.recipe || null;
      } catch(_) {}
      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        body: row.body,
        tags: row.related_topics
          ? String(row.related_topics).split(/[,;]/).map(t => t.trim()).filter(Boolean)
          : [],
        created_at: row.created_at,
        recipe,
      };
    });
    // Stats
    const total = recipes.length;
    const withServings = recipes.filter(r => r.recipe?.servings).length;
    const totalIngredients = recipes.reduce((s, r) => s + (r.recipe?.ingredients?.length || 0), 0);
    const avgTime = (() => {
      const ts = recipes.map(r => r.recipe?.total_minutes).filter(t => Number.isInteger(t));
      return ts.length ? Math.round(ts.reduce((a, b) => a + b, 0) / ts.length) : null;
    })();
    const tagCounts = {};
    recipes.forEach(r => r.tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));

    return new Response(JSON.stringify({
      ok: true,
      stats: { total, withServings, totalIngredients, avgMinutes: avgTime, topTags: tagCounts },
      recipes,
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
