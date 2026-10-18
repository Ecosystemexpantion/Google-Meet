// Local dev server: static files + the same token API the Edge Function serves.
//
//   ./livekit-server --dev            (LiveKit, ws://localhost:7880, devkey/secret)
//   HOST_PASSWORD=test npm run dev    (this server, http://localhost:5173)
//
// config.js is patched on the fly to point at /api/livekit and to skip Supabase.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../supabase/functions/livekit/handler.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const env = {
  LIVEKIT_URL: 'ws://localhost:7880',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'secret',
  HOST_PASSWORD: 'test',
  HOST_NAME: 'Coach Victor',
  ...process.env,
};
const handle = createHandler((k) => env[k]);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/livekit') {
    const body = req.method === 'POST' ? await new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => r(d)); }) : undefined;
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
      data = `${data}\nObject.assign(window.EEM26_CONFIG, { LIVEKIT_TOKEN_ENDPOINT: '/api/livekit', SUPABASE_URL: '' });\n`;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`Dev server on http://localhost:${PORT}  (host password: ${env.HOST_PASSWORD})`));
