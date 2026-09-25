// The contract this agent publishes. The agent owns the *interface*; every
// consumer owns the *implementation* (in its own browser, against its own data).
//
// All data tools speak the normalized `Product` shape below. Mapping a
// platform's native catalog into this shape is the consumer's job.

const Product = {
  type: 'object',
  description: 'Normalized product. Consumers map their native records into this shape.',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string', description: 'Plain-text customer-facing copy. Empty string if none.' },
    tags: { type: 'array', items: { type: 'string' } },
    attributes: { type: 'object', description: 'Free-form platform-specific facts (material, price, specs...).' },
  },
};

export const SPEC = {
  name: 'product-enrichment',
  version: '1.0.0',
  description:
    'Product enrichment agent. Host pages implement these tools via WebMCP ' +
    '(navigator.modelContext) and pass them in the AG-UI RunAgentInput.tools array.',
  tools: [
    {
      name: 'search_products',
      kind: 'data',
      description:
        'Search the host catalog. Returns { products: Product[] } with normalized product summaries.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text filter. Empty string returns everything.' },
          only_missing_copy: {
            type: 'boolean',
            description: 'If true, only return products whose description is empty or very thin.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      returns: { type: 'object', properties: { products: { type: 'array', items: Product } } },
    },
    {
      name: 'get_product',
      kind: 'data',
      description: 'Fetch one product by id. Returns a full normalized Product.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      returns: Product,
    },
    {
      name: 'update_product',
      kind: 'data',
      description:
        'Persist enrichment for one product. Only call after request_approval returned approved=true. ' +
        'Returns { ok, product }.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          patch: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
        required: ['id', 'patch'],
        additionalProperties: false,
      },
    },
    {
      name: 'request_approval',
      kind: 'ui',
      description:
        'Show the proposed enrichment to the human in the host UI and wait for a decision. ' +
        'Returns { approved: boolean, final?: { description, tags }, comment?: string }. ' +
        'If `final` is present the human edited the proposal; persist `final`, not your draft.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          proposed: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['description', 'tags'],
            additionalProperties: false,
          },
          rationale: { type: 'string', description: 'One sentence on why this copy fits the brand guidelines.' },
        },
        required: ['id', 'proposed'],
        additionalProperties: false,
      },
    },
    {
      name: 'show_product_card',
      kind: 'ui',
      description: 'Render a product card in the host UI (host decides what that looks like). Returns { displayed: true }.',
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
