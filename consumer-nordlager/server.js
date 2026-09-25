// NORDLAGER PIM has no backend API at all: it's a local-first app whose SKU
// master lives in the browser (IndexedDB). This server only hosts static files.

import express from 'express';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.NORDLAGER_PORT ?? 3002);
const app = express();
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));
app.listen(PORT, () => console.log(`[nordlager] PIM on http://localhost:${PORT}`));
