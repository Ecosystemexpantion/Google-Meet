// Local dev server: static files + the classroom Edge Function (in-memory
// registry), talking to the fake Cloudflare SFU in dev/fakesfu.
//
//   (cd dev/fakesfu && go run .)      fake Realtime SFU on :7890
//   npm run dev                       http://localhost:5173 (host password "test")
//
// config.js is patched on the fly to point at /api/classroom and skip Supabase.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler, memoryStore } from '../supabase/functions/classroom/handler.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const env = {
  CF_SFU_APP_ID: 'devapp',
  CF_SFU_APP_TOKEN: 'devtoken',
  CF_SFU_API_BASE: 'http://127.0.0.1:7890/v1',
  HOST_PASSWORD: 'test',
  ...process.env,
};
const handle = createHandler({ env: (k) => env[k], store: memoryStore() });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/classroom')) {
    const body = ['POST', 'PUT'].includes(req.method) ? await new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => r(d)); }) : undefined;
    const out = await handle(new Request(url, { method: req.method, headers: req.headers, body }));
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(await out.text());
    return;
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '') || 'index.html';
  if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
  try {
    let data = await readFile(join(ROOT, rel));
    if (rel === 'config.js') {
      data = `${data}\nObject.assign(window.EEM26_CONFIG, { CLASSROOM_API: location.origin + '/api/classroom', SUPABASE_URL: '' });\n`;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`Dev server on http://localhost:${PORT}  (host password: ${env.HOST_PASSWORD})`));
