import { AgentSession, fetchSpec } from 'http://localhost:4000/sdk/webmcp-agui.js';
import { installTools } from './webmcp.js';
import { seedIfEmpty, allItems, auditLog, ETIM } from './store.js';

const AGENT_URL = 'http://localhost:4000';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ------------------------------------------------------------- tables ----

async function refresh() {
  const items = await allItems();
  $('#count').textContent = `[${items.length} records]`;
  $('#table tbody').replaceChildren(
    ...items.map((i) => {
      const tr = el('tr');
      tr.dataset.sku = i.sku;
      const hasEn = i.texts.en.trim().length >= 40;
      tr.append(
        el('td', 'sku', i.sku),
        el('td', null, i.designation),
        el('td', 'dim', i.etim),
        el('td', hasEn ? 'ok' : 'bad', hasEn ? '✓' : '✗'),
        el('td', `st st-${i.status.toLowerCase()}`, i.status),
        el('td', 'dim', String(i.rev).padStart(3, '0')),
      );
      tr.onclick = () => showDatasheet(i);
      return tr;
    }),
  );
  const log = await auditLog();
  $('#audit').replaceChildren(
    ...(log.length ? log.slice().reverse() : [{ empty: true }]).map((a) =>
      a.empty
        ? el('div', 'dim', 'no changes this session')
        : el('div', 'audit-row', `${a.at.slice(11, 19)}  ${a.sku}  r${a.rev}  ${a.actor}  [${a.changed.join(', ')}]`),
    ),
  );
}

