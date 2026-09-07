// ---------------------------------------------------------------------------
// What-if simulation (ORACLE v6).
//
// Re-runs the v3 Monte-Carlo stockout simulation with the inputs changed —
// demand higher or lower than forecast, an incoming order, a delivery date —
// and compares the outcome to the untouched baseline. Also solves for the
// order that would hit a target service level.
//
// Pure functions, no DOM. Built on stockout.js.
// ---------------------------------------------------------------------------
import { assessStockout } from './stockout.js';

const DEFAULT_HORIZON = 30;
const DEFAULT_PATHS = 4000;
const DAYS_PER_MONTH = 30.44;

/**
 * @param {object} scenario  { demandMultiplier=1, reorderQty=0, reorderInDays=0 }
 */
export function assess(forecastResult, currentStock, scenario = {}, opts = {}) {
  return assessStockout(forecastResult, currentStock, {
    horizonDays: opts.horizonDays || DEFAULT_HORIZON,
    paths: opts.paths || DEFAULT_PATHS,
    seed: opts.seed == null ? 42 : opts.seed,
    demandMultiplier: scenario.demandMultiplier == null ? 1 : scenario.demandMultiplier,
    reorderQty: scenario.reorderQty || 0,
    reorderInDays: scenario.reorderInDays || 0
  });
}

/** Baseline (nothing changed) vs the caller's scenario. */
export function compareScenario(forecastResult, currentStock, scenario, opts = {}) {
  return {
    baseline: assess(forecastResult, currentStock, {}, opts),
    scenario: assess(forecastResult, currentStock, scenario, opts)
  };
}

/**
 * Smallest order (arriving in `leadDays`) that pulls P(stockout) down to
 * `1 - targetService` within the look-ahead window, under the given demand
 * assumption. Returns { needed:false } when no order is required.
 */
export function recommendReorder(forecastResult, currentStock, opts = {}) {
  const horizonDays = opts.horizonDays || DEFAULT_HORIZON;
  const leadDays = opts.leadDays == null ? 7 : opts.leadDays;
  const targetService = opts.targetService == null ? 0.95 : opts.targetService;
  const demandMultiplier = opts.demandMultiplier == null ? 1 : opts.demandMultiplier;
  const maxP = 1 - targetService;

  const dailyRate = (forecastResult.mean[0] / DAYS_PER_MONTH) * demandMultiplier;
  const pFor = (qty, lead) => assess(forecastResult, currentStock, {
    demandMultiplier,
    reorderQty: qty,
    reorderInDays: qty > 0 ? (lead == null ? leadDays : lead) : 0
  }, { horizonDays, paths: 2000 }).pStockout;

  const currentP = pFor(0);
  if (currentP <= maxP) {
    return { needed: false, currentP, targetService, leadDays };
  }

  // Enough stock to cover ~3× the look-ahead window — the practical ceiling.
  const cap = Math.max(dailyRate * horizonDays * 3, 500);

  // If even that can't hit the target, the risk is running out *before* the
  // delivery arrives — no order size fixes that, only a faster delivery.
  const floorP = pFor(cap);
  if (floorP > maxP) {
    let fasterLead = null;
    for (const L of [Math.floor(leadDays / 2), 3, 2, 1]) {
      if (L > 0 && L < leadDays && pFor(cap, L) <= maxP) { fasterLead = L; break; }
    }
    return { needed: true, achievable: false, floorP, currentP, leadDays, targetService, fasterLead };
  }

  let lo = 0, hi = cap;
  for (let i = 0; i < 13; i++) {
    const mid = (lo + hi) / 2;
    if (pFor(mid) <= maxP) hi = mid; else lo = mid;
  }
  const qty = Math.ceil(hi / 10) * 10;
  return { needed: true, achievable: true, qty, leadDays, targetService, currentP, resultingP: pFor(qty) };
}
