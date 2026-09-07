// Local dev server: static files + the /api/ask proxy for the v7 agent.
// Reads GEMINI_API_KEY from the repo-root .env so the agent works locally
// the same way it will on Vercel (which uses api/ask.mjs instead).
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import { handleAskRequest } from '../js/gemini-proxy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// --- minimal .env loader (no dependency) ---
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const port = process.env.PORT || 4173;
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.csv': 'text/csv', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml'
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 200_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);

  if (path === '/api/ask') {
    const fwd = req.headers['x-forwarded-for'];
    const ip = (typeof fwd === 'string' && fwd.split(',')[0].trim()) ||
      req.socket.remoteAddress || 'unknown';
    const { status, json } = await handleAskRequest({
      method: req.method,
      ip,
      origin: req.headers.origin,
      host: req.headers.host,
      bodyText: await readBody(req),
      env: process.env
    });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
    return;
  }

  try {
    const rel = path === '/' ? '/index.html' : path;
    const file = join(root, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404); res.end('Not found');
  }
}).listen(port, () => {
  console.log('serving on http://localhost:' + port +
    (process.env.GEMINI_API_KEY ? '  (agent: GEMINI_API_KEY loaded)' : '  (agent: add GEMINI_API_KEY to .env)'));
});
