// Cloudflare Pages Function — lists available ElevenLabs voices.
// Endpoint: GET /api/voices
// Auth: implicit via Cloudflare Access (inherits the Pages project policy).
// Secret: ELEVENLABS_API_KEY (Cloudflare dashboard → Pages project →
//         Settings → Environment variables → Production, then redeploy).
//
// Returns: { voices: [{ id, name, category }, ...] }

export async function onRequestGet({ env }) {
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  if (!env.ELEVENLABS_API_KEY) {
    return json({ error: 'ELEVENLABS_API_KEY not configured. Add it in Cloudflare Pages → Settings → Environment variables.' }, 500);
  }

  let apiRes;
  try {
    apiRes = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
    });
  } catch (err) {
    return json({ error: 'ElevenLabs API request failed: ' + (err.message || err) }, 502);
  }

  if (!apiRes.ok) {
    const errBody = await apiRes.text().catch(() => '');
    return new Response(errBody || JSON.stringify({ error: `ElevenLabs HTTP ${apiRes.status}` }), {
      status: apiRes.status,
      headers: { 'Content-Type': apiRes.headers.get('Content-Type') || 'application/json' },
    });
  }

  // Pass-through with a small projection so the browser only gets what it
  // needs (id, name, category) — no labels/preview-urls/extra metadata.
  const data = await apiRes.json();
  const voices = (data.voices || []).map(v => ({
    id: v.voice_id,
    name: v.name,
    category: v.category,
  }));
  return json({ voices });
}

export async function onRequest({ request }) {
  return new Response(`Method ${request.method} not allowed. Use GET.`, {
    status: 405,
    headers: { 'Allow': 'GET', 'Content-Type': 'text/plain' },
  });
}
