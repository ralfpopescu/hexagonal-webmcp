// NORDLAGER's implementation of the enrichment agent's WebMCP spec.
// Same contract as every other consumer; completely different plumbing:
//   - data tools  -> IndexedDB SKU master, bilingual texts, revisioned + audited writes
//   - UI tools    -> inline console diff with [Y]/[N] keys, datasheet panel
//   - plus one NORDLAGER-only tool the spec doesn't define (lookup_etim_class)

import { implementSpec, modelContext, createApprovalGate } from 'http://localhost:4000/sdk/webmcp-agui.js';
import { allItems, getItem, commit, ETIM } from './store.js';

export function toProduct(item) {
  return {
    id: item.sku,
    title: item.designation,
    description: item.texts.en,
    tags: item.keywords,
    attributes: { classification: `ETIM ${item.etim} (${ETIM[item.etim] ?? 'unknown'})`, status: item.status, ...item.specs },
  };
}

const mustGet = async (sku) => {
  const item = await getItem(sku);
  if (!item) throw new Error(`SKU ${sku} not found in PIM`);
  return item;
};

export function installTools(spec, ui) {
  const approvals = createApprovalGate();
  const conformance = implementSpec(spec, {
    search_products: {
      description: 'Query the NORDLAGER SKU master (IndexedDB). Matches SKU, designation, ETIM class and German text.',
      async execute({ query = '', only_missing_copy = false, limit = 20 }) {
        const q = query.toLowerCase();
        const items = (await allItems())
          .filter((i) => !q || `${i.sku} ${i.designation} ${i.etim} ${i.texts.de}`.toLowerCase().includes(q))
          .filter((i) => !only_missing_copy || i.texts.en.trim().length < 40)
          .slice(0, limit);
        return { products: items.map(toProduct) };
      },
    },

    async get_product({ id }) {
      return toProduct(await mustGet(id));
    },

    async update_product({ id, patch }) {
      approvals.consume(id, patch);
      const item = await commit(
        id,
        (i) => {
          const changed = [];
          if (patch.description !== undefined) {
            i.texts.en = patch.description;
            changed.push('texts.en');
          }
          if (patch.tags !== undefined) {
            i.keywords = patch.tags.map((t) => t.toLowerCase().replace(/\s+/g, '-'));
            changed.push('keywords');
          }
          if (i.status === 'DRAFT') i.status = 'ENRICHED';
          return changed;
        },
        'enrichment-agent',
      );
      await ui.refresh();
      return { ok: true, product: toProduct(item) };
    },

    async request_approval({ id, proposed, rationale }) {
      const decision = await ui.inlineApproval({ item: await mustGet(id), proposed, rationale });
      return approvals.record(id, decision, proposed);
    },

    async show_product_card({ id, note }) {
      ui.showDatasheet(await mustGet(id), note);
      return { displayed: true };
    },
  });

  // Not part of the agent's spec: a host may offer extra tools and the agent
  // will see them for this session only.
  modelContext.registerTool({
    name: 'lookup_etim_class',
    description: 'NORDLAGER-only: resolve an ETIM class code (e.g. EC000293) to its name.',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    async execute({ code }) {
      return { code, name: ETIM[code] ?? null };
    },
  });

  return conformance;
}
