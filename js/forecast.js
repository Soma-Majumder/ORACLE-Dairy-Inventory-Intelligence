// ---------------------------------------------------------------------------
// Demand forecasting engine (ORACLE v2).
//
// A small suite of classical time-series models behind one interface, plus
// walk-forward backtesting so we can measure accuracy and pick the best model
// per product instead of guessing.
//
//   forecast(series, horizon, opts)   -> { mean[], lower[], upper[], model, params }
//   backtest(series, opts)            -> accuracy metrics for one model
//   selectModel(series, opts)         -> ranks models, picks a winner
//   forecastProduct(product, opts)    -> everything, for a timeseries.js product
//
// Pure functions, no DOM, no dependencies. Demand is clamped at >= 0.
// ---------------------------------------------------------------------------

// z-multipliers for symmetric prediction intervals.
const Z_BY_LEVEL = { 0.5: 0.674, 0.8: 1.2816, 0.9: 1.645, 0.95: 1.96, 0.99: 2.576 };
const DEFAULT_LEVEL = 0.8;

function zFor(level) {
  return Z_BY_LEVEL[level] || 1.2816;
}

// --- tiny stats ---------------------------------------------------------

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }

function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

function clamp0(x) { return x < 0 ? 0 : x; }

// Residuals between actuals and one-step-ahead fitted values (nulls skipped).
function residualsOf(y, fitted) {
  const r = [];
  for (let t = 0; t < y.length; t++) {
    if (fitted[t] !== null && fitted[t] !== undefined && isFinite(fitted[t])) {
      r.push(y[t] - fitted[t]);
    }
  }
  return r;
}

// --- models ------------------------------------------------------------
// Each returns { fitted:number[](with leading nulls), forecast:number[], name, params }

// Seasonal naive: next period = same period one season ago.
function seasonalNaive(y, h, m) {
  const n = y.length;
  const fitted = new Array(n).fill(null);
  for (let t = m; t < n; t++) fitted[t] = y[t - m];
  const forecast = [];
  for (let k = 1; k <= h; k++) forecast.push(clamp0(y[n - m + ((k - 1) % m)]));
  return { fitted, forecast, name: 'seasonal-naive', params: { m } };
}

// Naive: next period = last observed value.
function naive(y, h) {
  const n = y.length;
  const fitted = new Array(n).fill(null);
  for (let t = 1; t < n; t++) fitted[t] = y[t - 1];
  return { fitted, forecast: new Array(h).fill(clamp0(y[n - 1])), name: 'naive', params: {} };
}

// Simple exponential smoothing (level only). Optimizes alpha if not given.
function ses(y, h, params) {
  const alpha = params && params.alpha != null ? params.alpha : optimize1(y, a => sesRun(y, a).fitted);
  const { fitted, level } = sesRun(y, alpha);
  return { fitted, forecast: new Array(h).fill(clamp0(level)), name: 'ses', params: { alpha: round(alpha, 3) } };
}
function sesRun(y, alpha) {
  const n = y.length;
  const fitted = new Array(n).fill(null);
  let level = y[0];
  for (let t = 1; t < n; t++) {
    fitted[t] = level;
    level = alpha * y[t] + (1 - alpha) * level;
  }
  return { fitted, level };
}

// Holt's linear trend (level + trend, no seasonality).
function holt(y, h, params) {
  const best = params && params.alpha != null
    ? { alpha: params.alpha, beta: params.beta }
    : optimize2(y, (a, b) => holtRun(y, a, b).fitted);
  const { fitted, level, trend } = holtRun(y, best.alpha, best.beta);
  const forecast = [];
  for (let k = 1; k <= h; k++) forecast.push(clamp0(level + k * trend));
  return { fitted, forecast, name: 'holt', params: { alpha: round(best.alpha, 3), beta: round(best.beta, 3) } };
}
function holtRun(y, alpha, beta) {
  const n = y.length;
  const fitted = new Array(n).fill(null);
  let level = y[0];
  let trend = n > 1 ? y[1] - y[0] : 0;
  for (let t = 1; t < n; t++) {
    fitted[t] = level + trend;
    const newLevel = alpha * y[t] + (1 - alpha) * (level + trend);
    trend = beta * (newLevel - level) + (1 - beta) * trend;
    level = newLevel;
  }
  return { fitted, level, trend };
}

