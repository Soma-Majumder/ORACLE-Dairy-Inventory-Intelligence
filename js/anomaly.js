// ---------------------------------------------------------------------------
// Anomaly detection (ORACLE v4).
//
// Looks back over a product's monthly demand history and flags:
//   - point anomalies — a month far from what the recent past + seasonal
//     pattern predicted (robust z-score, so the spikes don't hide themselves)
//   - a level shift — demand stepped to a new baseline and stayed there
//   - whether the most recent month is itself unusual (the actionable bit)
//
// Deliberately independent of forecast.js: an outlier in the history should
// stand out here, not get quietly absorbed into a fitted model.
//
// Pure functions, no DOM, no dependencies.
// ---------------------------------------------------------------------------

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }

function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

// Median absolute deviation, scaled to be a consistent estimator of sigma.
function robustSigma(a) {
  const md = median(a);
  const mad = median(a.map(x => Math.abs(x - md)));
  return 1.4826 * mad;
}

function monthIdx(period) {
  const m = Number(String(period).slice(5, 7));
  return m >= 1 && m <= 12 ? m - 1 : 0;
}

// Additive month-of-year effect: how far each calendar month's typical demand
// sits from the series median.
function seasonalFactors(series, periods) {
  const byMonth = Array.from({ length: 12 }, () => []);
  periods.forEach((p, i) => { byMonth[monthIdx(p)].push(series[i]); });
  const overall = median(series);
  return byMonth.map(v => (v.length ? median(v) - overall : 0));
}

// One-step-ahead robust level: median of the previous `w` points only
// (never includes the current point, so it can't mask its own anomaly).
function trailingMedian(a, w) {
  return a.map((_, i) => {
    const win = a.slice(Math.max(0, i - w), i);
    return win.length ? median(win) : a[i];
  });
}

function round(n, dp = 0) {
  if (!isFinite(n)) return n;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * @param {number[]} series   monthly demand, oldest first
 * @param {string[]} periods  matching "YYYY-MM" labels
 * @param {object} [opts]     { zHigh=3, zMod=2.5, window=7, shiftWindow=6, shiftStat=4 }
 * @returns {{
 *   enoughData: boolean,
 *   scale: number,
 *   expected: number[],
 *   points: Array<{index,period,actual,expected,residual,z,direction,severity}>,
 *   levelShift: null | {index,period,beforeMean,afterMean,pctChange,direction,stat},
 *   latest: null | {index,period,actual,expected,z,direction,isAnomaly}
 * }}
 */
export function detectAnomalies(series, periods, opts = {}) {
  const n = series.length;
  const zHigh = opts.zHigh ?? 3.0;
  const zMod = opts.zMod ?? 2.5;
  const w = opts.window ?? 7;

  if (n < 12) {
    return { enoughData: false, scale: 0, expected: [], points: [], levelShift: null, latest: null };
  }

  const seas = seasonalFactors(series, periods);
  const deseason = series.map((v, i) => v - seas[monthIdx(periods[i])]);
  const trend = trailingMedian(deseason, w);
  const expected = trend.map((t, i) => t + seas[monthIdx(periods[i])]);
  const resid = series.map((v, i) => v - expected[i]);

  // Scale from the interior residuals (skip the warm-up where the trailing
  // window is short and residuals are artificially near zero).
  const warm = Math.min(w, n - 4);
  let scale = robustSigma(resid.slice(warm)) || std(resid.slice(warm)) || 1;

  const points = [];
  for (let i = warm; i < n; i++) {
    const z = resid[i] / scale;
    if (Math.abs(z) >= zMod) {
      points.push({
        index: i,
        period: periods[i],
        actual: round(series[i]),
        expected: round(expected[i]),
        residual: round(resid[i]),
        z: round(z, 2),
        direction: z > 0 ? 'spike' : 'drop',
        severity: Math.abs(z) >= zHigh ? 'high' : 'moderate'
      });
    }
  }

  // Level shift: biggest step between two adjacent windows of the
  // deseasonalized series.
  let levelShift = null;
  const lw = opts.shiftWindow ?? 6;
  if (n >= 2 * lw) {
    let best = { stat: 0, index: -1, diff: 0, before: 0, after: 0 };
    for (let i = lw; i <= n - lw; i++) {
      const before = mean(deseason.slice(i - lw, i));
      const after = mean(deseason.slice(i, i + lw));
      const diff = after - before;
      const stat = Math.abs(diff) / (scale * Math.sqrt(2 / lw));
      if (stat > best.stat) best = { stat, index: i, diff, before, after };
    }
    if (best.stat >= (opts.shiftStat ?? 4) && best.index >= 0) {
      levelShift = {
        index: best.index,
        period: periods[best.index],
        beforeMean: round(best.before),
        afterMean: round(best.after),
        pctChange: round((best.after - best.before) / (Math.abs(best.before) || 1) * 100, 1),
        direction: best.diff > 0 ? 'up' : 'down',
        stat: round(best.stat, 1)
      };
    }
  }

  const lastZ = resid[n - 1] / scale;
  const latest = {
    index: n - 1,
    period: periods[n - 1],
    actual: round(series[n - 1]),
    expected: round(expected[n - 1]),
    z: round(lastZ, 2),
    direction: lastZ > 0 ? 'spike' : 'drop',
    isAnomaly: Math.abs(lastZ) >= zMod
  };

  return {
    enoughData: true,
    scale: round(scale),
    expected: expected.map(v => round(v)),
    points,
    levelShift,
    latest
  };
}

/**
 * Convenience: run detection for a buildDemandSeries() product.
 */
export function detectProductAnomalies(product, opts = {}) {
  const res = detectAnomalies(product.demand, product.periods, opts);
  return { product: product.product, ...res };
}
