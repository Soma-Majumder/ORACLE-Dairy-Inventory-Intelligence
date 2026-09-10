// "Ask ORACLE" panel (v7). The browser computes the analysis, then POSTs it
// to /api/ask; the server holds the OpenRouter key. No key setup in the UI.
import { escapeHtml } from './utils.js';
import { ask, investigate } from './agent.js';

const EXAMPLES = [
  'Which products are most at risk of running out?',
  'What’s the demand forecast for Milk, and what should I watch?',
  'Were there any unusual months for Cheese, and why?',
  'What happens to Buttermilk if demand rises 25%?'
];

let ctx = null;
let wired = false;
let busy = false;

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

function renderSetup() {
  const el = document.getElementById('agentKeySetup');
  if (!el) return;
  el.innerHTML =
    '<div class="agent-key-saved">' +
    '<span class="ok">&#10003;</span> Runs on a free AI model via the site’s server — no setup needed. ' +
    'ORACLE calculates every figure first; the AI only explains it.' +
    '</div>';
}

function renderExamples() {
  const el = document.getElementById('agentExamples');
  if (!el) return;
  el.innerHTML = EXAMPLES.map(q =>
    '<button type="button" class="agent-chip" data-q="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>').join('');
}

function renderInvestigate() {
  const sel = document.getElementById('agentInvProduct');
  if (!sel || !ctx) return;
  sel.innerHTML = ctx.demand.products
    .map(p => '<option>' + escapeHtml(p.product) + '</option>').join('');
}

function setAnswer(html) {
  const el = document.getElementById('agentAnswer');
  if (el) el.innerHTML = html;
}

const BTN_IDS = ['agentAskBtn', 'agentInvBtn', 'agentTriageBtn'];
function setBusy(on) {
  busy = on;
  BTN_IDS.forEach(id => { const b = document.getElementById(id); if (b) b.disabled = on; });
}

// Shared runner. `run` is (onStep) => Promise<{answer, sections, usage, model}>.
async function execute(run) {
  if (busy) return;
  if (!ctx || !ctx.demand) { setAnswer('<div class="agent-error">Load the dataset first.</div>'); return; }

  setBusy(true);
  const steps = [];
  const paint = () => setAnswer(
    '<div class="agent-running"><span class="agent-spin"></span> ' +
    (steps.length ? escapeHtml(steps[steps.length - 1]) + '…' : 'working…') + '</div>' +
    (steps.length > 1 ? '<div class="agent-steps">' + steps.slice(0, -1).map(escapeHtml).join(' &middot; ') + '</div>' : ''));
  paint();

  try {
    const res = await run((label) => { steps.push(label); paint(); });
    const analyzed = res.sections && res.sections.length ? 'Analysed: ' + res.sections.join(', ') : '';
    const tok = res.usage
      ? ' &middot; ~' + res.usage.input.toLocaleString() + ' in / ' + res.usage.output.toLocaleString() + ' out tokens'
      : '';
    setAnswer(
      '<div class="agent-answer-body">' + mdLite(res.answer) + '</div>' +
      '<div class="agent-meta">' + escapeHtml(analyzed) + tok +
      (res.model ? ' &middot; ' + escapeHtml(res.model) : '') + '</div>');
  } catch (e) {
    setAnswer('<div class="agent-error">' + escapeHtml(e.message || String(e)) + '</div>');
  } finally {
    setBusy(false);
  }
}

function runAsk(question) {
  if (!question.trim()) return;
  execute((onStep) => ask(question, ctx, onStep));
}
function runInvestigate(target) {
  execute((onStep) => investigate(target, ctx, onStep));
}

function wire() {
  const card = document.getElementById('sectionAgent');
  if (!card) return;

  card.addEventListener('click', (e) => {
    const t = e.target;
    if (t.id === 'agentAskBtn') { runAsk(document.getElementById('agentInput').value); return; }
    if (t.id === 'agentInvBtn') { runInvestigate({ product: document.getElementById('agentInvProduct').value }); return; }
    if (t.id === 'agentTriageBtn') { runInvestigate({ topRisks: 3 }); return; }
    if (t.classList.contains('agent-chip')) {
      document.getElementById('agentInput').value = t.dataset.q;
      runAsk(t.dataset.q);
    }
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

  subtitle.innerHTML = 'Ask a plain-English question, or hit <strong>Investigate</strong> for a full briefing on one ' +
    'product or the top risks. ORACLE runs its engines first; the language model only explains the results — ' +
    'what’s happening, why it matters, what to watch. It never invents figures.';

  renderSetup();
  renderExamples();
  renderInvestigate();
  if (!wired) { wire(); wired = true; }
}
