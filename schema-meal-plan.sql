-- Weekly meal planning + pantry inventory + shopping-list integration.
-- Pragmatic approach (single _lib/meal-aggregator.js does the heavy
-- lifting; shopping_list gets reused via 'plan:<id>' marker in notes
-- instead of a new FK column).
--
-- Apply with:
--   wrangler d1 execute larry-db --remote --file schema-meal-plan.sql
-- or via Cloudflare D1 console.

-- ─── Weekly plan headers ──────────────────────────────────────────
-- Multiple plans can co-exist (history). is_active=1 marks the one
-- currently displayed/synced; toggling it should demote any other
-- active plan via the PUT handler (D1 has no partial-unique index
-- support so the constraint lives in the handler logic).
CREATE TABLE IF NOT EXISTS meal_plans (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT,                         -- "KW 19", "Familie Mai 11", optional
  week_start        TEXT NOT NULL,                -- ISO Monday 'YYYY-MM-DD'
  default_servings  INTEGER DEFAULT 2,
  is_active         INTEGER DEFAULT 0,
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_meal_plans_active ON meal_plans(is_active DESC, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_meal_plans_week   ON meal_plans(week_start DESC);

-- ─── 21 slots per plan (3 meal types × 7 days) ────────────────────
-- recipe_id may be NULL = empty slot. note allows "auswärts essen"
-- or "Resteessen" without a recipe. servings_override falls back to
-- meal_plans.default_servings when NULL.
CREATE TABLE IF NOT EXISTS meal_slots (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id            INTEGER NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  day_idx            INTEGER NOT NULL,            -- 0=Mon … 6=Sun
  meal_type          TEXT NOT NULL,               -- 'breakfast' | 'lunch' | 'dinner'
  recipe_id          INTEGER,                     -- FK notes(id) where note_type='recipe' (no DB-level FK to keep it permissive)
  servings_override  INTEGER,
  note               TEXT,
  updated_at         TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(plan_id, day_idx, meal_type)
);
CREATE INDEX IF NOT EXISTS idx_meal_slots_plan   ON meal_slots(plan_id);
CREATE INDEX IF NOT EXISTS idx_meal_slots_recipe ON meal_slots(recipe_id);

-- ─── Pantry (Vorratsschrank) ──────────────────────────────────────
-- item_key is the normalized form (lowercase + light German plural
-- stemming) used for matching against aggregated shopping items.
-- qty_value NULL means "vorhanden, Menge egal" — aggregator drops
-- the line entirely if any pantry row with NULL exists for the key.
CREATE TABLE IF NOT EXISTS pantry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item        TEXT NOT NULL,         -- display name "Olivenöl"
  item_key    TEXT NOT NULL UNIQUE,  -- normalized "olivenol"
  qty_value   REAL,
  qty_unit    TEXT,
  notes       TEXT,
  source      TEXT DEFAULT 'manual', -- 'manual' | 'auto-shopping'
  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pantry_key ON pantry(item_key);

-- Note: shopping_list is reused as-is. Plan-generated rows are tagged
-- with notes='plan:<id>' (optionally followed by '|<extra>') so the
-- resync handler can delete only its own rows without touching
-- manually-added items or items the user has already checked off.
