// Cloudflare Pages Function — POST /api/note-assist
// AI helpers for the fullscreen note editor's <-command menu.
//
// Body: { action: 'summarize' | 'continue' | 'improve' | 'translate' |
//                 'expand' | 'outline' | 'ideas' | 'title' | 'rewrite',
//         text: string, selection?: string, language?: string,
//         prompt?: string }
//
// Returns: { ok: true, result: "..." }
//
// All actions use claude-haiku-4-5 (fast + cheap) with action-specific
// system prompts. Output is plain text or markdown ready to paste into
// the textarea at the cursor position.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

const ACTIONS = {
  summarize: {
    label: 'Zusammenfassen',
    system: 'Du fasst Notizen prägnant zusammen. Antworte mit der Zusammenfassung in 3-5 Markdown-Bulletpoints in Deutsch. KEINE Vorrede, kein "Hier ist deine Zusammenfassung:". Nur die Bullets.',
    userTpl: (text, opts) => `Notiz:\n\n${text}`,
  },
  continue: {
    label: 'Weiterschreiben',
    system: 'Du setzt eine angefangene Notiz fort — im gleichen Stil, gleichen Sprache, gleicher Ton. Schreib 2-4 Sätze die natürlich an den Text anschliessen. KEINE Wiederholung des Bestehenden. KEINE Vorrede.',
    userTpl: (text) => `Setze diese Notiz fort:\n\n${text}\n\n[Cursor hier]`,
  },
  improve: {
    label: 'Sprache verbessern',
    system: 'Du verbesserst Grammatik, Rechtschreibung und Stil OHNE den Inhalt zu verändern. Erhalte alle Markdown-Formatierungen. Antworte AUSSCHLIESSLICH mit dem verbesserten Text, keine Erklärung.',
    userTpl: (text, opts) => opts.selection || text,
  },
  translate: {
    label: 'Übersetzen',
    system: 'Du übersetzt Text in die angegebene Zielsprache. Erhalte Markdown-Formatierungen + Eigennamen. Antworte AUSSCHLIESSLICH mit der Übersetzung, keine Erklärung.',
    userTpl: (text, opts) => `Zielsprache: ${opts.language || 'Englisch'}\n\nText:\n${opts.selection || text}`,
  },
  expand: {
    label: 'Bulletpoint ausarbeiten',
    system: 'Du nimmst einen kurzen Bulletpoint und arbeitest ihn zu 2-4 ausführlichen Sätzen aus. Stil: präzise, sachlich, nicht aufgeblasen. Sprache: gleich wie Eingabe. Antwort: nur der ausgearbeitete Text, KEIN Bullet-Strich davor.',
    userTpl: (text, opts) => opts.selection || text,
  },
  outline: {
    label: 'In Outline umwandeln',
    system: 'Du wandelst Fliesstext in eine hierarchische Outline um. Verwende Markdown-Bullets (- ) mit 2-Leerzeichen-Einrückung für Sub-Bullets. Behalte alle wichtigen Aussagen, eliminiere Redundanz. Sprache: gleich wie Eingabe.',
    userTpl: (text) => text,
  },
  ideas: {
    label: 'Ideen generieren',
    system: 'Du generierst 5-8 Ideen / Aspekte / Anknüpfungspunkte zu einem Thema oder Text. Format: Markdown-Bullets, kurz prägnant (1 Zeile pro Idee). Sprache: gleich wie Eingabe.',
    userTpl: (text, opts) => opts.prompt || text,
  },
  title: {
    label: 'Titel vorschlagen',
    system: 'Du generierst einen prägnanten Titel (3-7 Wörter) für eine Notiz. Antwort: NUR der Titel, ohne Anführungszeichen, ohne Erklärung.',
    userTpl: (text) => text,
  },
  rewrite: {
    label: 'Umformulieren',
    system: 'Du formulierst Text um — Inhalt gleich, Wortwahl anders, eventuell anderer Ton (z.B. förmlicher oder lockerer wenn angegeben). Erhalte Markdown. Antwort: nur der umformulierte Text.',
    userTpl: (text, opts) => `${opts.prompt ? 'Stil: ' + opts.prompt + '\n\n' : ''}Text:\n${opts.selection || text}`,
  },
};

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const action = body.action;
  const spec = ACTIONS[action];
  if (!spec) return json({ error: 'Unknown action. Available: ' + Object.keys(ACTIONS).join(', ') }, 400);

  const text = typeof body.text === 'string' ? body.text.slice(0, 30000) : '';
  if (!text.trim() && !body.selection && !body.prompt) {
    return json({ error: 'Need at least one of: text, selection, prompt' }, 400);
  }

  const userMsg = spec.userTpl(text, {
    selection: typeof body.selection === 'string' ? body.selection.slice(0, 10000) : null,
    language: typeof body.language === 'string' ? body.language : null,
    prompt:   typeof body.prompt === 'string'   ? body.prompt.slice(0, 1000) : null,
  });

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
        system: spec.system,
        max_tokens: action === 'title' ? 60 : 1500,
        messages: [{ role: 'user', content: userMsg }],
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
  const result = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  return json({ ok: true, action, result, usage: data.usage });
}

export async function onRequest({ request }) {
  return new Response('POST only', { status: 405, headers: { 'Allow': 'POST' } });
}
