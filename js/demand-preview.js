// Preview panel for the v2 demand-history data-prep layer.
// Renders what buildDemandSeries() produced so the pipeline is visible before
// the forecasting engine is wired up. Reads the bundled dataset only.
import { escapeHtml } from './utils.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CLASS_LABEL = {
  smooth: 'Smooth &mdash; steady, easy to forecast',
  intermittent: 'Intermittent &mdash; frequent zero-demand months',
  erratic: 'Erratic &mdash; volatile order sizes',
  lumpy: 'Lumpy &mdash; sporadic and volatile',
  'no-demand': 'No demand recorded'
};

function sparkline(values, width = 120, height = 28) {
  if (!values.length) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const stepX = width / Math.max(values.length - 1, 1);
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / span) * (height - 2) - 1;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  return '<svg class="spark" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height +
    '" preserveAspectRatio="none" aria-hidden="true">' +
    '<polyline fill="none" stroke="currentColor" stroke-width="1.5" points="' + points + '" /></svg>';
}

function trendCell(pct) {
  if (pct === null || !isFinite(pct)) return '&mdash;';
  const arrow = pct > 2 ? '▲' : pct < -2 ? '▼' : '▬';
  const sign = pct > 0 ? '+' : '';
  return arrow + ' ' + sign + pct.toFixed(1) + '%/yr';
}

function seasonalCell(strength, peakMonth) {
  if (strength === null) return '&mdash;';
  const pct = Math.round(strength * 100);
  const peak = peakMonth !== null ? ' &middot; peaks ' + MONTHS[peakMonth] : '';
  return pct + '%' + peak;
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
  subtitle.innerHTML =
    'Monthly demand per product, rebuilt from ' + demand.products.reduce((s, p) => s + p.summary.nNonZero, 0) +
    '+ sales records &middot; ' + fmtDate(demand.start) + ' &ndash; ' + fmtDate(demand.end) +
    ' &middot; ' + demand.periods.length + ' months' +
    (demand.skipped ? ' &middot; ' + demand.skipped + ' rows skipped (missing date/qty)' : '') +
    '. This is the input the forecasting engine will use.';

  let html = '<table><thead><tr>' +
    '<th>Product</th>' +
    '<th class="num">Total demand</th>' +
    '<th class="num">Avg / month</th>' +
    '<th class="num">Trend</th>' +
    '<th class="num">Seasonality</th>' +
    '<th>Demand pattern</th>' +
    '<th>History</th>' +
    '</tr></thead><tbody>';

  for (const p of demand.products) {
    const s = p.summary;
    html += '<tr>' +
      '<td class="name">' + escapeHtml(p.product) + '</td>' +
      '<td class="num">' + Math.round(s.totalDemand).toLocaleString() + '</td>' +
      '<td class="num">' + Math.round(s.mean).toLocaleString() + '</td>' +
      '<td class="num">' + trendCell(s.trendPctPerYear) + '</td>' +
      '<td class="num">' + seasonalCell(s.seasonalityStrength, s.peakMonth) + '</td>' +
      '<td>' + (CLASS_LABEL[s.demandClass] || escapeHtml(s.demandClass)) + '</td>' +
      '<td class="spark-cell">' + sparkline(p.demand) + '</td>' +
      '</tr>';
  }
  html += '</tbody></table>';
  body.innerHTML = html;
}
