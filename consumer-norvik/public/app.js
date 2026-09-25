import { AgentSession, fetchSpec, modelContext } from 'http://localhost:4000/sdk/webmcp-agui.js';
import { installTools, rpc } from './webmcp.js';

const AGENT_URL = 'http://localhost:4000';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmt = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const gbp = (n) => `£${Number(n).toFixed(2)}`;
const STATUS_LABEL = { ACTIVE: 'Active', PENDING_INSTALL: 'Installation booked', PAUSED: 'Paused', CANCELLED: 'Cancelled' };
const ICON = { BROADBAND: '📶', TV: '📺' };

// ------------------------------------------------------------ services ----

function serviceTile(s) {
  const tile = el('article', 'tile');
  tile.dataset.id = s.serviceId;
  const head = el('div', 'tile-head');
  head.append(el('span', 'tile-icon', ICON[s.type]), el('span', `status st-${s.status}`, STATUS_LABEL[s.status]));
  const rows = el('dl');
  const row = (k, v) => rows.append(el('dt', null, k), el('dd', null, v));
  if (s.product.downMbps) row('Speed', `${s.product.downMbps} Mbps down / ${s.product.upMbps} Mbps up`);
  row('Monthly price', gbp(s.product.monthlyPrice));
  row('Minimum term ends', fmt(s.contract.minTermEnd));
  if (s.appointment) row('Engineer visit', `${fmt(s.appointment.date)}, ${s.appointment.window}`);
  if (s.pause) row('Paused until', fmt(s.pause.until));
  if (s.endsOn) row('Service ends', fmt(s.endsOn));
  row('Address', s.installAddress);
  tile.append(head, el('h3', null, s.product.name), el('div', 'tile-id', s.serviceId), rows);
  return tile;
}

async function refresh() {
  const { services } = await rpc('account.get');
  $('#services').replaceChildren(...services.map(serviceTile));
}

// --------------------------------------------------- UI tool renderers ----

function confirmModal({ service, action, eligibility: e, summary }) {
  const dlg = $('#confirm');
  const body = el('div', 'c-body');
  const detail = el('dl');
  const row = (k, v) => detail.append(el('dt', null, k), el('dd', null, v));
  row('Service', `${service.product.name} (${service.serviceId})`);
  row('Address', service.installAddress);

  const inputs = el('div', 'c-inputs');
  const consequences = [];
  let params = () => ({});
  let title = '';

  const radios = (name, options) => {
    options.forEach(([value, label], i) => {
      const lab = el('label', 'radio');
      const r = Object.assign(el('input'), { type: 'radio', name, value, checked: i === 0 });
      lab.append(r, el('span', null, label));
      inputs.append(lab);
    });
    return () => inputs.querySelector(`input[name="${name}"]:checked`)?.value;
  };

  if (action === 'pause') {
    title = 'Holiday pause';
    const months = radios('months', Array.from({ length: e.maxMonths }, (_, i) => [String(i + 1), `${i + 1} month${i ? 's' : ''}`]));
    consequences.push(`A reduced charge of ${gbp(e.feePerMonth)} per month applies while paused.`, 'Your service resumes automatically at the end of the pause.');
    params = () => ({ months: Number(months()) });
  } else if (action === 'change_plan') {
    title = 'Change broadband plan';
    const plan = radios('plan', e.options.map((p) => [p.code, `${p.name}: ${p.downMbps} Mbps, ${gbp(p.monthlyPrice)}/month`]));
    consequences.push(`A new ${e.newMinTermMonths}-month minimum term starts on the date of the change.`);
    if (e.note) consequences.push(e.note);
    params = () => ({ plan_code: plan() });
  } else if (action === 'reschedule_install') {
    title = 'Reschedule engineer visit';
    row('Current appointment', `${fmt(service.appointment.date)}, ${service.appointment.window}`);
    const slot = radios('slot', e.slots.map((s) => [s.slotId, `${fmt(s.date)}, ${s.window}`]));
    consequences.push('Someone aged 18 or over must be at the property for the whole window.');
    params = () => ({ slot_id: slot() });
  } else if (action === 'cancel') {
    title = 'Cancel service';
    consequences.push(
      e.earlyTerminationFee ? `An early termination fee of ${gbp(e.earlyTerminationFee)} will be added to your final bill.` : 'No early termination fee applies.',
      e.noticeDays ? `Your service will end after a ${e.noticeDays}-day notice period.` : 'Your service will end immediately.',
    );
    params = () => ({ acknowledged_fee: e.earlyTerminationFee });
  }

  body.append(el('h2', null, title), detail);
  if (summary) body.append(el('p', 'c-agent', `Assistant: ${summary}`));
  body.append(inputs);
  const box = el('div', 'c-consequences');
  box.append(el('strong', null, 'Please note'), ...consequences.map((c) => el('p', null, c)));
  const ack = el('label', 'ack');
  const check = Object.assign(el('input'), { type: 'checkbox' });
  ack.append(check, el('span', null, 'I understand and want to make this change to my account.'));
  body.append(box, ack);

  const actions = el('div', 'c-actions');
  const cancel = el('button', 'btn-secondary', 'Cancel');
  const ok = el('button', 'btn-primary', 'Confirm change');
  ok.disabled = true;
  check.onchange = () => (ok.disabled = !check.checked);
  actions.append(cancel, ok);
  dlg.replaceChildren(el('div', 'c-bar', 'Confirm a change to your account'), body, actions);
  dlg.showModal();

  return new Promise((resolve) => {
    const done = (r) => {
      dlg.close();
      resolve(r);
    };
    cancel.onclick = () => done({ confirmed: false });
    dlg.oncancel = (ev) => {
      ev.preventDefault();
      done({ confirmed: false });
    };
    ok.onclick = () => done({ confirmed: true, params: params() });
  });
}

