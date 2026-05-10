// Cloudflare Pages Function — proxies text-to-speech requests to ElevenLabs.
// Endpoint: POST /api/tts
// Auth: implicit via Cloudflare Access (inherits the Pages project policy).
// Secret: ELEVENLABS_API_KEY (Cloudflare dashboard → Pages project →
//         Settings → Environment variables → Production, then redeploy).
//
// Body: { text: string, voiceId: string, modelId?: string,
//         stability?: number, similarity_boost?: number }
// Returns: audio/mpeg stream straight from ElevenLabs (passes through).

export async function onRequestPost({ request, env }) {
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  if (!env.ELEVENLABS_API_KEY) {
    return json({ error: 'ELEVENLABS_API_KEY not configured. Add it in Cloudflare Pages → Settings → Environment variables.' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid JSON in request body' }, 400);
  }

  const { text, voiceId } = body;
  if (typeof text !== 'string' || !text.trim()) {
    return json({ error: 'Field "text" must be a non-empty string' }, 400);
  }
  if (typeof voiceId !== 'string' || !voiceId.trim()) {
    return json({ error: 'Field "voiceId" must be a non-empty string' }, 400);
  }

  // Sanity-cap the text length to bound cost and latency. ~5000 chars =
  // a few cents at most. Caller can request less, never more.
  const safeText = text.slice(0, 5000);
  const modelId = (typeof body.modelId === 'string' && body.modelId) || 'eleven_multilingual_v2';
  const stability = Math.min(Math.max(parseFloat(body.stability) || 0.5, 0), 1);
  const similarity = Math.min(Math.max(parseFloat(body.similarity_boost) || 0.75, 0), 1);

  let apiRes;
  try {
    apiRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: safeText,
        model_id: modelId,
        voice_settings: { stability, similarity_boost: similarity },
      }),
    });
  } catch (err) {
    return json({ error: 'ElevenLabs API request failed: ' + (err.message || err) }, 502);
  }

  if (!apiRes.ok) {
    // Pass through ElevenLabs error JSON so the browser can show a useful
    // message ("Key invalid", "Quota exceeded", etc.) without leaking the key.
    const errBody = await apiRes.text().catch(() => '');
    return new Response(errBody || JSON.stringify({ error: `ElevenLabs HTTP ${apiRes.status}` }), {
      status: apiRes.status,
      headers: { 'Content-Type': apiRes.headers.get('Content-Type') || 'application/json' },
    });
  }

  // Stream the MP3 audio body straight to the client. Cloudflare runtime
  // supports passing through Response bodies natively — no buffering.
  return new Response(apiRes.body, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
    },
  });
}

// Block other methods so random scanners can't probe the endpoint.
export async function onRequest({ request }) {
  return new Response(`Method ${request.method} not allowed. Use POST.`, {
    status: 405,
    headers: { 'Allow': 'POST', 'Content-Type': 'text/plain' },
  });
}
