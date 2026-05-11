// Cloudflare Pages Function — proxies chat requests to Anthropic.
// Endpoint: POST /api/chat
//
// Two modes:
//   - Simple chat: client sends messages + optional system → response.
//   - Agentic chat: client sets `enable_tools: true` → we expose Larry's
//     tool catalogue (notes / journal / tasks / ideas / people CRUD)
//     plus Anthropic's built-in web_search. We run the tool_use loop
//     server-side until Claude returns a final text answer.
//
// Secrets (Cloudflare Pages → Settings → Environment variables, Encrypted):
//   - ANTHROPIC_API_KEY   — required
// Bindings (wrangler.toml):
//   - DB (D1 database "larry-db") — required for tools to work

import { TOOLS, executeTool } from '../_lib/tools.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOOL_ROUNDS = 6;  // safety cap on agentic loop

const allowedModels = new Set([
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-3-5-haiku-latest',
  'claude-3-5-sonnet-latest',
  'claude-3-opus-latest',
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function callAnthropic(apiKey, body) {
  return fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY not configured. Add it in Cloudflare Pages → Settings → Environment variables.' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON in request body' }, 400);
  }

  const { messages, model, system, max_tokens, stream, enable_tools } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'Field "messages" must be a non-empty array' }, 400);
  }

  const modelToUse = allowedModels.has(model) ? model : 'claude-haiku-4-5';
  const maxTokens  = Math.min(Math.max(parseInt(max_tokens, 10) || 1024, 64), 4096);
  const wantStream = stream === true && enable_tools !== true;  // tools force non-stream

  // ── Mode A: simple non-agentic chat (current behaviour) ────
  if (!enable_tools) {
    let apiRes;
    try {
      apiRes = await callAnthropic(env.ANTHROPIC_API_KEY, {
        model: modelToUse,
        messages,
        ...(system ? { system } : {}),
        max_tokens: maxTokens,
        ...(wantStream ? { stream: true } : {}),
      });
    } catch (err) {
      return json({ error: 'Anthropic API request failed: ' + (err.message || err) }, 502);
    }

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
    const data = await apiRes.json();
    return json(data, apiRes.status);
  }

  // ── Mode B: agentic chat with tool catalogue + web_search ──
  if (!env.DB) {
    return json({ error: 'D1 binding env.DB missing — wrangler.toml not deployed yet, or database not bound. Re-deploy via git push.' }, 500);
  }

  // Build the tool list: our SQL tools + Anthropic's built-in web_search.
  // web_search runs server-side in Anthropic's infra — we never see it
  // here, the result comes back inline in the next message.
  const tools = [
    ...TOOLS,
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5,  // safety cap per request
    },
  ];

  // Working copy of messages — we append assistant turns + tool_result
  // turns as the loop progresses.
  const workingMessages = messages.slice();
  const trace = [];  // visible to client for debugging in DevTools

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let apiRes;
    try {
      apiRes = await callAnthropic(env.ANTHROPIC_API_KEY, {
        model: modelToUse,
        messages: workingMessages,
        ...(system ? { system } : {}),
        max_tokens: maxTokens,
        tools,
      });
    } catch (err) {
      return json({ error: 'Anthropic API request failed: ' + (err.message || err), trace }, 502);
    }

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      return json({ error: 'Anthropic API ' + apiRes.status + ': ' + errBody, trace }, apiRes.status);
    }

    const data = await apiRes.json();
    trace.push({ round, stop_reason: data.stop_reason, blocks: (data.content || []).map(b => b.type) });

    // Append Claude's assistant turn to the working messages
    workingMessages.push({ role: 'assistant', content: data.content });

    // If Claude is done (no more tools needed), return the final response.
    if (data.stop_reason !== 'tool_use') {
      return json({ ...data, _trace: trace });
    }

    // Otherwise execute every tool_use block and add a single user turn
    // with corresponding tool_result blocks.
    const toolResults = [];
    for (const block of data.content) {
      if (block.type !== 'tool_use') continue;
      // Anthropic's server tools (like web_search) are handled by
      // Anthropic — we never see them as tool_use blocks we have to
      // execute. So any tool_use we get here is a custom one.
      const resultStr = await executeTool(block.name, block.input || {}, env);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: resultStr,
      });
    }
    workingMessages.push({ role: 'user', content: toolResults });
    // Loop continues — Claude now sees the results and can act on them.
  }

  // Hit the safety cap → return whatever we have, plus a hint to the client.
  return json({
    error: 'tool loop exceeded MAX_TOOL_ROUNDS=' + MAX_TOOL_ROUNDS + ' — Claude kept calling tools. Trace below.',
    _trace: trace,
  }, 500);
}

export async function onRequest({ request }) {
  return new Response(`Method ${request.method} not allowed. Use POST.`, {
    status: 405,
    headers: { 'Allow': 'POST', 'Content-Type': 'text/plain' },
  });
}
