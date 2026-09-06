// ---------------------------------------------------------------------------
// Data-prep for demand forecasting (ORACLE v2).
//
// Turns the raw transactional dairy dataset into one clean, gap-filled demand
// time series per product, plus the summary statistics a forecasting engine
// needs to pick a model (trend, seasonality, how intermittent/lumpy demand is).
//
// Pure functions, no DOM. `buildDemandSeries` is the entry point.
// ---------------------------------------------------------------------------
import { parseDate, toNumber } from './utils.js';

// Column names in data/dairy_dataset.csv (already trimmed by ingest.js).
const COL_DATE = 'Date';
const COL_PRODUCT = 'Product Name';
const COL_QTY_SOLD = 'Quantity Sold (liters/kg)';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Parse a date to LOCAL midnight. `new Date("2019-01-01")` is parsed as UTC,
// which shifts to the previous day in timezones behind UTC and lands rows in
// the wrong month/week. Handle the dataset's YYYY-MM-DD form explicitly first.
function parseLocalDate(value) {
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  return parseDate(value);
}

// --- Bucketing -------------------------------------------------------------

function pad2(n) { return String(n).padStart(2, '0'); }

// Monday-based week number, returned as "YYYY-Www" (ISO 8601 week date).
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;              // Sun=0 -> 7
  d.setUTCDate(d.getUTCDate() + 4 - day);      // nearest Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / MS_PER_DAY + 1) / 7);
  return d.getUTCFullYear() + '-W' + pad2(week);
}

export function bucketKey(date, bucket) {
  const y = date.getFullYear();
  if (bucket === 'week') return isoWeekKey(date);
  if (bucket === 'quarter') return y + '-Q' + (Math.floor(date.getMonth() / 3) + 1);
  return y + '-' + pad2(date.getMonth() + 1); // month (default)
}

// Every bucket key from `start` to `end` inclusive, in order, with no gaps.
export function enumerateBuckets(start, end, bucket) {
  const keys = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const step = bucket === 'week' ? 7 : 0;
  let guard = 0;
  while (cur <= end && guard++ < 10000) {
    const key = bucketKey(cur, bucket);
    if (keys[keys.length - 1] !== key) keys.push(key);
    if (bucket === 'week') {
      cur.setDate(cur.getDate() + step);
    } else if (bucket === 'quarter') {
      cur.setMonth(cur.getMonth() + 3);
    } else {
      cur.setMonth(cur.getMonth() + 1);
    }
  }
  // Make sure the final partial period is included.
  const lastKey = bucketKey(end, bucket);
  if (keys[keys.length - 1] !== lastKey) keys.push(lastKey);
  return keys;
}

// --- Small stats helpers -------------------------------------------------

