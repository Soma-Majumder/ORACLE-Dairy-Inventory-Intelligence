// Reasoning panel (ORACLE v5). For each product: what drives its demand,
// why the v4-flagged months happened, and the forecast in plain terms.
// Bundled dataset only.
import { escapeHtml } from './utils.js';
import { detectProductAnomalies } from './anomaly.js';
import { forecastProduct } from './forecast.js';
import { topDrivers, explainAnomaly, explainForecast } from './reasoning.js';

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtPeriod = (p) => MONTH[Number(String(p).split('-')[1]) - 1] + ' ' + String(p).split('-')[0];

function driversCell(drivers) {
  if (!drivers) return '&mdash;';
  const ch = drivers.channel;
  const rg = drivers.region;
  const br = drivers.brand;

  const channelTxt = ch.concentrated
    ? 'Mostly <strong>' + escapeHtml(ch.dominant.category) + '</strong> (' + ch.dominant.share + '%)'
    : 'Fairly even across ' + ch.top.map(c => escapeHtml(c.category)).join(', ');

  const movers = [ch.mover, rg.mover, br.mover].filter(Boolean).map(m =>
    escapeHtml(m.category) + ' ' + (m.growthPctYr > 0 ? '+' : '') + m.growthPctYr + '%/yr');

  const items = [];
  if (br.dominant) {
    items.push('<span class="dl-label">Top brand:</span> ' +
      escapeHtml(br.dominant.category) + ' (' + br.dominant.share + '%)');
  }
  if (rg.dominant) {
    items.push('<span class="dl-label">Biggest region:</span> ' +
      escapeHtml(rg.dominant.category) + ' (' + rg.dominant.share + '%)');
  }
  if (movers.length) {
    items.push('<span class="dl-label">Trending:</span> ' + movers.join(', '));
  }

  return '<div>' + channelTxt + '</div>' +
    (items.length
      ? '<ul class="drivers-list">' + items.map(i => '<li>' + i + '</li>').join('') + '</ul>'
      : '');
}

function whyCell(anomaly, rec, periods) {
  if (!anomaly.points.length) return '<span class="an-none">No unusual months</span>';
  const lines = anomaly.points.map(p => {
    const dev = p.actual - p.expected;
    const ex = explainAnomaly(rec, p.period, periods, dev);
    const arrow = p.direction === 'spike' ? '▲' : '▼';
    const cls = p.direction === 'spike' ? 'an-up' : 'an-down';
    return '<span class="' + cls + '">' + arrow + '</span> ' + fmtPeriod(p.period) +
      ' <span class="muted">— ' + (ex ? escapeHtml(ex.text) : 'cause unclear') + '</span>';
  });
  return '<div class="sub reason-list">' + lines.join('<br>') + '</div>';
}

export function renderReasoningView(demand, factorIndex) {
  const section = document.getElementById('sectionReasoning');
  const body = document.getElementById('reasoningBody');
  const subtitle = document.getElementById('reasoningSubtitle');
  if (!section || !body) return;

  if (!demand || !demand.products.length || !factorIndex) {
    section.classList.add('hidden');
    body.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');

  const rows = demand.products.map(p => {
    const rec = factorIndex.get(p.product) || null;
    const anomaly = detectProductAnomalies(p);
    let fPeriods = [];
    try { fPeriods = forecastProduct(p, { horizon: 6 }).periods; } catch (e) { /* ignore */ }
    return {
      p,
      rec,
      anomaly,
      drivers: topDrivers(rec, demand.periods),
      forecastText: explainForecast(p.summary, fPeriods)
    };
  });

  const withAnoms = rows.filter(r => r.anomaly.points.length).length;
  subtitle.innerHTML =
    'Breaking each product\'s sales down by channel, region and brand to explain what\'s behind the numbers. ' +
    'Causes are suggested for the <strong>' + withAnoms + '</strong> products with unusual months.';

  rows.sort((a, b) => b.anomaly.points.length - a.anomaly.points.length);

  let html = '<table><thead><tr>' +
    '<th>Product</th>' +
    '<th>What drives demand</th>' +
    '<th>Why the unusual months</th>' +
    '<th>Forecast, explained</th>' +
    '</tr></thead><tbody>';

  for (const r of rows) {
    html += '<tr>' +
      '<td class="name">' + escapeHtml(r.p.product) + '</td>' +
      '<td>' + driversCell(r.drivers) + '</td>' +
      '<td>' + whyCell(r.anomaly, r.rec, demand.periods) + '</td>' +
      '<td>' + escapeHtml(r.forecastText) + '</td>' +
      '</tr>';
  }
  html += '</tbody></table>' +
    '<p class="chart-legend reason-note">Driver splits and suggested causes are read straight from the ' +
    'transaction rows &mdash; on a synthetic dataset they can be noisy.</p>';
  body.innerHTML = html;
}
