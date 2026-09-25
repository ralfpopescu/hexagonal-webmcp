// Norvik Fibre: a broadband provider's account portal. Nothing like a store:
// subscriptions instead of orders, a JSON-RPC 2.0 backend instead of REST,
// bearer tokens instead of cookies, and an eligibility engine that owns the
// rules (minimum terms, early termination fees, holiday pauses, engineer slots).

import express from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.NORVIK_PORT ?? 3002);
const DAY = 864e5;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const monthsBetween = (a, b) => Math.max(0, Math.ceil((b - a) / (30.44 * DAY)));
const latency = () => new Promise((r) => setTimeout(r, 150 + Math.random() * 200));

const PLANS = {
  FIB150: { code: 'FIB150', name: 'Fibre 150', downMbps: 150, upMbps: 30, monthlyPrice: 32 },
  FIB500: { code: 'FIB500', name: 'Fibre 500', downMbps: 500, upMbps: 75, monthlyPrice: 38 },
  FIB900: { code: 'FIB900', name: 'Fibre 900', downMbps: 900, upMbps: 110, monthlyPrice: 45 },
};

const account = {
  accountNumber: 'NV-448120',
  holder: { firstName: 'Alex', lastName: 'Morgan' },
  services: [
    {
      serviceId: 'SVC-10021', type: 'BROADBAND', product: PLANS.FIB150, status: 'ACTIVE',
      installAddress: 'Flat 3, 88 Quay Street, Bristol BS1 4DB',
      contract: { startDate: iso(now - 182 * DAY), minTermEnd: iso(now + 365 * DAY) },
      pause: null, appointment: null, endsOn: null,
    },
    {
      serviceId: 'SVC-10022', type: 'TV', product: { code: 'TVESS', name: 'Norvik TV Essentials', monthlyPrice: 12 }, status: 'ACTIVE',
      installAddress: 'Flat 3, 88 Quay Street, Bristol BS1 4DB',
      contract: { startDate: iso(now - 790 * DAY), minTermEnd: iso(now - 60 * DAY) },
      pause: null, appointment: null, endsOn: null,
    },
    {
      serviceId: 'SVC-10031', type: 'BROADBAND', product: PLANS.FIB500, status: 'PENDING_INSTALL',
      installAddress: '14 Harbour Row, Bristol BS1 6XN',
      contract: { startDate: iso(now), minTermEnd: iso(now + 548 * DAY) },
      pause: null, endsOn: null,
      appointment: { slotId: 'SLOT-8-AM', date: iso(now + 8 * DAY), window: '08:00–13:00' },
    },
  ],
};

function slots(service) {
  return Array.from({ length: 6 }, (_, i) => {
    const date = iso(now + (3 + Math.floor(i / 2)) * DAY);
    const am = i % 2 === 0;
    return { slotId: `SLOT-${3 + Math.floor(i / 2)}-${am ? 'AM' : 'PM'}`, date, window: am ? '08:00–13:00' : '13:00–18:00' };
  }).filter((s) => s.slotId !== service.appointment?.slotId);
}

// The eligibility engine: Norvik's business rules, owned by Norvik's backend.
function eligibility(s) {
  const inTerm = Date.parse(s.contract.minTermEnd) > Date.now();
  const active = s.status === 'ACTIVE';
  return {
    PAUSE: s.type !== 'BROADBAND'
      ? { eligible: false, reason: 'Holiday pause is only available for broadband, not TV packages.' }
      : !active ? { eligible: false, reason: s.status === 'PAUSED' ? 'This service is already paused.' : 'This service is not active yet.' }
      : { eligible: true, maxMonths: 3, feePerMonth: 5 },
    CHANGE_PLAN: s.type !== 'BROADBAND'
      ? { eligible: false, reason: 'There are no alternative TV packages available on your account.' }
      : !active ? { eligible: false, reason: 'Plan changes are available once installation is complete.' }
      : {
          eligible: true,
          options: Object.values(PLANS).filter((p) => p.monthlyPrice > s.product.monthlyPrice),
          newMinTermMonths: 18,
          note: inTerm ? `Downgrades are available after your minimum term ends on ${s.contract.minTermEnd.slice(0, 10)}.` : null,
        },
    CANCEL: s.status === 'CANCELLED'
      ? { eligible: false, reason: 'This service is already cancelled.' }
      : {
          eligible: true,
          noticeDays: s.status === 'PENDING_INSTALL' ? 0 : 30,
          earlyTerminationFee: active && inTerm ? monthsBetween(Date.now(), Date.parse(s.contract.minTermEnd)) * s.product.monthlyPrice : 0,
        },
    RESCHEDULE: s.status !== 'PENDING_INSTALL'
      ? { eligible: false, reason: 'There is no engineer appointment booked for this service.' }
      : { eligible: true, slots: slots(s) },
  };
}

