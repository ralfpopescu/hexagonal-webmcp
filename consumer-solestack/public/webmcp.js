// Solestack's adapters for the support agent's ports.
// This file is everything Solestack wrote to plug into the shared agent:
//   - data tools -> Solestack's cookie-session REST API, mapped to/from `Purchase`
//   - UI tools   -> Solestack's own bottom sheet and order card
//   - policy     -> Solestack's return window, final-sale rule, "cancel before shipping"

import { implementSpec, createApprovalGate } from 'http://localhost:4000/sdk/webmcp-agui.js';

const DAY = 864e5;

const api = async (path, init) => {
  const res = await fetch(`/api/storefront${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Store API ${res.status}`);
  return body;
};
const getOrder = async (id) => (await api(`/orders/${String(id).replace(/^#/, '')}`)).order;
const fmt = (d) => new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

export function statusOf(o) {
  if (o.cancelled_at) return 'cancelled';
  if (o.shipment_status === 'delivered') return 'delivered';
  if (o.fulfillment_status) return 'shipped';
  return 'processing';
}

function summaryOf(o) {
  switch (statusOf(o)) {
    case 'cancelled': return 'Cancelled, refunded to your original payment method';
    case 'processing': return 'Being packed, ships in 1–2 days';
    case 'shipped': return `On its way with ${o.tracking.carrier}, arriving ${fmt(o.tracking.eta)}`;
    case 'delivered': return `Delivered ${fmt(o.delivered_at)}${o.return_status ? ' · return label sent' : ''}`;
  }
}

export function toPurchase(o) {
  const a = o.shipping_address;
  return {
    id: `#${o.name}`,
    title: o.line_items.map((i) => i.title).join(', '),
    kind: 'order',
    status: statusOf(o),
    date: o.created_at,
    amount: `$${o.total_price}`,
    summary: summaryOf(o),
    details: {
      items: o.line_items.map((i) => `${i.quantity}× ${i.title} (${i.variant_title})${i.final_sale ? ', final sale' : ''}`),
      ship_to: `${a.address1}, ${a.city}, ${a.province} ${a.zip}`,
      ...(o.tracking && { tracking: `${o.tracking.carrier} ${o.tracking.number}` }),
    },
  };
}

// Solestack's policies, in Solestack's words.
function actionsFor(o) {
  const status = statusOf(o);
  const available = [];
  const unavailable = [];
  const add = (ok, action, label, why, note) => (ok ? available.push({ action, label, ...(note && { note }) }) : unavailable.push({ action, label, reason: why }));

  add(status === 'processing', 'cancel', 'Cancel order',
    { shipped: 'It already shipped. Once it arrives you can send it back free within 30 days.', delivered: "It's already been delivered, but a return might work instead.", cancelled: "It's already cancelled." }[status],
    `Full refund of $${o.total_price} in 3–5 business days`);

  add(status === 'processing', 'change_address', 'Change shipping address', status === 'cancelled' ? 'That order was cancelled.' : 'The address can only change before the order ships.');

  const days = o.delivered_at ? (Date.now() - Date.parse(o.delivered_at)) / DAY : null;
  const finalSale = o.line_items.some((i) => i.final_sale);
  const returnWhy =
    status !== 'delivered' ? "It hasn't been delivered yet."
    : finalSale ? "Limited drops are final sale, so they can't be returned."
    : o.return_status ? 'A return is already in progress.'
    : days > 30 ? 'The 30-day return window has closed.'
    : null;
  add(!returnWhy, 'return', 'Start a free return', returnWhy, 'Free prepaid label, refund once it arrives');

  return { available, unavailable };
}

const MESSAGES = {
  cancel: (o) => `Order #${o.name} is cancelled. $${o.total_price} goes back to your card in 3–5 business days.`,
  return: (o) => `Return started for #${o.name}. Your free label (${o.return.rma}) is on its way to your inbox.`,
  change_address: (o) => `Order #${o.name} will now ship to ${o.shipping_address.address1}, ${o.shipping_address.city}.`,
};

export function installTools(spec, ui) {
  const approvals = createApprovalGate();

  return implementSpec(spec, {
    async list_purchases({ include_closed = true } = {}) {
      const { orders } = await api('/orders');
      return { purchases: orders.map(toPurchase).filter((p) => include_closed || p.status !== 'cancelled') };
    },

    async get_purchase({ id }) {
      return toPurchase(await getOrder(id));
    },

    async get_available_actions({ id }) {
      return actionsFor(await getOrder(id));
    },

    async confirm_action({ id, action, summary }) {
      const order = await getOrder(id);
      if (!actionsFor(order).available.some((a) => a.action === action)) throw new Error(`"${action}" is not available for ${id}`);
      const result = await ui.confirmSheet({ order, action, summary });
      approvals.record(`${id}:${action}`, result.confirmed, result.params ?? {});
      return result;
    },

    async perform_action({ id, action, params = {} }) {
      approvals.consume(`${id}:${action}`, params);
      const name = String(id).replace(/^#/, '');
      const { order } = await ({
        cancel: () => api(`/orders/${name}/cancel`, { method: 'POST' }),
        return: () => api(`/orders/${name}/returns`, { method: 'POST', body: JSON.stringify({ reason: params.reason }) }),
        change_address: () => api(`/orders/${name}/shipping_address`, { method: 'PUT', body: JSON.stringify({ address: params.address }) }),
      }[action] ?? (() => { throw new Error(`Unknown action ${action}`); }))();
      await ui.refresh();
      return { ok: true, message: MESSAGES[action](order), purchase: toPurchase(order) };
    },

    async show_purchase_card({ id, note }) {
      ui.showOrderCard(await getOrder(id), note);
      return { displayed: true };
    },
  });
}