// Holt-Winters, additive trend + additive seasonality.
function holtWinters(y, h, m, params) {
  const best = params && params.alpha != null
    ? params
    : optimize3(y, (a, b, g) => hwRun(y, m, a, b, g).fitted);
  const { fitted, level, trend, seas } = hwRun(y, m, best.alpha, best.beta, best.gamma);
  const n = y.length;
  const forecast = [];
  for (let k = 1; k <= h; k++) forecast.push(clamp0(level + k * trend + seas[(n + k - 1) % m]));
  return {
    fitted, forecast, name: 'holt-winters',
    params: { alpha: round(best.alpha, 3), beta: round(best.beta, 3), gamma: round(best.gamma, 3), m }
  };
}
function hwRun(y, m, alpha, beta, gamma) {
  const n = y.length;
  const fitted = new Array(n).fill(null);
  const base = mean(y.slice(0, m));
  const next = mean(y.slice(m, 2 * m));
  let level = base;
  let trend = (next - base) / m;
  const seas = [];
  for (let i = 0; i < m; i++) seas[i] = y[i] - base;
  for (let t = 0; t < n; t++) {
    const slot = t % m;
    const sPrev = seas[slot];
    if (t >= m) fitted[t] = level + trend + sPrev;
    const newLevel = alpha * (y[t] - sPrev) + (1 - alpha) * (level + trend);
    const newTrend = beta * (newLevel - level) + (1 - beta) * trend;
    seas[slot] = gamma * (y[t] - newLevel) + (1 - gamma) * sPrev;
    level = newLevel;
    trend = newTrend;
  }
  return { fitted, level, trend, seas };
}

// Croston's method for intermittent demand: smooth the non-zero sizes and the
// gaps between them separately; the forecast is size / interval.
function croston(y, h, params) {
  const alpha = params && params.alpha != null ? params.alpha : 0.1;
  const n = y.length;
  const fitted = new Array(n).fill(null);
  let sizeEst = null;
  let intervalEst = null;
  let gap = 1;
  let rate = 0;
  for (let t = 0; t < n; t++) {
    if (fitted[t] === null && rate) fitted[t] = rate;
    if (y[t] > 0) {
      if (sizeEst === null) { sizeEst = y[t]; intervalEst = gap; }
      else {
        sizeEst = alpha * y[t] + (1 - alpha) * sizeEst;
        intervalEst = alpha * gap + (1 - alpha) * intervalEst;
      }
      rate = sizeEst / Math.max(intervalEst, 1e-9);
      gap = 1;
    } else {
      gap += 1;
    }
    if (fitted[t] === null) fitted[t] = rate;
  }
  return { fitted, forecast: new Array(h).fill(clamp0(rate)), name: 'croston', params: { alpha } };
}

// --- parameter search (coarse grids; fast and good enough) --------------

const G1 = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 0.9];
const G3 = [0.05, 0.15, 0.3, 0.5];

function sse(y, fitted) {
  let s = 0, c = 0;
  for (let t = 0; t < y.length; t++) {
    if (fitted[t] !== null && isFinite(fitted[t])) { s += (y[t] - fitted[t]) ** 2; c++; }
  }
  return c ? s / c : Infinity;
}

function optimize1(y, fittedFor) {
  let best = G1[0], bestErr = Infinity;
  for (const a of G1) { const e = sse(y, fittedFor(a)); if (e < bestErr) { bestErr = e; best = a; } }
  return best;
}
function optimize2(y, fittedFor) {
  let best = { alpha: G3[0], beta: G3[0] }, bestErr = Infinity;
  for (const a of G3) for (const b of G3) {
    const e = sse(y, fittedFor(a, b));
    if (e < bestErr) { bestErr = e; best = { alpha: a, beta: b }; }
  }
  return best;
}
function optimize3(y, fittedFor) {
  let best = { alpha: G3[0], beta: G3[0], gamma: G3[0] }, bestErr = Infinity;
  for (const a of G3) for (const b of G3) for (const g of G3) {
    const e = sse(y, fittedFor(a, b, g));
    if (e < bestErr) { bestErr = e; best = { alpha: a, beta: b, gamma: g }; }
  }
  return best;
}

// --- interval width growth by horizon ---------------------------------

function sigmaGrowth(sigma, h, model, m, params) {
  const out = [];
  for (let k = 1; k <= h; k++) {
    let f;
    if (model === 'seasonal-naive') f = Math.sqrt(Math.floor((k - 1) / m) + 1);
    else if (model === 'ses') f = Math.sqrt(1 + (k - 1) * (params.alpha ** 2));
    else f = Math.sqrt(k);
    out.push(sigma * f);
  }
  return out;
}

