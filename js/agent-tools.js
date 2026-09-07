// Shared, pure data for the Ask ORACLE agent (v7).
// Imported by the browser (js/agent.js) AND the backend proxy
// (.claude/serve.mjs locally, api/ask.mjs on Vercel). No DOM, no engine code.

export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const MODEL_SUGGESTIONS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'];

// The server will only ever use a model from this list (override with the
// ALLOWED_MODELS env var, comma-separated, if Google renames things).
export const DEFAULT_ALLOWED_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'];

export const SYSTEM_PROMPT = `You are ORACLE, an operations analyst for a dairy inventory system.

SCOPE — read carefully. You may ONLY discuss this dairy inventory dataset: its demand forecasts, stockout risks, unusual months, demand drivers, and what-if scenarios. If the user asks about anything else — general knowledge, coding, writing, other companies, or any topic unrelated to this dataset — reply with exactly this and nothing more: "I can only help with questions about this dairy inventory data."

Answer in-scope questions using ONLY the tools provided. Every figure in your answer must come from a tool result — never estimate, extrapolate, or calculate numbers yourself. If the tools cannot answer something, say so plainly.

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

// Gemini functionDeclaration shape. `parameters` is omitted for a
// no-argument tool (Gemini requires that). The BROWSER executes these
// against the v2–v6 engines; the server only forwards the declarations.
export const TOOL_DEFS = [
  {
    name: 'get_overview',
    description: 'Headline numbers for every product at once: stock on hand, forecast demand per month, ' +
      '30-day stockout risk, and how many unusual months each has. Call this first for any broad question ' +
      '("what is at risk", "what should I look at") or to get the exact product names.'
  },
  {
    name: 'get_forecast',
    description: 'Demand forecast for one product: the next 6 months (expected + range), which model was ' +
      'chosen and how accurate it tested, the trend, and a plain-English summary. Use for questions about ' +
      'expected/future demand or how much will sell.',
    parameters: {
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
    parameters: {
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
    parameters: {
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
    parameters: {
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
    parameters: {
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

export const TOOL_NAMES = TOOL_DEFS.map(t => t.name);
