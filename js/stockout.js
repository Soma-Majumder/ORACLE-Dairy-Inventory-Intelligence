// ---------------------------------------------------------------------------
// Stockout probability (ORACLE v3).
//
// v1 answered "days of cover = stock / average sales rate" — a single number
// with no sense of confidence. v3 runs a Monte-Carlo simulation: many possible
// futures of daily demand (drawn from the v2 forecast and its uncertainty),
// depleting stock along each one, and reports how often — and how soon — the
// product actually runs out.
//
// This simulation is also the substrate for v6 what-if scenarios: change the
// inputs (demand +20%, a delayed delivery, a bigger safety stock) and re-run.
//
// Pure functions, no DOM, no dependencies.
// ---------------------------------------------------------------------------

const DAYS_PER_MONTH = 30.44;

// --- seeded RNG + samplers -------------------------------------------

// mulberry32 — small, fast, seedable. Same seed => same simulation.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randn(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Gamma(shape, scale) via Marsaglia–Tsang. Handles shape < 1 by boosting.
function gammaSample(rng, shape, scale) {
  if (shape < 1) {
    return gammaSample(rng, shape + 1, scale) * Math.pow(rng() || 1e-12, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 64; i++) {
    let x, v;
    do { x = randn(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
  return d * scale; // give up gracefully
}

// One day's demand: Gamma matched to (mean, sd). Gamma keeps demand >= 0 and
// right-skewed, which fits sales better than a clipped normal.
function drawDemand(rng, mean, sd) {
  if (mean <= 0) return 0;
  if (sd <= 0) return mean;
  const shape = (mean / sd) ** 2;
  const scale = (sd * sd) / mean;
  return gammaSample(rng, shape, scale);
}

// --- simulation ----------------------------------------------------

/**
 * @param {object} p
 * @param {number}   p.currentStock
 * @param {number[]} p.dailyMean   expected demand for each day, length = horizonDays
 * @param {number[]} p.dailySd     demand std-dev for each day
 * @param {number}  [p.horizonDays=dailyMean.length]
 * @param {number}  [p.paths=2000]
 * @param {number}  [p.seed=42]
 * @param {number}  [p.reorderQty=0]   units arriving on p.reorderInDays
 * @param {number}  [p.reorderInDays=0]
 */
export function simulateStockout(p) {
  const horizonDays = p.horizonDays || p.dailyMean.length;
  const paths = p.paths || 2000;
  const rng = mulberry32(p.seed == null ? 42 : p.seed);
  const reorderQty = p.reorderQty || 0;
  const reorderDay = p.reorderInDays || 0;

  let outCount = 0;
  let shortfallSum = 0;
  const stockoutDays = [];
  const survival = new Array(horizonDays + 1).fill(0); // paths still in stock at end of day d

  for (let path = 0; path < paths; path++) {
    let stock = p.currentStock;
    let outDay = 0;
    for (let day = 1; day <= horizonDays; day++) {
      if (reorderQty > 0 && day === reorderDay) stock += reorderQty;
      const idx = Math.min(day - 1, p.dailyMean.length - 1);
      stock -= drawDemand(rng, p.dailyMean[idx], p.dailySd[idx]);
      if (stock <= 0 && outDay === 0) outDay = day;
      if (stock > 0) survival[day] += 1;
    }
    if (outDay > 0) { outCount++; stockoutDays.push(outDay); }
    if (stock < 0) shortfallSum += -stock;
  }

  stockoutDays.sort((a, b) => a - b);
  const pStockout = outCount / paths;

  // Percentile of "day it runs out" across ALL paths. Paths that never run out
  // rank above the horizon, so a percentile past the survivor line returns null.
  const dayQuantile = (frac) => {
    const rank = Math.floor(frac * paths);
    return rank < stockoutDays.length ? stockoutDays[rank] : null;
  };

  return {
    horizonDays,
    paths,
    pStockout,
    serviceLevel: 1 - pStockout,
    daysUntilStockout: {
      earliest: stockoutDays.length ? stockoutDays[0] : null,
      p10: dayQuantile(0.10),
      p50: dayQuantile(0.50),
      p90: dayQuantile(0.90)
    },
    expectedUnitsShort: shortfallSum / paths,
    survivalCurve: survival.map(c => c / paths) // survivalCurve[d] = P(in stock through day d)
  };
}

// --- product-level convenience ------------------------------------

const RISK_ORDER = ['low', 'medium', 'high', 'critical'];

function riskLevel(sim) {
  const p50 = sim.daysUntilStockout.p50;
  if (sim.pStockout >= 0.5 || (p50 !== null && p50 <= 7)) return 'critical';
  if (sim.pStockout >= 0.2) return 'high';
  if (sim.pStockout >= 0.05) return 'medium';
  return 'low';
}

/**
 * Build a daily demand profile from a v2 forecast and simulate stockout.
 *
 * @param {object} forecastResult  output of forecastProduct() — needs .mean[] and .sigma
 * @param {number} currentStock
 * @param {object} [opts]  { horizonDays=30, paths=2000, seed=42, reorderQty, reorderInDays }
 */
export function assessStockout(forecastResult, currentStock, opts = {}) {
  const horizonDays = opts.horizonDays || 30;
  const monthlyMean = forecastResult.mean || [];
  const sigma = forecastResult.sigma || 0;
  const demandMult = opts.demandMultiplier == null ? 1 : Math.max(0, opts.demandMultiplier);

  const dailyMean = [];
  const dailySd = [];
  for (let day = 1; day <= horizonDays; day++) {
    const mi = Math.min(monthlyMean.length - 1, Math.floor((day - 1) / DAYS_PER_MONTH));
    dailyMean.push(Math.max(0, monthlyMean[mi] || 0) / DAYS_PER_MONTH * demandMult);
    dailySd.push(sigma / Math.sqrt(DAYS_PER_MONTH) * demandMult);
  }

  const sim = simulateStockout({
    currentStock,
    dailyMean,
    dailySd,
    horizonDays,
    paths: opts.paths || 2000,
    seed: opts.seed == null ? 42 : opts.seed,
    reorderQty: opts.reorderQty,
    reorderInDays: opts.reorderInDays
  });

  const rate0 = dailyMean[0];
  const expectedDaysCover = rate0 > 0 ? currentStock / rate0 : Infinity;

  return {
    product: forecastResult.product,
    currentStock,
    dailyDemandMean: round(rate0, 2),
    expectedDaysCover: isFinite(expectedDaysCover) ? round(expectedDaysCover, 1) : null,
    ...sim,
    pStockout: round(sim.pStockout, 4),
    serviceLevel: round(sim.serviceLevel, 4),
    expectedUnitsShort: round(sim.expectedUnitsShort, 1),
    riskLevel: riskLevel(sim)
  };
}

export { RISK_ORDER };

function round(n, dp = 0) {
  if (!isFinite(n)) return n;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
