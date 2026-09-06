// Preview panel for the v2 demand layer: history data-prep + forecast.
// Renders what buildDemandSeries() + forecastProduct() produced so the
// pipeline is visible. Reads the bundled dataset only.
import { escapeHtml } from './utils.js';
import { forecastProduct } from './forecast.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FORECAST_HORIZON = 6;
const FORECAST_LEVEL = 0.8;

const CLASS_LABEL = {
  smooth: 'Smooth',
  intermittent: 'Intermittent',
  erratic: 'Erratic',
  lumpy: 'Lumpy',
  'no-demand': 'No demand'
};

// History (solid) + forecast mean (dashed) + prediction band (shaded).
function chart(history, fc, width = 210, height = 40) {
  const hist = history;
  const all = hist.concat(fc.upper, fc.lower, fc.mean);
  const max = Math.max(...all, 1);
  const min = Math.min(...all, 0);
  const span = max - min || 1;
  const total = hist.length + fc.mean.length - 1;
  const x = (i) => (i / Math.max(total, 1)) * width;
  const y = (v) => height - ((v - min) / span) * (height - 3) - 1.5;

  const histPts = hist.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');

  const fi = (k) => hist.length - 1 + k; // forecast index k (0..h) on shared x-axis
  const bandTop = fc.upper.map((v, k) => x(fi(k + 1)).toFixed(1) + ',' + y(v).toFixed(1));
  const bandBot = fc.lower.map((v, k) => x(fi(k + 1)).toFixed(1) + ',' + y(v).toFixed(1)).reverse();
  const lastHistX = x(hist.length - 1).toFixed(1);
  const lastHistY = y(hist[hist.length - 1]).toFixed(1);
  const band = lastHistX + ',' + lastHistY + ' ' + bandTop.join(' ') + ' ' + bandBot.join(' ');

  const meanPts = [lastHistX + ',' + lastHistY]
    .concat(fc.mean.map((v, k) => x(fi(k + 1)).toFixed(1) + ',' + y(v).toFixed(1)))
    .join(' ');

  return '<svg class="spark" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height +
    '" preserveAspectRatio="none" aria-hidden="true">' +
    '<polygon class="spark-band" points="' + band + '" />' +
    '<line class="spark-div" x1="' + lastHistX + '" y1="1" x2="' + lastHistX + '" y2="' + (height - 1) + '" />' +
    '<polyline class="spark-hist" points="' + histPts + '" />' +
    '<polyline class="spark-fc" points="' + meanPts + '" />' +
    '</svg>';
}

function num(n) { return Math.round(n).toLocaleString(); }

function accuracyCell(acc, baseline) {
  if (!acc) return '&mdash;';
  const beatsNaive = baseline && acc.mase < baseline.mase;
  const vs = baseline
    ? ' <span class="muted">vs ' + baseline.mase.toFixed(2) + ' naive</span>'
    : '';
  const mark = beatsNaive ? '<span class="ok">&#10003;</span> ' : '';
  return mark + 'MASE ' + acc.mase.toFixed(2) + vs +
    '<div class="sub">' + Math.round(acc.coverage * 100) + '% of actuals in band (target ' +
    Math.round(acc.level * 100) + '%)</div>';
}

export function renderDemandPreview(demand) {
  const section = document.getElementById('sectionDemand');
  const body = document.getElementById('demandBody');
  const subtitle = document.getElementById('demandSubtitle');
  if (!section || !body) return;

  if (!demand || !demand.products.length) {
    section.classList.add('hidden');
    body.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');

  const fmtDate = (d) => d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' }) : '?';

  const forecasts = demand.products.map(p => {
    try { return { p, f: forecastProduct(p, { horizon: FORECAST_HORIZON, level: FORECAST_LEVEL }) }; }
    catch (e) { return { p, f: null }; }
  });

  const nextRange = forecasts[0] && forecasts[0].f
    ? forecasts[0].f.periods[0] + ' – ' + forecasts[0].f.periods[forecasts[0].f.periods.length - 1]
    : '';

  subtitle.innerHTML =
    'Monthly demand per product, rebuilt from the bundled sales records &middot; history ' +
    fmtDate(demand.start) + ' &ndash; ' + fmtDate(demand.end) + ' (' + demand.periods.length + ' months)' +
    (demand.skipped ? ' &middot; ' + demand.skipped + ' rows skipped' : '') +
    '. Forecast = next ' + FORECAST_HORIZON + ' months (' + nextRange + '), ' +
    Math.round(FORECAST_LEVEL * 100) + '% prediction interval, model chosen per product by walk-forward backtest.';

  let html = '<table><thead><tr>' +
    '<th>Product</th>' +
    '<th>History &rarr; forecast</th>' +
    '<th class="num">Next ' + FORECAST_HORIZON + ' months</th>' +
    '<th>Model picked</th>' +
    '<th class="num">Backtest accuracy</th>' +
    '</tr></thead><tbody>';

  for (const { p, f } of forecasts) {
    const s = p.summary;
    const model = f
      ? escapeHtml(f.modelLabel) + '<div class="sub">' + (CLASS_LABEL[s.demandClass] || '') + ' demand</div>'
      : '&mdash;';
    const ht = f ? f.horizonTotal : null;
    const totalCell = ht
      ? '<strong>' + num(ht.mean) + '</strong><div class="sub">range ' + num(ht.lower) + ' – ' + num(ht.upper) +
        '</div><div class="sub muted">history avg ' + num(s.mean * FORECAST_HORIZON) + '</div>'
      : '&mdash;';
    const chartCell = f ? chart(f.history.demand, f) : '';

    html += '<tr>' +
      '<td class="name">' + escapeHtml(p.product) + '</td>' +
      '<td class="spark-cell">' + chartCell + '</td>' +
      '<td class="num">' + totalCell + '</td>' +
      '<td>' + model + '</td>' +
      '<td class="num">' + accuracyCell(f && f.accuracy, f && f.baseline) + '</td>' +
      '</tr>';
  }
  html += '</tbody></table>' +
    '<p class="chart-legend"><span class="k hist"></span> history &nbsp; ' +
    '<span class="k fc"></span> forecast &nbsp; <span class="k band"></span> ' +
    Math.round(FORECAST_LEVEL * 100) + '% interval</p>';
  body.innerHTML = html;
}