function showServiceCard(s, note) {
  const card = serviceTile(s);
  card.classList.add('in-chat');
  if (note) card.append(el('div', 'tile-note', note));
  addToChat(card);
  const tile = document.querySelector(`#services .tile[data-id="${s.serviceId}"]`);
  tile?.classList.add('flash');
  setTimeout(() => tile?.classList.remove('flash'), 2000);
}

// ---------------------------------------------------------------- chat ----

const chat = $('#chat');
const addToChat = (node) => {
  chat.append(node);
  chat.scrollTop = chat.scrollHeight;
};
let msg = null;
const steps = new Map();
const LABELS = {
  list_purchases: 'Retrieving your services',
  get_purchase: 'Retrieving service details',
  get_available_actions: 'Checking eligibility',
  confirm_action: 'Awaiting your confirmation',
  perform_action: 'Updating your account',
  show_purchase_card: 'Displaying service',
};

function onEvent(ev) {
  const { timestamp, ...rest } = ev;
  $('#event-log').textContent += `${JSON.stringify(rest)}\n`;
  $('#event-log').scrollTop = $('#event-log').scrollHeight;
  switch (ev.type) {
    case 'CUSTOM':
      if (ev.name === 'agent_info') $('#agent-status').textContent = `Shared agent · ${ev.value.brain}`;
      break;
    case 'TEXT_MESSAGE_START':
      msg = el('div', 'msg agent', '');
      addToChat(msg);
      break;
    case 'TEXT_MESSAGE_CONTENT':
      msg.textContent += ev.delta;
      chat.scrollTop = chat.scrollHeight;
      break;
    case 'TOOL_CALL_START': {
      const step = el('div', 'step pending', LABELS[ev.toolCallName] ?? ev.toolCallName);
      step.title = ev.toolCallName;
      steps.set(ev.toolCallId, step);
      addToChat(step);
      break;
    }
    case 'LOCAL_TOOL_RESULT': {
      const step = steps.get(ev.toolCallId);
      step?.classList.replace('pending', ev.error ? 'failed' : 'ok');
      if (ev.error) step?.append(el('span', null, `: ${ev.error}`));
      break;
    }
    case 'RUN_ERROR':
      addToChat(el('div', 'msg error', `The assistant encountered an error: ${ev.message}`));
      break;
  }
}

// ---------------------------------------------------------------- boot ----

const { accountNumber, holder } = await rpc('account.get');
$('#greeting').textContent = `Welcome back, ${holder.firstName}`;
$('#acct').textContent = `Account ${accountNumber}`;
await refresh();

const spec = await fetchSpec(AGENT_URL);
const conformance = installTools(spec, { refresh, confirmModal, showServiceCard });
console.log('[norvik] WebMCP conformance', conformance, modelContext.listTools());
$('#agent-status').textContent = conformance.ok ? `Shared agent · spec v${spec.version}` : `Missing: ${conformance.missing.join(', ')}`;

const session = new AgentSession({
  agentUrl: AGENT_URL,
  context: [
    { description: 'host', value: 'Norvik Fibre broadband account portal (UK)' },
    {
      description: 'tone of voice',
      value:
        'Formal, calm and precise. British English. No emoji, no exclamation marks. Always state fees, dates and ' +
        'minimum-term consequences plainly before a change. Refer to "your account" and "your service".',
    },
  ],
  onEvent,
});

async function send(text) {
  if (!text.trim() || document.body.classList.contains('busy')) return;
  addToChat(el('div', 'msg user', text));
  $('#prompt').value = '';
  document.body.classList.add('busy');
  try {
    await session.send(text);
  } catch (err) {
    addToChat(el('div', 'msg error', err.message));
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
