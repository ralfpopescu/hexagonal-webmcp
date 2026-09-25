// Maple & Co.'s implementation of the enrichment agent's WebMCP spec.
// This file is everything Maple had to write to plug into the shared agent:
//   - data tools  -> call Maple's own REST API, map to/from the normalized Product
//   - UI tools    -> render with Maple's own components (modal, storefront card)

import { implementSpec, createApprovalGate } from 'http://localhost:4000/sdk/webmcp-agui.js';

const api = async (path, init) => {
  const res = await fetch(`/admin/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (!res.ok) throw new Error(`Maple API ${res.status} on ${path}`);
  return res.json();
};

// gid://maple/Product/7781 <-> handle: the agent gets stable ids, Maple's API wants handles.
const handleById = new Map();

const stripHtml = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export function toProduct(p) {
  handleById.set(p.id, p.handle);
  return {
    id: p.id,
    title: p.title,
    description: stripHtml(p.body_html),
    tags: p.tags.split(',').map((t) => t.trim()).filter(Boolean),
    attributes: {
      product_type: p.product_type,
      vendor: p.vendor,
      price: `$${p.variants[0].price}`,
      ...p.metafields,
    },
  };
}

const handleFor = async (id) => {
  if (!handleById.has(id)) (await api('/products.json')).products.forEach(toProduct);
  const h = handleById.get(id);
  if (!h) throw new Error(`No Maple product with id ${id}`);
  return h;
};

export function installTools(spec, ui) {
  const approvals = createApprovalGate();
  return implementSpec(spec, {
    async search_products({ query = '', only_missing_copy = false, limit = 20 }) {
      const { products } = await api(`/products.json?q=${encodeURIComponent(query)}`);
      return {
        products: products
          .map(toProduct)
          .filter((p) => !only_missing_copy || p.description.length < 40)
          .slice(0, limit),
      };
    },

    async get_product({ id }) {
      const { product } = await api(`/products/${await handleFor(id)}.json`);
      return toProduct(product);
    },

    async update_product({ id, patch }) {
      approvals.consume(id, patch);
      const body = {};
      if (patch.description !== undefined) {
        body.body_html = patch.description.split(/\n{2,}/).map((para) => `<p>${escapeHtml(para)}</p>`).join('');
      }
      if (patch.tags !== undefined) body.tags = patch.tags.map((t) => t.toLowerCase()).join(', ');
      const { product } = await api(`/products/${await handleFor(id)}.json`, {
        method: 'PUT',
        body: JSON.stringify({ product: body }),
      });
      await ui.refreshCatalog();
      return { ok: true, product: toProduct(product) };
    },

    // UI tools: resolved by Maple's own components.
    async request_approval({ id, proposed, rationale }) {
      const { product } = await api(`/products/${await handleFor(id)}.json`);
      const decision = await ui.openApprovalModal({ product, current: toProduct(product), proposed, rationale });
      return approvals.record(id, decision, proposed);
    },

    async show_product_card({ id, note }) {
      const { product } = await api(`/products/${await handleFor(id)}.json`);
      ui.renderStorefrontCard(product, note);
      return { displayed: true };
    },
  });
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
