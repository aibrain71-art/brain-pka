// Meal-plan aggregation + pantry-subtract + shopping-list resync.
//
// Used by:
//   - PUT /api/meal-plans/:id/slots          → auto-resync after slot edits
//   - PUT /api/meal-plans/:id                → resync when is_active flips
//   - tools.js (Larry)                       → "create shopping list from plan"
//
// Pure-ish: aggregate() / parseIngredient() / normalizeItemKey() / convertUnit()
// take no DB; only aggregateForPlan() and resyncShoppingForPlan() touch env.DB.
//
// Why a single helper file (vs. splitting into normalize/units/aggregation):
// the architecture is "Pragmatic" — server-side correctness + Larry-Voice
// reusability matter, but the domain is small enough that 4 micro-modules
// would be over-engineered for a solo project.

// ─── Item-name normalization ──────────────────────────────────────
// Goal: "Zwiebeln" / "Zwiebel" / "zwiebeln" all map to the same key.
// Strategy: conservative German plural-stemming (most common patterns)
// + Unicode diacritic strip. We deliberately do NOT word-stem ("Mehl"
// must not collapse with "Vollkornmehl") — only the trailing plural
// suffix.
export function normalizeItemKey(name) {
  if (!name) return '';
  let s = String(name).toLowerCase().trim();
  // Strip diacritics: ä→a, ö→o, ü→u, ß→ss
  s = s.replace(/ß/g, 'ss');
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ');
  // Light German plural stemming — only the final word, conservative.
  // Apply at most ONE rule. Order matters: longest endings first.
  const words = s.split(' ');
  const lastIdx = words.length - 1;
  const last = words[lastIdx];
  // -innen → keep root (e.g. "Lehrerinnen" — irrelevant for cooking but safe)
  // -er    → keep (e.g. "Kinder" — irrelevant; could be "Eier" though, leave it)
  // -en    → drop -en           ("Tomaten" → "tomat", "Zwiebeln" → "zwiebel")
  // -n     → drop -n             ("Kartoffeln" → "kartoffel", "Karotten" → "karotte")
  // -e     → drop -e             ("Mehle" → "mehl"; minimal risk)
  // Skip if root would be <3 chars (e.g. "Tee" stays "tee", not "t")
  for (const suffix of ['en', 'n']) {
    if (last.endsWith(suffix) && last.length - suffix.length >= 4) {
      words[lastIdx] = last.slice(0, -suffix.length);
      break;
    }
  }
  return words.join(' ');
}

// ─── Unit conversion ──────────────────────────────────────────────
// Buckets units by physical family. Same-family quantities can be
// summed after conversion to a base unit; cross-family quantities
// must stay separate ("1 EL Öl" + "200 ml Öl" → two lines).
//
// Conversions match the formatScaledIngredient() conventions used
// in the cookbook UI so server- and client-side render consistently.

const UNIT_FAMILIES = {
  // family : { unit → multiplier-to-base }
  mass:   { g: 1, kg: 1000, mg: 0.001 },
  volume: { ml: 1, cl: 10, dl: 100, l: 1000 },
};

export function unitFamily(unit) {
  if (!unit) return null;
  const u = String(unit).toLowerCase().trim();
  for (const [family, table] of Object.entries(UNIT_FAMILIES)) {
    if (u in table) return family;
  }
  return null; // 'EL', 'TL', 'Stk', 'Bund', 'Prise', etc. — uncountable
}

// Convert {qty, unit} to its family's base unit (g for mass, ml for
// volume). Returns null if the unit isn't in a convertible family.
export function toBaseUnit(qty, unit) {
  const family = unitFamily(unit);
  if (!family) return null;
  const mult = UNIT_FAMILIES[family][String(unit).toLowerCase().trim()];
  return { qty: qty * mult, family };
}

