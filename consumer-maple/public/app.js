import { AgentSession, fetchSpec } from 'http://localhost:4000/sdk/webmcp-agui.js';
import { installTools } from './webmcp.js';

const AGENT_URL = 'http://localhost:4000';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ------------------------------------------------------------- catalog ----

async function refreshCatalog() {
  const { products } = await (await fetch('/admin/api/products.json')).json();
  const grid = $('#grid');
  grid.replaceChildren(
    ...products.map((p) => {
      const text = p.body_html.replace(/<[^>]+>/g, '').trim();
      const card = el('article', 'card');
      card.dataset.id = p.id;
      card.append(
        el('div', 'thumb', p.emoji),
        el('h3', null, p.title),
        el('div', 'price', `$${p.variants[0].price}`),
        el('p', text.length < 40 ? 'desc missing' : 'desc', text || 'No description yet'),
        tagRow(p.tags),
      );
      return card;
    }),
  );
}

const tagRow = (tags) => {
  const row = el('div', 'tags');
  tags.split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => row.append(el('span', 'tag', t)));
  return row;
};

// --------------------------------------------------- UI tool renderers ----

function openApprovalModal({ product, current, proposed, rationale }) {
  const dlg = $('#approval');
  dlg.replaceChildren();
  const textarea = el('textarea');
  textarea.value = proposed.description;
  const tagsInput = el('input');
  tagsInput.value = proposed.tags.join(', ');

  const body = el('div', 'approval-body');
  body.append(
    el('div', 'eyebrow', 'Review suggested copy'),
    el('h2', null, `${product.emoji}  ${product.title}`),
    rationale ? el('p', 'rationale', rationale) : '',
    el('label', null, 'Current'),
    el('p', 'current', current.description || '— empty —'),
    el('label', null, 'Suggested description (you can edit)'),
    textarea,
    el('label', null, 'Tags'),
    tagsInput,
  );
  const actions = el('div', 'approval-actions');
  const reject = el('button', 'ghost', 'Not this one');
  const approve = el('button', 'primary', 'Approve & publish');
  actions.append(reject, approve);
  dlg.append(body, actions);
  dlg.showModal();

  return new Promise((resolve) => {
    const done = (result) => {
      dlg.close();
      resolve(result);
    };
    reject.onclick = () => done({ approved: false, comment: 'Merchant declined' });
    dlg.oncancel = (e) => {
      e.preventDefault();
      done({ approved: false, comment: 'Merchant dismissed the dialog' });
    };
    approve.onclick = () => {
      const final = {
        description: textarea.value.trim(),
        tags: tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean),
      };
      const edited = final.description !== proposed.description || final.tags.join() !== proposed.tags.join();
      done({ approved: true, ...(edited && { final }) });
    };
  });
}

function renderStorefrontCard(p, note) {
  const card = el('div', 'storefront-card');
  const body = el('div', 'sf-body');
  card.append(el('div', 'sf-thumb', p.emoji), body);
  const text = p.body_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  body.append(el('div', 'sf-title', p.title), el('div', 'sf-price', `$${p.variants[0].price}`), el('p', 'sf-desc', text), tagRow(p.tags));
  if (note) body.append(el('div', 'sf-note', `✓ ${note}`));
  addToChat(card);

  const gridCard = document.querySelector(`.card[data-id="${CSS.escape(p.id)}"]`);
  gridCard?.classList.add('flash');
  gridCard?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => gridCard?.classList.remove('flash'), 2400);
}

// ---------------------------------------------------------------- chat ----

const chat = $('#chat');
const addToChat = (node) => {
  chat.append(node);
  chat.scrollTop = chat.scrollHeight;
};

let currentBubble = null;
const toolChips = new Map();
const TOOL_LABELS = {
  search_products: 'Searching your catalog',
  get_product: 'Reading product',
  update_product: 'Publishing to store',
  request_approval: 'Waiting for your review',
  show_product_card: 'Showing preview',
};

function onEvent(ev) {
  logEvent(ev);
  switch (ev.type) {
    case 'CUSTOM':
      if (ev.name === 'agent_info') $('#agent-status').textContent = `shared agent · ${ev.value.brain} · ${ev.value.model}`;
      break;
    case 'TEXT_MESSAGE_START':
      currentBubble = el('div', 'bubble agent', '');
      addToChat(currentBubble);
      break;
    case 'TEXT_MESSAGE_CONTENT':
      currentBubble.textContent += ev.delta;
      chat.scrollTop = chat.scrollHeight;
      break;
    case 'TOOL_CALL_START': {
      const chip = el('div', 'tool-chip pending');
      chip.append(el('span', 'spinner'), el('span', null, TOOL_LABELS[ev.toolCallName] ?? ev.toolCallName), el('code', null, ev.toolCallName));
      toolChips.set(ev.toolCallId, chip);
      addToChat(chip);
      break;
    }
    case 'LOCAL_TOOL_RESULT': {
      const chip = toolChips.get(ev.toolCallId);
      chip?.classList.remove('pending');
      chip?.classList.add(ev.error ? 'error' : 'done');
      if (ev.error) chip?.append(el('span', 'err', ev.error));
      break;
    }
    case 'RUN_ERROR':
      addToChat(el('div', 'bubble error', `Agent error: ${ev.message}`));
      break;
  }
}

const logEvent = (ev) => {
  const log = $('#event-log');
  const { timestamp, ...rest } = ev;
  log.textContent += `${JSON.stringify(rest)}\n`;
  log.scrollTop = log.scrollHeight;
};

$('#toggle-events').onclick = () => $('#events').classList.toggle('hidden');

// ---------------------------------------------------------------- boot ----

const spec = await fetchSpec(AGENT_URL);
const conformance = installTools(spec, { refreshCatalog, openApprovalModal, renderStorefrontCard });
console.log('[maple] WebMCP conformance', conformance, navigator.modelContext.listTools());

const session = new AgentSession({
  agentUrl: AGENT_URL,
  context: [
    { description: 'host', value: 'Maple & Co. storefront admin (DTC home goods)' },
    {
      description: 'brand voice',
      value:
        'Warm, sensory and a little playful. Second person is fine. 2–3 short sentences, US English, ' +
        'no exclamation marks, no superlatives like "best ever". Tags: lowercase, max 5, shopper-facing words.',
    },
  ],
  onEvent,
});

await refreshCatalog();
$('#agent-status').textContent = conformance.ok ? `spec v${spec.version} implemented · ready` : `missing: ${conformance.missing.join(', ')}`;

async function send(text) {
  if (!text.trim()) return;
  addToChat(el('div', 'bubble user', text));
  $('#prompt').value = '';
  document.body.classList.add('busy');
  try {
    await session.send(text);
  } catch (err) {
    addToChat(el('div', 'bubble error', err.message));
  } finally {
    document.body.classList.remove('busy');
  }
}

$('#composer').onsubmit = (e) => {
  e.preventDefault();
  send($('#prompt').value);
};
document.querySelectorAll('[data-prompt]').forEach((b) => (b.onclick = () => send(b.dataset.prompt)));
