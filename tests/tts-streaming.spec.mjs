// Structural test for Bug B (voice-tools-streaming branch).
//
// What this verifies:
//   1. /api/tts proxy picks the /stream variant of ElevenLabs when
//      the client sends stream:true.
//   2. /api/tts proxy passes through the upstream body without
//      buffering (the change isn't observable in code, but we assert
//      the Response constructor is fed a ReadableStream-like body,
//      not a Buffer).
//   3. optimize_streaming_latency=3 lands in the query string when
//      streaming is requested; absent when buffered.
//   4. output_format=mp3_44100_128 is always set so the browser
//      side (MediaSource) gets a known-good codec.
//
// We stub global fetch to intercept the call ElevenLabs would receive
// and assert on the URL / body shape, then return a fake streaming
// response and verify the handler passes the body through.
//
// Run:  cd PKM && node --test tests/tts-streaming.spec.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/tts.js';

// ── helpers ─────────────────────────────────────────────────────
function makeReq(bodyObj) {
  return new Request('https://example.invalid/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
}

function makeEnv() {
  return { ELEVENLABS_API_KEY: 'sk_test_fake_key' };
}

function makeStreamResponse(bytes = new Uint8Array([0xFF, 0xFB, 0x90, 0x00])) {
  // Mimic ElevenLabs returning a chunked MP3 stream.
  const stream = new ReadableStream({
    start(ctrl) { ctrl.enqueue(bytes); ctrl.close(); },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
  });
}

// ── tests ───────────────────────────────────────────────────────

test('proxy picks /stream endpoint when stream:true', async () => {
  let capturedUrl;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return makeStreamResponse();
  };
  try {
    const req = makeReq({ text: 'Hallo Sir.', voiceId: '21m00Tcm4TlvDq8ikWAM', stream: true });
    await onRequestPost({ request: req, env: makeEnv() });
    assert.match(capturedUrl, /\/text-to-speech\/[^/]+\/stream\?/, 'should hit /stream variant: ' + capturedUrl);
    assert.match(capturedUrl, /optimize_streaming_latency=3/);
    assert.match(capturedUrl, /output_format=mp3_44100_128/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('proxy uses non-stream endpoint when stream flag omitted', async () => {
  let capturedUrl;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return makeStreamResponse();
  };
  try {
    const req = makeReq({ text: 'Hallo.', voiceId: '21m00Tcm4TlvDq8ikWAM' });
    await onRequestPost({ request: req, env: makeEnv() });
    assert.doesNotMatch(capturedUrl, /\/stream\?/, 'should NOT hit /stream when stream omitted: ' + capturedUrl);
    // But output_format still pinned for predictable browser playback.
    assert.match(capturedUrl, /output_format=mp3_44100_128/);
    assert.doesNotMatch(capturedUrl, /optimize_streaming_latency/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('proxy honours custom optimize_streaming_latency in the 0-4 range', async () => {
  let capturedUrl;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { capturedUrl = String(url); return makeStreamResponse(); };
  try {
    const req = makeReq({
      text: 'X.', voiceId: 'v1',
      stream: true,
      optimize_streaming_latency: 4,
    });
    await onRequestPost({ request: req, env: makeEnv() });
    assert.match(capturedUrl, /optimize_streaming_latency=4/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('proxy clamps invalid optimize_streaming_latency to default 3', async () => {
  let capturedUrl;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { capturedUrl = String(url); return makeStreamResponse(); };
  try {
    const req = makeReq({
      text: 'X.', voiceId: 'v1',
      stream: true,
      optimize_streaming_latency: 'banana',
    });
    await onRequestPost({ request: req, env: makeEnv() });
    assert.match(capturedUrl, /optimize_streaming_latency=3/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('proxy passes the upstream body through (no server-side buffering)', async () => {
  // Confirms the Cloudflare Pages function returns apiRes.body (a
  // ReadableStream) directly, not a buffered Buffer. We do this by
  // counting the time between the upstream's first chunk arriving
  // and the response being returned — should be near-zero, not the
  // upstream's full duration.
  let upstreamCtrl;
  const upstreamBody = new ReadableStream({
    start(c) { upstreamCtrl = c; /* don't close — leave the stream live */ },
  });
  const upstreamRes = new Response(upstreamBody, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => upstreamRes;
  try {
    const req = makeReq({ text: 'Hallo.', voiceId: 'v1', stream: true });
    const startT = Date.now();
    const out = await onRequestPost({ request: req, env: makeEnv() });
    const elapsed = Date.now() - startT;

    // The handler returns immediately, BEFORE the upstream stream closes
    // (we never called upstreamCtrl.close). If it were buffering the body,
    // this Promise would hang forever — the test would time out.
    assert.ok(elapsed < 1000, 'handler should return fast, was ' + elapsed + 'ms');
    assert.equal(out.status, 200);
    assert.equal(out.headers.get('Content-Type'), 'audio/mpeg');
    assert.equal(out.headers.get('X-Streaming'), '1');
    assert.ok(out.body instanceof ReadableStream, 'response body should be a ReadableStream');

    // Now push a chunk through and confirm it surfaces on the response.
    const reader = out.body.getReader();
    upstreamCtrl.enqueue(new Uint8Array([0xFF, 0xFB]));
    upstreamCtrl.close();
    const { value, done } = await reader.read();
    assert.equal(done, false);
    assert.ok(value && value.length >= 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('proxy errors when ELEVENLABS_API_KEY missing — surfaced to client, no upstream call', async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return makeStreamResponse(); };
  try {
    const req = makeReq({ text: 'X.', voiceId: 'v1', stream: true });
    const out = await onRequestPost({ request: req, env: {} });
    assert.equal(out.status, 500);
    assert.equal(calls, 0, 'should not call upstream when key missing');
    const body = await out.json();
    assert.match(body.error, /ELEVENLABS_API_KEY not configured/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('proxy validates body — empty text rejected before upstream call', async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return makeStreamResponse(); };
  try {
    const req = makeReq({ text: '', voiceId: 'v1', stream: true });
    const out = await onRequestPost({ request: req, env: makeEnv() });
    assert.equal(out.status, 400);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