// Inverse: take a base-unit qty and emit the most-readable variant
// (e.g. 1500 g → "1.5 kg"). Mirrors formatScaledIngredient logic.
export function fromBaseUnit(qtyBase, family) {
  if (family === 'mass') {
    if (qtyBase >= 1000) return { qty: qtyBase / 1000, unit: 'kg' };
    return { qty: qtyBase, unit: 'g' };
  }
  if (family === 'volume') {
    if (qtyBase >= 1000) return { qty: qtyBase / 1000, unit: 'l' };
    if (qtyBase >= 100)  return { qty: qtyBase / 100,  unit: 'dl' };
    return { qty: qtyBase, unit: 'ml' };
  }
  return { qty: qtyBase, unit: '' };
}

// Round a quantity to a sensible number of digits — matches the
// cookbook's formatScaledIngredient style.
export function roundQty(n) {
  if (!Number.isFinite(n)) return n;
  if (n >= 100) return Math.round(n);
  if (n >= 10)  return Math.round(n * 10) / 10;
  if (n >= 1)   return Math.round(n * 10) / 10;
  return Math.round(n * 100) / 100;
}

// ─── Ingredient parser (server-side mirror of cookbook.html's) ─────
// Inputs are recipe ingredient strings like "500 g Mehl", "1 1/2 EL Öl",
// "Salz nach Bedarf". Output: { qty: number|null, unit: string|'', item: string, raw }.
// Mirrors parseIngredient() in cookbook.html ~line 897. Kept simple —
// any line we can't parse falls back to { qty: null, raw } and is
// emitted as-is in the shopping list.
export function parseIngredient(line) {
  const txt = String(line || '').trim();
  if (!txt) return { qty: null, unit: '', item: '', raw: '' };
  // "1/2 TL Salz" or "1 1/2 EL Öl" or "500 g Mehl" or "200 ml Milch"
  const m = txt.match(
    /^(\d+(?:[.,]\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s*([a-zA-ZäöüÄÖÜ]+\.?|EL|TL|cl|dl|ml|l|g|kg|mg|Prise|Stk|Stück|Stueck|Pck|Pkg|Tasse|Tassen|Glas|Bund|Dose|Becher)?\s+(.+)$/
  );
  if (!m) return { qty: null, unit: '', item: txt, raw: txt };
  let qStr = m[1].replace(',', '.');
  let qty;
  if (qStr.includes(' ')) {
    // "1 1/2"
    const [whole, frac] = qStr.split(' ');
    const [n, d] = frac.split('/').map(parseFloat);
    qty = parseFloat(whole) + n / d;
  } else if (qStr.includes('/')) {
    const [n, d] = qStr.split('/').map(parseFloat);
    qty = n / d;
  } else {
    qty = parseFloat(qStr);
  }
  return {
    qty: Number.isFinite(qty) ? qty : null,
    unit: m[2] || '',
    item: m[3].trim(),
    raw: txt,
  };
}

// ─── Aggregation ──────────────────────────────────────────────────
// Combines parsed-ingredient inputs from many recipes into a unified
// shopping list. Same item + same unit-family → sum after converting
// to base unit; different families → keep as separate lines.
// Items with no qty (e.g. "Salz nach Bedarf") are deduped by key.
//
// Input:  [{ qty, unit, item, raw, source_recipe_id, source_recipe_title }, ...]
// Output: [{ item, qty_value, qty_unit, source_recipe_title, notes }, ...]
//         in shopping_list row shape (ready for batch INSERT).
export function aggregateIngredients(parsedList) {
  // bucket key = "<normalized item>|<family-or-raw-unit>"
  const buckets = new Map();
  // separate bucket for "as-needed" items (no qty) → dedupe by key
  const asNeeded = new Map();

  for (const p of parsedList || []) {
    if (!p || !p.item) continue;
    const key = normalizeItemKey(p.item);
    if (!key) continue;

    if (p.qty == null) {
      // "Salz nach Bedarf" — listed once regardless of recipe count
      if (!asNeeded.has(key)) {
        asNeeded.set(key, {
          item: p.item,
          qty_value: null,
          qty_unit: null,
          source_recipe_title: p.source_recipe_title || null,
          notes: 'nach Bedarf',
        });
      }
      continue;
    }

    const family = unitFamily(p.unit) || ('raw:' + (p.unit || '').toLowerCase());
    const bucketKey = key + '|' + family;
    const base = toBaseUnit(p.qty, p.unit);

    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        keyName: key,
        displayItem: p.item,
        family,
        sumBase: base ? base.qty : null,   // null if non-convertible unit
        rawQtySum: base ? null : p.qty,    // for non-convertible: just sum scalars
        rawUnit: base ? null : p.unit,
        titles: new Set(),
      });
    } else {
      const b = buckets.get(bucketKey);
      if (base) b.sumBase += base.qty;
      else      b.rawQtySum = (b.rawQtySum || 0) + p.qty;
    }
    if (p.source_recipe_title) {
      buckets.get(bucketKey).titles.add(p.source_recipe_title);
    }
  }

  const out = [];
  for (const b of buckets.values()) {
    let qty_value, qty_unit;
    if (b.sumBase != null) {
      const formatted = fromBaseUnit(b.sumBase, b.family);
      qty_value = roundQty(formatted.qty);
      qty_unit  = formatted.unit;
    } else {
      qty_value = roundQty(b.rawQtySum);
      qty_unit  = b.rawUnit || '';
    }
    out.push({
      item: b.displayItem,
      qty_value,
      qty_unit,
      source_recipe_title: [...b.titles].slice(0, 3).join(', ') || null,
      notes: null,
    });
  }
  for (const it of asNeeded.values()) out.push(it);
  return out;
}

