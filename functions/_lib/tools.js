// Tool catalogue for Larry — every tool exposed to the Anthropic API.
// Each tool has a JSONSchema input_schema (so Claude knows what to send)
// and a server-side executor that runs against env.DB (the D1 binding).
//
// Tools are invoked by /api/chat in an agentic loop: Claude returns a
// tool_use block, this module executes it, and the result is fed back
// as a tool_result content block on the next turn.

import { normalizeItemKey, resyncShoppingForPlan } from './meal-aggregator.js';

// ── helpers ─────────────────────────────────────────────────────
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || ('note-' + Date.now());
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function ok(data)     { return JSON.stringify({ ok: true,  ...data }); }
function fail(reason) { return JSON.stringify({ ok: false, error: reason }); }

// ── tool definitions ────────────────────────────────────────────
// IMPORTANT: keep this list small and focused. Each tool you add
// inflates Larry's system prompt size and his decision space. Five
// useful tools beat fifteen vague ones.
export const TOOLS = [
  // ───── notes ───────────────────────────────────────────────
  {
    name: 'create_note',
    description: 'Create a new note in the user\'s personal knowledge base. Use for ideas, facts, quotes, references — anything the user wants to remember later. Confirm out loud after saving.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title (max ~60 chars). Required.' },
        body:  { type: 'string', description: 'Full content. Required.' },
        note_type: { type: 'string', enum: ['note', 'quote', 'recipe', 'reference', 'followup'], description: 'Type of note. Default "note".' },
        tags:  { type: 'string', description: 'Comma-separated topic tags, e.g. "stoicism,reading".' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'search_notes',
    description: 'Find notes matching a query. Searches title + body + tags case-insensitively. Returns up to 10 hits with id, title, snippet, created_at.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword(s) to look for.' },
        limit: { type: 'integer', description: 'Max results (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'delete_note',
    description: 'Delete a note by id. Always confirm with the user before calling — deletion is permanent.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Note id from search_notes.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_recent_notes',
    description: 'List the most recent notes, newest first. Useful for "what did I write down lately?"',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many (default 5, max 20).' },
      },
    },
  },

  // ───── journal ─────────────────────────────────────────────
  {
    name: 'create_journal',
    description: 'Write a journal entry. Use for daily reflection, what happened today, mood notes. Different from create_note — journal is dated and chronological.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One-line summary of the entry.' },
        body:  { type: 'string', description: 'Full reflection text.' },
        mood:  { type: 'string', description: 'Optional mood label e.g. "focused", "tired", "grateful".' },
        entry_date: { type: 'string', description: 'YYYY-MM-DD. Default today.' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'search_journal',
    description: 'Search journal entries by keyword. Returns id, entry_date, title, snippet.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', description: 'Default 10.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_recent_journal',
    description: 'List most recent journal entries.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Default 5, max 30.' },
      },
    },
  },

  // ───── tasks ───────────────────────────────────────────────
  {
    name: 'create_task',
    description: 'Capture a TODO / action item. Use for things the user has to DO (vs. notes which are things to REMEMBER).',
    input_schema: {
      type: 'object',
      properties: {
        title:    { type: 'string', description: 'What needs doing.' },
        details:  { type: 'string', description: 'Optional extra context.' },
        priority: { type: 'integer', enum: [1,2,3,4], description: '1=urgent, 2=high, 3=normal (default), 4=low.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD when it must be done.' },
        tags:     { type: 'string', description: 'Comma-separated tags.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_open_tasks',
    description: 'List the user\'s open tasks, sorted by priority then due date.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Default 10.' },
      },
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done. Always confirm the task title with the user before calling so you delete the right one.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
      },
      required: ['id'],
    },
  },

  // ───── recipes (structured notes with note_type='recipe') ─
  {
    name: 'create_recipe',
    description: 'Strukturiertes Rezept anlegen — Larry sollte das nutzen wenn der User Kochbuch-Inhalt diktiert ("Rezept Bolognese für 4 Personen…"). Speichert servings, Zeit, Geräte, Nährwerte, Zutaten, Schritte als eigene Felder, damit die Rezept-Webseite (cookbook.html) sie strukturiert rendern kann.',
    input_schema: {
      type: 'object',
      properties: {
        title:           { type: 'string', description: 'Name des Rezepts.' },
        servings:        { type: 'integer', description: 'Anzahl Portionen (Standard 4).' },
        total_minutes:   { type: 'integer', description: 'Gesamtzeit in Minuten.' },
        prep_minutes:    { type: 'integer', description: 'Vorbereitungszeit.' },
        cook_minutes:    { type: 'integer', description: 'Koch-/Backzeit.' },
        location:        { type: 'string', description: 'Wo gekocht wird, z.B. "Herd + Backofen".' },
        equipment:       { type: 'array', items: { type: 'string' }, description: 'Geräte/Werkzeuge, z.B. ["Backofen","grosse Pfanne","Sieb"].' },
        ingredients:     { type: 'array', items: { type: 'string' }, description: 'Zutaten als ganze Zeilen, z.B. ["500 g Spaghetti","4 Tomaten","1 Zwiebel"].' },
        steps:           { type: 'array', items: { type: 'string' }, description: 'Schritte in Reihenfolge, z.B. ["Wasser zum Kochen bringen","Zwiebel hacken","Tomaten anbraten"].' },
        calories_per_serving: { type: 'integer', description: 'Kalorien pro Portion (kcal).' },
        protein_g:       { type: 'integer', description: 'Eiweiss pro Portion in Gramm.' },
        carbs_g:         { type: 'integer', description: 'Kohlenhydrate pro Portion in Gramm.' },
        fat_g:           { type: 'integer', description: 'Fett pro Portion in Gramm.' },
        tags:            { type: 'array', items: { type: 'string' }, description: 'Schlagwörter wie ["italienisch","vegetarisch","schnell"].' },
        notes:           { type: 'string', description: 'Freitext-Anmerkungen.' },
      },
      required: ['title', 'ingredients', 'steps'],
    },
  },
  {
    name: 'promote_note_to_recipe',
    description: 'Wandelt eine bestehende Notiz in ein strukturiertes Rezept um. Nutze dies wenn der User sagt „mach die letzte Notiz zum Rezept", „nimm Notiz X als Rezept ins Kochbuch" o.ä. Larry liest dazu vorher den Body der Notiz (via list_recent_notes oder search_notes), extrahiert die strukturierten Felder selbst und übergibt sie hier — die SQL-UPDATE-Logik passiert dann server-seitig. Original-Titel und related_topics bleiben erhalten.',
    input_schema: {
      type: 'object',
      properties: {
        id:              { type: 'integer', description: 'Note-ID die konvertiert wird.' },
        servings:        { type: 'integer', description: 'Anzahl Portionen (Standard 4).' },
        total_minutes:   { type: 'integer' },
        prep_minutes:    { type: 'integer' },
        cook_minutes:    { type: 'integer' },
        location:        { type: 'string' },
        equipment:       { type: 'array', items: { type: 'string' } },
        ingredients:     { type: 'array', items: { type: 'string' }, description: 'Zutaten als ganze Zeilen.' },
        steps:           { type: 'array', items: { type: 'string' }, description: 'Schritte in Reihenfolge.' },
        calories_per_serving: { type: 'integer' },
        protein_g:       { type: 'integer' },
        carbs_g:         { type: 'integer' },
        fat_g:           { type: 'integer' },
        tags:            { type: 'array', items: { type: 'string' } },
        notes:           { type: 'string' },
      },
      required: ['id', 'ingredients', 'steps'],
    },
  },
  // ───── shopping list ───────────────────────────────────────
  {
    name: 'add_to_shopping_list',
    description: 'Fügt einen oder mehrere Einträge zur Einkaufsliste hinzu. Nutze dies wenn der User sagt „setz X auf die Einkaufsliste", „füg Y zur Einkaufsliste hinzu", „ich brauche Z", „Einkaufsliste: Milch, Brot, Käse". Bei mehreren Items in einer Sprachaussage MEHRERE create-Aufrufe auf einmal — alternativ items[] für Bulk.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Liste von Einkaufseinträgen. Jeder Eintrag hat item (Produktname) plus optional qty_value + qty_unit.',
          items: {
            type: 'object',
            properties: {
              item:      { type: 'string', description: 'Produktname, z.B. „Milch", „Brot"' },
              qty_value: { type: 'number', description: 'Menge als Zahl, z.B. 2' },
              qty_unit:  { type: 'string', description: 'Einheit, z.B. „l", „kg", „Stück", „Packung"' },
              notes:     { type: 'string', description: 'Optionale Anmerkung' },
            },
            required: ['item'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'list_shopping_list',
    description: 'Liest die aktuelle Einkaufsliste vor. Nutze dies wenn der User fragt „was ist auf der Einkaufsliste", „zeig mir die Einkaufsliste", „was muss ich kaufen".',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open','done','all'], description: 'Filter. Default open.' },
      },
    },
  },
  {
    name: 'clear_shopping_list_done',
    description: 'Entfernt alle bereits erledigten Einträge von der Einkaufsliste. Nur nach expliziter Bestätigung verwenden.',
    input_schema: { type: 'object', properties: {} },
  },
  // ───── blood pressure ──────────────────────────────────────
  {
    name: 'log_blood_pressure',
    description: 'Erfasst eine Blutdruck-Messung. Nutze dies wenn der User sagt „Blutdruck 135 zu 82", „mein Blutdruck war heute 138 86 puls 72", „BP eintragen 120/80". Sys = oberer Wert (höher), Dia = unterer Wert (tiefer). Pulse optional. Bestätige kurz „Eingetragen, Sir: SYS/DIA, Pulse N — Klassifizierung."',
    input_schema: {
      type: 'object',
      properties: {
        systolic:  { type: 'integer', description: 'Oberer Wert (Systolisch) in mmHg, 50-260' },
        diastolic: { type: 'integer', description: 'Unterer Wert (Diastolisch) in mmHg, 30-180' },
        pulse:     { type: 'integer', description: 'Puls in BPM (optional)' },
        body_position: { type: 'string', enum: ['sitzend','liegend','stehend'], description: 'Position bei der Messung' },
        arm:       { type: 'string', enum: ['links','rechts'], description: 'Arm bei der Messung' },
        mood:      { type: 'string', description: 'Befinden während Messung, z.B. „entspannt", „nach Sport", „gestresst"' },
        notes:     { type: 'string', description: 'Freitext-Anmerkung' },
        irregular_heartbeat: { type: 'boolean', description: 'true wenn Herzrhythmusstörung erkannt' },
      },
      required: ['systolic', 'diastolic'],
    },
  },
  {
    name: 'list_recent_blood_pressure',
    description: 'Liest die letzten N Blutdruckwerte vor. Nutze dies wenn der User fragt „wie war mein Blutdruck heute / diese Woche", „letzte Messung".',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Anzahl Einträge (default 5, max 50)' },
      },
    },
  },
  {
    name: 'blood_pressure_stats',
    description: 'Berechnet Durchschnitt + Trend für einen Zeitraum. Nutze dies wenn der User fragt „wie ist mein Schnitt", „Trend letzte Woche", „bin ich im Zielbereich".',
    input_schema: {
      type: 'object',
      properties: {
        range: { type: 'string', enum: ['day','week','month','year'], description: 'Zeitraum (default week)' },
      },
    },
  },
  {
    name: 'open_blood_pressure_dashboard',
    description: 'Öffnet das Blutdruck-Dashboard mit Chart. Nutze dies wenn der User sagt „zeig mir den Blutdruck", „öffne BP-Dashboard", „Health-Übersicht".',
    input_schema: { type: 'object', properties: {} },
  },

  {
    name: 'open_shopping_list',
    description: 'Öffnet die Einkaufsliste in der App. Nutze dies wenn der User sagt „öffne die Einkaufsliste", „zeig mir die Einkaufsliste"  und visuell sehen will.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'open_cookbook',
    description: 'Öffnet die Kochbuch-Webseite (eine Übersichtsseite mit allen Rezepten, sortiert, mit Inhaltsverzeichnis). Nutze dies wenn der User sagt "öffne Kochbuch", "zeig mir alle Rezepte", "wo sind meine Rezepte", "Kochbuch bitte".',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  // ───── ideas ───────────────────────────────────────────────
  {
    name: 'create_idea',
    description: 'Capture a half-baked idea or side-project spark. Lower commitment than a task — just a thought to come back to.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body:  { type: 'string', description: 'Optional elaboration.' },
        tags:  { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_ideas',
    description: 'List ideas, newest first.',
    input_schema: {
      type: 'object',
      properties: {
        limit:  { type: 'integer', description: 'Default 10.' },
        status: { type: 'string', enum: ['spark','developing','shipped','shelved'] },
      },
    },
  },

  // ───── people ──────────────────────────────────────────────
  {
    name: 'search_people',
    description: 'Find a person in the user\'s contact list by name fragment.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },

  // ───── meal planning ───────────────────────────────────────
  {
    name: 'set_meal_slot',
    description: 'Place or change a recipe in the user\'s active weekly meal plan. Use when the user says things like "make Wednesday lunch Bolognese" or "remove Friday dinner". The user must have an active plan (call show_meal_plan first if unsure). recipe_query is fuzzy-matched against recipe titles; if you want to clear a slot, omit recipe_query.',
    input_schema: {
      type: 'object',
      properties: {
        day_idx: { type: 'integer', description: 'Day of week: 0=Mo, 1=Tue, 2=Wed, 3=Thu, 4=Fri, 5=Sat, 6=Sun.' },
        meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner'], description: 'Which slot of the day.' },
        recipe_query: { type: 'string', description: 'Recipe title (fuzzy). Omit to clear the slot.' },
        servings_override: { type: 'integer', description: 'Override portion count for this slot.' },
        note: { type: 'string', description: 'Optional note (e.g. "auswärts essen", "Reste").' },
      },
      required: ['day_idx', 'meal_type'],
    },
  },
  {
    name: 'show_meal_plan',
    description: 'Read out the user\'s currently-active meal plan. Returns all 21 slots (Mo-So × 3) with recipe titles, notes, and plan metadata. Use when the user asks "what\'s the plan this week?" or "what am I cooking on Wednesday?".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'add_to_pantry',
    description: 'Add or update an item in the user\'s pantry (Vorratsschrank) so the meal-plan aggregator can subtract it from future shopping lists. Use when the user says "I just bought 1 liter of olive oil" or "we still have 500g of pasta at home". Items match on a normalized key so "Karotten" and "Karotte" land on the same row.',
    input_schema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Display name, e.g. "Olivenöl".' },
        qty_value: { type: 'number', description: 'Quantity (numeric). Omit for "have it, amount doesn\'t matter".' },
        qty_unit: { type: 'string', description: 'Unit, e.g. "kg", "l", "Stk".' },
        notes: { type: 'string', description: 'Optional notes.' },
      },
      required: ['item'],
    },
  },
];

