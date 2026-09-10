// ---------------------------------------------------------------------------
// Reasoning (ORACLE v5) — "why is it happening?"
//
// Breaks a product's demand down by the dimensions in the raw transaction
// data (sales channel, customer region, brand) to answer:
//   - what drives this product's demand, and what's growing
//   - why a flagged anomaly month happened (which slice moved, or one big order)
//   - what the forecast means in plain terms (level / trend / season)
//
// Pure functions, no DOM, no dependencies.
// ---------------------------------------------------------------------------

import { parseDate, toNumber as toNum } from './utils.js';

// --- shared small helpers ------------------------------------------

// Parse to LOCAL midnight. Handles the CSV's "YYYY-MM-DD" strings and the
// Excel serial numbers XLSX produces when it parses the same file.
function parseLocalDate(value) {
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  return parseDate(value);
}
function periodKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function olsSlope(y) {
  const n = y.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2, ym = mean(y);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xm) * (y[i] - ym); den += (i - xm) ** 2; }
  return den ? num / den : 0;
}
function round(n, dp = 0) {
  if (!isFinite(n)) return n;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

const DIMENSIONS = [
  { key: 'channel', label: 'sales channel' },
  { key: 'region', label: 'customer region' },
  { key: 'brand', label: 'brand' }
];

// --- factor index ------------------------------------------------

/**
 * Map<productName, { txns: [{period, qty, channel, region, brand}] }>
 */
export function buildFactorIndex(rawRows) {
  const products = new Map();
  for (const row of rawRows) {
    const product = String(row['Product Name'] ?? '').trim();
    const date = parseLocalDate(row['Date']);
    const qty = toNum(row['Quantity Sold (liters/kg)']);
    if (!product || !date || qty == null || qty < 0) continue;
    if (!products.has(product)) products.set(product, { txns: [] });
    products.get(product).txns.push({
      period: periodKey(date),
      qty,
      channel: String(row['Sales Channel'] ?? '').trim() || 'unknown',
      region: String(row['Customer Location'] ?? '').trim() || 'unknown',
      brand: String(row['Brand'] ?? '').trim() || 'unknown'
    });
  }
  return products;
}

// category -> demand series aligned to `periods`
function seriesByCategory(txns, dimKey, periods) {
  const idx = new Map(periods.map((p, i) => [p, i]));
  const cats = new Map();
  for (const t of txns) {
    const i = idx.get(t.period);
    if (i === undefined) continue;
    const c = t[dimKey];
    if (!cats.has(c)) cats.set(c, new Array(periods.length).fill(0));
    cats.get(c)[i] += t.qty;
  }
  return [...cats.entries()].map(([category, series]) => ({
    category, series, total: series.reduce((s, x) => s + x, 0)
  }));
}

// --- driver summary ---------------------------------------------

/**
 * For one product: the dominant category and the fastest mover on each
 * dimension.
 */
export function topDrivers(rec, periods) {
  if (!rec) return null;
  const out = {};
  for (const dim of DIMENSIONS) {
    const cats = seriesByCategory(rec.txns, dim.key, periods);
    const grand = cats.reduce((s, c) => s + c.total, 0) || 1;
    for (const c of cats) {
      c.share = c.total / grand;
      const m = mean(c.series) || 1;
      c.growthPctYr = round((olsSlope(c.series) * 12) / m * 100, 0);
    }
    cats.sort((a, b) => b.share - a.share);
    const movers = cats.filter(c => c.share >= 0.12)
      .sort((a, b) => Math.abs(b.growthPctYr) - Math.abs(a.growthPctYr));
    out[dim.key] = {
      label: dim.label,
      top: cats.slice(0, 3).map(c => ({ category: c.category, share: round(c.share * 100, 0) })),
      dominant: cats[0] ? { category: cats[0].category, share: round(cats[0].share * 100, 0) } : null,
      second: cats[1] ? { category: cats[1].category, share: round(cats[1].share * 100, 0) } : null,
      concentrated: cats[0] ? cats[0].share >= 0.4 : false,
      mover: movers[0] && Math.abs(movers[0].growthPctYr) >= 12
        ? { category: movers[0].category, growthPctYr: movers[0].growthPctYr }
        : null
    };
  }
  return out;
}

// --- anomaly cause --------------------------------------------

/**
 * Why did `period` deviate? Looks for (a) one dominant transaction, then
 * (b) the dimension category whose demand moved most that month.
 * @param deviation  actual − expected for that month (sign = spike/drop)
 */
export function explainAnomaly(rec, period, periods, deviation) {
  if (!rec) return null;
  const monthTxns = rec.txns.filter(t => t.period === period);
  if (!monthTxns.length) return null;
  const monthTotal = monthTxns.reduce((s, t) => s + t.qty, 0);
  const spike = deviation >= 0;

  // (a) concentrated in a single order?
  const biggest = monthTxns.slice().sort((a, b) => b.qty - a.qty)[0];
  if (spike && biggest && biggest.qty / (monthTotal || 1) >= 0.4 && monthTxns.length <= 5) {
    return {
      kind: 'single-order',
      text: 'one large order — ' + Math.round(biggest.qty).toLocaleString() + ' units, ' +
        biggest.channel + ' / ' + biggest.region
    };
  }

  // (b) which category moved most, vs its typical month
  const thisIdx = periods.indexOf(period);
  let best = null;
  for (const dim of DIMENSIONS) {
    const cats = seriesByCategory(rec.txns, dim.key, periods);
    const grandTotal = cats.reduce((s, c) => s + c.total, 0) || 1;
    const monthTotalDim = cats.reduce((s, c) => s + c.series[thisIdx], 0) || 1;
    for (const c of cats) {
      const here = c.series[thisIdx];
      const typical = median(c.series.filter((_, i) => i !== thisIdx));
      const excess = here - typical;
      if ((spike && excess <= 0) || (!spike && excess >= 0)) continue;
      const contribution = Math.abs(excess) / (Math.abs(deviation) || 1);
      if (!best || Math.abs(excess) > Math.abs(best.excess)) {
        best = {
          dim: dim.label,
          category: c.category,
          excess,
          contribution,
          shareThen: round(here / monthTotalDim * 100, 0),
          shareUsual: round(c.total / grandTotal * 100, 0)
        };
      }
    }
  }

  if (best && best.contribution >= 0.4) {
    return {
      kind: 'category',
      text: best.category + ' (' + best.dim + ') ' + (spike ? 'jumped to' : 'dropped to') +
        ' ~' + best.shareThen + '% of that month’s sales, vs ~' + best.shareUsual + '% usually'
    };
  }
  return { kind: 'broad', text: 'spread across channels and regions — no single source' };
}

// --- forecast in plain terms ---------------------------------

/**
 * @param summary       a buildDemandSeries() product.summary
 * @param forecastPeriods  ["2023-01", ...] the months being forecast
 */
export function explainForecast(summary, forecastPeriods, levelOverride) {
  const level = Math.round(
    levelOverride != null && isFinite(levelOverride) ? levelOverride : (summary.recentMeanDemand || summary.mean)
  );
  const tr = summary.trendPctPerYear;

  let trendTxt;
  if (tr == null || !isFinite(tr) || Math.abs(tr) < 3) trendTxt = 'no real trend up or down';
  else if (tr > 0) trendTxt = 'drifting up about ' + Math.round(tr) + '%/yr';
  else trendTxt = 'sliding about ' + Math.round(Math.abs(tr)) + '%/yr';

  let seasonTxt = '';
  if (summary.seasonalIndices && forecastPeriods && forecastPeriods.length) {
    const idxs = forecastPeriods.map(p => summary.seasonalIndices[Number(p.slice(5, 7)) - 1] ?? 1);
    const avg = mean(idxs);
    if (avg >= 1.08) seasonTxt = ', and the months ahead are usually a busier stretch';
    else if (avg <= 0.92) seasonTxt = ', and the months ahead are usually a quieter stretch';
    else seasonTxt = ', and the months ahead are average for the year';
  }

  return 'Around ' + level.toLocaleString() + '/mo — ' + trendTxt + seasonTxt + '.';
}