// ─── Pantry subtraction ───────────────────────────────────────────
// Subtracts on-hand pantry quantities from an aggregated shopping
// list. Matches by normalized item-key AND unit-family.
// Rules:
//   - pantry.qty_value NULL (= "vorhanden, Menge egal") → drop item entirely
//   - pantry.qty_value >= needed                       → drop item entirely
//   - pantry.qty_value <  needed                       → subtract, keep rest
//   - cross-family pantry/list units                   → no subtraction (keep full)
//
// Mutates nothing; returns a new array.
export function subtractPantry(aggregated, pantryRows) {
  // Build pantry lookup keyed by normalized item
  const byKey = new Map();
  for (const p of pantryRows || []) {
    const k = p.item_key || normalizeItemKey(p.item);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p);
  }

  const result = [];
  for (const item of aggregated) {
    const key = normalizeItemKey(item.item);
    const matches = byKey.get(key) || [];
    if (!matches.length) { result.push(item); continue; }

    // If any pantry row has qty_value NULL → "have it, don't buy"
    if (matches.some(p => p.qty_value == null)) continue;

    // Try to subtract within same unit-family
    if (item.qty_value == null) { result.push(item); continue; }
    const itemBase = toBaseUnit(item.qty_value, item.qty_unit);
    if (!itemBase) { result.push(item); continue; } // can't compute → keep as-is

    let pantryHaveBase = 0;
    for (const p of matches) {
      const pb = toBaseUnit(p.qty_value, p.qty_unit);
      if (pb && pb.family === itemBase.family) pantryHaveBase += pb.qty;
    }

    if (pantryHaveBase >= itemBase.qty) continue; // fully covered
    const remainingBase = itemBase.qty - pantryHaveBase;
    const formatted = fromBaseUnit(remainingBase, itemBase.family);
    result.push({
      ...item,
      qty_value: roundQty(formatted.qty),
      qty_unit: formatted.unit,
      notes: (item.notes ? item.notes + '; ' : '') +
             'Vorrat berücksichtigt',
    });
  }
  return result;
}