const tokens = new Set();
const fail = (code, message) => Object.assign(new Error(message), { rpcCode: code });
const svc = (id) => account.services.find((s) => s.serviceId === id) ?? (() => { throw fail(-32004, `Unknown service ${id}`); })();
const require_ = (cond, msg) => { if (!cond) throw fail(-32010, msg); };

const methods = {
  'account.get': () => account,
  'service.get': ({ serviceId }) => svc(serviceId),
  'service.eligibility': ({ serviceId }) => eligibility(svc(serviceId)),
  'service.pause': ({ serviceId, months }) => {
    const s = svc(serviceId);
    const e = eligibility(s).PAUSE;
    require_(e.eligible && months >= 1 && months <= e.maxMonths, 'Pause not permitted');
    s.status = 'PAUSED';
    s.pause = { until: iso(Date.now() + months * 30.44 * DAY), feePerMonth: e.feePerMonth };
    return s;
  },
  'service.changePlan': ({ serviceId, planCode }) => {
    const s = svc(serviceId);
    const e = eligibility(s).CHANGE_PLAN;
    require_(e.eligible && e.options.some((p) => p.code === planCode), 'Plan change not permitted');
    s.product = PLANS[planCode];
    s.contract = { startDate: iso(Date.now()), minTermEnd: iso(Date.now() + e.newMinTermMonths * 30.44 * DAY) };
    return s;
  },
  'service.cancel': ({ serviceId, acknowledgedFee }) => {
    const s = svc(serviceId);
    const e = eligibility(s).CANCEL;
    require_(e.eligible, 'Cancellation not permitted');
    require_(acknowledgedFee === e.earlyTerminationFee, 'The early termination fee must be acknowledged');
    s.status = 'CANCELLED';
    s.endsOn = iso(Date.now() + e.noticeDays * DAY);
    s.appointment = null;
    return s;
  },
  'appointment.reschedule': ({ serviceId, slotId }) => {
    const s = svc(serviceId);
    const slot = eligibility(s).RESCHEDULE.slots?.find((x) => x.slotId === slotId);
    require_(slot, 'That appointment slot is not available');
    s.appointment = slot;
    return s;
  },
};

const app = express();
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

// Stand-in for SSO: the portal gets a bearer token for the signed-in customer.
app.post('/auth/session', (_req, res) => {
  const token = `nv_${randomBytes(12).toString('hex')}`;
  tokens.add(token);
  res.json({ token, expiresIn: 3600 });
});

app.post('/rpc', async (req, res) => {
  await latency();
  const { id = null, method, params = {} } = req.body ?? {};
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  if (!tokens.has(token)) return res.status(401).json({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorised' } });
  try {
    if (!methods[method]) throw fail(-32601, `Method not found: ${method}`);
    res.json({ jsonrpc: '2.0', id, result: methods[method](params) });
  } catch (err) {
    res.json({ jsonrpc: '2.0', id, error: { code: err.rpcCode ?? -32000, message: err.message } });
  }
});

app.listen(PORT, () => console.log(`[norvik] broadband account portal on http://localhost:${PORT}`));
