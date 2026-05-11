// Cookbook URL import: server-side fetches a PDF from a public URL,
// converts to base64, and stores in the cookbooks table + chunks.
//
// POST /api/cookbooks/import-url
// Body: { url, title?, source?, servings_base? }

import { saveCookbookChunks } from '../../_lib/pdf-chunks.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || ('cookbook-' + Date.now());
}
function arrayBufferToBase64(buffer) {
  // Cloudflare Workers don't have Buffer; build base64 from Uint8Array
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding missing' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const url = (body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return json({ error: 'url must be a public http(s) URL' }, 400);

  let pdfBuf;
  let contentType = '';
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BrainPKA/1.0)' },
      redirect: 'follow',
    });
    if (!r.ok) return json({ error: 'Fetch failed: HTTP ' + r.status }, 502);
    contentType = r.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('pdf')) {
      return json({ error: 'URL does not point to a PDF (got Content-Type: ' + contentType + ')' }, 415);
    }
    pdfBuf = await r.arrayBuffer();
    // Size cap — mirror /api/cookbooks's POST limit (~18 MB PDF)
    if (pdfBuf.byteLength > 19 * 1024 * 1024) {
      return json({ error: 'PDF too large after fetch (' + Math.round(pdfBuf.byteLength/1024/1024) + ' MB). Max 18 MB for in-D1 storage.' }, 413);
    }
  } catch (e) {
    return json({ error: 'Fetch error: ' + (e.message || e) }, 502);
  }

  const pdf_b64 = arrayBufferToBase64(pdfBuf);
  const pdf_size_kb = Math.round(pdfBuf.byteLength / 1024);
  const title = (body.title || url.split('/').pop().replace(/\.pdf$/i, '').replace(/%[0-9A-F]{2}/gi, c => decodeURIComponent(c))).slice(0, 200);
  const slug = slugify(title) + '-' + Date.now().toString(36);

  try {
    // Metadata row first (no pdf_b64 in cookbooks anymore — bytes live
    // in cookbook_chunks).
    const r = await env.DB.prepare(
      'INSERT INTO cookbooks (slug, title, author, description, pdf_size_kb, source, servings_base) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      slug, title,
      body.author || null,
      body.description || null,
      pdf_size_kb,
      body.source || null,
      Number.isInteger(body.servings_base) ? body.servings_base : 4,
    ).run();
    const newId = r.meta?.last_row_id;
    if (!newId) throw new Error('Could not get inserted cookbook id');
    const chunkCount = await saveCookbookChunks(env, newId, pdf_b64);
    return json({
      ok: true,
      id: newId,
      slug, title, pdf_size_kb,
      chunks: chunkCount,
      source_url: url,
    });
  } catch (e) {
    return json({ error: 'D1 insert failed: ' + (e.message || e) }, 500);
  }
}