// --- model registry --------------------------------------------------

const MODELS = {
  'naive': (y, h, o) => naive(y, h),
  'seasonal-naive': (y, h, o) => seasonalNaive(y, h, o.m),
  'ses': (y, h, o) => ses(y, h, o.params),
  'holt': (y, h, o) => holt(y, h, o.params),
  'holt-winters': (y, h, o) => holtWinters(y, h, o.m, o.params),
  'croston': (y, h, o) => croston(y, h, o.params)
};

export const MODEL_LABELS = {
  'naive': 'Last value',
  'seasonal-naive': 'Same month last year',
  'ses': 'Exponential smoothing',
  'holt': 'Trend (Holt)',
  'holt-winters': 'Trend + seasonality (Holt-Winters)',
  'croston': "Intermittent demand (Croston)"
};

// --- public: forecast ------------------------------------------------

/**
 * @param {number[]} series      historical demand, oldest first
 * @param {number}   horizon     periods to forecast
 * @param {object}  [opts]
 * @param {string}  [opts.model='holt-winters']
 * @param {number}  [opts.seasonLength=12]
 * @param {number}  [opts.level=0.8]           prediction-interval level
 * @param {object}  [opts.params]              fixed model params (skips search)
 */
export function forecast(series, horizon, opts = {}) {
  const y = series.map(v => (v == null || !isFinite(v) ? 0 : Math.max(0, v)));
  const m = opts.seasonLength || 12;
  const level = opts.level || DEFAULT_LEVEL;
  const modelName = opts.model || 'holt-winters';
  const runner = MODELS[modelName];
  if (!runner) throw new Error('Unknown model: ' + modelName);

  const res = runner(y, horizon, { m, params: opts.params });
  const sigma = std(residualsOf(y, res.fitted)) || 0;
  const z = zFor(level);
  const sig = sigmaGrowth(sigma, horizon, res.name, m, res.params);

  const meanF = res.forecast.map(v => round(clamp0(v), 2));
  const lower = meanF.map((v, i) => round(clamp0(v - z * sig[i]), 2));
  const upper = meanF.map((v, i) => round(v + z * sig[i], 2));

  return { model: res.name, params: res.params, level, mean: meanF, lower, upper, sigma: round(sigma, 2) };
}

// --- public: backtest (walk-forward) --------------------------------

/**
 * Repeatedly fit on a growing prefix and score the next `horizon` actuals.
 * Returns { model, nOrigins, horizon, mase, rmse, mape, coverage, level } or
 * null when the series is too short to test.
 */
export function backtest(series, opts = {}) {
  const y = series.map(v => (v == null || !isFinite(v) ? 0 : Math.max(0, v)));
  const n = y.length;
  const m = opts.seasonLength || 12;
  const model = opts.model || 'holt-winters';
  const horizon = opts.horizon || Math.min(6, Math.max(1, Math.floor(n / 4)));
  const level = opts.level || DEFAULT_LEVEL;
  const minTrain = opts.minTrain || Math.max(model.includes('season') || model === 'holt-winters' ? 2 * m : 6, 6);
  const step = opts.step || 1;

  if (n < minTrain + 1) return null;

  const scale = scaleFactor(y, m); // denominator for MASE
  let absErr = 0, sqErr = 0, pctErr = 0, pctCount = 0, covHits = 0, count = 0, origins = 0;

  for (let o = minTrain; o < n; o += step) {
    const train = y.slice(0, o);
    const test = y.slice(o, Math.min(o + horizon, n));
    if (!test.length) break;
    let fc;
    try {
      fc = forecast(train, test.length, { model, seasonLength: m, level });
    } catch { continue; }
    origins++;
    for (let i = 0; i < test.length; i++) {
      const e = test[i] - fc.mean[i];
      absErr += Math.abs(e);
      sqErr += e * e;
      if (test[i] > 0) { pctErr += Math.abs(e) / test[i]; pctCount++; }
      if (test[i] >= fc.lower[i] && test[i] <= fc.upper[i]) covHits++;
      count++;
    }
  }

  if (!count) return null;
  return {
    model,
    nOrigins: origins,
    horizon,
    level,
    mase: round((absErr / count) / (scale || 1), 3),
    rmse: round(Math.sqrt(sqErr / count), 2),
    mape: pctCount ? round((pctErr / pctCount) * 100, 1) : null,
    coverage: round(covHits / count, 3)
  };
}

