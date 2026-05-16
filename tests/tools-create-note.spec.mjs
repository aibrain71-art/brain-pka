// Node-level structural test for Bug A (voice-tools-streaming branch).
//
// What this test does NOT do: it does NOT exercise the live /api/chat
// agentic loop (that would need ANTHROPIC_API_KEY bound and a real
// Claude round-trip). The owner's caveat is that Preview-Deploys have no
// secrets bound, so the test we CAN run is:
//
//   "Given the tool catalogue we expose to Claude, and given a stubbed
//    D1 binding, does executeTool('create_note', ...) actually write
//    the row we'd expect Claude to produce when the user dictates a
//    note via voice?"
//
// If this passes, then any Bug A regression is upstream of the executor
// (= a system-prompt issue that makes Claude refuse to emit a tool_use
// block in the first place). That's exactly the layer Bug A's fix
// targets — the system prompt in vaRespond() is the only remaining
// reason Larry would verbally refuse a note.
//
// Run:  cd PKM && node --test tests/tools-create-note.spec.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, executeTool } from '../functions/_lib/tools.js';

// ── Stub D1 binding ────────────────────────────────────────────
// Mimics the surface we use: .prepare(sql).bind(...).run() / .all() / .first()
// Stores executed statements + bound params so tests can assert on them.
function makeStubDB() {
  const executions = [];
  let nextRowId = 1;
  const prepared = (sql) => ({
    _sql: sql,
    _binds: [],
    bind(...args) { this._binds = args; return this; },
    async run()  { executions.push({ sql: this._sql, binds: this._binds, op: 'run' });
                   return { meta: { last_row_id: nextRowId++ } }; },
    async all()  { executions.push({ sql: this._sql, binds: this._binds, op: 'all' });
                   return { results: [] }; },
    async first(){ executions.push({ sql: this._sql, binds: this._binds, op: 'first' });
                   return null; },
  });
  return {
    prepare(sql) { return prepared(sql); },
    _executions: executions,
  };
}

// ── Tests ──────────────────────────────────────────────────────

test('TOOLS catalogue exposes the four mutation tools voice needs', () => {
  const names = new Set(TOOLS.map(t => t.name));
  // The four Bug A "erweiterte Pflicht" tools — all must exist.
  assert.ok(names.has('create_note'),    'create_note missing from TOOLS');
  assert.ok(names.has('create_task'),    'create_task missing from TOOLS');
  assert.ok(names.has('create_journal'), 'create_journal missing from TOOLS');
  assert.ok(names.has('create_idea'),    'create_idea missing from TOOLS');
});

test('create_note tool has the schema Claude needs to call it', () => {
  const tool = TOOLS.find(t => t.name === 'create_note');
  assert.ok(tool, 'create_note tool not in catalogue');
  assert.ok(tool.description && tool.description.length > 10, 'description missing/short');
  assert.deepStrictEqual(tool.input_schema.required.sort(), ['body', 'title']);
  // The schema must declare title + body as strings so Claude generates
  // them correctly from a dictation.
  assert.equal(tool.input_schema.properties.title.type, 'string');
  assert.equal(tool.input_schema.properties.body.type,  'string');
});

test('executeTool("create_note", ...) writes a row when Claude provides title + body', async () => {
  // Simulates what the agentic loop in chat.js does when Claude returns
  // tool_use({name:'create_note', input:{title, body}}) after the user
  // dictated "Larry, erstelle mir eine Notiz dass der Müll heute raus muss".
  // Claude is expected to redigieren the dictation → clean title+body.
  const db = makeStubDB();
  const env = { DB: db };
  const result = await executeTool('create_note', {
    title: 'Müll heute rausbringen',
    body:  'Der Müll muss heute rausgebracht werden.',
  }, env);

  const parsed = JSON.parse(result);
  assert.equal(parsed.ok, true,   'tool returned ok=false: ' + JSON.stringify(parsed));
  assert.equal(parsed.title, 'Müll heute rausbringen');
  assert.ok(parsed.id, 'expected an id from last_row_id');
  assert.ok(parsed.slug && parsed.slug.startsWith('mull-heute-rausbringen-'),
            'slug should be derived from title (got: ' + parsed.slug + ')');

  // Verify the INSERT actually fired with the right bindings.
  assert.equal(db._executions.length, 1, 'expected exactly one DB execution');
  const exec = db._executions[0];
  assert.match(exec.sql, /INSERT INTO notes/);
  assert.equal(exec.binds[1], 'Müll heute rausbringen');                // title
  assert.equal(exec.binds[2], 'Der Müll muss heute rausgebracht werden.'); // body
});

test('executeTool("create_note", ...) fails cleanly when title or body missing', async () => {
  const db = makeStubDB();
  const env = { DB: db };
  const r1 = JSON.parse(await executeTool('create_note', { title: 'X' }, env));
  assert.equal(r1.ok, false, 'should refuse missing body');
  assert.match(r1.error, /title and body required/);

  const r2 = JSON.parse(await executeTool('create_note', { body: 'Y' }, env));
  assert.equal(r2.ok, false, 'should refuse missing title');

  // No DB write should have happened on either failing attempt.
  assert.equal(db._executions.length, 0, 'no INSERT should fire on validation failure');
});

test('executeTool("create_task", ...) writes a row with default priority 3', async () => {
  const db = makeStubDB();
  const env = { DB: db };
  const result = await executeTool('create_task', {
    title: 'Anthropic-Quota prüfen',
  }, env);
  const parsed = JSON.parse(result);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.priority, 3, 'default priority should be 3 (normal)');
  assert.equal(db._executions[0].binds[2], 3);
});

test('executeTool("create_journal", ...) defaults entry_date to today', async () => {
  const db = makeStubDB();
  const env = { DB: db };
  const today = new Date().toISOString().slice(0, 10);
  const result = await executeTool('create_journal', {
    title: 'Testeintrag',
    body:  'Heute Bug A gefixt.',
  }, env);
  const parsed = JSON.parse(result);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entry_date, today, 'should default to today ISO');
  assert.equal(db._executions[0].binds[0], today);   // entry_date binding
  assert.match(db._executions[0].sql, /source.*'voice'/, 'voice journal should tag source=voice');
});

test('executeTool("create_idea", ...) writes when body omitted', async () => {
  // create_idea schema has title required, body optional — voice scenario
  // "Larry, Idee: WordPress-Plugin für Rezepte" might come in title-only.
  const db = makeStubDB();
  const env = { DB: db };
  const result = await executeTool('create_idea', {
    title: 'WordPress-Plugin für Rezepte',
  }, env);
  const parsed = JSON.parse(result);
  assert.equal(parsed.ok, true, 'create_idea should accept title-only: ' + result);
});

test('executeTool refuses unknown tool name gracefully', async () => {
  const db = makeStubDB();
  const env = { DB: db };
  const result = await executeTool('definitely_not_a_tool', {}, {...env});
  const parsed = JSON.parse(result);
  assert.equal(parsed.ok, false);
  // Should produce a structured error, not throw — chat.js feeds this back
  // to Claude as a tool_result so the model can self-correct.
});

test('executeTool returns structured error when DB binding missing', async () => {
  // Bug A diagnostic: if Claude DOES try the tool but env.DB isn't bound,
  // the executor must return ok:false (so Larry can verbally say "Fehler
  // beim Speichern: D1 binding missing") instead of throwing — which
  // would otherwise propagate to the catch-all "I can't do that" path.
  const result = await executeTool('create_note', {
    title: 'X', body: 'Y',
  }, { /* no DB */ });
  const parsed = JSON.parse(result);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /D1 database binding/);
});
