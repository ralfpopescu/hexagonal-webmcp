// Deterministic stand-in for the LLM so the demo runs with no API key.
// It speaks exactly the same AG-UI protocol as the Claude brain: it looks at
// the conversation so far, decides the next tool call, streams it, and ends
// the run. Copy is template-generated from the product's attributes.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_PER_REQUEST = 3;

export async function mockBrain({ messages, context, ui }) {
  const lastUser = messages.findLastIndex((m) => m.role === 'user');
  const calls = collectToolCalls(messages.slice(lastUser + 1));
  const last = calls.at(-1);
  const voice = voiceFrom(context);

  if (!last) {
    await say(ui, 'Scanning the catalog for products with missing or thin copy…');
    return call(ui, 'search_products', { query: '', only_missing_copy: true, limit: 10 });
  }

  const candidates = (calls.findLast((c) => c.name === 'search_products')?.result?.products ?? []).slice(0, MAX_PER_REQUEST);
  const finished = new Set(
    calls
      .filter((c) => c.name === 'show_product_card' || (c.name === 'request_approval' && !c.result?.approved))
      .map((c) => c.args.id),
  );

  const next = async (prefix = '') => {
    const product = candidates.find((p) => !finished.has(p.id));
    if (!product) return summarize(ui, calls, candidates);
    await say(ui, `${prefix}Drafting copy for “${product.title}”.`);
    return call(ui, 'get_product', { id: product.id });
  };

  switch (last.name) {
    case 'search_products':
      if (!candidates.length) return say(ui, 'Every product already has solid copy. Nothing to enrich.');
      await say(ui, `Found ${last.result.products.length} product(s) needing copy. I'll work through ${candidates.length}.\n`);
      return next();

    case 'get_product': {
      const product = last.result;
      return call(ui, 'request_approval', {
        id: product.id,
        proposed: enrich(product, voice),
        rationale: voice === 'technical'
          ? 'Spec-first copy built only from the recorded attributes, per the technical style guide.'
          : 'Warm, sensory copy drawn from the product details, per the brand voice guide.',
      });
    }

    case 'request_approval':
      if (last.result?.approved) {
        const patch = last.result.final ?? last.args.proposed;
        return call(ui, 'update_product', { id: last.args.id, patch });
      }
      return next('Skipped that one. ');

    case 'update_product':
      return call(ui, 'show_product_card', { id: last.args.id, note: 'Enriched and saved.' });

    case 'show_product_card':
      return next();

    default:
      return say(ui, `I called ${last.name} but I don't know what to do with it in mock mode.`);
  }
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

async function summarize(ui, calls, candidates) {
  const saved = calls.filter((c) => c.name === 'update_product' && c.result?.ok).length;
  const skipped = calls.filter((c) => c.name === 'request_approval' && !c.result?.approved).length;
  await say(ui, `Done. ${saved} of ${candidates.length} product(s) enriched${skipped ? `, ${skipped} skipped` : ''}.`);
}

// --- template "enrichment" -------------------------------------------------

function voiceFrom(context) {
  const text = JSON.stringify(context).toLowerCase();
  return text.includes('technical') ? 'technical' : 'warm';
}

function enrich(product, voice) {
  const a = product.attributes ?? {};
  const facts = Object.entries(a).filter(([k, v]) => v !== '' && v != null && !['price', 'vendor', 'status', 'classification', 'product_type'].includes(k));

  if (voice === 'technical') {
    const spec = facts.map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('; ');
    return {
      description: `${product.title}. ${spec}.`,
      tags: unique([
        ...product.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2),
        ...(a.material ? [String(a.material).toLowerCase()] : []),
      ]).slice(0, 6),
    };
  }

  const name = product.title.split('—')[0].trim().toLowerCase();
  const bits = [];
  if (a.scent_notes) bits.push(`Notes of ${a.scent_notes}.`);
  if (a.material) bits.push(`Made from ${a.material}.`);
  if (a.finish) bits.push(`Finished in a ${a.finish}.`);
  if (a.burn_time_hours) bits.push(`Around ${a.burn_time_hours} hours of slow, even burn.`);
  if (a.care) bits.push(`Care: ${a.care}.`);
  return {
    description: `Meet the ${name}. ${bits.slice(0, 3).join(' ')} A small, everyday ritual, made to last.`.replace(/\s+/g, ' ').trim(),
    tags: unique([
      ...(a.product_type ? [String(a.product_type).toLowerCase()] : []),
      ...String(a.material ?? '').toLowerCase().split(/,\s*/).filter(Boolean),
      'giftable',
    ]).slice(0, 5),
  };
}

// --- streaming helpers -----------------------------------------------------

async function say(ui, text) {
  for (const chunk of text.match(/.{1,6}/gs) ?? []) {
    ui.textDelta(chunk);
    await sleep(12);
  }
}

let seq = 0;
async function call(ui, name, args) {
  const id = `mock_call_${Date.now().toString(36)}_${seq++}`;
  ui.toolStart(id, name);
  for (const chunk of JSON.stringify(args).match(/.{1,24}/gs) ?? []) {
    ui.toolArgs(id, chunk);
    await sleep(8);
  }
  ui.toolEnd(id);
}

const unique = (xs) => [...new Set(xs)];
function parse(s) {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s;
  } catch {
    return s;
  }
}
