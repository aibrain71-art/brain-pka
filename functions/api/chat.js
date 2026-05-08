// Cloudflare Pages Function — proxies chat requests to the Anthropic API.
// Endpoint: POST /api/chat
// Auth: implicit via Cloudflare Access (this Function inherits the access
//       policy of the parent Pages project, so only the policy's allowlisted
//       emails can call it).
// Secret: ANTHROPIC_API_KEY (set in Cloudflare dashboard → Pages project →
//         Settings → Environment variables → Production, then redeploy).

export async function onRequestPost({ request, env }) {
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY not configured. Add it in Cloudflare Pages → Settings → Environment variables.' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid JSON in request body' }, 400);
  }

  const { messages, model, system, max_tokens, stream } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'Field "messages" must be a non-empty array' }, 400);
  }

  // Allowlist of accepted models — protects against typos and prevents
  // someone from forcing an unexpectedly expensive model via the public
  // endpoint. Update here when Anthropic releases new model IDs.
  const allowedModels = new Set([
    'claude-haiku-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-5',
    'claude-3-5-haiku-latest',
    'claude-3-5-sonnet-latest',
    'claude-3-opus-latest',
  ]);
  const modelToUse = allowedModels.has(model) ? model : 'claude-haiku-4-5';

  // Cap output tokens to bound cost — Haiku at $5/MTok output, 4096 tokens
  // = ~$0.02/answer ceiling. Caller can request less, never more.
  const maxTokens = Math.min(Math.max(parseInt(max_tokens, 10) || 1024, 64), 4096);
  const wantStream = stream === true;

  let apiRes;
  try {
    apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelToUse,
        messages,
        ...(system ? { system } : {}),
        max_tokens: maxTokens,
        ...(wantStream ? { stream: true } : {}),
      }),
    });
  } catch (err) {
    return json({ error: 'Anthropic API request failed: ' + (err.message || err) }, 502);
  }

  // Streaming: pass the SSE body straight through to the client. The
  // Cloudflare runtime supports streaming Response bodies natively.
  if (wantStream && apiRes.ok && apiRes.body) {
    return new Response(apiRes.body, {
      status: apiRes.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  // Non-streaming (or error): pass through Anthropic's JSON response so the
  // client can surface API errors (rate limits, invalid model, etc.) directly.
  const data = await apiRes.json();
  return json(data, apiRes.status);
}

// Block GET / other methods so the endpoint can't be probed by random
// scanners (and so a stray browser navigation doesn't burn a request).
export async function onRequest({ request }) {
  return new Response(`Method ${request.method} not allowed. Use POST.`, {
    status: 405,
    headers: { 'Allow': 'POST', 'Content-Type': 'text/plain' },
  });
}
