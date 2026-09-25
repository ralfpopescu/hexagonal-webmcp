import { AgentSession, fetchSpec } from 'http://localhost:4000/sdk/webmcp-agui.js';
import { installTools, statusOf } from './webmcp.js';

const AGENT_URL = 'http://localhost:4000';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmt = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const STATUS_LABEL = { processing: 'Processing', shipped: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled' };

// ------------------------------------------------------------- orders ----

async function refresh() {
  const { orders } = await (await fetch('/api/storefront/orders')).json();
  $('#orders').replaceChildren(
    ...orders.map((o) => {
      const status = statusOf(o);
      const row = el('article', 'order');
      row.dataset.name = o.name;
      const info = el('div', 'o-info');
      info.append(
        el('div', 'o-title', o.line_items.map((i) => i.title).join(', ')),
        el('div', 'o-meta', `#${o.name} · ordered ${fmt(o.created_at)} · ${o.line_items[0].variant_title}`),
      );
      if (o.line_items.some((i) => i.final_sale)) info.append(el('span', 'badge-final', 'final sale'));
      row.append(el('div', 'o-emoji', o.emoji), info, el('span', `pill pill-${status}`, STATUS_LABEL[status]), el('div', 'o-price', `$${o.total_price}`));
      return row;
    }),
  );
}

// --------------------------------------------------- UI tool renderers ----

function confirmSheet({ order, action, summary }) {
  const dlg = $('#sheet');
  const item = order.line_items[0];
  const body = el('div', 'sheet-body');
  const fields = el('div', 'fields');
  let collect = () => ({});
  let cta = 'Yes, do it';

  if (action === 'cancel') {
    body.append(el('div', 'sheet-emoji', '✖️'), el('h2', null, `Cancel order #${order.name}?`));
    fields.append(el('p', null, `You'll get $${order.total_price} back on your card in 3–5 business days.`));
    cta = 'Yes, cancel it';
  } else if (action === 'return') {
    body.append(el('div', 'sheet-emoji', '↩️'), el('h2', null, `Return ${item.title}?`));
    const select = el('select');
    ['', 'Too small', 'Too big', 'Not my style', 'Arrived damaged'].forEach((r) => select.append(Object.assign(el('option', null, r || 'Why are you sending it back?'), { value: r })));
    fields.append(el('p', null, "We'll email a free prepaid label. Refund lands once it's back with us."), select);
    collect = () => (select.value ? { reason: select.value } : null);
    cta = 'Start my return';
  } else if (action === 'change_address') {
    body.append(el('div', 'sheet-emoji', '🏠'), el('h2', null, `New address for #${order.name}`));
    const a = order.shipping_address;
    const inputs = Object.fromEntries(
      [['address1', 'Street'], ['city', 'City'], ['province', 'State'], ['zip', 'ZIP']].map(([k, label]) => {
        const input = Object.assign(el('input'), { value: a[k], placeholder: label });
        fields.append(input);
        return [k, input];
      }),
    );
    collect = () => ({ address: Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()])) });
    cta = 'Update address';
  }
  if (summary) body.append(el('p', 'agent-says', `🤖 ${summary}`));
  body.append(fields);

  const actions = el('div', 'sheet-actions');
  const no = el('button', 'btn-ghost', 'Never mind');
  const yes = el('button', 'btn-hot', cta);
  actions.append(no, yes);
  dlg.replaceChildren(body, actions);
  dlg.showModal();

  return new Promise((resolve) => {
    const done = (r) => {
      dlg.close();
      resolve(r);
    };
    no.onclick = () => done({ confirmed: false });
    dlg.oncancel = (e) => {
      e.preventDefault();
      done({ confirmed: false });
    };
    yes.onclick = () => {
      const params = collect();
      if (params) return done({ confirmed: true, params });
      fields.classList.add('shake');
      setTimeout(() => fields.classList.remove('shake'), 400);
    };
  });
}