// Mean absolute seasonal (or first) difference — the MASE scaling denominator.
function scaleFactor(y, m) {
  const lag = m > 1 && y.length > m ? m : 1;
  let s = 0, c = 0;
  for (let t = lag; t < y.length; t++) { s += Math.abs(y[t] - y[t - lag]); c++; }
  return c ? s / c : 1;
}

// --- public: model selection --------------------------------------

/**
 * Backtest every candidate model and rank by MASE. Candidates are chosen from
 * the data: seasonal models only with >= 2 seasons of history, Croston only
 * when demand is intermittent/lumpy.
 * @returns {{ best: object, ranking: object[], baseline: object|null }}
 */
export function selectModel(series, opts = {}) {
  const y = series.map(v => (v == null || !isFinite(v) ? 0 : Math.max(0, v)));
  const m = opts.seasonLength || 12;
  const horizon = opts.horizon;
  const level = opts.level || DEFAULT_LEVEL;
  const canSeason = y.length >= 2 * m;
  const zeroFrac = y.filter(v => v === 0).length / (y.length || 1);
  const cls = opts.demandClass;

  const candidates = new Set(['ses', 'holt']);
  if (canSeason) { candidates.add('seasonal-naive'); candidates.add('holt-winters'); }
  if (cls === 'intermittent' || cls === 'lumpy' || zeroFrac >= 0.25) candidates.add('croston');
  if (!canSeason) candidates.add('naive');

  const ranking = [];
  for (const model of candidates) {
    const r = backtest(y, { model, seasonLength: m, horizon, level });
    if (r) ranking.push(r);
  }
  ranking.sort((a, b) => a.mase - b.mase);

  // Simplicity tie-break: if a simpler model is within 3% MASE of the leader, prefer it.
  const SIMPLICITY = ['naive', 'seasonal-naive', 'ses', 'croston', 'holt', 'holt-winters'];
  let best = ranking[0] || null;
  if (best) {
    for (const r of ranking) {
      if (r.mase <= best.mase * 1.03 &&
          SIMPLICITY.indexOf(r.model) < SIMPLICITY.indexOf(best.model)) {
        best = r;
      }
    }
  }

  const baseline = ranking.find(r => r.model === (canSeason ? 'seasonal-naive' : 'naive')) || null;
  return { best, ranking, baseline };
}

// --- public: product-level convenience ---------------------------

/**
 * @param {object} product  a product entry from buildDemandSeries().products
 * @param {object} [opts]    { horizon=6, seasonLength=12, level=0.8 }
 */
export function forecastProduct(product, opts = {}) {
  const y = product.demand;
  const m = opts.seasonLength || 12;
  const level = opts.level || DEFAULT_LEVEL;
  const horizon = opts.horizon || 6;
  const demandClass = product.summary ? product.summary.demandClass : undefined;

  const sel = selectModel(y, { seasonLength: m, horizon, level, demandClass });
  const modelName = sel.best ? sel.best.model : (y.length >= 2 * m ? 'holt-winters' : 'ses');
  const fc = forecast(y, horizon, { model: modelName, seasonLength: m, level });

  const lastKey = product.periods[product.periods.length - 1];
  const future = nextMonthlyPeriods(lastKey, horizon);

  const totalMean = round(fc.mean.reduce((s, x) => s + x, 0));
  const totalLow = round(fc.lower.reduce((s, x) => s + x, 0));
  const totalHigh = round(fc.upper.reduce((s, x) => s + x, 0));

  return {
    product: product.product,
    model: fc.model,
    modelLabel: MODEL_LABELS[fc.model] || fc.model,
    params: fc.params,
    horizon,
    level,
    periods: future,
    mean: fc.mean,
    lower: fc.lower,
    upper: fc.upper,
    horizonTotal: { mean: totalMean, lower: totalLow, upper: totalHigh },
    history: { periods: product.periods.slice(), demand: y.slice() },
    accuracy: sel.best,          // { mase, rmse, mape, coverage, ... }
    baseline: sel.baseline,
    ranking: sel.ranking
  };
}

// "2022-12" + 3  ->  ["2023-01","2023-02","2023-03"]
export function nextMonthlyPeriods(lastKey, count) {
  const parts = String(lastKey).split('-');
  let year = Number(parts[0]);
  let month = Number(parts[1]);           // 1..12
  const out = [];
  for (let i = 0; i < count; i++) {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    out.push(year + '-' + String(month).padStart(2, '0'));
  }
  return out;
}

function round(n, dp = 0) {
  if (!isFinite(n)) return n;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
