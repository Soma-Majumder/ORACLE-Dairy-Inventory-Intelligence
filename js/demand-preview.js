// Preview panel for the v2 demand layer: history data-prep + forecast.
// Renders what buildDemandSeries() + forecastProduct() produced so the
// pipeline is visible. Reads the bundled dataset only.
import { escapeHtml } from './utils.js';
import { forecastProduct } from './forecast.js';

const FORECAST_HORIZON = 6;
const FORECAST_LEVEL = 0.8;

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

// --- hover tooltip ---------------------------------------------------
// A single body-level element, so it isn't clipped by the scrolling card
// the way a CSS ::after or a slow native title tooltip would be.

let tipEl = null;
function initTooltip() {
  if (tipEl) return;
  tipEl = document.createElement('div');
  tipEl.className = 'oracle-tip';
  document.body.appendChild(tipEl);

  const place = (anchor) => {
    tipEl.textContent = anchor.getAttribute('data-tip');
    tipEl.classList.add('show');
    const r = anchor.getBoundingClientRect();
    const tw = tipEl.offsetWidth;
    const th = tipEl.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - 8 - tw);
    let top = r.bottom + 8;
    if (top + th > window.innerHeight - 8) top = r.top - 8 - th;
    tipEl.style.left = Math.max(8, left) + 'px';
    tipEl.style.top = Math.max(8, top) + 'px';
  };

  document.addEventListener('mouseover', (e) => {
    const a = e.target.closest('[data-tip]');
    if (a) place(a);
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-tip]')) tipEl.classList.remove('show');
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-tip]');
    if (a) place(a); else tipEl.classList.remove('show');
  });
}

function tipAttr(text) {
  return text ? ' data-tip="' + escapeHtml(text) + '" tabindex="0"' : '';
}

// --- "How it's predicted" — short plain-English method label ----------

const PREDICT_PHRASE = {
  'ses': 'Follows the recent average',
  'naive': 'Repeats last month',
  'seasonal-naive': "Repeats last year's month",
  'holt': 'Follows the trend',
  'holt-winters': 'Trend + seasonal pattern',
  'croston': 'Handles on-and-off demand'
};

function predictPhrase(f) {
  return PREDICT_PHRASE[f.model] || (f.modelLabel || f.model);
}

// --- "Track record" — a rating word from the walk-forward backtest ----
// Rated mainly on absolute accuracy (MASE: <1 beats a no-thought guess),
// then adjusted for how well the prediction range held up (coverage vs
// the 80% target). Raw numbers stay in the cell tooltip.

function ratingFor(f) {
  const acc = f.accuracy;
  if (!acc) return { word: 'Untested', cls: 'muted', note: 'not enough history to back-test' };

  const mase = acc.mase;
  const covOff = acc.coverage - acc.level;   // + = range too wide, - = range too tight
  const beatsBase = f.baseline ? mase < f.baseline.mase : mase < 1;

  let word, cls;
  if (covOff < -0.12) { word = 'Fair'; cls = 'warning'; }        // range badly overconfident
  else if (mase <= 0.70 && covOff <= 0.16) { word = 'Strong'; cls = 'good'; }
  else if (mase <= 0.90) { word = 'Good'; cls = 'sage'; }
  else if (mase <= 1.05 || beatsBase) { word = 'Fair'; cls = 'warning'; }
  else { word = 'Weak'; cls = 'serious'; }

  let note;
  if (word === 'Weak') note = 'worse than a no-thought guess here';
  else if (!beatsBase) note = 'history too noisy to beat a rough guess';
  else if (covOff <= -0.05) note = 'beats a rough guess; treat range as a floor';
  else if (covOff >= 0.10) note = 'beats a rough guess; range is cautious';
  else note = 'beats a rough guess; range holds up';

  return { word, cls, note };
}

function trackRecordCell(f) {
  const r = ratingFor(f);
  const acc = f.accuracy;
  const tooltip = acc
    ? [f.modelLabel,
       'MASE ' + acc.mase.toFixed(2) + (f.baseline ? ' vs ' + f.baseline.mase.toFixed(2) + ' (same-month-last-year)' : ''),
       'range coverage ' + Math.round(acc.coverage * 100) + '% at ' + Math.round(acc.level * 100) + '% target',
       acc.nOrigins + ' walk-forward tests, ' + acc.horizon + '-month horizon'].join(' · ')
    : (f.modelLabel || f.model);
  return '<span class="rating-wrap"' + tipAttr(tooltip) + '>' +
    '<span class="rating rating-' + r.cls + '">' + r.word + '</span>' +
    '<img class="tip-dot" src="assets/cow-16.png" alt="" aria-hidden="true" />' +
    '</span>' +
    '<div class="sub">' + r.note + '</div>';
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
  initTooltip();

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
    '<th>How it&rsquo;s predicted</th>' +
    '<th>Track record</th>' +
    '</tr></thead><tbody>';

  for (const { p, f } of forecasts) {
    const s = p.summary;
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
      '<td class="predict-cell">' + (f
        ? '<span class="rating-wrap"' + tipAttr('Statistical model: ' + f.modelLabel) + '>' +
          escapeHtml(predictPhrase(f)) + '</span>'
        : '&mdash;') + '</td>' +
      '<td>' + (f ? trackRecordCell(f) : '&mdash;') + '</td>' +
      '</tr>';
  }
  html += '</tbody></table>' +
    '<p class="chart-legend"><span class="k hist"></span> history &nbsp; ' +
    '<span class="k fc"></span> forecast &nbsp; <span class="k band"></span> ' +
    Math.round(FORECAST_LEVEL * 100) + '% interval</p>';
  body.innerHTML = html;
}
