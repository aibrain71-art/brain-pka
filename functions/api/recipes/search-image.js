// Auto image-search for recipes.
//   GET /api/recipes/search-image?q=<recipe-title>
// Returns 6-12 candidate photos with thumbnail + full URL + credit.
//
// Uses the Pexels API (no Anthropic web_search to keep things free
// and reliable for image-only results). Needs PEXELS_API_KEY as
// Cloudflare-Secret. If the secret is missing, returns a clear
// error so the UI can fall back to the manual URL-paste flow.
// Get a free key at https://www.pexels.com/api/ — 200 req/hour.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet({ env, request }) {
  if (!env.PEXELS_API_KEY) {
    return json({
      error: 'PEXELS_API_KEY not configured',
      hint: 'Free key at https://www.pexels.com/api/ — add it to Cloudflare Pages → Settings → Environment Variables as encrypted secret PEXELS_API_KEY.',
    }, 503);
  }
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ error: 'q (search query) required' }, 400);

  try {
    const r = await fetch('https://api.pexels.com/v1/search?per_page=12&query=' + encodeURIComponent(q + ' food'), {
      headers: { 'Authorization': env.PEXELS_API_KEY },
    });
    if (!r.ok) return json({ error: 'Pexels HTTP ' + r.status }, 502);
    const data = await r.json();
    const photos = (data.photos || []).map(p => ({
      id: p.id,
      thumb: p.src?.medium,
      url: p.src?.large || p.src?.original,
      credit: p.photographer,
      credit_url: p.photographer_url,
    }));
    return json({ ok: true, query: q, count: photos.length, photos });
  } catch (e) {
    return json({ error: e.message || String(e) }, 502);
  }
}