function showDatasheet(item, note) {
  const ds = $('#datasheet');
  ds.classList.remove('dim');
  const specs = el('table', 'specs');
  Object.entries(item.specs).forEach(([k, v]) => {
    const tr = el('tr');
    tr.append(el('td', 'dim', k.replace(/_/g, ' ').toUpperCase()), el('td', null, String(v)));
    specs.append(tr);
  });
  ds.replaceChildren(
    el('div', 'ds-sku', `${item.sku}   ·   ETIM ${item.etim} ${ETIM[item.etim] ?? ''}   ·   REV ${item.rev}   ·   ${item.status}`),
    el('div', 'ds-title', item.designation),
    specs,
    el('div', 'ds-label', 'TEXT [EN]'),
    el('div', item.texts.en ? 'ds-text' : 'ds-text bad', item.texts.en || '(missing)'),
    el('div', 'ds-label', 'TEXT [DE]'),
    el('div', 'ds-text dim', item.texts.de),
    el('div', 'ds-label', 'KEYWORDS'),
    el('div', 'ds-text', item.keywords.join('  ') || '—'),
    ...(note ? [el('div', 'ds-note', `// agent: ${note}`)] : []),
  );
  document.querySelectorAll('#table tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.sku === item.sku));
}

// -------------------------------------------------- UI tool: approval ----

function inlineApproval({ item, proposed, rationale }) {
  const block = el('div', 'approval');
  block.append(
    el('div', 'ap-head', `APPROVAL REQUIRED · ${item.sku}`),
    ...(rationale ? [el('div', 'dim', `# ${rationale}`)] : []),
    el('div', 'diff del', `- en: ${item.texts.en || '(empty)'}`),
    el('div', 'diff add', `+ en: ${proposed.description}`),
    el('div', 'diff del', `- keywords: ${item.keywords.join(', ') || '(none)'}`),
    el('div', 'diff add', `+ keywords: ${proposed.tags.join(', ')}`),
  );
  const actions = el('div', 'ap-actions');
  const yes = el('button', 'btn-yes', '[Y] ACCEPT');
  const no = el('button', 'btn-no', '[N] REJECT');
  actions.append(yes, no);
  block.append(actions);
  out(block);

  return new Promise((resolve) => {
    const finish = (approved) => {
      window.removeEventListener('keydown', onKey);
      actions.replaceChildren(el('span', approved ? 'ok' : 'bad', approved ? '>> ACCEPTED' : '>> REJECTED'));
      resolve(approved ? { approved: true } : { approved: false, comment: 'Rejected by product data steward' });
    };
    const onKey = (e) => {
      if (document.activeElement === $('#input') && $('#input').value) return;
      const k = e.key.toLowerCase();
      if (k !== 'y' && k !== 'n') return;
      e.preventDefault();
      finish(k === 'y');
    };
    window.addEventListener('keydown', onKey);
    yes.onclick = () => finish(true);
    no.onclick = () => finish(false);
  });
}

// ------------------------------------------------------------ console ----

const con = $('#console');
const out = (node) => {
  con.append(node);
  con.scrollTop = con.scrollHeight;
};

let agentLine = null;
const toolLines = new Map();

function onEvent(ev) {
  const { timestamp, ...rest } = ev;
  $('#rawlog').textContent += `${JSON.stringify(rest)}\n`;
  $('#rawlog').scrollTop = $('#rawlog').scrollHeight;

  switch (ev.type) {
    case 'CUSTOM':
      if (ev.name === 'agent_info') $('#agent-status').textContent = `// ${ev.value.brain} · ${ev.value.model}`;
      break;
    case 'TEXT_MESSAGE_START':
      agentLine = el('div', 'line agent', '');
      out(agentLine);
      break;
    case 'TEXT_MESSAGE_CONTENT':
      agentLine.textContent += ev.delta;
      con.scrollTop = con.scrollHeight;
      break;
    case 'TOOL_CALL_START': {
      const line = el('div', 'line tool', `⇢ ${ev.toolCallName}(`);
      toolLines.set(ev.toolCallId, line);
      out(line);
      break;
    }
    case 'TOOL_CALL_ARGS':
      toolLines.get(ev.toolCallId).textContent += ev.delta;
      break;
    case 'TOOL_CALL_END':
      toolLines.get(ev.toolCallId).textContent += ')';
      break;
    case 'LOCAL_TOOL_RESULT': {
      const summary = ev.error ? `ERR ${ev.error}` : ev.result.length > 110 ? `${ev.result.slice(0, 110)}…` : ev.result;
      out(el('div', ev.error ? 'line bad' : 'line result', `⇠ ${summary}`));
      break;
    }
    case 'RUN_ERROR':
      out(el('div', 'line bad', `!! RUN_ERROR ${ev.message}`));
      break;
  }
}

// --------------------------------------------------------------- boot ----

await seedIfEmpty();
await refresh();

const spec = await fetchSpec(AGENT_URL);
const conformance = installTools(spec, { refresh, inlineApproval, showDatasheet });
out(el('div', 'line sys', `spec ${spec.name}@${spec.version}: ${conformance.ok ? 'all required tools implemented' : `MISSING ${conformance.missing}`}; extra: ${conformance.extra.join(', ') || 'none'}`));

const session = new AgentSession({
  agentUrl: AGENT_URL,
  context: [
    { description: 'host', value: 'NORDLAGER industrial PIM (B2B fasteners & drive elements)' },
    {
      description: 'style guide',
      value:
        'Technical catalogue English. Lead with the standard and material, state key dimensions in metric units, ' +
        'no marketing adjectives, no second person, max 2 sentences. Keywords: lowercase, hyphenated, ' +
        'include the thread/size designation and standard number.',
    },
  ],
  onEvent,
});

$('#cmd').onsubmit = async (e) => {
  e.preventDefault();
  const raw = $('#input').value.trim();
  if (!raw) return;
  $('#input').value = '';
  const text = raw === 'enrich' ? 'Enrich SKUs that are missing English copy.' : raw;
  out(el('div', 'line user', `nl> ${raw}`));
  document.body.classList.add('busy');
  try {
    await session.send(text);
  } catch (err) {
    out(el('div', 'line bad', `!! ${err.message}`));
  } finally {
    document.body.classList.remove('busy');
  }
};

$('#raw').onclick = () => $('#rawlog').classList.toggle('hidden');
$('#reset').onclick = async () => {
  await seedIfEmpty(true);
  await refresh();
  out(el('div', 'line sys', 'PIM data reset to seed.'));
};
