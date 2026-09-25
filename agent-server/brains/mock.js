// Deterministic stand-in for the LLM so the demo runs with no API key.
// It speaks exactly the same AG-UI protocol as the Claude brain: it looks at
// the conversation so far, picks the next tool call, streams it, and ends the
// run. Intent comes from keywords; wording comes from the host's context.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INTENTS = [
  ['reschedule_install', /reschedul|engineer|install|appointment/],
  ['change_address', /address/],
  ['return', /return|refund|send (it|them) back/],
  ['pause', /pause|holiday|away/],
  ['change_plan', /upgrade|faster|speed|change (my )?plan/],
  ['cancel', /cancel/],
  ['status', /./],
];

// Which purchase states each intent most plausibly refers to, best first.
const PREFERRED = {
  status: ['shipped', 'processing', 'pending', 'active'],
  cancel: ['processing', 'active', 'pending'],
  change_address: ['processing'],
  return: ['delivered'],
  pause: ['active'],
  change_plan: ['active'],
  reschedule_install: ['pending'],
};

export async function mockBrain({ messages, context, ui }) {
  const lastUser = messages.findLastIndex((m) => m.role === 'user');
  const text = String(messages[lastUser]?.content ?? '').toLowerCase();
  const intent = INTENTS.find(([, re]) => re.test(text))[0];
  const calls = collectToolCalls(messages.slice(lastUser + 1));
  const last = calls.at(-1);
  const v = voice(context);

  if (!last) {
    await say(ui, v.start);
    return call(ui, 'list_purchases', { include_closed: true });
  }
  if (last.result?.error) return say(ui, v.error(last.result.error));

  const purchases = calls.find((c) => c.name === 'list_purchases')?.result?.purchases ?? [];

  switch (last.name) {
    case 'list_purchases': {
      const target = pickTarget(purchases, intent, text);
      if (!target) return say(ui, v.nothing);
      if (intent === 'status') return call(ui, 'show_purchase_card', { id: target.id, note: target.summary });
      await say(ui, v.checking(target.title));
      return call(ui, 'get_available_actions', { id: target.id });
    }

    case 'get_available_actions': {
      const id = last.args.id;
      const ok = last.result.available?.find((a) => a.action === intent);
      if (ok) return call(ui, 'confirm_action', { id, action: intent, summary: ok.note ? `${ok.label}. ${ok.note}` : ok.label });
      const no = last.result.unavailable?.find((a) => a.action === intent);
      await say(ui, v.unavailable(no?.reason ?? v.notOffered));
      return call(ui, 'show_purchase_card', { id, note: no?.reason ?? '' });
    }

    case 'confirm_action':
      if (!last.result?.confirmed) return say(ui, v.declined);
      return call(ui, 'perform_action', { id: last.args.id, action: last.args.action, params: last.result.params ?? {} });

    case 'perform_action':
      return call(ui, 'show_purchase_card', { id: last.args.id, note: last.result.message });

    case 'show_purchase_card': {
      const before = calls.at(-2);
      if (before?.name === 'perform_action') return say(ui, v.done(before.result.message));
      if (before?.name === 'list_purchases') {
        const p = purchases.find((x) => x.id === last.args.id);
        return say(ui, v.status(p));
      }
      return undefined;
    }

    default:
      return say(ui, `I called ${last.name}, but mock mode doesn't know what to do next.`);
  }
}

function pickTarget(purchases, intent, text) {
  const words = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  const pref = PREFERRED[intent] ?? [];
  let best = null;
  purchases.forEach((p, i) => {
    let score = 0;
    const id = p.id.toLowerCase().replace(/^#/, '');
    if (text.includes(id)) score += 10;
    for (const tok of `${p.title} ${p.kind}`.toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok.length >= 2 && [...words].some((w) => w === tok || (tok.length > 3 && w.startsWith(tok)))) score += 2;
    }
    const rank = pref.indexOf(p.status);
    if (rank !== -1) score += 1 + (pref.length - rank) * 0.25;
    score -= i * 0.01; // newest first wins ties
    if (!best || score > best.score) best = { p, score };
  });
  return best?.p;
}

function voice(context) {
  const formal = JSON.stringify(context).toLowerCase().includes('formal');
  return formal
    ? {
        start: "Certainly. I'm retrieving the services on your account.",
        checking: (t) => `I'm checking which changes are available for ${t}.`,
        unavailable: (r) => `I'm sorry, that isn't possible. ${r}`,
        notOffered: 'That change is not offered for this service.',
        declined: 'Understood. No changes have been made to your account.',
        done: (m) => `That's complete. ${m}`,
        status: (p) => `${p.title}: ${p.summary}.`,
        nothing: 'I could not find any services on your account.',
        error: (e) => `I'm sorry, something went wrong: ${e}`,
      }
    : {
        start: 'On it! Pulling up your orders 👟',
        checking: (t) => `Checking what I can do with your ${t}…`,
        unavailable: (r) => `Ah, no can do. ${r}`,
        notOffered: "That's not something I can do for this order.",
        declined: 'No worries, nothing changed.',
        done: (m) => `Done! ${m}`,
        status: (p) => `Your ${p.title}: ${p.summary}.`,
        nothing: "I couldn't find any orders on your account.",
        error: (e) => `Hmm, something broke: ${e}`,
      };
}

function collectToolCalls(turn) {
  const calls = [];
  const byId = new Map();
  for (const m of turn) {
    if (m.role === 'assistant') {
      for (const tc of m.toolCalls ?? []) {
        const c = { id: tc.id, name: tc.function.name, args: parse(tc.function.arguments), result: undefined };
        calls.push(c);
        byId.set(tc.id, c);
      }
    } else if (m.role === 'tool' && byId.has(m.toolCallId)) {
      byId.get(m.toolCallId).result = parse(m.content);
    }
  }
  return calls;
}

// --- streaming helpers -----------------------------------------------------

async function say(ui, text) {
  for (const chunk of text.match(/.{1,6}/gsu) ?? []) {
    ui.textDelta(chunk);
    await sleep(12);
  }
}

let seq = 0;
async function call(ui, name, args) {
  const id = `mock_call_${Date.now().toString(36)}_${seq++}`;
  ui.toolStart(id, name);
  for (const chunk of JSON.stringify(args).match(/.{1,24}/gsu) ?? []) {
    ui.toolArgs(id, chunk);
    await sleep(8);
  }
  ui.toolEnd(id);
}

function parse(s) {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s;
  } catch {
    return s;
  }
}
