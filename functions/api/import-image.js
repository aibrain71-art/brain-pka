// Cloudflare Pages Function — POST /api/import-image
// Body: { image: "data:image/jpeg;base64,...", filename: "name.jpg", source: "camera"|"picker" }
//
// Pipeline:
//   1. Strip the data-URL prefix to get the raw base64 + media_type
//   2. Send to Claude (multimodal) with a structured prompt asking it
//      to classify content type and extract any text + structured data
//   3. Server-side detect if it's a recipe → mark note_type='recipe' so
//      it lands on the cookbook page; otherwise just a note with OCR
//   4. INSERT into notes with source_type='image' + source_meta carrying
//      the recipe block (if recipe), the OCR text, filename
//
// Output to the client mirrors /api/import-link's shape so the browser
// can reuse the same toast/refresh flow.

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
    .slice(0, 80) || ('image-' + Date.now());
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  return { media_type: m[1], data: m[2] };
}

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  if (!env.DB) return json({ error: 'D1 binding env.DB missing' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const parsed = parseDataUrl(body.image);
  if (!parsed) return json({ error: 'image must be a base64 data URL like data:image/jpeg;base64,…' }, 400);
  // Cloudflare Workers cap request bodies around 100 MB but we want
  // sane limits for Claude (max ~5 MB base64 = ~3.5 MB image).
  if (parsed.data.length > 6_500_000) return json({ error: 'Image too large after compression. Aim for <4 MB.' }, 413);

  const filename = (body.filename || 'image').slice(0, 200);
  const source   = body.source === 'camera' ? 'camera' : 'picker';
  const today    = new Date().toISOString().slice(0, 10);

  const systemPrompt = `Du analysierst ein Bild, das der Nutzer in seine persönliche Wissensbank importieren möchte. Sprache der Ausgabe: **Deutsch**.

Liefere AUSSCHLIESSLICH ein einzelnes JSON-Objekt:

{
  "kind": "recipe | receipt | document | screenshot | handwritten_note | photo | menu | label | whiteboard | other",
  "title": "Knapper Titel max 80 Zeichen — beschreibt was auf dem Bild ist",
  "preview": "Kurze Einleitung max 200 Zeichen, ein Satz",
  "detailed": "Ausführlichere Beschreibung 300-600 Zeichen, 2-3 Sätze",
  "garden_type": "Eine von: Recipe, Article, Receipt, Document, Screenshot, Note, Menu, Other",
  "topics": ["hierarchische tags z.B. food/recipe oder finance/receipt"],
  "ocr_text": "Vollständiger Text der im Bild lesbar ist (falls vorhanden). Erhalte Zeilenumbrüche.",
  "entities": [
    { "name": "Eigenname", "type": "Person | Place | Organization | Topic | Book | Movie | Product | Event" }
  ],
  "is_recipe": false,
  "recipe": null
}

WENN das Bild ein REZEPT zeigt (Zutaten + Schritte erkennbar — z.B. Foto einer Kochbuch-Seite, Rezept-Karte, handgeschriebenes Rezept), setze "is_recipe": true UND fülle "recipe":

{
  "servings": 4,
  "total_minutes": 45,
  "prep_minutes": 15,
  "cook_minutes": 30,
  "location": "Herd, Backofen",
  "equipment": ["Backofen", "grosse Pfanne"],
  "ingredients": ["500 g Spaghetti", "4 Tomaten"],
  "steps": ["Wasser zum Kochen bringen", "Zwiebel hacken"],
  "calories_per_serving": null,
  "protein_g": null,
  "carbs_g": null,
  "fat_g": null,
  "tags": ["italienisch"],
  "notes": ""
}

Regeln:
- "kind" so spezifisch wie möglich wählen (recipe, receipt, screenshot, etc.).
- ocr_text: ALLES was lesbar ist 1:1 transkribieren, in der Original-Sprache des Bildes. Bei Handschrift so gut wie möglich.
- entities: nur Eigennamen die WIRKLICH im Bild stehen, NIE halluzinieren. 0-15 Einträge.
- is_recipe NUR true wenn klare Zutaten- UND Schritte-Liste erkennbar. Speise-Fotos oder Menüs sind KEIN Rezept.
- Bei is_recipe=true MÜSSEN ingredients[] und steps[] gefüllt sein, fehlende Felder wie Nährwerte = null.
- garden_type strikt eine der vorgegebenen Optionen.
- topics: hierarchische Slugs in Kleinbuchstaben, ohne Umlaute (ae/oe/ue/ss).
- KEINE Erklärung vor oder nach dem JSON, KEIN \`\`\`json-Block — nur das pure JSON.

Heute: ${today}. Bildquelle: ${source} (camera | picker), Dateiname: ${filename}.`;

  // Call Claude Vision
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
        max_tokens: 3072,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: parsed.media_type, data: parsed.data },
            },
            { type: 'text', text: 'Bitte analysiere dieses Bild gemäss den Vorgaben.' },
          ],
        }],
      }),
    });
  } catch (e) {
    return json({ error: 'Anthropic request failed: ' + (e.message || e) }, 502);
  }

  if (!apiRes.ok) {
    const errBody = await apiRes.text();
    return json({ error: 'Anthropic ' + apiRes.status + ': ' + errBody.slice(0, 400) }, apiRes.status);
  }
  const data = await apiRes.json();
  const txt = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();

  // Parse Claude's JSON output
  let analysis;
  let jsonStr = txt;
  if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  const a = jsonStr.indexOf('{');
  const b = jsonStr.lastIndexOf('}');
  if (a >= 0 && b > a) jsonStr = jsonStr.slice(a, b + 1);
  try { analysis = JSON.parse(jsonStr); }
  catch (e) { return json({ error: 'Claude returned non-JSON: ' + txt.slice(0, 300) }, 502); }

  // Build source_meta with optional recipe + OCR + raw analysis
  const sourceMeta = {
    filename, source,
    kind: analysis.kind || 'other',
    ocr_text: typeof analysis.ocr_text === 'string' ? analysis.ocr_text : '',
  };
  if (Array.isArray(analysis.entities)) {
    sourceMeta.entities = analysis.entities
      .filter(e => e && typeof e.name === 'string' && e.name.trim().length > 1)
      .slice(0, 20);
  }

  const isRecipe = analysis.is_recipe === true
    && analysis.recipe
    && Array.isArray(analysis.recipe.ingredients)
    && analysis.recipe.ingredients.length > 0
    && Array.isArray(analysis.recipe.steps)
    && analysis.recipe.steps.length > 0;
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

  const title = (analysis.title || filename || 'Bild').slice(0, 200);
  const preview  = analysis.preview  || '';
  const detailed = analysis.detailed || '';
  const noteType = isRecipe ? 'recipe' : 'image';
  const garden_type = isRecipe ? 'Recipe' : (analysis.garden_type || 'Document');
  const tags = Array.isArray(analysis.topics) ? analysis.topics.join(',') : '';
  const slug = slugify(title) + '-' + Date.now().toString(36);

  // Body shown in the note view = detailed description + OCR snippet
  let bodyText = detailed;
  if (sourceMeta.ocr_text && sourceMeta.ocr_text.length > 5) {
    bodyText += '\n\n--- Erkannter Text ---\n' + sourceMeta.ocr_text;
  }

  try {
    const r = await env.DB.prepare(
      'INSERT INTO notes (slug, title, body, note_type, related_topics, source_type, source_meta, garden_type) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      slug, title, bodyText, noteType, tags,
      'image', JSON.stringify(sourceMeta), garden_type
    ).run();
    return json({
      ok: true,
      id: r.meta?.last_row_id,
      slug, title, preview, detailed,
      kind: analysis.kind || 'photo',
      is_recipe: isRecipe,
      garden_type,
      topics: analysis.topics || [],
      entity_count: (analysis.entities || []).length,
      ocr_chars: (sourceMeta.ocr_text || '').length,
    });
  } catch (e) {
    return json({ error: 'D1 insert failed: ' + (e.message || e) }, 500);
  }
}

export async function onRequest({ request }) {
  return new Response('POST only', { status: 405, headers: { 'Allow': 'POST' } });
}
