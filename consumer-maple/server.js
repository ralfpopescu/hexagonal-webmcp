// Maple & Co. — a DTC storefront admin. Its catalog lives behind its own REST
// API, in a Shopify-flavoured shape (body_html, comma-joined tags, variants,
// metafields). The agent never sees this API; only the page's WebMCP tools do.

import express from 'express';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.MAPLE_PORT ?? 3001);
const latency = () => new Promise((r) => setTimeout(r, 150 + Math.random() * 200));

const products = [
  {
    id: 'gid://maple/Product/7781', handle: 'ember-soy-candle-fig-cedar', emoji: '🕯️',
    title: 'Ember Soy Candle — Fig & Cedar', product_type: 'Candle', vendor: 'Maple & Co.',
    body_html: '', tags: 'candle',
    variants: [{ sku: 'MPL-CDL-FIG', price: '32.00', inventory: 84 }],
    metafields: { scent_notes: 'green fig, cedarwood, a little amber', material: 'soy wax, cotton wick', burn_time_hours: 55, vessel: 'hand-poured amber glass' },
  },
  {
    id: 'gid://maple/Product/7782', handle: 'stoneware-mug-speckled-oat', emoji: '☕',
    title: 'Stoneware Mug — Speckled Oat', product_type: 'Mug', vendor: 'Maple & Co.',
    body_html: '<p>Mug.</p>', tags: '',
    variants: [{ sku: 'MPL-MUG-OAT', price: '26.00', inventory: 41 }],
    metafields: { material: 'stoneware', finish: 'speckled matte glaze', capacity_oz: 12, care: 'dishwasher and microwave safe' },
  },
  {
    id: 'gid://maple/Product/7783', handle: 'linen-tea-towel-set', emoji: '🧺',
    title: 'Linen Tea Towel Set', product_type: 'Kitchen textile', vendor: 'Maple & Co.',
    body_html: '<p>Three stonewashed European linen towels that get softer (and thirstier) with every wash. Hang one by the stove and feel quietly organised.</p>',
    tags: 'linen, kitchen, bestseller',
    variants: [{ sku: 'MPL-TWL-3', price: '38.00', inventory: 120 }],
    metafields: { material: 'European flax linen', count: 3 },
  },
  {
    id: 'gid://maple/Product/7784', handle: 'olivewood-serving-board', emoji: '🪵',
    title: 'Olivewood Serving Board', product_type: 'Serveware', vendor: 'Oliva Workshop',
    body_html: '', tags: '',
    variants: [{ sku: 'MPL-BRD-OLV', price: '48.00', inventory: 17 }],
    metafields: { material: 'olive wood', dimensions: '16 × 7 in', care: 'hand wash, oil monthly' },
  },
  {
    id: 'gid://maple/Product/7785', handle: 'wool-throw-heather', emoji: '🧶',
    title: 'Wool Throw — Heather Grey', product_type: 'Throw', vendor: 'Maple & Co.',
    body_html: '<p>A heavyweight lambswool throw for long Sunday reading sessions. Woven in a small mill in Wales, fringed by hand.</p>',
    tags: 'wool, living room',
    variants: [{ sku: 'MPL-THR-GRY', price: '120.00', inventory: 9 }],
    metafields: { material: 'lambswool' },
  },
  {
    id: 'gid://maple/Product/7786', handle: 'beeswax-taper-pair', emoji: '🐝',
    title: 'Beeswax Taper Pair', product_type: 'Candle', vendor: 'Hive & Wick',
    body_html: '<p>Two candles</p>', tags: '',
    variants: [{ sku: 'MPL-TPR-2', price: '18.00', inventory: 200 }],
    metafields: { material: '100% beeswax', height_in: 10, burn_time_hours: 8, scent_notes: 'natural honey' },
  },
  {
    id: 'gid://maple/Product/7787', handle: 'ceramic-bud-vase', emoji: '🏺',
    title: 'Ceramic Bud Vase', product_type: 'Vase', vendor: 'Maple & Co.',
    body_html: '<p>Small enough for a single stem from the garden, sturdy enough to survive the cat. Thrown by hand, so no two are quite alike.</p>',
    tags: 'ceramic, decor',
    variants: [{ sku: 'MPL-VAS-BUD', price: '22.00', inventory: 33 }],
    metafields: { material: 'stoneware' },
  },
  {
    id: 'gid://maple/Product/7788', handle: 'cotton-waffle-robe', emoji: '🥋',
    title: 'Cotton Waffle Robe', product_type: 'Robe', vendor: 'Maple & Co.',
    body_html: '', tags: '',
    variants: [{ sku: 'MPL-RBE-WFL', price: '88.00', inventory: 26 }],
    metafields: { material: 'organic cotton waffle weave', finish: 'garment-washed', care: 'machine wash cold' },
  },
];

const app = express();
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

app.get('/admin/api/products.json', async (req, res) => {
  await latency();
  const q = String(req.query.q ?? '').toLowerCase();
  res.json({ products: products.filter((p) => !q || `${p.title} ${p.tags} ${p.product_type}`.toLowerCase().includes(q)) });
});

app.get('/admin/api/products/:handle.json', async (req, res) => {
  await latency();
  const p = products.find((x) => x.handle === req.params.handle);
  p ? res.json({ product: p }) : res.status(404).json({ errors: 'Not Found' });
});

app.put('/admin/api/products/:handle.json', async (req, res) => {
  await latency();
  const p = products.find((x) => x.handle === req.params.handle);
  if (!p) return res.status(404).json({ errors: 'Not Found' });
  const { body_html, tags } = req.body.product ?? {};
  if (body_html !== undefined) p.body_html = body_html;
  if (tags !== undefined) p.tags = tags;
  p.updated_at = new Date().toISOString();
  res.json({ product: p });
});

app.listen(PORT, () => console.log(`[maple] storefront admin on http://localhost:${PORT}`));
