// Solestack: a sneaker store. Its "My orders" API is a cookie-session REST API
// in a Shopify-flavoured shape (line_items, fulfillment_status, total_price).
// The support agent never sees this API or the cookie; only the page's WebMCP
// tools do, running as the logged-in customer.

import express from 'express';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.SOLESTACK_PORT ?? 3001);
const PUBLIC = fileURLToPath(new URL('./public', import.meta.url));
const DAY = 864e5;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const latency = () => new Promise((r) => setTimeout(r, 120 + Math.random() * 180));

const customer = { id: 'cust_jamie', first_name: 'Jamie', email: 'jamie@example.com' };
const address = { name: 'Jamie Rivera', address1: '221 Larch St', city: 'Portland', province: 'OR', zip: '97209' };

const orders = [
  {
    name: '1042', emoji: '🏃', created_at: iso(now - 1 * DAY), total_price: '140.00',
    fulfillment_status: null, shipment_status: null, delivered_at: null, cancelled_at: null, return_status: null,
    line_items: [{ title: 'Aero Glide Runner', variant_title: 'US 10 / Volt', quantity: 1, price: '140.00', final_sale: false }],
    shipping_address: { ...address }, tracking: null,
  },
  {
    name: '1038', emoji: '👟', created_at: iso(now - 4 * DAY), total_price: '95.00',
    fulfillment_status: 'fulfilled', shipment_status: 'in_transit', delivered_at: null, cancelled_at: null, return_status: null,
    line_items: [{ title: 'Court Classic Low', variant_title: 'US 10 / White', quantity: 1, price: '95.00', final_sale: false }],
    shipping_address: { ...address }, tracking: { carrier: 'UPS', number: '1Z84X0A20391', eta: iso(now + 2 * DAY) },
  },
  {
    name: '1017', emoji: '🥾', created_at: iso(now - 16 * DAY), total_price: '165.00',
    fulfillment_status: 'fulfilled', shipment_status: 'delivered', delivered_at: iso(now - 12 * DAY), cancelled_at: null, return_status: null,
    line_items: [{ title: 'Trail Hiker Mid', variant_title: 'US 10.5 / Moss', quantity: 1, price: '165.00', final_sale: false }],
    shipping_address: { ...address }, tracking: { carrier: 'UPS', number: '1Z84X0A19877', eta: null },
  },
  {
    name: '0993', emoji: '⚡', created_at: iso(now - 25 * DAY), total_price: '190.00',
    fulfillment_status: 'fulfilled', shipment_status: 'delivered', delivered_at: iso(now - 20 * DAY), cancelled_at: null, return_status: null,
    line_items: [{ title: 'Neon Hi-Top (Limited Drop)', variant_title: 'US 10 / Acid', quantity: 1, price: '190.00', final_sale: true }],
    shipping_address: { ...address }, tracking: { carrier: 'USPS', number: '9400 1118 9922', eta: null },
  },
];

const app = express();
app.use(express.json());

// "Log in" whoever opens the store. Real stores do this with a real login.
app.get('/', (_req, res) => {
  res.cookie('sid', customer.id, { httpOnly: true, sameSite: 'lax' });
  res.sendFile(`${PUBLIC}/index.html`);
});
app.use(express.static(PUBLIC, { index: false }));

const api = express.Router();
api.use(async (req, res, next) => {
  await latency();
  if (!req.headers.cookie?.includes(`sid=${customer.id}`)) return res.status(401).json({ error: 'Not signed in' });
  next();
});

const find = (req, res) => {
  const o = orders.find((x) => x.name === req.params.name);
  if (!o) res.status(404).json({ error: 'Order not found' });
  return o;
};

api.get('/me', (_req, res) => res.json({ customer }));
api.get('/orders', (_req, res) => res.json({ orders }));
api.get('/orders/:name', (req, res) => {
  const o = find(req, res);
  if (o) res.json({ order: o });
});

// The store's API enforces its own rules; the adapter only mirrors them for display.
api.post('/orders/:name/cancel', (req, res) => {
  const o = find(req, res);
  if (!o) return;
  if (o.fulfillment_status || o.cancelled_at) return res.status(422).json({ error: 'Only unshipped orders can be cancelled' });
  o.cancelled_at = iso(Date.now());
  res.json({ order: o });
});

api.post('/orders/:name/returns', (req, res) => {
  const o = find(req, res);
  if (!o) return;
  const days = o.delivered_at ? (Date.now() - Date.parse(o.delivered_at)) / DAY : Infinity;
  if (o.shipment_status !== 'delivered' || days > 30 || o.return_status || o.line_items.some((i) => i.final_sale)) {
    return res.status(422).json({ error: 'This order is not eligible for return' });
  }
  if (!req.body.reason) return res.status(422).json({ error: 'A return reason is required' });
  o.return_status = 'label_sent';
  o.return = { reason: req.body.reason, rma: `RMA-${o.name}-${Math.floor(Math.random() * 9000 + 1000)}` };
  res.json({ order: o });
});

api.put('/orders/:name/shipping_address', (req, res) => {
  const o = find(req, res);
  if (!o) return;
  if (o.fulfillment_status || o.cancelled_at) return res.status(422).json({ error: 'Address can only change before shipping' });
  const { address1, city, province, zip } = req.body.address ?? {};
  if (!address1 || !city || !zip) return res.status(422).json({ error: 'Incomplete address' });
  Object.assign(o.shipping_address, { address1, city, province, zip });
  res.json({ order: o });
});

app.use('/api/storefront', api);
app.listen(PORT, () => console.log(`[solestack] sneaker store on http://localhost:${PORT}`));
