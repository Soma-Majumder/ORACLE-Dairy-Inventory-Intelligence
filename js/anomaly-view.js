// Anomaly Detection panel (ORACLE v4). Runs detectAnomalies() over each
// product's demand history and shows the flagged months, any level shift,
// and whether the latest month is unusual. Bundled dataset only.
import { escapeHtml } from './utils.js';
import { detectProductAnomalies } from './anomaly.js';

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtPeriod(p) {
  const parts = String(p).split('-');
  return MONTH[Number(parts[1]) - 1] + ' ' + parts[0];
}
function num(n) { return Math.round(n).toLocaleString(); }

// History line + expected ±2σ band + markers for anomalies and a level shift.
function chart(series, expected, scale, points, shiftIndex, width = 220, height = 46) {
  const n = series.length;
  const hi = expected.map(e => e + 2 * scale);
  const lo = expected.map(e => e - 2 * scale);
  const all = series.concat(hi, lo);
  const max = Math.max(...all, 1);
  const min = Math.min(...all, 0);
  const span = max - min || 1;
  const x = (i) => (i / Math.max(n - 1, 1)) * width;
  const y = (v) => height - ((v - min) / span) * (height - 4) - 2;

  const bandTop = hi.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1));
  const bandBot = lo.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).reverse();
  const band = bandTop.join(' ') + ' ' + bandBot.join(' ');
  const line = series.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
  const dots = points.map(p =>
    '<circle cx="' + x(p.index).toFixed(1) + '" cy="' + y(p.actual).toFixed(1) +
    '" r="2.6" class="an-dot an-' + p.direction + '" />').join('');
  const shift = shiftIndex >= 0
    ? '<line x1="' + x(shiftIndex).toFixed(1) + '" y1="1" x2="' + x(shiftIndex).toFixed(1) +
      '" y2="' + (height - 1) + '" class="an-shift" />'
    : '';

  return '<svg class="spark anomaly-spark" width="' + width + '" height="' + height + '" viewBox="0 0 ' +
    width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' +
    '<polygon class="an-band" points="' + band + '" />' + shift +
    '<polyline class="an-line" points="' + line + '" />' + dots + '</svg>';
}

function unusualCell(a) {
  if (!a.points.length) return '<span class="an-none">None flagged</span>';
  const list = a.points.map(p =>
    fmtPeriod(p.period) + ' <span class="muted">(' + (p.direction === 'spike' ? '▲' : '▼') + ' ' +
    num(p.actual) + ' vs ~' + num(p.expected) + ')</span>').join('<br>');
  const highs = a.points.filter(p => p.severity === 'high').length;
  return '<strong>' + a.points.length + ' month' + (a.points.length === 1 ? '' : 's') + '</strong>' +
    (highs ? ' <span class="muted">· ' + highs + ' strong</span>' : '') +
    '<div class="sub">' + list + '</div>';
}

function shiftCell(a) {
  const s = a.levelShift;
  if (!s) return '<span class="an-none">Steady</span>';
  const arrow = s.direction === 'up' ? 'Stepped up' : 'Stepped down';
  return '<strong>' + arrow + '</strong><div class="sub">~' + Math.abs(s.pctChange) + '% around ' +
    fmtPeriod(s.period) + ' &middot; ' + num(s.beforeMean) + ' → ' + num(s.afterMean) + '/mo</div>';
}

function latestCell(a) {
  const l = a.latest;
  if (!l) return '&mdash;';
  if (!l.isAnomaly) {
    return '<span class="badge good">NORMAL</span><div class="sub">' + fmtPeriod(l.period) + ' ' + num(l.actual) +
      ', near expected</div>';
  }
  const strong = Math.abs(l.z) >= 3;
  const label = (l.direction === 'spike' ? 'SPIKE' : 'DROP');
  return '<span class="badge ' + (strong ? 'critical' : 'warning') + '">&#9888; ' + label + '</span>' +
    '<div class="sub">' + fmtPeriod(l.period) + ': ' + num(l.actual) + ' vs ~' + num(l.expected) +
    ' expected (z ' + l.z.toFixed(1) + ')</div>';
}

export function renderAnomalyView(demand) {
  const section = document.getElementById('sectionAnomaly');
  const body = document.getElementById('anomalyBody');
  const subtitle = document.getElementById('anomalySubtitle');
  if (!section || !body) return;

  if (!demand || !demand.products.length) {
    section.classList.add('hidden');
    body.innerHTML = '';
    return;
  }

  const assessed = demand.products
    .map(p => detectProductAnomalies(p))
    .filter(a => a.enoughData);

  if (!assessed.length) {
    section.classList.add('hidden');
    body.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');

  const recent = assessed.filter(a => a.latest && a.latest.isAnomaly).length;
  const withPoints = assessed.filter(a => a.points.length).length;
  const shifts = assessed.filter(a => a.levelShift).length;

  subtitle.innerHTML =
    'Each product\'s demand history checked against what its own recent trend and seasonal pattern predicted. ' +
    '<strong>' + withPoints + '</strong> of ' + assessed.length + ' products have unusual months' +
    (shifts ? ', <strong>' + shifts + '</strong> ' + (shifts === 1 ? 'shows' : 'show') + ' a lasting shift in baseline' : '') +
    ', and ' + (recent ? '<strong>' + recent + '</strong> had an unusual most-recent month'
      : 'the most recent month looks normal everywhere') + '.';

  // Most actionable first: recent anomaly, then a level shift, then most flagged.
  const score = (a) => (a.latest && a.latest.isAnomaly ? 100 : 0) + (a.levelShift ? 20 : 0) + a.points.length;
  assessed.sort((x, y) => score(y) - score(x));

  let html = '<table><thead><tr>' +
    '<th>Product</th>' +
    '<th>History &amp; expected range</th>' +
    '<th>Unusual months</th>' +
    '<th>Baseline change</th>' +
    '<th>Latest month</th>' +
    '</tr></thead><tbody>';

  for (const a of assessed) {
    const p = demand.products.find(pr => pr.product === a.product);
    html += '<tr>' +
      '<td class="name">' + escapeHtml(a.product) + '</td>' +
      '<td class="spark-cell">' + chart(p.demand, a.expected, a.scale, a.points,
        a.levelShift ? a.levelShift.index : -1) + '</td>' +
      '<td>' + unusualCell(a) + '</td>' +
      '<td>' + shiftCell(a) + '</td>' +
      '<td>' + latestCell(a) + '</td>' +
      '</tr>';
  }
  html += '</tbody></table>' +
    '<p class="chart-legend"><span class="k an-l"></span> demand &nbsp; ' +
    '<span class="k band"></span> expected range &nbsp; ' +
    '<span class="k dot-sp"></span> spike / drop &nbsp; ' +
    '<span class="k shift"></span> baseline change</p>';
  body.innerHTML = html;
}