// ─── Plan-aware aggregation (touches DB) ──────────────────────────
// Reads all slots for a plan, joins to the recipe rows in `notes`,
// parses + scales + aggregates ingredients, subtracts pantry, returns
// the final shopping-ready list.
export async function aggregateForPlan(env, planId) {
  if (!env?.DB) throw new Error('env.DB missing');
  // Load plan + slots
  const plan = await env.DB.prepare(
    'SELECT id, default_servings FROM meal_plans WHERE id = ?'
  ).bind(planId).first();
  if (!plan) throw new Error('Plan ' + planId + ' not found');

  const slotsRes = await env.DB.prepare(
    'SELECT recipe_id, servings_override FROM meal_slots WHERE plan_id = ? AND recipe_id IS NOT NULL'
  ).bind(planId).all();
  const slots = slotsRes.results || [];
  if (!slots.length) return [];

  // Batch-load all needed recipe rows
  const recipeIds = [...new Set(slots.map(s => s.recipe_id).filter(Boolean))];
  if (!recipeIds.length) return [];
  // D1 doesn't support .bind(array), so build the IN clause manually
  const placeholders = recipeIds.map(() => '?').join(',');
  const recipesRes = await env.DB.prepare(
    `SELECT id, title, source_meta, servings_base FROM notes
       WHERE note_type = 'recipe' AND id IN (${placeholders})`
  ).bind(...recipeIds).all();
  const recipeById = new Map();
  for (const r of (recipesRes.results || [])) {
    let recipeJson = null;
    try {
      const meta = r.source_meta ? JSON.parse(r.source_meta) : null;
      recipeJson = meta?.recipe || null;
    } catch (_) {}
    recipeById.set(r.id, {
      title: r.title,
      servings_base: r.servings_base || recipeJson?.servings || 4,
      ingredients: Array.isArray(recipeJson?.ingredients) ? recipeJson.ingredients : [],
    });
  }

  // Parse + scale every slot's ingredients
  const parsed = [];
  for (const slot of slots) {
    const recipe = recipeById.get(slot.recipe_id);
    if (!recipe) continue;
    const targetServings = slot.servings_override || plan.default_servings || 2;
    const factor = recipe.servings_base > 0 ? targetServings / recipe.servings_base : 1;
    for (const line of recipe.ingredients) {
      const p = parseIngredient(line);
      if (!p.item) continue;
      parsed.push({
        qty: p.qty != null ? p.qty * factor : null,
        unit: p.unit,
        item: p.item,
        raw: p.raw,
        source_recipe_id: slot.recipe_id,
        source_recipe_title: recipe.title,
      });
    }
  }

  const aggregated = aggregateIngredients(parsed);

  // Subtract pantry
  const pantryRes = await env.DB.prepare(
    'SELECT item, item_key, qty_value, qty_unit FROM pantry'
  ).all().catch(() => ({ results: [] }));
  return subtractPantry(aggregated, pantryRes.results || []);
}

// ─── Resync: aggregate + write to shopping_list ───────────────────
// Replaces all open shopping_list rows tagged with this plan's marker
// in one batch. Manually-added items and items already 'done' are
// untouched.
export async function resyncShoppingForPlan(env, planId) {
  const items = await aggregateForPlan(env, planId);
  const marker = 'plan:' + planId;
  const stmts = [];
  // Delete prior plan-generated open rows. The "plan:N|..." prefix
  // catches both bare 'plan:N' and 'plan:N|extra' notes.
  stmts.push(
    env.DB.prepare(
      "DELETE FROM shopping_list WHERE status='open' AND (notes = ? OR notes LIKE ?)"
    ).bind(marker, marker + '|%')
  );
  for (const it of items) {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO shopping_list (item, qty_value, qty_unit, source_recipe_title, notes, priority) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(
        String(it.item).slice(0, 200),
        Number.isFinite(it.qty_value) ? it.qty_value : null,
        it.qty_unit ? String(it.qty_unit).slice(0, 24) : null,
        it.source_recipe_title ? String(it.source_recipe_title).slice(0, 200) : null,
        marker + (it.notes ? '|' + String(it.notes).slice(0, 200) : ''),
        3
      )
    );
  }
  await env.DB.batch(stmts);
  return { count: items.length };
}
