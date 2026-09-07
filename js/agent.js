// ---------------------------------------------------------------------------
// Ask ORACLE — natural-language agent (ORACLE v7).
//
// A tool-use agent: the language model interprets the question and decides
// which of ORACLE's engines to run; the engines (v2–v6) do every calculation.
// The model never invents a number — it only calls tools and narrates results.
//
// Bring-your-own-key: the browser calls the Google Gemini API directly with
// the user's own API key. Nothing goes through a server we run.
// ---------------------------------------------------------------------------
import { forecastProduct } from './forecast.js';
import { assessStockout } from './stockout.js';
import { detectProductAnomalies } from './anomaly.js';
import { topDrivers, explainAnomaly, explainForecast } from './reasoning.js';
import { compareScenario, recommendReorder } from './whatif.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const MAX_TURNS = 6;

// Editable in the UI — Google's model names change often. These are the
// suggestions; the key field accepts any model id.
export const MODEL_SUGGESTIONS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'];
export const DEFAULT_MODEL = 'gemini-2.5-flash';

const SYSTEM_PROMPT = `You are ORACLE, an operations analyst for a dairy inventory system.

Answer the user's question using ONLY the tools provided. Every figure in your answer must come from a tool result — never estimate, extrapolate, or invent numbers. If the tools cannot answer something, say so plainly.

The data: 10 dairy products, ~4 years of monthly demand history, current stock on hand, and per-transaction breakdowns by sales channel, customer region, and brand. It is a synthetic demo dataset, so driver breakdowns can look noisy or evenly split — say so when that is the case.

How to work:
- Call get_overview first when you need to know which products exist or get the lay of the land.
- Call only the tools you need. For a "which products are at risk" question, get_overview alone is usually enough.
- Product names must match exactly (e.g. "Ice Cream", "Buttermilk"). get_overview lists them.

How to answer:
- Lead with the direct answer, then the key supporting numbers.
- Be concise. Short paragraphs or bullet lists. No preamble like "Great question".
- Round sensibly: "about 2,300", not "2,317.4".
- If the question is ambiguous about product or time window, pick a reasonable default and state it.
- Format with Markdown: ** for key figures, - for bullets.`;

// --- tool definitions ------------------------------------------------

export const TOOLS = [
  {
    name: 'get_overview',
    description: 'Headline numbers for every product at once: stock on hand, forecast demand per month, ' +
      '30-day stockout risk, and how many unusual months each has. Call this first for any broad question ' +
      '("what is at risk", "what should I look at") or to get the exact product names.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_forecast',
    description: 'Demand forecast for one product: the next 6 months (expected + range), which model was ' +
      'chosen and how accurate it tested, the trend, and a plain-English summary. Use for questions about ' +
      'expected/future demand or how much will sell.',
    input_schema: {
      type: 'object',
      properties: { product: { type: 'string', description: 'Exact product name' } },
      required: ['product']
    }
  },
  {
    name: 'get_stockout_risk',
    description: 'Stockout simulation for one product over a horizon: the chance of running out, when it ' +
      'likely runs out, the risk level, and expected unmet demand. Use for "will we run out", "how long ' +
      'until", "how risky is X".',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Exact product name' },
        horizon_days: { type: 'number', description: 'Look-ahead window in days (default 30)' }
      },
      required: ['product']
    }
  },
  {
    name: 'get_anomalies',
    description: 'Unusual months in one product\'s demand history: the spikes and drops (actual vs expected), ' +
      'any lasting shift in the baseline, and whether the most recent month is unusual. Use for "was there ' +
      'anything strange", "any unusual activity", "did demand change".',
    input_schema: {
      type: 'object',
      properties: { product: { type: 'string', description: 'Exact product name' } },
      required: ['product']
    }
  },
  {
    name: 'explain_drivers',
    description: 'What drives one product\'s demand: the split by sales channel / customer region / brand, ' +
      'which parts are trending up or down, and a suggested cause for each unusual month. Use for "why", ' +
      '"what is behind", "where do sales come from".',
    input_schema: {
      type: 'object',
      properties: { product: { type: 'string', description: 'Exact product name' } },
      required: ['product']
    }
  },
  {
    name: 'run_what_if',
    description: 'Re-run the stockout simulation for one product with changed assumptions, versus the ' +
      'baseline. Use for "what if demand rises 20%", "what if I order X", "what if the delivery is late". ' +
      'Also returns the order size that would reach a 95% service level.',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Exact product name' },
        demand_change_pct: { type: 'number', description: 'Percent change vs forecast, e.g. 20 or -15 (default 0)' },
        order_qty: { type: 'number', description: 'Units of an incoming order (default 0)' },
        delivery_days: { type: 'number', description: 'Days until that order arrives (default 7)' },
        horizon_days: { type: 'number', description: 'Look-ahead window in days (default 30)' }
      },
      required: ['product']
    }
  }
];

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

// ORACLE's tools in Gemini's functionDeclarations shape (drop `parameters`
// entirely for a no-argument tool, which Gemini requires).
const FUNCTION_DECLARATIONS = TOOLS.map(t => {
  const decl = { name: t.name, description: t.description };
  if (t.input_schema && Object.keys(t.input_schema.properties || {}).length) {
    decl.parameters = t.input_schema;
  }
  return decl;
});

async function callGemini({ apiKey, model, contents }) {
  let res;
  try {
    res = await fetch(API_BASE + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
        generationConfig: { maxOutputTokens: 8192, temperature: 0.4 }
      })
    });
  } catch (e) {
    throw new Error('Could not reach the Gemini API. Check your connection.');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (e) { /* ignore */ }
    const known = {
      400: 'The request was rejected' + (detail ? ': ' + detail : ' (often an invalid API key or model name).'),
      403: 'That API key was rejected, or it lacks access to this model.',
      404: 'Model "' + model + '" was not found — check the model name.',
      429: 'Rate limited by Google — wait a moment and retry.',
      500: 'Google had a server error — retry shortly.',
      503: 'The Gemini model is overloaded right now — retry in a bit.'
    };
    throw new Error(known[res.status] || ('Gemini API error ' + res.status + (detail ? ': ' + detail : '')));
  }
  return res.json();
}

/**
 * @param question  the user's plain-English question
 * @param context   { demand, stockByProduct, factorIndex }
 * @param config    { apiKey, model }
 * @param onEvent   optional (evt) => void  — { type:'tool', name, input }
 * @returns { answer, toolsUsed: string[], usage: {input, output}, model }
 */
export async function ask(question, context, config, onEvent) {
  const model = config.model || DEFAULT_MODEL;
  const contents = [{ role: 'user', parts: [{ text: String(question).trim() }] }];
  const usage = { input: 0, output: 0 };
  const toolsUsed = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await callGemini({ apiKey: config.apiKey, model, contents });
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