function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Ordinary-least-squares slope of y against its own index (0..n-1).
function olsSlope(y) {
  const n = y.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(y);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (y[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function periodsPerYear(bucket) {
  return bucket === 'week' ? 52 : bucket === 'quarter' ? 4 : 12;
}

// --- Demand classification (Syntetos–Boylan) ---------------------------

// ADI  = average interval between non-zero demand periods
// CV2  = squared coefficient of variation of the non-zero demand sizes
function classifyDemand(demand) {
  const nonZero = demand.filter(v => v > 0);
  if (nonZero.length === 0) return { demandClass: 'no-demand', adi: Infinity, cv2: 0 };
  const adi = demand.length / nonZero.length;
  const cv = std(nonZero) / (mean(nonZero) || 1);
  const cv2 = cv * cv;
  const lumpyInterval = adi >= 1.32;
  const erraticSize = cv2 >= 0.49;
  let demandClass;
  if (!lumpyInterval && !erraticSize) demandClass = 'smooth';
  else if (lumpyInterval && !erraticSize) demandClass = 'intermittent';
  else if (!lumpyInterval && erraticSize) demandClass = 'erratic';
  else demandClass = 'lumpy';
  return { demandClass, adi, cv2 };
}

// --- Seasonality --------------------------------------------------------

// Average demand per calendar month (index 0 = Jan). Returns 12 multiplicative
// indices centred on 1.0, plus a 0..1 strength score.
function monthlySeasonality(periods, demand) {
  const byMonth = Array.from({ length: 12 }, () => []);
  periods.forEach((key, i) => {
    const m = Number(key.slice(5, 7)) - 1; // "YYYY-MM..." -> month index
    if (m >= 0 && m < 12) byMonth[m].push(demand[i]);
  });
  const monthMeans = byMonth.map(vals => (vals.length ? mean(vals) : null));
  const known = monthMeans.filter(v => v !== null);
  const overall = mean(known) || 1;
  const indices = monthMeans.map(v => (v === null ? 1 : v / overall));
  // Strength: how much month-to-month variation there is, relative to the mean.
  const strength = Math.min(1, std(known) / (overall || 1));
  let peakMonth = 0, troughMonth = 0;
  indices.forEach((v, i) => {
    if (v > indices[peakMonth]) peakMonth = i;
    if (v < indices[troughMonth]) troughMonth = i;
  });
  return { indices, strength, peakMonth, troughMonth };
}

// --- Main entry point --------------------------------------------------

/**
 * @param {Array<Object>} rawRows  Trimmed rows from data/dairy_dataset.csv
 * @param {Object} [opts]
 * @param {'month'|'week'|'quarter'} [opts.bucket='month']
 * @returns {{
 *   bucket: string, start: Date, end: Date, periods: string[],
 *   products: Array<Object>, skipped: number
 * }}
 */
export function buildDemandSeries(rawRows, opts = {}) {
  const bucket = opts.bucket || 'month';

  // 1. Parse and keep only rows we can place on the timeline.
  const clean = [];
  let skipped = 0;
  for (const row of rawRows) {
    const date = parseLocalDate(row[COL_DATE]);
    const product = String(row[COL_PRODUCT] ?? '').trim();
    const qty = toNumber(row[COL_QTY_SOLD]);
    if (!date || !product || qty === null) { skipped++; continue; }
    clean.push({ date, product, qty: Math.max(0, qty) });
  }

  if (!clean.length) {
    return { bucket, start: null, end: null, periods: [], products: [], skipped };
  }

  // 2. Overall timeline.
  const times = clean.map(r => r.date.getTime());
  const start = new Date(Math.min(...times));
  const end = new Date(Math.max(...times));
  const periods = enumerateBuckets(start, end, bucket);
  const periodIndex = new Map(periods.map((k, i) => [k, i]));

  // 3. Aggregate demand into buckets, per product.
  const byProduct = new Map();
  for (const { date, product, qty } of clean) {
    const bi = periodIndex.get(bucketKey(date, bucket));
    if (bi === undefined) continue;
    if (!byProduct.has(product)) {
      byProduct.set(product, {
        demand: new Array(periods.length).fill(0),
        txns: new Array(periods.length).fill(0)
      });
    }
    const rec = byProduct.get(product);
    rec.demand[bi] += qty;
    rec.txns[bi] += 1;
  }

  // 4. Summary stats per product.
  const ppy = periodsPerYear(bucket);
  const products = [];
  for (const [product, { demand, txns }] of byProduct.entries()) {
    const nNonZero = demand.filter(v => v > 0).length;
    const m = mean(demand);
    const s = std(demand);
    const slope = olsSlope(demand);
    const { demandClass, adi, cv2 } = classifyDemand(demand);
    const season = bucket === 'month' ? monthlySeasonality(periods, demand) : null;
    const recent = demand.slice(-3);

    products.push({
      product,
      unit: 'liters/kg',
      periods,                    // shared reference — same for every product
      demand,
      transactions: txns,
      summary: {
        totalDemand: round(demand.reduce((a, b) => a + b, 0)),
        nPeriods: demand.length,
        nNonZero,
        coverage: round(nNonZero / demand.length, 3),
        mean: round(m),
        median: round(median(demand)),
        std: round(s),
        cv: round(s / (m || 1), 3),
        min: round(Math.min(...demand)),
        max: round(Math.max(...demand)),
        demandClass,               // smooth | intermittent | erratic | lumpy
        adi: round(adi, 2),
        cv2: round(cv2, 3),
        trendPerPeriod: round(slope),
        trendPctPerYear: round((slope * ppy) / (m || 1) * 100, 1),
        seasonalityStrength: season ? round(season.strength, 3) : null,
        seasonalIndices: season ? season.indices.map(v => round(v, 3)) : null,
        peakMonth: season ? season.peakMonth : null,     // 0 = Jan
        troughMonth: season ? season.troughMonth : null,
        lastPeriodDemand: round(demand[demand.length - 1]),
        recentMeanDemand: round(mean(recent))
      }
    });
  }

  products.sort((a, b) => b.summary.totalDemand - a.summary.totalDemand);
  return { bucket, start, end, periods, products, skipped };
}

function round(n, dp = 2) {
  if (!isFinite(n)) return n;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
