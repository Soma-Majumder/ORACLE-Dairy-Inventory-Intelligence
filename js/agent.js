// ---------------------------------------------------------------------------
// Ask ORACLE — natural-language agent (ORACLE v7).
//
// A tool-use agent: the language model interprets the question and decides
// which of ORACLE's engines to run; the engines (v2–v6) do every calculation.
// The model never invents a number — it only calls tools and narrates results.
//
// The browser POSTs the conversation to /api/ask; the server holds the
// Gemini API key. The engine tools below still run here in the browser —
// only the model credential lives server-side.
// ---------------------------------------------------------------------------
import { forecastProduct } from './forecast.js';
import { assessStockout } from './stockout.js';
import { detectProductAnomalies } from './anomaly.js';
import { topDrivers, explainAnomaly, explainForecast } from './reasoning.js';
import { compareScenario, recommendReorder } from './whatif.js';
import { DEFAULT_MODEL } from './agent-tools.js';

const PROXY_URL = '/api/ask';
const MAX_TURNS = 6;

export { DEFAULT_MODEL, MODEL_SUGGESTIONS, TOOL_DEFS as TOOLS } from './agent-tools.js';

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

const DISPATCH = {
  get_overview: (input, context) => toolOverview(context),
  get_forecast: toolForecast,
  get_stockout_risk: toolStockout,
  get_anomalies: toolAnomalies,
  explain_drivers: toolDrivers,
  run_what_if: toolWhatIf
};

export function executeTool(name, input, context) {
  const fn = DISPATCH[name];
  if (!fn) return { error: 'Unknown tool: ' + name };
  return fn(input, context);
}

// --- API call + agentic loop ---------------------------------------

async function callProxy({ model, contents }) {
  let res;
  try {
    res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, contents })
    });
  } catch (e) {
    throw new Error('Could not reach the server. Is it running?');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) {
    throw new Error((data && data.error) || ('Server error ' + res.status));
  }
  return data || {};
}

/**
 * @param question  the user's plain-English question
 * @param context   { demand, stockByProduct, factorIndex }
 * @param config    { model }
 * @param onEvent   optional (evt) => void  — { type:'tool', name, input }
 * @returns { answer, toolsUsed: string[], usage: {input, output}, model }
 */
export async function ask(question, context, config, onEvent) {
  const model = (config && config.model) || DEFAULT_MODEL;
  const contents = [{ role: 'user', parts: [{ text: String(question).trim() }] }];
  const usage = { input: 0, output: 0 };
  const toolsUsed = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await callProxy({ model, contents });
    usage.input += resp.usageMetadata?.promptTokenCount || 0;
    usage.output += resp.usageMetadata?.candidatesTokenCount || 0;

    const cand = resp.candidates && resp.candidates[0];
    if (!cand) return { answer: '(no response from the model)', toolsUsed, usage, model };
    if (cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT') {
      return { answer: 'The model declined to answer that request.', toolsUsed, usage, model };
    }

    const parts = (cand.content && cand.content.parts) || [];
    const calls = parts.filter(p => p.functionCall);

    if (!calls.length) {
      const answer = parts.filter(p => p.text).map(p => p.text).join('').trim();
      return { answer: answer || '(no answer)', toolsUsed, usage, model };
    }

    contents.push({ role: 'model', parts: calls });
    const responseParts = [];
    for (const p of calls) {
      const name = p.functionCall.name;
      const args = p.functionCall.args || {};
      toolsUsed.push(name);
      if (onEvent) onEvent({ type: 'tool', name, input: args });
      let out;
      try {
        out = executeTool(name, args, context);
      } catch (e) {
        out = { error: 'tool failed: ' + (e.message || String(e)) };
      }
      responseParts.push({ functionResponse: { name, response: out } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return {
    answer: '(ORACLE used all its steps without finishing — try asking something more specific.)',
    toolsUsed, usage, model
  };
}
