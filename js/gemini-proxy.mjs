// ---------------------------------------------------------------------------
// Server-side Gemini proxy for the Ask ORACLE agent (v7).
//
// The browser POSTs { contents, model } to /api/ask. This module — running on
// the server (locally via .claude/serve.mjs, in production via api/ask.mjs) —
// adds GEMINI_API_KEY from the environment and forwards to Gemini. The key
// never reaches the browser.
//
// Abuse protection so it can't be used as a free general-purpose Gemini proxy:
//   1. Origin gate      — the request's Origin must match the site or an
//                         allow-listed domain (blocks casual cross-site use).
//   2. Payload sanitise — contents are forced into the exact shape an ORACLE
//                         conversation has (user/model turns; text or ORACLE
//                         tool calls only; no images/files/code; size caps).
//   3. Model allow-list — only a small set of models, server-chosen.
//   4. Rate limit       — best-effort in-memory per-IP + global cap.
//   5. System prompt    — ORACLE refuses anything off-topic (see agent-tools).
//
// The rate limiter is in-memory: it resets on a serverless cold start and is
// not shared across instances. For a hard guarantee, put a KV store
// (Upstash / Vercel KV) in front. For a demo, layers 1–3 + 5 are the real
// protection and this is a useful extra.
//
// Calls Gemini through Google's official @google/genai SDK.
// ---------------------------------------------------------------------------
import { GoogleGenAI } from '@google/genai';
import { SYSTEM_PROMPT, TOOL_DEFS, TOOL_NAMES, DEFAULT_ALLOWED_MODELS } from './agent-tools.js';

// --- limits ---
const MAX_TURNS = 24;
const MAX_PARTS_PER_TURN = 12;
const MAX_TEXT_PART = 8000;
const MAX_TOTAL_TEXT = 60000;

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_IP = 12;
const RATE_MAX_GLOBAL = 40;

// --- rate limiter (best-effort, in-memory) ---
const ipHits = new Map();
let globalHits = [];

function rateOk(ip) {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  globalHits = globalHits.filter(t => t > cutoff);
  if (globalHits.length >= RATE_MAX_GLOBAL) return false;
  const arr = (ipHits.get(ip) || []).filter(t => t > cutoff);
  if (arr.length >= RATE_MAX_PER_IP) { ipHits.set(ip, arr); return false; }
  arr.push(now);
  ipHits.set(ip, arr);
  globalHits.push(now);
  if (ipHits.size > 500) {
    for (const [k, v] of ipHits) if (!v.some(t => t > cutoff)) ipHits.delete(k);
  }
  return true;
}

// --- origin gate ---
export function originAllowed(origin, host, allowedEnv) {
  if (!origin) return false;                       // real browsers send Origin on POST
  let oHost;
  try { oHost = new URL(origin).host; } catch (e) { return false; }
  if (host && oHost === host) return true;
  const list = String(allowedEnv || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .concat(['localhost:4173', '127.0.0.1:4173']);
  return list.includes(origin) || list.includes(oHost);
}

// --- payload sanitiser: return a clean contents[] or null ---
function sanitizeContents(contents) {
  if (!Array.isArray(contents) || contents.length < 1 || contents.length > MAX_TURNS) return null;

  let totalText = 0;
  const out = [];
  for (const c of contents) {
    if (!c || (c.role !== 'user' && c.role !== 'model')) return null;
    if (!Array.isArray(c.parts) || !c.parts.length || c.parts.length > MAX_PARTS_PER_TURN) return null;

    const parts = [];
    for (const p of c.parts) {
      if (p && typeof p.text === 'string') {
        if (p.text.length > MAX_TEXT_PART) return null;
        totalText += p.text.length;
        parts.push({ text: p.text });
      } else if (p && p.functionCall && typeof p.functionCall.name === 'string') {
        if (!TOOL_NAMES.includes(p.functionCall.name)) return null;
        parts.push({ functionCall: { name: p.functionCall.name, args: p.functionCall.args || {} } });
      } else if (p && p.functionResponse && typeof p.functionResponse.name === 'string') {
        if (!TOOL_NAMES.includes(p.functionResponse.name)) return null;
        parts.push({ functionResponse: { name: p.functionResponse.name, response: p.functionResponse.response || {} } });
      } else {
        return null;  // reject inlineData / fileData / executableCode / anything else
      }
    }
    out.push({ role: c.role, parts });
  }

  if (totalText > MAX_TOTAL_TEXT) return null;
  if (out[0].role !== 'user') return null;          // a conversation always starts with the user
  return out;
}

// --- the Gemini call (official @google/genai SDK) ---
async function callGemini(apiKey, model, contents) {
  const ai = new GoogleGenAI({ apiKey });

  let response;
  try {
    response = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.4,
        maxOutputTokens: 8192,
        tools: [{ functionDeclarations: TOOL_DEFS }]
      }
    });
  } catch (e) {
    const status = Number(e && e.status) || 0;
    const detail = (e && e.message) || '';
    const msg = {
      400: 'Gemini rejected the request' + (detail ? ': ' + detail : '.'),
      401: 'The server’s GEMINI_API_KEY was rejected — it is not a valid Gemini API key.',
      403: 'The server’s Gemini key was rejected or lacks access to this model.',
      404: 'Model "' + model + '" was not found.',
      429: 'Gemini rate limit reached — wait a moment and retry.',
      500: 'Gemini had a server error — retry shortly.',
      503: 'Gemini is overloaded right now — retry in a bit.'
    }[status] || ('Gemini API error' + (status ? ' ' + status : '') + (detail ? ': ' + detail : ''));
    return { status: status === 429 ? 429 : 502, json: { error: msg } };
  }

  return {
    status: 200,
    json: {
      candidates: response.candidates || [],
      usageMetadata: response.usageMetadata || null
    }
  };
}

/**
 * Single entry point for both server flavours.
 * @param {object} p
 * @param {string} p.method
 * @param {string} p.ip
 * @param {string} p.origin
 * @param {string} p.host
 * @param {string} p.bodyText   raw request body
 * @param {object} p.env        process.env (or a subset)
 * @returns {{ status:number, json:object }}
 */
export async function handleAskRequest({ method, ip, origin, host, bodyText, env }) {
  if (method !== 'POST') return { status: 405, json: { error: 'POST only' } };
  if (!originAllowed(origin, host, env.ALLOWED_ORIGIN)) {
    return { status: 403, json: { error: 'Origin not allowed.' } };
  }
  if (!rateOk(ip || 'unknown')) {
    return { status: 429, json: { error: 'Too many requests — give it a minute.' } };
  }

  let body;
  try { body = JSON.parse(bodyText); } catch (e) { body = null; }
  if (!body || typeof body !== 'object') return { status: 400, json: { error: 'Invalid JSON body.' } };

  const contents = sanitizeContents(body.contents);
  if (!contents) return { status: 400, json: { error: 'Request does not look like an ORACLE conversation.' } };

  const allowed = String(env.ALLOWED_MODELS || DEFAULT_ALLOWED_MODELS.join(','))
    .split(',').map(s => s.trim()).filter(Boolean);
  const model = allowed.includes(body.model) ? body.model : (allowed[0] || DEFAULT_ALLOWED_MODELS[0]);

  if (!env.GEMINI_API_KEY) {
    return { status: 500, json: { error: 'The server has no GEMINI_API_KEY set.' } };
  }

  return callGemini(env.GEMINI_API_KEY, model, contents);
}
