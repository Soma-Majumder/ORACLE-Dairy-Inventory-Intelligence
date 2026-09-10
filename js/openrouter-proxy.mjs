// ---------------------------------------------------------------------------
// Server-side OpenRouter proxy for the Ask ORACLE feature (v7).
//
// The browser computes a full analysis bundle from the v2–v6 engines, then
// POSTs { question, analysis } to /api/ask. This module — running on the
// server (locally via .claude/serve.mjs, in production via api/ask.mjs) —
// adds OPENROUTER_API_KEY from the environment and makes ONE chat-completions
// call. The key never reaches the browser.
//
// The LLM only interprets the pre-computed analysis into plain English; it
// never calculates. See SYSTEM_PROMPT in agent-tools.js.
//
// Abuse protection (so it can't be a free general-purpose LLM proxy):
//   1. Origin gate      — request Origin must match the site or an allow-listed
//                         domain.
//   2. Payload shape    — must be { question, analysis } where analysis is an
//                         object containing ORACLE's `overview` output; size
//                         capped; nothing else is forwarded.
//   3. Fixed model      — server picks the model (OPENROUTER_MODEL env or the
//                         free router); the client cannot choose.
//   4. Rate limit       — best-effort in-memory per-IP + global cap.
//   5. System prompt    — ORACLE refuses anything off-topic.
//
// The rate limiter is in-memory: it resets on a serverless cold start and is
// not shared across instances. For a hard guarantee put a KV store in front.
// ---------------------------------------------------------------------------
import { SYSTEM_PROMPT, DEFAULT_MODEL } from './agent-tools.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// --- limits ---
const MAX_QUESTION = 2000;
const MAX_ANALYSIS_BYTES = 60_000;

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

// --- payload shape: return { question, analysisJson } or null ---
function sanitizeAskPayload(body) {
  if (!body || typeof body !== 'object') return null;

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question || question.length > MAX_QUESTION) return null;

  const analysis = body.analysis;
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return null;
  // must actually be ORACLE's engine output
  if (!analysis.overview || typeof analysis.overview !== 'object') return null;

  let analysisJson;
  try { analysisJson = JSON.stringify(analysis); } catch (e) { return null; }
  if (analysisJson.length > MAX_ANALYSIS_BYTES) return null;

  return { question, analysisJson };
}

function buildUserMessage(question, analysisJson) {
  return 'QUESTION:\n' + question +
    '\n\nANALYSIS — already computed by ORACLE\'s engines. Use ONLY the numbers and ' +
    'facts that appear here:\n' + analysisJson;
}

function stripReasoning(s) {
  return String(s || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

async function callOpenRouter(apiKey, model, question, analysisJson, referer) {
  let res, text;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'X-Title': 'ORACLE Dairy Dashboard',
        ...(referer ? { 'HTTP-Referer': referer } : {})
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(question, analysisJson) }
        ],
        temperature: 0.3,
        max_tokens: 1600,
        reasoning: { exclude: true }   // keep chain-of-thought out of the response
      })
    });
    text = await res.text();
  } catch (e) {
    return { status: 502, json: { error: 'Could not reach OpenRouter.' } };
  }

  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* leave null */ }

  if (!res.ok) {
    const detail = (data && data.error && data.error.message) || '';
    const msg = {
      401: 'The server’s OPENROUTER_API_KEY was rejected.',
      402: 'The OpenRouter account has no credit for this model.',
      403: 'OpenRouter refused this request' + (detail ? ': ' + detail : '.'),
      408: 'The model timed out — try a shorter question.',
      429: 'OpenRouter rate limit reached — wait a minute and retry.',
      500: 'The model had a server error — retry shortly.',
      502: 'The upstream model is unavailable — retry shortly.',
      503: 'OpenRouter is overloaded right now — retry in a bit.'
    }[res.status] || ('OpenRouter error ' + res.status + (detail ? ': ' + detail : ''));
    return { status: res.status === 429 ? 429 : 502, json: { error: msg } };
  }

  const choice = data && data.choices && data.choices[0];
  const answer = stripReasoning(choice && choice.message && choice.message.content);
  if (!answer) {
    return { status: 502, json: { error: 'The free model returned an empty answer — try again or rephrase.' } };
  }

  return {
    status: 200,
    json: {
      answer,
      model: (data && data.model) || model,
      usage: data && data.usage
        ? { input: data.usage.prompt_tokens || 0, output: data.usage.completion_tokens || 0 }
        : null
    }
  };
}

/**
 * Single entry point for both server flavours.
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
  const payload = sanitizeAskPayload(body);
  if (!payload) {
    return { status: 400, json: { error: 'Request does not look like an ORACLE analysis request.' } };
  }

  if (!env.OPENROUTER_API_KEY) {
    return { status: 500, json: { error: 'The server has no OPENROUTER_API_KEY set.' } };
  }

  const model = env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const referer = origin || (host ? 'https://' + host : undefined);
  return callOpenRouter(env.OPENROUTER_API_KEY, model, payload.question, payload.analysisJson, referer);
}
