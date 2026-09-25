// NORDLAGER's SKU master: IndexedDB, in the browser. Records are keyed by SKU,
// carry bilingual texts, a spec sheet, ETIM class, a release status and a
// revision counter. Every write appends to an audit log.

const DB = 'nordlager-pim';
const SEED = [
  {
    sku: 'NL-933-M8X40-A2', designation: 'Hex bolt M8×40 DIN 933 A2-70', etim: 'EC000293', status: 'DRAFT', rev: 3,
    specs: { standard: 'DIN 933 / ISO 4017', thread: 'M8', length_mm: 40, material: 'Stainless steel A2-70', drive: 'Hex 13 mm', thread_pitch_mm: 1.25 },
    texts: { de: 'Sechskantschraube mit Gewinde bis Kopf, Edelstahl A2-70.', en: '' }, keywords: [],
  },
  {
    sku: 'NL-6204-2RS', designation: 'Deep groove ball bearing 6204-2RS', etim: 'EC000392', status: 'DRAFT', rev: 1,
    specs: { bore_mm: 20, outer_diameter_mm: 47, width_mm: 14, seal: '2RS rubber, both sides', dynamic_load_kN: 13.5, limiting_speed_rpm: 13000, material: 'Chrome steel 100Cr6' },
    texts: { de: 'Rillenkugellager, beidseitig gedichtet.', en: '' }, keywords: [],
  },
  {
    sku: 'NL-125-M10-ZN', designation: 'Flat washer M10 DIN 125 zinc plated', etim: 'EC000267', status: 'DRAFT', rev: 2,
    specs: { standard: 'DIN 125-A / ISO 7089', inner_diameter_mm: 10.5, outer_diameter_mm: 20, thickness_mm: 2, material: 'Steel 140 HV, zinc plated' },
    texts: { de: 'Unterlegscheibe.', en: 'Washer.' }, keywords: ['washer'],
  },
  {
    sku: 'NL-985-M12-8', designation: 'Prevailing torque nut M12 DIN 985 cl. 8', etim: 'EC000316', status: 'RELEASED', rev: 5,
    specs: { standard: 'DIN 985 / ISO 10511', thread: 'M12', property_class: '8', material: 'Steel, zinc plated, PA insert' },
    texts: { de: 'Sicherungsmutter mit Klemmteil.', en: 'Prevailing torque type hexagon thin nut with polyamide insert, M12, property class 8. Resists loosening under vibration; single use recommended.' },
    keywords: ['nyloc', 'lock-nut', 'm12'],
  },
  {
    sku: 'NL-4762-M6X20-129', designation: 'Socket head cap screw M6×20 ISO 4762 12.9', etim: 'EC000293', status: 'DRAFT', rev: 1,
    specs: { standard: 'ISO 4762 / DIN 912', thread: 'M6', length_mm: 20, property_class: '12.9', material: 'Alloy steel, black oxide', drive: 'Hex socket 5 mm' },
    texts: { de: 'Zylinderschraube mit Innensechskant.', en: '' }, keywords: [],
  },
  {
    sku: 'NL-6885-8X7X40', designation: 'Parallel key 8×7×40 DIN 6885-A', etim: 'EC002237', status: 'DRAFT', rev: 1,
    specs: { standard: 'DIN 6885-A', width_mm: 8, height_mm: 7, length_mm: 40, material: 'C45+C bright steel', ends: 'round (form A)' },
    texts: { de: 'Passfeder, rundstirnig.', en: '' }, keywords: [],
  },
  {
    sku: 'NL-HC-W2-16-27', designation: 'Worm drive hose clamp 16–27 mm W2', etim: 'EC000512', status: 'RELEASED', rev: 4,
    specs: { clamping_range_mm: '16–27', band_width_mm: 9, material: 'W2: stainless band, galvanised screw' },
    texts: { de: 'Schlauchschelle W2.', en: 'Worm drive hose clamp, clamping range 16–27 mm, 9 mm band. W2 material grade: stainless band and housing with galvanised steel screw.' },
    keywords: ['hose-clamp', 'w2'],
  },
];

export const ETIM = {
  EC000293: 'Screw (with head)',
  EC000392: 'Radial deep groove ball bearing',
  EC000267: 'Washer',
  EC000316: 'Nut',
  EC002237: 'Parallel key',
  EC000512: 'Hose clamp',
};

let dbp;
function db() {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('items', { keyPath: 'sku' });
      d.createObjectStore('audit', { keyPath: 'seq', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

const tx = async (stores, mode, fn) => {
  const t = (await db()).transaction(stores, mode);
  const result = await fn(t);
  await new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
  return result;
};
const req = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

export async function seedIfEmpty(force = false) {
  const count = await tx(['items'], 'readonly', (t) => req(t.objectStore('items').count()));
  if (count && !force) return;
  await tx(['items', 'audit'], 'readwrite', (t) => {
    t.objectStore('items').clear();
    t.objectStore('audit').clear();
    SEED.forEach((i) => t.objectStore('items').put(structuredClone(i)));
  });
}

export const allItems = () => tx(['items'], 'readonly', (t) => req(t.objectStore('items').getAll()));
export const getItem = (sku) => tx(['items'], 'readonly', (t) => req(t.objectStore('items').get(sku)));
export const auditLog = () => tx(['audit'], 'readonly', (t) => req(t.objectStore('audit').getAll()));

export async function commit(sku, mutate, actor) {
  return tx(['items', 'audit'], 'readwrite', async (t) => {
    const item = await req(t.objectStore('items').get(sku));
    if (!item) throw new Error(`SKU ${sku} not found in PIM`);
    const changed = mutate(item);
    item.rev += 1;
    t.objectStore('items').put(item);
    t.objectStore('audit').add({ at: new Date().toISOString(), sku, rev: item.rev, actor, changed });
    return item;
  });
}