// ── executor ────────────────────────────────────────────────────
// Single entry point — chat.js calls this for each tool_use block.
// Returns a JSON string (Anthropic tool_result content is a string).
export async function executeTool(name, args, env) {
  if (!env.DB) return fail('D1 database binding env.DB missing — wrangler.toml not deployed?');
  args = args || {};
  try {
    switch (name) {
      // ───── notes ─────────────────────────────────────────
      case 'create_note': {
        if (!args.title || !args.body) return fail('title and body required');
        const slug = slugify(args.title) + '-' + Date.now().toString(36);
        const note_type = args.note_type || 'note';
        const tags = args.tags || null;
        const r = await env.DB.prepare(
          'INSERT INTO notes (slug, title, body, note_type, related_topics) VALUES (?, ?, ?, ?, ?)'
        ).bind(slug, args.title, args.body, note_type, tags).run();
        return ok({ id: r.meta?.last_row_id, slug, title: args.title });
      }
      case 'search_notes': {
        const q = '%' + (args.query || '').toLowerCase() + '%';
        const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 25);
        const rows = await env.DB.prepare(
          'SELECT id, title, substr(body,1,200) AS snippet, note_type, related_topics, created_at FROM notes ' +
          'WHERE lower(title) LIKE ? OR lower(body) LIKE ? OR lower(coalesce(related_topics,\'\')) LIKE ? ' +
          'ORDER BY created_at DESC LIMIT ?'
        ).bind(q, q, q, limit).all();
        return ok({ count: rows.results.length, results: rows.results });
      }
      case 'delete_note': {
        const id = parseInt(args.id, 10);
        if (!id) return fail('id required');
        const before = await env.DB.prepare('SELECT title FROM notes WHERE id = ?').bind(id).first();
        if (!before) return fail('Note not found');
        await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
        return ok({ deleted_id: id, deleted_title: before.title });
      }
      case 'list_recent_notes': {
        const limit = Math.min(Math.max(parseInt(args.limit, 10) || 5, 1), 20);
        const rows = await env.DB.prepare(
          'SELECT id, title, substr(body,1,150) AS snippet, note_type, created_at FROM notes ORDER BY created_at DESC LIMIT ?'
        ).bind(limit).all();
        return ok({ count: rows.results.length, results: rows.results });
      }

      // ───── journal ───────────────────────────────────────
      case 'create_journal': {
        if (!args.title || !args.body) return fail('title and body required');
        const entry_date = args.entry_date || todayISO();
        const r = await env.DB.prepare(
          'INSERT INTO journal (entry_date, title, body, mood, source) VALUES (?, ?, ?, ?, \'voice\')'
        ).bind(entry_date, args.title, args.body, args.mood || null).run();
        return ok({ id: r.meta?.last_row_id, entry_date, title: args.title });
      }
      case 'search_journal': {
        const q = '%' + (args.query || '').toLowerCase() + '%';
        const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
        const rows = await env.DB.prepare(
          'SELECT id, entry_date, title, substr(body,1,200) AS snippet, mood FROM journal ' +
          'WHERE lower(title) LIKE ? OR lower(body) LIKE ? ORDER BY entry_date DESC LIMIT ?'
        ).bind(q, q, limit).all();
        return ok({ count: rows.results.length, results: rows.results });
      }
      case 'list_recent_journal': {
        const limit = Math.min(Math.max(parseInt(args.limit, 10) || 5, 1), 30);
        const rows = await env.DB.prepare(
          'SELECT id, entry_date, title, substr(body,1,150) AS snippet, mood FROM journal ORDER BY entry_date DESC LIMIT ?'
        ).bind(limit).all();
        return ok({ count: rows.results.length, results: rows.results });
      }

      // ───── tasks ─────────────────────────────────────────
      case 'create_task': {
        if (!args.title) return fail('title required');
        const prio = [1,2,3,4].includes(parseInt(args.priority,10)) ? parseInt(args.priority,10) : 3;
        const r = await env.DB.prepare(
          'INSERT INTO tasks (title, details, priority, due_date, tags) VALUES (?, ?, ?, ?, ?)'
        ).bind(args.title, args.details || null, prio, args.due_date || null, args.tags || null).run();
        return ok({ id: r.meta?.last_row_id, title: args.title, priority: prio });
      }
      case 'list_open_tasks': {
        const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);
        const rows = await env.DB.prepare(
          'SELECT id, title, details, priority, due_date, tags, created_at FROM tasks WHERE status = \'open\' ORDER BY priority ASC, due_date ASC NULLS LAST, created_at ASC LIMIT ?'
        ).bind(limit).all();
        return ok({ count: rows.results.length, results: rows.results });
      }
      case 'complete_task': {
        const id = parseInt(args.id, 10);
        if (!id) return fail('id required');
        const before = await env.DB.prepare('SELECT title FROM tasks WHERE id = ?').bind(id).first();
        if (!before) return fail('Task not found');
        await env.DB.prepare('UPDATE tasks SET status = \'done\', completed_at = CURRENT_TIMESTAMP WHERE id = ?').bind(id).run();
        return ok({ completed_id: id, title: before.title });
      }

      // ───── recipes ───────────────────────────────────────
      case 'create_recipe': {
        if (!args.title) return fail('title required');
        if (!Array.isArray(args.ingredients) || args.ingredients.length === 0) return fail('ingredients[] required');
        if (!Array.isArray(args.steps) || args.steps.length === 0) return fail('steps[] required');
        // Bundle all structured fields into the source_meta JSON so the
        // existing notes table doesn't need new columns.
        const recipe = {
          servings:      Number.isInteger(args.servings)      ? args.servings      : 4,
          total_minutes: Number.isInteger(args.total_minutes) ? args.total_minutes : null,
          prep_minutes:  Number.isInteger(args.prep_minutes)  ? args.prep_minutes  : null,
          cook_minutes:  Number.isInteger(args.cook_minutes)  ? args.cook_minutes  : null,
          location:      typeof args.location === 'string'    ? args.location      : null,
          equipment:     Array.isArray(args.equipment) ? args.equipment.filter(Boolean) : [],
          ingredients:   args.ingredients.filter(Boolean),
          steps:         args.steps.filter(Boolean),
          calories_per_serving: Number.isInteger(args.calories_per_serving) ? args.calories_per_serving : null,
          protein_g:     Number.isInteger(args.protein_g) ? args.protein_g : null,
          carbs_g:       Number.isInteger(args.carbs_g) ? args.carbs_g : null,
          fat_g:         Number.isInteger(args.fat_g) ? args.fat_g : null,
          tags:          Array.isArray(args.tags) ? args.tags.filter(Boolean) : [],
          notes:         typeof args.notes === 'string' ? args.notes : '',
        };
        // Build a readable body that contains all info as plain text — this
        // is what the user sees if they look at the note before clicking
        // into the Rezept tab. It's also what /api/chat search_notes will
        // grep over so the recipe is findable by ingredient name.
        const bodyParts = [];
        bodyParts.push(`Für ${recipe.servings} Personen.`);
        if (recipe.total_minutes) bodyParts.push(`Gesamtzeit: ${recipe.total_minutes} Min.`);
        if (recipe.location) bodyParts.push(`Wo: ${recipe.location}.`);
        if (recipe.equipment.length) bodyParts.push(`Geräte: ${recipe.equipment.join(', ')}.`);
        bodyParts.push('');
        bodyParts.push('Zutaten:');
        recipe.ingredients.forEach(i => bodyParts.push('  • ' + i));
        bodyParts.push('');
        bodyParts.push('Zubereitung:');
        recipe.steps.forEach((s, i) => bodyParts.push((i + 1) + '. ' + s));
        if (recipe.notes) { bodyParts.push(''); bodyParts.push('Notizen: ' + recipe.notes); }
        const body = bodyParts.join('\n');

        const slug = slugify(args.title) + '-' + Date.now().toString(36);
        const tags = recipe.tags.join(',');
        const r = await env.DB.prepare(
          'INSERT INTO notes (slug, title, body, note_type, related_topics, source_meta, garden_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(slug, args.title, body, 'recipe', tags, JSON.stringify({ recipe }), 'Recipe').run();
        return ok({ id: r.meta?.last_row_id, title: args.title, servings: recipe.servings });
      }
      case 'promote_note_to_recipe': {
        const id = parseInt(args.id, 10);
        if (!id) return fail('id required');
        if (!Array.isArray(args.ingredients) || args.ingredients.length === 0) return fail('ingredients[] required');
        if (!Array.isArray(args.steps) || args.steps.length === 0) return fail('steps[] required');
        const before = await env.DB.prepare('SELECT title, body, source_meta FROM notes WHERE id = ?').bind(id).first();
        if (!before) return fail('Note not found');
        const recipe = {
          servings:      Number.isInteger(args.servings)      ? args.servings      : 4,
          total_minutes: Number.isInteger(args.total_minutes) ? args.total_minutes : null,
          prep_minutes:  Number.isInteger(args.prep_minutes)  ? args.prep_minutes  : null,
          cook_minutes:  Number.isInteger(args.cook_minutes)  ? args.cook_minutes  : null,
          location:      typeof args.location === 'string'    ? args.location      : null,
          equipment:     Array.isArray(args.equipment) ? args.equipment.filter(Boolean) : [],
          ingredients:   args.ingredients.filter(Boolean),
          steps:         args.steps.filter(Boolean),
          calories_per_serving: Number.isInteger(args.calories_per_serving) ? args.calories_per_serving : null,
          protein_g:     Number.isInteger(args.protein_g) ? args.protein_g : null,
          carbs_g:       Number.isInteger(args.carbs_g) ? args.carbs_g : null,
          fat_g:         Number.isInteger(args.fat_g) ? args.fat_g : null,
          tags:          Array.isArray(args.tags) ? args.tags.filter(Boolean) : [],
          notes:         typeof args.notes === 'string' ? args.notes : '',
        };
        // Build the readable body just like create_recipe does — replaces
        // the original free-form note text so the note view + search work.
        const bp = [];
        bp.push(`Für ${recipe.servings} Personen.`);
        if (recipe.total_minutes) bp.push(`Gesamtzeit: ${recipe.total_minutes} Min.`);
        if (recipe.location) bp.push(`Wo: ${recipe.location}.`);
        if (recipe.equipment.length) bp.push(`Geräte: ${recipe.equipment.join(', ')}.`);
        bp.push('', 'Zutaten:');
        recipe.ingredients.forEach(i => bp.push('  • ' + i));
        bp.push('', 'Zubereitung:');
        recipe.steps.forEach((s, i) => bp.push((i + 1) + '. ' + s));
        if (recipe.notes) { bp.push('', 'Notizen: ' + recipe.notes); }
        const newBody = bp.join('\n');

        // Merge with any pre-existing source_meta (preserves linkEntities etc.)
        let existingMeta = {};
        try { existingMeta = before.source_meta ? JSON.parse(before.source_meta) : {}; } catch(_) {}
        const newMeta = { ...existingMeta, recipe };

        await env.DB.prepare(
          'UPDATE notes SET note_type = \'recipe\', body = ?, source_meta = ?, garden_type = \'Recipe\', updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).bind(newBody, JSON.stringify(newMeta), id).run();
        return ok({ promoted_id: id, title: before.title, servings: recipe.servings });
      }
      // ───── shopping list ─────────────────────────────────
      case 'add_to_shopping_list': {
        if (!Array.isArray(args.items) || args.items.length === 0) return fail('items[] required');
        const valid = args.items.filter(it => it && typeof it.item === 'string' && it.item.trim());
        if (!valid.length) return fail('no valid items');
        const stmts = valid.map(it => env.DB.prepare(
          'INSERT INTO shopping_list (item, qty_value, qty_unit, notes, priority) VALUES (?, ?, ?, ?, ?)'
        ).bind(
          it.item.trim().slice(0, 200),
          Number.isFinite(parseFloat(it.qty_value)) ? parseFloat(it.qty_value) : null,
          it.qty_unit ? String(it.qty_unit).slice(0, 24) : null,
          it.notes ? String(it.notes).slice(0, 500) : null,
          3,
        ));
        const results = await env.DB.batch(stmts);
        return ok({ added: results.length, items: valid.map(v => v.item) });
      }
      case 'list_shopping_list': {
        const status = args.status === 'done' ? 'done' : (args.status === 'all' ? null : 'open');
        const rows = status
          ? await env.DB.prepare('SELECT id, item, qty_value, qty_unit, source_recipe_title, status FROM shopping_list WHERE status = ? ORDER BY added_at DESC LIMIT 50').bind(status).all()
          : await env.DB.prepare("SELECT id, item, qty_value, qty_unit, source_recipe_title, status FROM shopping_list ORDER BY (status='open') DESC, added_at DESC LIMIT 50").all();
        return ok({ count: rows.results.length, items: rows.results });
      }
      case 'clear_shopping_list_done': {
        const r = await env.DB.prepare("DELETE FROM shopping_list WHERE status = 'done'").run();
        return ok({ cleared: r.meta?.changes || 0 });
      }
      // ───── blood pressure ────────────────────────────────
      case 'log_blood_pressure': {
        const sys = parseInt(args.systolic, 10);
        const dia = parseInt(args.diastolic, 10);
        if (!Number.isInteger(sys) || sys < 50 || sys > 260) return fail('systolic must be 50-260');
        if (!Number.isInteger(dia) || dia < 30 || dia > 180) return fail('diastolic must be 30-180');
        const pulse = Number.isInteger(parseInt(args.pulse, 10)) ? parseInt(args.pulse, 10) : null;
        const classify = (s, d) => {
          if (s >= 180 || d >= 120) return 'Crisis';
          if (s >= 140 || d >= 90)  return 'Hypertension Stage 2';
          if (s >= 130 || d >= 80)  return 'Hypertension Stage 1';
          if (s >= 120 && d < 80)   return 'Elevated';
          if (s < 120 && d < 80)    return 'Normal';
          return 'Unknown';
        };
        const classification = classify(sys, dia);
        const r = await env.DB.prepare(
          'INSERT INTO blood_pressure (systolic, diastolic, pulse, source, body_position, arm, mood, notes, irregular_heartbeat, classification) ' +
          'VALUES (?, ?, ?, \'voice\', ?, ?, ?, ?, ?, ?)'
        ).bind(
          sys, dia, pulse,
          args.body_position || null,
          args.arm || null,
          args.mood || null,
          args.notes || null,
          args.irregular_heartbeat ? 1 : 0,
          classification,
        ).run();
        return ok({
          id: r.meta?.last_row_id,
          systolic: sys, diastolic: dia, pulse, classification,
        });
      }
      case 'list_recent_blood_pressure': {
        const limit = Math.min(Math.max(parseInt(args.limit, 10) || 5, 1), 50);
        const rows = await env.DB.prepare(
          'SELECT id, systolic, diastolic, pulse, taken_at, classification FROM blood_pressure ORDER BY taken_at DESC LIMIT ?'
        ).bind(limit).all();
        return ok({ count: rows.results.length, items: rows.results });
      }
      case 'blood_pressure_stats': {
        const range = ['day','week','month','year'].includes(args.range) ? args.range : 'week';
        const whereSql = {
          day:   "WHERE taken_at >= datetime('now', '-1 day')",
          week:  "WHERE taken_at >= datetime('now', '-7 days')",
          month: "WHERE taken_at >= datetime('now', '-30 days')",
          year:  "WHERE taken_at >= datetime('now', '-365 days')",
        }[range];
        const rows = await env.DB.prepare(
          'SELECT systolic, diastolic, pulse, taken_at, classification FROM blood_pressure ' + whereSql + ' LIMIT 1000'
        ).all();
        const items = rows.results || [];
        if (!items.length) return ok({ range, count: 0, message: 'Keine Messungen in diesem Zeitraum.' });
        let sumS = 0, sumD = 0, sumP = 0, nP = 0, inTarget = 0;
        for (const r of items) {
          sumS += r.systolic; sumD += r.diastolic;
          if (r.pulse) { sumP += r.pulse; nP++; }
          if (r.systolic < 135 && r.diastolic < 85) inTarget++;
        }
        return ok({
          range, count: items.length,
          avg_systolic: Math.round(sumS / items.length),
          avg_diastolic: Math.round(sumD / items.length),
          avg_pulse: nP ? Math.round(sumP / nP) : null,
          target_pct: Math.round(inTarget / items.length * 100),
        });
      }
      case 'open_blood_pressure_dashboard': {
        return JSON.stringify({
          ok: true,
          action: 'open_blood_pressure_dashboard',
          navigate_to: '/blood-pressure.html',
          spoken: 'Öffne das Blutdruck-Dashboard, Sir.',
        });
      }

      case 'open_shopping_list': {
        return JSON.stringify({
          ok: true,
          action: 'open_shopping_list',
          navigate_to: '/cookbook.html#shopping',
          spoken: 'Öffne die Einkaufsliste, Sir.',
        });
      }

      case 'open_cookbook': {
        // Marker result — the browser-side chat handler watches for this
        // tool result and navigates the user to /cookbook.html. The text
        // we return is also what Larry will say to the user.
        return JSON.stringify({
          ok: true,
          action: 'open_cookbook',
          navigate_to: '/cookbook.html',
          spoken: 'Öffne das Kochbuch, Sir.',
        });
      }

      // ───── ideas ─────────────────────────────────────────
      case 'create_idea': {
        if (!args.title) return fail('title required');
        const r = await env.DB.prepare(
          'INSERT INTO ideas (title, body, tags) VALUES (?, ?, ?)'
        ).bind(args.title, args.body || null, args.tags || null).run();
        return ok({ id: r.meta?.last_row_id, title: args.title });
      }
      case 'list_ideas': {
        const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);
        const status = args.status || null;
        const sql = status
          ? 'SELECT id, title, body, tags, status, created_at FROM ideas WHERE status = ? ORDER BY created_at DESC LIMIT ?'
          : 'SELECT id, title, body, tags, status, created_at FROM ideas ORDER BY created_at DESC LIMIT ?';
        const stmt = status ? env.DB.prepare(sql).bind(status, limit) : env.DB.prepare(sql).bind(limit);
        const rows = await stmt.all();
        return ok({ count: rows.results.length, results: rows.results });
      }

      // ───── people ────────────────────────────────────────
      case 'search_people': {
        const q = '%' + (args.query || '').toLowerCase() + '%';
        const rows = await env.DB.prepare(
          'SELECT id, slug, full_name, known_as, role_context, notes FROM people ' +
          'WHERE lower(full_name) LIKE ? OR lower(coalesce(known_as,\'\')) LIKE ? OR lower(coalesce(role_context,\'\')) LIKE ? LIMIT 15'
        ).bind(q, q, q).all();
        return ok({ count: rows.results.length, results: rows.results });
      }

      // ───── meal planning ─────────────────────────────────
      case 'set_meal_slot': {
        // Find the active plan
        const plan = await env.DB.prepare(
          'SELECT id, default_servings FROM meal_plans WHERE is_active = 1 ORDER BY week_start DESC LIMIT 1'
        ).first().catch(() => null);
        if (!plan) return fail('Kein aktiver Wochenplan. Erst einen Plan im Cookbook → Plan-Tab erstellen.');

        const dayIdx = parseInt(args.day_idx, 10);
        if (!Number.isInteger(dayIdx) || dayIdx < 0 || dayIdx > 6) {
          return fail('day_idx muss 0..6 sein (0=Montag)');
        }
        if (!['breakfast','lunch','dinner'].includes(args.meal_type)) {
          return fail('meal_type muss breakfast|lunch|dinner sein');
        }

        // Fuzzy-resolve recipe if requested
        let recipeId = null;
        let recipeTitle = null;
        if (args.recipe_query) {
          const q = '%' + String(args.recipe_query).toLowerCase() + '%';
          const hit = await env.DB.prepare(
            "SELECT id, title FROM notes WHERE note_type = 'recipe' AND lower(title) LIKE ? ORDER BY length(title) ASC LIMIT 1"
          ).bind(q).first();
          if (!hit) return fail('Kein Rezept gefunden für "' + args.recipe_query + '"');
          recipeId = hit.id;
          recipeTitle = hit.title;
        }
        const servings = Number.isInteger(args.servings_override) && args.servings_override > 0
          ? args.servings_override : null;
        const note = args.note ? String(args.note).slice(0, 500) : null;

        await env.DB.prepare(
          `UPDATE meal_slots
             SET recipe_id = ?, servings_override = ?, note = ?, updated_at = CURRENT_TIMESTAMP
           WHERE plan_id = ? AND day_idx = ? AND meal_type = ?`
        ).bind(recipeId, servings, note, plan.id, dayIdx, args.meal_type).run();

        // Auto-resync shopping list since this is the active plan
        let resyncCount = null;
        try {
          const r = await resyncShoppingForPlan(env, plan.id);
          resyncCount = r.count;
        } catch (_) {}

        return ok({
          plan_id: plan.id,
          day_idx: dayIdx,
          meal_type: args.meal_type,
          recipe_id: recipeId,
          recipe_title: recipeTitle,
          note,
          shopping_items_after_resync: resyncCount,
        });
      }
      case 'show_meal_plan': {
        const plan = await env.DB.prepare(
          'SELECT id, title, week_start, default_servings FROM meal_plans WHERE is_active = 1 ORDER BY week_start DESC LIMIT 1'
        ).first().catch(() => null);
        if (!plan) return fail('Kein aktiver Wochenplan vorhanden.');
        const slotsRes = await env.DB.prepare(
          `SELECT s.day_idx, s.meal_type, s.recipe_id, s.servings_override, s.note,
                  n.title AS recipe_title
             FROM meal_slots s
             LEFT JOIN notes n ON n.id = s.recipe_id AND n.note_type = 'recipe'
            WHERE s.plan_id = ?
            ORDER BY s.day_idx ASC,
                     CASE s.meal_type WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 ELSE 2 END`
        ).bind(plan.id).all();
        return ok({ plan, slots: slotsRes.results || [] });
      }
      case 'add_to_pantry': {
        if (!args.item) return fail('item required');
        const itemKey = normalizeItemKey(args.item);
        if (!itemKey) return fail('item normalized to empty key');
        const qtyValue = Number.isFinite(parseFloat(args.qty_value)) ? parseFloat(args.qty_value) : null;
        const qtyUnit = args.qty_unit ? String(args.qty_unit).slice(0, 24) : null;
        const notes = args.notes ? String(args.notes).slice(0, 500) : null;
        const r = await env.DB.prepare(
          `INSERT INTO pantry (item, item_key, qty_value, qty_unit, notes, source)
             VALUES (?, ?, ?, ?, ?, 'manual')
             ON CONFLICT(item_key) DO UPDATE SET
               qty_value = COALESCE(pantry.qty_value, 0) + COALESCE(excluded.qty_value, 0),
               qty_unit = COALESCE(pantry.qty_unit, excluded.qty_unit),
               notes = COALESCE(excluded.notes, pantry.notes),
               updated_at = CURRENT_TIMESTAMP
             RETURNING id, item, item_key, qty_value, qty_unit`
        ).bind(String(args.item).slice(0, 200), itemKey, qtyValue, qtyUnit, notes).first();
        return ok({ pantry_row: r });
      }

      default:
        return fail('Unknown tool: ' + name);
    }
  } catch (e) {
    return fail('Tool execution error: ' + (e.message || String(e)));
  }
}
