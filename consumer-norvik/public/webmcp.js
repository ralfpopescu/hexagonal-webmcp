// Norvik Fibre's adapters for the support agent's ports.
// Same contract as every other host; completely different plumbing:
//   - data tools -> JSON-RPC 2.0 with the portal's bearer token, subscriptions mapped to `Purchase`
//   - policy     -> Norvik's server-side eligibility engine (the adapter just translates it)
//   - UI tools   -> Norvik's formal confirmation modal and service tile

import { implementSpec, createApprovalGate } from 'http://localhost:4000/sdk/webmcp-agui.js';

let token;
let seq = 0;
export async function rpc(method, params = {}) {
  token ??= (await (await fetch('/auth/session', { method: 'POST' })).json()).token;
  const res = await fetch('/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

const fmt = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const gbp = (n) => `£${Number(n).toFixed(2)}`;

// Spec action name <-> Norvik eligibility key.
const ACTIONS = {
  pause: ['PAUSE', 'Holiday pause'],
  change_plan: ['CHANGE_PLAN', 'Change broadband plan'],
  cancel: ['CANCEL', 'Cancel service'],
  reschedule_install: ['RESCHEDULE', 'Reschedule engineer visit'],
};

const STATUS = { ACTIVE: 'active', PENDING_INSTALL: 'pending', PAUSED: 'paused', CANCELLED: 'cancelled' };

function summaryOf(s) {
  switch (s.status) {
    case 'ACTIVE': return Date.parse(s.contract.minTermEnd) > Date.now() ? `Active, minimum term ends ${fmt(s.contract.minTermEnd)}` : 'Active, out of contract';
    case 'PAUSED': return `Paused until ${fmt(s.pause.until)} (${gbp(s.pause.feePerMonth)}/month while paused)`;
    case 'PENDING_INSTALL': return `Engineer visit ${fmt(s.appointment.date)}, ${s.appointment.window}`;
    case 'CANCELLED': return `Cancelled, service ends ${fmt(s.endsOn)}`;
  }
}

export function toPurchase(s) {
  return {
    id: s.serviceId,
    title: s.product.name,
    kind: `${s.type === 'TV' ? 'tv' : 'broadband'} subscription`,
    status: STATUS[s.status],
    date: s.contract.startDate,
    amount: `${gbp(s.product.monthlyPrice)}/month`,
    summary: summaryOf(s),
    details: {
      address: s.installAddress,
      ...(s.product.downMbps && { speed: `${s.product.downMbps}/${s.product.upMbps} Mbps` }),
      minimum_term_ends: s.contract.minTermEnd.slice(0, 10),
      ...(s.appointment && { engineer_visit: `${s.appointment.date.slice(0, 10)} ${s.appointment.window}` }),
    },
  };
}

function noteFor(action, e) {
  if (action === 'pause') return `Up to ${e.maxMonths} months at ${gbp(e.feePerMonth)}/month`;
  if (action === 'change_plan') return `Upgrades start a new ${e.newMinTermMonths}-month minimum term.${e.note ? ` ${e.note}` : ''}`;
  if (action === 'cancel') return e.earlyTerminationFee ? `Early termination fee of ${gbp(e.earlyTerminationFee)} applies` : 'No early termination fee';
  if (action === 'reschedule_install') return `${e.slots.length} alternative slots available`;
}

const MESSAGES = {
  pause: (s) => `${s.product.name} is paused until ${fmt(s.pause.until)}.`,
  change_plan: (s) => `Your broadband is now ${s.product.name} at ${gbp(s.product.monthlyPrice)} per month. Your new minimum term ends ${fmt(s.contract.minTermEnd)}.`,
  cancel: (s) => `${s.product.name} has been cancelled and will end on ${fmt(s.endsOn)}.`,
  reschedule_install: (s) => `Your engineer visit is now ${fmt(s.appointment.date)}, ${s.appointment.window}.`,
};

export function installTools(spec, ui) {
  const approvals = createApprovalGate();

  return implementSpec(spec, {
    list_purchases: {
      description: 'List the services on the customer\'s Norvik account (broadband, TV) as purchases.',
      async execute({ include_closed = true } = {}) {
        const { services } = await rpc('account.get');
        return { purchases: services.map(toPurchase).filter((p) => include_closed || p.status !== 'cancelled') };
      },
    },

    async get_purchase({ id }) {
      return toPurchase(await rpc('service.get', { serviceId: id }));
    },

    async get_available_actions({ id }) {
      const elig = await rpc('service.eligibility', { serviceId: id });
      const available = [];
      const unavailable = [];
      for (const [action, [key, label]] of Object.entries(ACTIONS)) {
        const e = elig[key];
        if (e.eligible) available.push({ action, label, note: noteFor(action, e) });
        else unavailable.push({ action, label, reason: e.reason });
      }
      return { available, unavailable };
    },

    async confirm_action({ id, action, summary }) {
      const [key] = ACTIONS[action] ?? [];
      if (!key) throw new Error(`Unknown action ${action}`);
      const [service, elig] = await Promise.all([rpc('service.get', { serviceId: id }), rpc('service.eligibility', { serviceId: id })]);
      if (!elig[key].eligible) throw new Error(elig[key].reason);
      const result = await ui.confirmModal({ service, action, eligibility: elig[key], summary });
      approvals.record(`${id}:${action}`, result.confirmed, result.params ?? {});
      return result;
    },

    async perform_action({ id, action, params = {} }) {
      approvals.consume(`${id}:${action}`, params);
      const call = {
        pause: () => rpc('service.pause', { serviceId: id, months: params.months }),
        change_plan: () => rpc('service.changePlan', { serviceId: id, planCode: params.plan_code }),
        cancel: () => rpc('service.cancel', { serviceId: id, acknowledgedFee: params.acknowledged_fee }),
        reschedule_install: () => rpc('appointment.reschedule', { serviceId: id, slotId: params.slot_id }),
      }[action];
      if (!call) throw new Error(`Unknown action ${action}`);
      const service = await call();
      await ui.refresh();
      return { ok: true, message: MESSAGES[action](service), purchase: toPurchase(service) };
    },

    async show_purchase_card({ id, note }) {
      ui.showServiceCard(await rpc('service.get', { serviceId: id }), note);
      return { displayed: true };
    },
  });
}
