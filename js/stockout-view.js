// Predictive stockout panel (ORACLE v3). Joins current stock (summed across
// brands) with the v2 forecast, runs the Monte-Carlo simulation per product,
// and renders probability + timing + risk.
import { escapeHtml } from './utils.js';
import { forecastProduct } from './forecast.js';
import { assessStockout } from './stockout.js';

const DEFAULT_HORIZON = 30;
const PATHS = 3000;

const RISK_BADGE = { critical: 'critical', high: 'serious', medium: 'warning', low: 'good' };
const RISK_LABEL = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };

function pct(x) { return (x * 100).toFixed(x >= 0.995 ? 0 : x < 0.1 ? 1 : 0) + '%'; }
function num(n) { return Math.round(n).toLocaleString(); }

function probBar(p, risk) {
  const w = Math.max(2, Math.round(p * 100));
  return '<div class="pbar"><span class="pbar-fill risk-' + risk + '" style="width:' + w + '%"></span></div>';
}

function timingCell(sim, horizonDays) {
  const d = sim.daysUntilStockout;
  if (sim.pStockout < 0.5 || d.p50 == null) {
    return '<span class="muted">likely beyond ' + horizonDays + ' days</span>';
  }
  const lo = d.p10 == null ? null : d.p10;
  const hi = d.p90 == null ? horizonDays + '+' : d.p90;
  const range = lo != null ? '<div class="sub">likely day ' + lo + ' – ' + hi + '</div>' : '';
  return '<strong>~ day ' + d.p50 + '</strong>' + range;
}

export function renderStockoutView(demand, stockByProduct, horizonDays) {
  const section = document.getElementById('sectionStockoutProb');
  const body = document.getElementById('stockoutProbBody');
  const subtitle = document.getElementById('stockoutProbSubtitle');
  if (!section || !body) return;

  const H = Number(horizonDays) || DEFAULT_HORIZON;

  if (!demand || !demand.products.length || !stockByProduct) {
    section.classList.add('hidden');
    body.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');

  const assessed = demand.products.map((p, i) => {
    const stock = stockByProduct[p.product];
    if (stock == null) return null;
    try {
      const fc = forecastProduct(p, { horizon: 6, level: 0.8 });
      return assessStockout(fc, stock, { horizonDays: H, paths: PATHS, seed: 42 + i });
    } catch (e) { return null; }
  }).filter(Boolean);

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  assessed.sort((a, b) => (order[a.riskLevel] - order[b.riskLevel]) || (b.pStockout - a.pStockout));

  const atRisk = assessed.filter(a => a.pStockout >= 0.2).length;
  subtitle.innerHTML =
    'Each product\'s current stock (all brands combined) is run down against ' + num(PATHS) +
    ' simulated futures of daily demand drawn from the v2 forecast and its uncertainty. ' +
    '<strong>' + atRisk + ' of ' + assessed.length + '</strong> products have a 20%+ chance of running out within the horizon.';

  let html = '<table><thead><tr>' +
    '<th>Product</th>' +
    '<th class="num">On hand</th>' +
    '<th class="num">Forecast use / day</th>' +
    '<th class="num">P(stockout &le; ' + H + 'd)</th>' +
    '<th>When it runs out</th>' +
    '<th class="num">Expected unmet demand</th>' +
    '<th>Risk</th>' +
    '</tr></thead><tbody>';

  for (const a of assessed) {
    const badge = RISK_BADGE[a.riskLevel];
    html += '<tr>' +
      '<td class="name">' + escapeHtml(a.product) + '</td>' +
      '<td class="num">' + num(a.currentStock) +
        '<div class="sub">~' + (a.expectedDaysCover != null ? a.expectedDaysCover + 'd cover' : '—') + '</div></td>' +
      '<td class="num">' + num(a.dailyDemandMean) + '</td>' +
      '<td class="num">' + pct(a.pStockout) + probBar(a.pStockout, a.riskLevel) + '</td>' +
      '<td>' + timingCell(a, H) + '</td>' +
      '<td class="num">' + (a.expectedUnitsShort > 0 ? num(a.expectedUnitsShort) : '<span class="muted">0</span>') + '</td>' +
      '<td><span class="badge ' + badge + '">' + RISK_LABEL[a.riskLevel] + '</span></td>' +
      '</tr>';
  }
  html += '</tbody></table>';
  body.innerHTML = html;
}
