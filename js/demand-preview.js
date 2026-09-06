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

// --- "How this forecast works" — plain-English explanation ------------

function trendWord(pct) {
  if (pct == null || !isFinite(pct)) return 'flat';
  if (pct > 2) return 'upward';
  if (pct < -2) return 'downward';
  return 'flat';
}

// First sentence: which method won and why it fits this product.
function methodSentence(f, s) {
  switch (f.model) {
    case 'ses':
      return 'Follows the recent sales level; the history shows no reliable trend or seasonal cycle to lean on.';
    case 'naive':
      return 'Carries the last month forward — there isn’t enough history yet for anything more.';
    case 'seasonal-naive':
      return 'Repeats what happened in the same month last year — that yearly pattern is the strongest signal in the history.';
    case 'holt': {
      const w = trendWord(s.trendPctPerYear);
      return 'Projects the recent ' + (w === 'flat' ? '' : w + ' ') + 'trend in sales forward.';
    }
    case 'holt-winters':
      return 'Combines the direction demand has been heading with its month-to-month seasonal pattern.';
    case 'croston':
      return 'This product sells in occasional bursts with quiet gaps; the forecast estimates a low steady rate for the spells between orders.';
    default:
      return 'Forecast method: ' + (f.modelLabel || f.model) + '.';
  }
}

// Second sentence: how it did in walk-forward back-testing.
function trackRecordSentence(f) {
  const acc = f.accuracy;
  if (!acc) return 'There isn’t enough history to back-test this one yet, so treat it as a rough guide.';

  const cov = Math.round(acc.coverage * 100);
  const target = Math.round(acc.level * 100);
  const base = f.baseline;

  let lead;
  if (base && base.mase > 0) {
    const impr = Math.round((1 - acc.mase / base.mase) * 100);
    if (impr >= 3) {
      lead = 'In back-testing it was about ' + impr + '% more accurate than a simple “same month last year” guess';
    } else if (impr > -3) {
      lead = 'In back-testing it came out about level with a simple “same month last year” guess — the history is too noisy to do much better, so lean on the range rather than the single number';
    } else {
      lead = 'In back-testing a simple “same month last year” guess edged it out — lean on the range rather than the single number';
    }
  } else {
    lead = acc.mase < 1
      ? 'In back-testing its typical miss was smaller than a plain “same as last month” guess’s'
      : 'In back-testing it roughly matched a plain “same as last month” guess';
  }

  let cover;
  if (cov <= target - 6) {
    cover = ', though real demand only landed inside its predicted range ' + cov + '% of the time (target ' +
      target + '%) — so treat that range as a floor, not a ceiling.';
  } else if (cov >= target + 8) {
    cover = ', and its predicted range ran a little wide — real demand fell inside it ' + cov +
      '% of the time against an ' + target + '% target.';
  } else {
    cover = ', and real demand landed inside its predicted range about ' + cov + '% of the time (target ' +
      target + '%).';
  }
  return lead + cover;
}

function explainCell(f, s) {
  if (!f) return { html: '<span class="muted">No forecast &mdash; not enough history.</span>', tooltip: '' };
  const acc = f.accuracy;
  const tooltip = acc
    ? [f.modelLabel,
       'MASE ' + acc.mase.toFixed(2) + (f.baseline ? ' vs ' + f.baseline.mase.toFixed(2) + ' (same-month-last-year)' : ''),
       'range coverage ' + Math.round(acc.coverage * 100) + '% at ' + Math.round(acc.level * 100) + '% target',
       acc.nOrigins + ' walk-forward tests · ' + acc.horizon + '-month horizon'].join(' · ')
    : (f.modelLabel || f.model);
  return {
    html: '<div class="explain-method">' + escapeHtml(methodSentence(f, s)) + '</div>' +
          '<div class="explain-track">' + escapeHtml(trackRecordSentence(f)) + '</div>',
    tooltip
  };
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
    '<th>How this forecast works</th>' +
    '</tr></thead><tbody>';

  for (const { p, f } of forecasts) {
    const s = p.summary;
    const ht = f ? f.horizonTotal : null;
    const totalCell = ht
      ? '<strong>' + num(ht.mean) + '</strong><div class="sub">range ' + num(ht.lower) + ' – ' + num(ht.upper) +
        '</div><div class="sub muted">history avg ' + num(s.mean * FORECAST_HORIZON) + '</div>'
      : '&mdash;';
    const chartCell = f ? chart(f.history.demand, f) : '';
    const ex = explainCell(f, s);

    html += '<tr>' +
      '<td class="name">' + escapeHtml(p.product) + '</td>' +
      '<td class="spark-cell">' + chartCell + '</td>' +
      '<td class="num">' + totalCell + '</td>' +
      '<td class="explain-cell"' + (ex.tooltip ? ' title="' + escapeHtml(ex.tooltip) + '"' : '') + '>' +
        ex.html + '</td>' +
      '</tr>';
  }
  html += '</tbody></table>' +
    '<p class="chart-legend"><span class="k hist"></span> history &nbsp; ' +
    '<span class="k fc"></span> forecast &nbsp; <span class="k band"></span> ' +
    Math.round(FORECAST_LEVEL * 100) + '% interval</p>';
  body.innerHTML = html;
}
