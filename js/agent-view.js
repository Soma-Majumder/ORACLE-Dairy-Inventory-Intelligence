// "Ask ORACLE" panel (v7). Bring-your-own-key: the API key lives only in
// this browser's localStorage; questions + the figures the tools return go
// directly to the Anthropic API, not to any server we run.
import { escapeHtml } from './utils.js';
import { ask, MODELS, DEFAULT_MODEL } from './agent.js';

const KEY_STORE = 'oracle_agent_key';
const MODEL_STORE = 'oracle_agent_model';

const EXAMPLES = [
  'Which products are most at risk of running out?',
  'What’s the demand forecast for Milk?',
  'Were there any unusual months for Cheese, and why?',
  'What should I order for Buttermilk if demand rises 25%?'
];

let ctx = null;
let wired = false;
let busy = false;

function getKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
function setKey(v) { try { v ? localStorage.setItem(KEY_STORE, v) : localStorage.removeItem(KEY_STORE); } catch (e) { /* ignore */ } }
function getModel() { try { return localStorage.getItem(MODEL_STORE) || DEFAULT_MODEL; } catch (e) { return DEFAULT_MODEL; } }
function setModel(v) { try { localStorage.setItem(MODEL_STORE, v); } catch (e) { /* ignore */ } }

// --- tiny Markdown renderer (bold, code, headings, lists, paragraphs) ---
function mdLite(src) {
  const lines = String(src).split('\n');
  const inline = (s) => escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  let html = '';
  let list = null;
  const closeList = () => { if (list) { html += '</' + list + '>'; list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { closeList(); continue; }
    if ((m = line.match(/^#{1,4}\s+(.*)/))) { closeList(); html += '<p class="md-h">' + inline(m[1]) + '</p>'; continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += '<li>' + inline(m[1]) + '</li>'; continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += '<li>' + inline(m[1]) + '</li>'; continue;
    }
    closeList();
    html += '<p>' + inline(line) + '</p>';
  }
  closeList();
  return html;
}

const TOOL_LABEL = {
  get_overview: 'scanning all products',
  get_forecast: 'checking the forecast',
  get_stockout_risk: 'running the stockout simulation',
  get_anomalies: 'looking for unusual months',
  explain_drivers: 'breaking down the drivers',
  run_what_if: 'running the what-if scenario'
};

function renderKeySetup() {
  const el = document.getElementById('agentKeySetup');
  if (!el) return;
  const key = getKey();
  const model = getModel();
  const modelOpts = MODELS.map(m =>
    '<option value="' + m.id + '"' + (m.id === model ? ' selected' : '') + '>' + escapeHtml(m.label) + '</option>').join('');

  if (key) {
    el.innerHTML =
      '<div class="agent-key-saved">' +
      '<span class="ok">&#10003;</span> API key saved in this browser ' +
      '<button type="button" class="btn text" id="agentKeyChange">change</button>' +
      '<span class="agent-model-pick">Model <select id="agentModel">' + modelOpts + '</select></span>' +
      '</div>';
  } else {
    el.innerHTML =
      '<div class="agent-key-form">' +
      '<p class="agent-key-note">Ask ORACLE uses the Anthropic API. Paste your own API key ' +
      '(<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>) — ' +
      'it is stored only in this browser. Your question and the figures the tools return are sent to Anthropic.</p>' +
      '<div class="agent-key-row">' +
      '<input type="password" id="agentKeyInput" placeholder="sk-ant-..." autocomplete="off" />' +
      '<select id="agentModel">' + modelOpts + '</select>' +
      '<button type="button" class="btn primary" id="agentKeySave">Save</button>' +
      '</div></div>';
  }
}

function renderExamples() {
  const el = document.getElementById('agentExamples');
  if (!el) return;
  el.innerHTML = EXAMPLES.map(q =>
    '<button type="button" class="agent-chip" data-q="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>').join('');
}

function setAnswer(html) {
  const el = document.getElementById('agentAnswer');
  if (el) el.innerHTML = html;
}

async function runAsk(question) {
  if (busy) return;
  const key = getKey();
  if (!key) { renderKeySetup(); setAnswer('<div class="agent-error">Add your Anthropic API key first.</div>'); return; }
  if (!question.trim()) return;
  if (!ctx || !ctx.demand) { setAnswer('<div class="agent-error">Load the dataset first.</div>'); return; }

  busy = true;
  document.getElementById('agentAskBtn').disabled = true;
  const steps = [];
  const paint = () => setAnswer(
    '<div class="agent-running"><span class="agent-spin"></span> ' +
    (steps.length ? escapeHtml(steps[steps.length - 1]) + '…' : 'thinking…') + '</div>' +
    (steps.length > 1 ? '<div class="agent-steps">' + steps.slice(0, -1).map(escapeHtml).join(' &middot; ') + '</div>' : ''));
  paint();

  try {
    const res = await ask(question, ctx, { apiKey: key, model: getModel() }, (evt) => {
      if (evt.type === 'tool') { steps.push(TOOL_LABEL[evt.name] || evt.name); paint(); }
    });
    const toolLine = res.toolsUsed.length
      ? 'Ran: ' + [...new Set(res.toolsUsed)].join(', ')
      : 'Answered directly';
    const tok = res.usage ? ' &middot; ~' + res.usage.input.toLocaleString() + ' in / ' +
      res.usage.output.toLocaleString() + ' out tokens' : '';
    setAnswer(
      '<div class="agent-answer-body">' + mdLite(res.answer) + '</div>' +
      '<div class="agent-meta">' + escapeHtml(toolLine) + tok +
      (res.model ? ' &middot; ' + escapeHtml(res.model) : '') + '</div>');
  } catch (e) {
    setAnswer('<div class="agent-error">' + escapeHtml(e.message || String(e)) + '</div>');
  } finally {
    busy = false;
    const b = document.getElementById('agentAskBtn');
    if (b) b.disabled = false;
  }
}

function wire() {
  const card = document.getElementById('sectionAgent');
  if (!card) return;

  card.addEventListener('click', (e) => {
    const t = e.target;
    if (t.id === 'agentKeySave') {
      const v = document.getElementById('agentKeyInput').value.trim();
      const m = document.getElementById('agentModel');
      if (m) setModel(m.value);
      if (v) { setKey(v); renderKeySetup(); }
      return;
    }
    if (t.id === 'agentKeyChange') { setKey(''); renderKeySetup(); return; }
    if (t.id === 'agentAskBtn') { runAsk(document.getElementById('agentInput').value); return; }
    if (t.classList.contains('agent-chip')) {
      document.getElementById('agentInput').value = t.dataset.q;
      runAsk(t.dataset.q);
    }
  });
  card.addEventListener('change', (e) => {
    if (e.target.id === 'agentModel') setModel(e.target.value);
  });
  card.addEventListener('keydown', (e) => {
    if (e.target.id === 'agentInput' && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      runAsk(document.getElementById('agentInput').value);
    }
  });
}

export function renderAgentView(context) {
  const section = document.getElementById('sectionAgent');
  const subtitle = document.getElementById('agentSubtitle');
  if (!section) return;

  if (!context || !context.demand || !context.demand.products.length) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  ctx = context;

  subtitle.innerHTML = 'Ask a plain-English question. ORACLE picks which of its engines to run ' +
    '(forecast, stockout, anomalies, drivers, what-if) and answers with their numbers — it never makes figures up.';

  renderKeySetup();
  renderExamples();
  if (!wired) { wire(); wired = true; }
}
