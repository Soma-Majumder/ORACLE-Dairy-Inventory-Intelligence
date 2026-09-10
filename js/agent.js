// ---------------------------------------------------------------------------
// Ask ORACLE — natural-language insight feature (ORACLE v7).
//
// Compute-then-explain: the browser runs the v2–v6 engines to produce a full
// analysis bundle (every number calculated here), then POSTs { question,
// analysis } to /api/ask. The server makes one OpenRouter call; the model
// only turns that analysis into plain English for a non-technical reader.
// It never calculates, predicts, or invents a figure.
//
// The OPENROUTER_API_KEY lives server-side only.
// ---------------------------------------------------------------------------
import { forecastProduct } from './forecast.js';
import { assessStockout } from './stockout.js';
import { detectProductAnomalies } from './anomaly.js';
import { topDrivers, explainAnomaly, explainForecast } from './reasoning.js';
import { compareScenario, recommendReorder } from './whatif.js';

const PROXY_URL = '/api/ask';

// --- tool execution ------------------------------------------------

function round(n, dp = 0) {
  if (n == null || !isFinite(n)) return n;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function resolveProduct(name, context) {
  const products = context.demand.products;
  const q = String(name || '').trim().toLowerCase();
  return products.find(p => p.product.toLowerCase() === q) ||
    products.find(p => p.product.toLowerCase().replace(/\s+/g, '') === q.replace(/\s+/g, '')) ||
    products.find(p => p.product.toLowerCase().includes(q) || q.includes(p.product.toLowerCase())) ||
    null;
}

function cachedForecast(product, context) {
  if (!context._fc) context._fc = new Map();
  if (!context._fc.has(product.product)) {
    context._fc.set(product.product, forecastProduct(product, { horizon: 6, level: 0.8 }));
  }
  return context._fc.get(product.product);
}

function runOut(sim, horizonDays) {
  return (sim.pStockout < 0.5 || sim.daysUntilStockout.p50 == null)
    ? 'likely beyond ' + horizonDays + ' days'
    : 'around day ' + sim.daysUntilStockout.p50 +
      (sim.daysUntilStockout.p10 != null
        ? ' (likely ' + sim.daysUntilStockout.p10 + '–' +
          (sim.daysUntilStockout.p90 == null ? horizonDays + '+' : sim.daysUntilStockout.p90) + ')'
        : '');
}

function toolOverview(context) {
  const { demand, stockByProduct } = context;
  return {
    history: (demand.periods[0] || '?') + ' to ' + (demand.periods[demand.periods.length - 1] || '?'),
    note: 'Synthetic demo dataset. Stock is summed across brands per product.',
    products: demand.products.map(p => {
      const stock = stockByProduct[p.product];
      const f = cachedForecast(p, context);
      let risk = null;
      if (stock != null) {
        const sim = assessStockout(f, stock, { horizonDays: 30, paths: 1500 });
        risk = { chanceOfStockout30d: round(sim.pStockout * 100) + '%', level: sim.riskLevel };
      }
      const an = detectProductAnomalies(p);
      return {
        product: p.product,
        onHand: stock != null ? round(stock) : 'unknown',
        forecastPerMonth: round(f.mean[0]),
        stockoutRisk: risk,
        unusualMonths: an.points.length,
        recentMonthUnusual: !!(an.latest && an.latest.isAnomaly),
        baselineShift: an.levelShift ? an.levelShift.direction : null
      };
    })
  };
}

function toolForecast(input, context) {
  const p = resolveProduct(input.product, context);
  if (!p) return { error: 'No product named "' + input.product + '". Call get_overview for the list.' };
  const f = cachedForecast(p, context);
  return {
    product: p.product,
    method: f.modelLabel,
    monthlyForecast: f.periods.map((period, i) => ({
      month: period, expected: round(f.mean[i]), low: round(f.lower[i]), high: round(f.upper[i])
    })),
    sixMonthTotal: { expected: round(f.horizonTotal.mean), low: round(f.horizonTotal.lower), high: round(f.horizonTotal.upper) },
    accuracy: f.accuracy ? {
      maseVsNaiveBaseline: f.accuracy.mase + ' vs ' + (f.baseline ? f.baseline.mase : 'n/a') + ' (lower is better; <1 beats a rough guess)',
      rangeCoverage: Math.round(f.accuracy.coverage * 100) + '% of actual months landed in the predicted range (target ' + Math.round(f.accuracy.level * 100) + '%)'
    } : 'not enough history to back-test',
    trendPerYear: round(p.summary.trendPctPerYear, 1) + '%',
    plainSummary: explainForecast(p.summary, f.periods, f.mean[0])
  };
}

function toolStockout(input, context) {
  const p = resolveProduct(input.product, context);
  if (!p) return { error: 'No product named "' + input.product + '".' };
  const stock = context.stockByProduct[p.product];
  if (stock == null) return { error: 'No current stock figure for ' + p.product + '.' };
  const H = Math.max(7, Math.min(180, input.horizon_days || 30));
  const sim = assessStockout(cachedForecast(p, context), stock, { horizonDays: H, paths: 3000 });
  return {
    product: p.product,
    onHand: round(stock),
    horizonDays: H,
    chanceOfStockout: round(sim.pStockout * 100) + '%',
    riskLevel: sim.riskLevel,
    whenItRunsOut: runOut(sim, H),
    expectedDaysOfCover: sim.expectedDaysCover,
    expectedUnmetDemand: round(sim.expectedUnitsShort) + ' units'
  };
}

function toolAnomalies(input, context) {
  const p = resolveProduct(input.product, context);
  if (!p) return { error: 'No product named "' + input.product + '".' };
  const a = detectProductAnomalies(p);
  if (!a.enoughData) return { product: p.product, note: 'Not enough history to check.' };
  return {
    product: p.product,
    unusualMonths: a.points.map(pt => ({
      month: pt.period, direction: pt.direction, sold: round(pt.actual),
      expected: round(pt.expected), strength: pt.severity
    })),
    baselineShift: a.levelShift ? {
      direction: a.levelShift.direction, aroundMonth: a.levelShift.period,
      changePct: a.levelShift.pctChange + '%',
      from: round(a.levelShift.beforeMean) + '/mo', to: round(a.levelShift.afterMean) + '/mo'
    } : null,
    mostRecentMonth: a.latest ? {
      month: a.latest.period, sold: round(a.latest.actual), expected: round(a.latest.expected),
      verdict: a.latest.isAnomaly ? (a.latest.direction + ' — unusual') : 'normal'
    } : null
  };
}

function toolDrivers(input, context) {
  const p = resolveProduct(input.product, context);
  if (!p) return { error: 'No product named "' + input.product + '".' };
  const rec = context.factorIndex ? context.factorIndex.get(p.product) : null;
  const drivers = topDrivers(rec, context.demand.periods);
  const an = detectProductAnomalies(p);
  const causes = an.points.map(pt => {
    const ex = explainAnomaly(rec, pt.period, context.demand.periods, pt.actual - pt.expected);
    return { month: pt.period, direction: pt.direction, likelyCause: ex ? ex.text : 'unclear' };
  });
  const dimSummary = (d) => d ? {
    topCategories: d.top.map(c => c.category + ' ' + c.share + '%'),
    trending: d.mover ? d.mover.category + ' ' + (d.mover.growthPctYr > 0 ? '+' : '') + d.mover.growthPctYr + '%/yr' : 'nothing notable'
  } : null;
  return {
    product: p.product,
    note: 'Synthetic data — splits are often near-even and "trending" values are mostly noise.',
    byChannel: dimSummary(drivers && drivers.channel),
    byRegion: dimSummary(drivers && drivers.region),
    byBrand: dimSummary(drivers && drivers.brand),
    unusualMonthCauses: causes
  };
}

function toolWhatIf(input, context) {
  const p = resolveProduct(input.product, context);
  if (!p) return { error: 'No product named "' + input.product + '".' };
  const stock = context.stockByProduct[p.product];
  if (stock == null) return { error: 'No current stock figure for ' + p.product + '.' };
  const f = cachedForecast(p, context);
  const H = Math.max(7, Math.min(180, input.horizon_days || 30));
  const pct = input.demand_change_pct || 0;
  const mult = 1 + pct / 100;
  const qty = Math.max(0, input.order_qty || 0);
  const lead = Math.max(0, input.delivery_days == null ? 7 : input.delivery_days);

  const cmp = compareScenario(f, stock, { demandMultiplier: mult, reorderQty: qty, reorderInDays: lead }, { horizonDays: H });
  const rec = recommendReorder(f, stock, { horizonDays: H, leadDays: lead || 7, targetService: 0.95, demandMultiplier: mult });

  const line = (s) => ({
    chanceOfStockout: round(s.pStockout * 100) + '%',
    whenItRunsOut: runOut(s, H),
    expectedUnmetDemand: round(s.expectedUnitsShort) + ' units'
  });

  let recommendation;
  if (!rec.needed) {
    recommendation = 'No order needed — current stock covers the window' +
      (pct ? ' at demand ' + (pct > 0 ? '+' : '') + pct + '%' : '') + '.';
  } else if (rec.achievable === false) {
    recommendation = 'A bigger order alone will not reach 95% cover — about ' + round(rec.floorP * 100) +
      '% chance of running out before a ' + rec.leadDays + '-day delivery arrives.' +
      (rec.fasterLead ? ' A delivery within ' + rec.fasterLead + ' days would.' : '');
  } else {
    recommendation = 'Order about ' + round(rec.qty) + ' units arriving within ' + rec.leadDays +
      ' days to reach ~' + round(rec.resultingP * 100) + '% stockout risk.';
  }

  return {
    product: p.product,
    onHand: round(stock),
    assumptions: { demandChange: (pct > 0 ? '+' : '') + pct + '%', order: qty + ' units', deliveryDays: lead, horizonDays: H },
    baseline: line(cmp.baseline),
    scenario: line(cmp.scenario),
    recommendation
  };
}

// --- gathering the analysis bundle -------------------------------

// Products whose name appears in the question — as a whole word/phrase, so
// "Buttermilk" doesn't also pull in "Milk" and "Butter".
function productsInQuestion(question, context) {
  const q = String(question).toLowerCase();
  return context.demand.products
    .filter(p => {
      const n = p.product.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
      return new RegExp('(^|[^a-z])' + n + '([^a-z]|$)').test(q);
    })
    .map(p => p.product);
}

// A what-if question → scenario knobs, or null if it isn't one.
function detectWhatIf(question) {
  const q = String(question).toLowerCase();
  const isWhatIf = /\bwhat if\b|\bif (?:demand|sales)\b|\bsuppose\b|\bscenario\b|\brises?\b|\bdrops?\b|\bincreases?\b|\bfalls?\b|\bwere to\b|\bdouble\b|\bhalve\b/.test(q)
    || /\border\b[^.]*\b(units|kg|litres|liters)\b/.test(q);
  if (!isWhatIf) return null;
  const pctM = q.match(/(\d{1,3})\s*%/);
  const down = /\b(drop|down|fall|fell|less|lower|decrease|declin|reduc|halve)/.test(q);
  const qtyM = q.match(/(\d[\d,]{2,})\s*(?:units|kg|litres|liters)?/);
  const leadM = q.match(/(\d{1,2})\s*days?/);
  let pct = pctM ? Number(pctM[1]) * (down ? -1 : 1) : 0;
  if (!pctM && /\bdouble\b/.test(q)) pct = 100;
  if (!pctM && /\bhalve\b/.test(q)) pct = -50;
  return {
    demand_change_pct: pct,
    order_qty: qtyM ? Number(qtyM[1].replace(/,/g, '')) : 0,
    delivery_days: leadM ? Number(leadM[1]) : 7
  };
}

/**
 * Run the engines and assemble everything the LLM might need to answer.
 * @param question  plain-English question
 * @param context   { demand, stockByProduct, factorIndex }
 * @param onStep     optional (label) => void  — progress labels for the UI
 * @returns a plain object safe to JSON.stringify
 */
export function gatherAnalysis(question, context, onStep) {
  const step = (label) => { if (onStep) onStep(label); };
  const q = String(question).trim();
  const analysis = { question: q };

  step('scanning all products');
  analysis.overview = toolOverview(context);

  const targets = productsInQuestion(q, context);
  if (targets.length) {
    analysis.products = {};
    for (const name of targets) {
      step('analysing ' + name);
      analysis.products[name] = {
        forecast: toolForecast({ product: name }, context),
        stockout: toolStockout({ product: name }, context),
        anomalies: toolAnomalies({ product: name }, context),
        drivers: toolDrivers({ product: name }, context)
      };
    }
  }

  const wi = detectWhatIf(q);
  if (wi && targets.length) {
    step('running the what-if scenario');
    analysis.scenario = { assumptions: wi, byProduct: {} };
    for (const name of targets) {
      analysis.scenario.byProduct[name] = toolWhatIf({ product: name, ...wi }, context);
    }
  }

  analysis._sections = ['all-product overview']
    .concat(targets.map(n => n + ' deep-dive'))
    .concat(wi && targets.length ? ['what-if scenario'] : []);
  return analysis;
}

// --- Investigate (v7b): full multi-engine deep-dive -------------

// Every engine for one product, plus a default "+20% demand" scenario.
function deepDive(name, context, step) {
  if (step) step('investigating ' + name);
  return {
    forecast: toolForecast({ product: name }, context),
    stockout: toolStockout({ product: name, horizon_days: 30 }, context),
    anomalies: toolAnomalies({ product: name }, context),
    drivers: toolDrivers({ product: name }, context),
    demandShock20pct: toolWhatIf(
      { product: name, demand_change_pct: 20, delivery_days: 7, horizon_days: 30 }, context)
  };
}

// Rank products by how much they warrant attention, from the overview row.
function rankByRisk(overview, count) {
  return overview.products
    .map(p => {
      const pct = p.stockoutRisk
        ? Number(String(p.stockoutRisk.chanceOfStockout30d).replace('%', '')) || 0 : 0;
      const score = pct + (p.unusualMonths || 0) * 4 +
        (p.recentMonthUnusual ? 25 : 0) + (p.baselineShift ? 12 : 0);
      return { product: p.product, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(s => s.product);
}

/**
 * @param target   { product: 'Curd' }  OR  { topRisks: 3 }
 * @param context  { demand, stockByProduct, factorIndex }
 * @param onStep   optional (label) => void
 * @returns { answer, sections, usage, model }
 */
export async function investigate(target, context, onStep) {
  const step = (l) => { if (onStep) onStep(l); };
  const overview = toolOverview(context);

  let targets, headline;
  if (target && target.product) {
    targets = [target.product];
    headline = 'Investigate ' + target.product + ' and give me a briefing.';
  } else {
    step('ranking products by risk');
    targets = rankByRisk(overview, (target && target.topRisks) || 3);
    headline = 'Investigate the highest-risk products (' + targets.join(', ') +
      ') and give me a briefing.';
  }

  const analysis = {
    question: headline,
    mode: targets.length > 1 ? 'top-risk triage' : 'single-product investigation',
    overview,
    deepDives: {}
  };
  for (const name of targets) analysis.deepDives[name] = deepDive(name, context, step);
  analysis._sections = ['all-product overview'].concat(targets.map(n => n + ' full deep-dive'));

  step('writing the briefing (the free model can take up to a minute)');
  return postAsk({ question: headline, analysis, task: 'investigate' }, analysis._sections);
}

// --- the single server call --------------------------------------

async function postAsk(body, sections) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 75000);
  let res;
  try {
    res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? 'The free model took too long — try again (it varies a lot).'
      : 'Could not reach the server. Is it running?');
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) {
    throw new Error((data && data.error) || ('Server error ' + res.status));
  }

  return {
    answer: (data && data.answer) || '(no answer)',
    sections,
    usage: (data && data.usage) || null,
    model: (data && data.model) || null
  };
}

/**
 * @param question  the user's plain-English question
 * @param context   { demand, stockByProduct, factorIndex }
 * @param onStep    optional (label) => void  — progress labels while gathering
 * @returns { answer, sections: string[], usage: {input,output}|null, model }
 */
export async function ask(question, context, onStep) {
  const analysis = gatherAnalysis(question, context, onStep);
  if (onStep) onStep('writing the explanation (the free model can take up to a minute)');
  return postAsk({ question: analysis.question, analysis }, analysis._sections);
}
