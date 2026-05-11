// Cloudflare Pages Function — POST /api/import-document
// Body shapes:
//   { kind: "pdf",  filename, content_base64 }  → Claude reads the PDF natively
//   { kind: "text", filename, content_text }    → plain-text body
//
// Same downstream pipeline as /api/import-image:
//   - Claude returns a structured JSON (title, preview, detailed, kind,
//     garden_type, topics, entities, ocr_text, is_recipe?, recipe?)
//   - If is_recipe=true → note_type='recipe' and source_meta.recipe filled
//   - Else → note_type='document', body = analysis.detailed + ocr text
//   - Stored in D1 with source_type='document'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || ('doc-' + Date.now());
}

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  if (!env.DB) return json({ error: 'D1 binding env.DB missing' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const kind = body.kind === 'text' ? 'text' : 'pdf';
  const filename = (body.filename || (kind === 'pdf' ? 'dokument.pdf' : 'datei.txt')).slice(0, 200);
  const today = new Date().toISOString().slice(0, 10);

  const systemPrompt = `Du analysierst ein Dokument, das der Nutzer in seine persönliche Wissensbank importieren möchte. Sprache der Ausgabe: **Deutsch**.

Liefere AUSSCHLIESSLICH ein einzelnes JSON-Objekt:

{
  "kind": "article | recipe | report | receipt | document | contract | invoice | manual | other",
  "title": "Knapper Titel max 80 Zeichen",
  "preview": "Kurze Einleitung max 200 Zeichen, ein Satz",
  "detailed": "Ausführlichere Beschreibung 400-700 Zeichen, 2-4 Sätze",
  "garden_type": "Article | Recipe | Document | Report | Receipt | Manual | Other",
  "topics": ["hierarchische tags z.B. work/contracts oder food/recipes"],
  "ocr_text": "Vollständiger Inhalt des Dokuments als Klartext (bei PDFs der gesamte lesbare Text, bei Text-Dateien identisch zum Original — auf max 8000 Zeichen kappen).",
  "entities": [
    { "name": "Eigenname", "type": "Person | Place | Organization | Topic | Book | Movie | Product | Event" }
  ],
  "is_recipe": false,
  "recipe": null
}

WENN das Dokument ein REZEPT ist (klare Zutaten + Schritte), setze "is_recipe": true UND fülle "recipe":

{
  "servings": 4, "total_minutes": 45, "prep_minutes": 15, "cook_minutes": 30,
  "location": "Herd, Backofen", "equipment": ["Backofen"],
  "ingredients": ["500 g Spaghetti"], "steps": ["Wasser kochen"],
  "calories_per_serving": null, "protein_g": null, "carbs_g": null, "fat_g": null,
  "tags": ["italienisch"], "notes": ""
}

Regeln:
- Bei "ocr_text" den Volltext durchgeben, aber AUF MAX ~8000 Zeichen kappen damit das JSON klein bleibt. Bei langen Dokumenten lieber inhaltliche Zusammenfassung in "detailed".
- entities: nur Eigennamen die wirklich vorkommen, NIE halluzinieren. 0-20.
- is_recipe NUR true wenn klare Zutaten- UND Schritte-Liste. Kochbücher-Inhaltsverzeichnis zählt nicht als Rezept.
- garden_type strikt eine der vorgegebenen Optionen.
- KEINE Erklärung vor oder nach dem JSON, KEIN \`\`\`json-Block — nur das pure JSON.

Heute: ${today}. Dateiname: ${filename}.`;

  // Build the user content depending on kind
  let userContent;
  if (kind === 'pdf') {
    if (!body.content_base64 || typeof body.content_base64 !== 'string') {
      return json({ error: 'content_base64 required for kind=pdf' }, 400);
    }
    // Sane size cap — ~20 MB base64 = ~14 MB PDF
    if (body.content_base64.length > 30_000_000) {
      return json({ error: 'PDF too large. Aim for <14 MB.' }, 413);
    }
    userContent = [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: body.content_base64 },
      },
      { type: 'text', text: 'Bitte analysiere dieses PDF gemäss den Vorgaben.' },
    ];
  } else {
    if (typeof body.content_text !== 'string' || !body.content_text.trim()) {
      return json({ error: 'content_text required for kind=text' }, 400);
    }
    // Cap the text we send so we don't blow Claude's context budget
    const text = body.content_text.length > 80000
      ? body.content_text.slice(0, 80000) + '\n\n[…content truncated to 80000 chars…]'
      : body.content_text;
    userContent = [
      { type: 'text', text: 'Bitte analysiere dieses Text-Dokument:\n\n' + text },
    ];
  }

  // Call Claude
  let apiRes;
  try {
    apiRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        system: systemPrompt,
        max_tokens: 3500,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } catch (e) {
    return json({ error: 'Anthropic request failed: ' + (e.message || e) }, 502);
  }
  if (!apiRes.ok) {
    const errBody = await apiRes.text();
    return json({ error: 'Anthropic ' + apiRes.status + ': ' + errBody.slice(0, 500) }, apiRes.status);
  }
  const data = await apiRes.json();
  const txt = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();

  let analysis;
  let jsonStr = txt;
  if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  const a = jsonStr.indexOf('{');
  const b = jsonStr.lastIndexOf('}');
  if (a >= 0 && b > a) jsonStr = jsonStr.slice(a, b + 1);
  try { analysis = JSON.parse(jsonStr); }
  catch (e) { return json({ error: 'Claude returned non-JSON: ' + txt.slice(0, 300) }, 502); }

  const sourceMeta = {
    filename, kind,
    document_kind: analysis.kind || 'other',
    ocr_text: typeof analysis.ocr_text === 'string' ? analysis.ocr_text : '',
  };
  if (Array.isArray(analysis.entities)) {
    sourceMeta.entities = analysis.entities
      .filter(e => e && typeof e.name === 'string' && e.name.trim().length > 1)
      .slice(0, 25);
  }

  const isRecipe = analysis.is_recipe === true
    && analysis.recipe
    && Array.isArray(analysis.recipe.ingredients) && analysis.recipe.ingredients.length > 0
    && Array.isArray(analysis.recipe.steps) && analysis.recipe.steps.length > 0;
  if (isRecipe) {
    sourceMeta.recipe = {
      servings:      Number.isInteger(analysis.recipe.servings)      ? analysis.recipe.servings      : 4,
      total_minutes: Number.isInteger(analysis.recipe.total_minutes) ? analysis.recipe.total_minutes : null,
      prep_minutes:  Number.isInteger(analysis.recipe.prep_minutes)  ? analysis.recipe.prep_minutes  : null,
      cook_minutes:  Number.isInteger(analysis.recipe.cook_minutes)  ? analysis.recipe.cook_minutes  : null,
      location:      typeof analysis.recipe.location === 'string'   ? analysis.recipe.location      : null,
      equipment:     Array.isArray(analysis.recipe.equipment) ? analysis.recipe.equipment.filter(Boolean) : [],
      ingredients:   analysis.recipe.ingredients.filter(Boolean),
      steps:         analysis.recipe.steps.filter(Boolean),
      calories_per_serving: Number.isInteger(analysis.recipe.calories_per_serving) ? analysis.recipe.calories_per_serving : null,
      protein_g:     Number.isInteger(analysis.recipe.protein_g) ? analysis.recipe.protein_g : null,
      carbs_g:       Number.isInteger(analysis.recipe.carbs_g)   ? analysis.recipe.carbs_g   : null,
      fat_g:         Number.isInteger(analysis.recipe.fat_g)     ? analysis.recipe.fat_g     : null,
      tags:          Array.isArray(analysis.recipe.tags) ? analysis.recipe.tags.filter(Boolean) : [],
      notes:         typeof analysis.recipe.notes === 'string' ? analysis.recipe.notes : '',
    };
  }

  const title = (analysis.title || filename.replace(/\.[a-z0-9]+$/i, '') || 'Dokument').slice(0, 200);
  const preview  = analysis.preview  || '';
  const detailed = analysis.detailed || '';
  const noteType = isRecipe ? 'recipe' : 'document';
  const garden_type = isRecipe ? 'Recipe' : (analysis.garden_type || 'Document');
  const tags = Array.isArray(analysis.topics) ? analysis.topics.join(',') : '';
  const slug = slugify(title) + '-' + Date.now().toString(36);

  // Body shown in the note view = detailed description + (capped) OCR
  let bodyText = detailed;
  if (sourceMeta.ocr_text && sourceMeta.ocr_text.length > 5) {
    const ocrSnippet = sourceMeta.ocr_text.length > 4000
      ? sourceMeta.ocr_text.slice(0, 4000) + '\n\n[…Volltext gekürzt — vollständiger Text in source_meta.ocr_text]'
      : sourceMeta.ocr_text;
    bodyText += '\n\n--- Inhalt ---\n' + ocrSnippet;
  }

  try {
    const r = await env.DB.prepare(
      'INSERT INTO notes (slug, title, body, note_type, related_topics, source_type, source_meta, garden_type) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      slug, title, bodyText, noteType, tags,
      'document', JSON.stringify(sourceMeta), garden_type
    ).run();
    return json({
      ok: true,
      id: r.meta?.last_row_id,
      slug, title, preview, detailed,
      kind: analysis.kind || (kind === 'pdf' ? 'pdf' : 'text'),
      is_recipe: isRecipe,
      garden_type,
      topics: analysis.topics || [],
      entity_count: (analysis.entities || []).length,
      content_chars: (sourceMeta.ocr_text || '').length,
    });
  } catch (e) {
    return json({ error: 'D1 insert failed: ' + (e.message || e) }, 500);
  }
}

export async function onRequest({ request }) {
  return new Response('POST only', { status: 405, headers: { 'Allow': 'POST' } });
}
