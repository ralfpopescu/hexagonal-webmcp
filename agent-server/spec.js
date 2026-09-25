// The contract this agent publishes: its ports. The agent owns the interface;
// every host owns the implementation (in its own page, against its own backend,
// with the customer's own session).
//
// All data tools speak the normalized `Purchase` shape below. An order, a
// subscription, a booking: whatever the host sells, it maps it into this shape.

const Purchase = {
  type: 'object',
  description: 'Normalized purchase. Hosts map their native orders/subscriptions/bookings into this shape.',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    kind: { type: 'string', description: 'Host-defined, e.g. "order", "broadband subscription".' },
    status: { type: 'string', enum: ['processing', 'shipped', 'delivered', 'pending', 'active', 'paused', 'cancelled'] },
    date: { type: 'string', description: 'ISO date the purchase was made or started.' },
    amount: { type: 'string', description: 'Human-readable price, e.g. "$140.00" or "£32/month".' },
    summary: { type: 'string', description: 'One line on where things stand, written by the host.' },
    details: { type: 'object', description: 'Free-form host-specific facts (items, address, tracking, contract...).' },
  },
};

const Action = {
  type: 'object',
  properties: {
    action: { type: 'string', description: 'Host-defined action name, e.g. "cancel", "return", "pause".' },
    label: { type: 'string' },
    note: { type: 'string', description: 'Fees, deadlines or other consequences the customer should know.' },
    reason: { type: 'string', description: 'For unavailable actions: why, in customer-facing language.' },
  },
};

export const SPEC = {
  name: 'customer-support',
  version: '1.0.0',
  description:
    'In-app customer support agent. Host pages implement these tools via WebMCP ' +
    '(document.modelContext) and pass them in the AG-UI RunAgentInput.tools array. ' +
    'Tools run in the customer\'s logged-in session, so they only ever see and change that customer\'s account.',
  tools: [
    {
      name: 'list_purchases',
      kind: 'data',
      description: "List the logged-in customer's purchases, newest first. Returns { purchases: Purchase[] }.",
      parameters: {
        type: 'object',
        properties: {
          include_closed: { type: 'boolean', description: 'Include cancelled purchases. Default true.' },
        },
        additionalProperties: false,
      },
      returns: { type: 'object', properties: { purchases: { type: 'array', items: Purchase } } },
    },
    {
      name: 'get_purchase',
      kind: 'data',
      description: 'Fetch one purchase by id. Returns a Purchase.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      returns: Purchase,
    },
    {
      name: 'get_available_actions',
      kind: 'data',
      description:
        'Ask the host what the customer can do with a purchase right now, under the host\'s own business rules. ' +
        'Returns { available: Action[], unavailable: Action[] }. Unavailable actions include a customer-facing reason.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      returns: {
        type: 'object',
        properties: { available: { type: 'array', items: Action }, unavailable: { type: 'array', items: Action } },
      },
    },
    {
      name: 'confirm_action',
      kind: 'ui',
      description:
        'Show the host\'s own confirmation UI for an available action and wait for the customer. The host may collect ' +
        'inputs there (a reason, a new address, a plan, a date). Returns { confirmed: boolean, params?: object }.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string' },
          summary: { type: 'string', description: 'One sentence describing what will happen, in the host voice.' },
        },
        required: ['id', 'action'],
        additionalProperties: false,
      },
    },
    {
      name: 'perform_action',
      kind: 'data',
      description:
        'Carry out an action the customer just confirmed. Pass exactly the `params` that confirm_action returned. ' +
        'The host refuses anything the customer did not confirm. Returns { ok, message, purchase }.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string' },
          params: { type: 'object' },
        },
        required: ['id', 'action'],
        additionalProperties: false,
      },
    },
    {
      name: 'show_purchase_card',
      kind: 'ui',
      description: 'Render a purchase in the host UI (the host decides what that looks like). Returns { displayed: true }.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          note: { type: 'string', description: 'Short caption shown with the card.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ],
};

export const REQUIRED_TOOL_NAMES = SPEC.tools.map((t) => t.name);
