// Shared helper for storing + retrieving cookbook PDF bytes in D1.
// D1 has a ~1 MB cap per TEXT column, so a 2 MB PDF (~2.7 MB base64)
// gets split into ~700 KB chunks and stored in cookbook_chunks
// (cookbook_id, idx, data_b64). The cookbooks.pdf_b64 column is kept
// for backward compatibility but no longer populated by new inserts.

const CHUNK_SIZE = 700 * 1024;  // 700 KB base64 → ~525 KB binary per row

// Split a base64 string into chunks and INSERT them all in one batch.
// Returns number of chunks written. Throws on D1 failure.
export async function saveCookbookChunks(env, cookbookId, pdfB64) {
  if (!cookbookId || !pdfB64) throw new Error('cookbookId + pdfB64 required');
  // Remove any existing chunks first (in case of re-upload over same id)
  await env.DB.prepare('DELETE FROM cookbook_chunks WHERE cookbook_id = ?').bind(cookbookId).run();
  const chunks = [];
  for (let i = 0; i < pdfB64.length; i += CHUNK_SIZE) {
    chunks.push(pdfB64.slice(i, i + CHUNK_SIZE));
  }
  const stmts = chunks.map((data, idx) => env.DB.prepare(
    'INSERT INTO cookbook_chunks (cookbook_id, idx, data_b64) VALUES (?, ?, ?)'
  ).bind(cookbookId, idx, data));
  await env.DB.batch(stmts);
  return chunks.length;
}

// Reassemble a cookbook's PDF from chunks. Falls back to the legacy
// pdf_b64 column on the cookbooks table if no chunks exist (old uploads).
export async function loadCookbookB64(env, cookbookId) {
  if (!cookbookId) return null;
  const rows = await env.DB.prepare(
    'SELECT data_b64 FROM cookbook_chunks WHERE cookbook_id = ? ORDER BY idx ASC'
  ).bind(cookbookId).all();
  if (rows.results && rows.results.length) {
    return rows.results.map(r => r.data_b64).join('');
  }
  // Legacy path: small old uploads where pdf_b64 fit in a single row
  const legacy = await env.DB.prepare('SELECT pdf_b64 FROM cookbooks WHERE id = ?')
    .bind(cookbookId).first();
  return legacy?.pdf_b64 || null;
}

export async function deleteCookbookChunks(env, cookbookId) {
  await env.DB.prepare('DELETE FROM cookbook_chunks WHERE cookbook_id = ?').bind(cookbookId).run();
}