function showOrderCard(o, note) {
  const status = statusOf(o);
  const card = el('div', 'o-card');
  const head = el('div', 'o-card-head');
  const titles = el('div');
  titles.append(el('div', 'o-title', o.line_items[0].title), el('div', 'o-meta', `#${o.name} · $${o.total_price}`));
  head.append(el('div', 'o-emoji small', o.emoji), titles);
  card.append(head);

  if (status === 'cancelled') {
    card.append(el('span', 'pill pill-cancelled', 'Cancelled'));
  } else {
    const steps = ['processing', 'shipped', 'delivered'];
    const track = el('div', 'track');
    steps.forEach((s, i) => track.append(el('div', `step ${i <= steps.indexOf(status) ? 'on' : ''}`, STATUS_LABEL[s])));
    card.append(track);
  }
  if (o.tracking?.eta && status === 'shipped') card.append(el('div', 'o-meta', `${o.tracking.carrier} ${o.tracking.number} · ETA ${fmt(o.tracking.eta)}`));
  if (note) card.append(el('div', 'o-note', note));
  addToChat(card);

  const row = document.querySelector(`.order[data-name="${o.name}"]`);
  row?.classList.add('flash');
  setTimeout(() => row?.classList.remove('flash'), 2000);
}

// ---------------------------------------------------------------- chat ----

const chat = $('#chat');
const addToChat = (node) => {
  chat.append(node);
  chat.scrollTop = chat.scrollHeight;
};

let bubble = null;
const chips = new Map();
const LABELS = {
  list_purchases: 'Looking up your orders',
  get_purchase: 'Opening order',
  get_available_actions: 'Checking our policies',
  confirm_action: 'Waiting for you',
  perform_action: 'Making the change',
  show_purchase_card: 'Showing order',
};

function onEvent(ev) {
  const { timestamp, ...rest } = ev;
  $('#event-log').textContent += `${JSON.stringify(rest)}\n`;
  $('#event-log').scrollTop = $('#event-log').scrollHeight;

  switch (ev.type) {
    case 'CUSTOM':
      if (ev.name === 'agent_info') $('#agent-status').textContent = `shared agent · ${ev.value.brain}`;
      break;
    case 'TEXT_MESSAGE_START':
      bubble = el('div', 'bubble agent', '');
      addToChat(bubble);
      break;
    case 'TEXT_MESSAGE_CONTENT':
      bubble.textContent += ev.delta;
      chat.scrollTop = chat.scrollHeight;
      break;
    case 'TOOL_CALL_START': {
      const chip = el('div', 'tool pending');
      chip.append(el('span', 'dot'), el('span', null, LABELS[ev.toolCallName] ?? ev.toolCallName));
      chip.title = ev.toolCallName;
      chips.set(ev.toolCallId, chip);
      addToChat(chip);
      break;
    }
    case 'LOCAL_TOOL_RESULT': {
      const chip = chips.get(ev.toolCallId);
      chip?.classList.replace('pending', ev.error ? 'error' : 'done');
      if (ev.error) chip?.append(el('span', null, `: ${ev.error}`));
      break;
    }
    case 'RUN_ERROR':
      addToChat(el('div', 'bubble error', `Agent error: ${ev.message}`));
      break;
  }
}

// ---------------------------------------------------------------- boot ----

const { customer } = await (await fetch('/api/storefront/me')).json();
$('#me').textContent = `Hey, ${customer.first_name} 👋`;
await refresh();

const spec = await fetchSpec(AGENT_URL);
const conformance = installTools(spec, { refresh, confirmSheet, showOrderCard });
console.log('[solestack] WebMCP conformance', conformance, navigator.modelContext.listTools());

const session = new AgentSession({
  agentUrl: AGENT_URL,
  context: [
    { description: 'host', value: 'Solestack sneaker store: customer "My orders" page' },
    {
      description: 'brand voice',
      value: 'Casual, upbeat, short. First names, contractions, one emoji max per message. US English. Never sound like a legal notice.',
    },
  ],
  onEvent,
});
$('#agent-status').textContent = conformance.ok ? `shared agent · spec v${spec.version}` : `missing: ${conformance.missing.join(', ')}`;

async function send(text) {
  if (!text.trim() || document.body.classList.contains('busy')) return;
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
$('#toggle-events').onclick = () => $('#events').classList.toggle('hidden');
$('#close').onclick = () => {
  $('#widget').classList.add('hidden');
  $('#launcher').classList.remove('hidden');
};
$('#launcher').onclick = () => {
  $('#widget').classList.remove('hidden');
  $('#launcher').classList.add('hidden');
};
