// Vercel serverless function: POST /api/ask
//
// Thin wrapper around handleAskRequest — extracts what it needs from the
// Vercel request and delegates. OPENROUTER_API_KEY lives in the Vercel
// project's Environment Variables, never in the client.
import { handleAskRequest } from '../js/openrouter-proxy.mjs';

async function readBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 200_000) break;
  }
  return data;
}

export default async function handler(req, res) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (typeof fwd === 'string' && fwd.split(',')[0].trim()) ||
    req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';

  const { status, json } = await handleAskRequest({
    method: req.method,
    ip,
    origin: req.headers.origin,
    host: req.headers.host,
    bodyText: await readBody(req),
    env: process.env
  });

  res.status(status).json(json);
}
