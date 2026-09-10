# 🧠 ORACLE — Operational Reasoning & Advanced Learning Engine

An evolution of a dairy inventory dashboard into a predictive decision‑intelligence
system. Drop in a spreadsheet (or load the bundled open‑source dataset) and ORACLE
walks from *what happened* → *what's likely to happen* → *why* → *what to do* → a
plain‑English answer to a typed question.

It runs almost entirely in your browser. Your spreadsheet is never uploaded. The
only server‑side piece is a small `/api/ask` endpoint that keeps the language‑model
API key off the client.

**Live demo:** load the page and click **"Load open-source dairy dataset."**

---

## The evolution

| Version | Question it answers | What it adds |
|--------:|---------------------|--------------|
| **v1 — Dashboard** | What happened? | Stock, expiry, reorder and stockout alerts from a spreadsheet |
| **v2 — Forecasting** | What is likely to happen? | Per‑product monthly demand forecasts (seasonal‑naïve / exponential smoothing / Holt‑Winters / Croston), auto‑selected by walk‑forward back‑test, with prediction intervals |
| **v3 — Stockout probability** | Will we run out? | Monte‑Carlo simulation of daily demand vs. stock on hand → probability, timing, expected unmet demand |
| **v4 — Anomaly detection** | Was anything unusual? | Robust flagging of spike/drop months and lasting baseline shifts |
| **v5 — Reasoning** | Why is it happening? | Demand broken down by sales channel / customer region / brand; a suggested cause for each unusual month |
| **v6 — What‑if simulator** | What should we do? | Re‑run the stockout simulation with changed demand, an incoming order, or a delivery date; solves for the order that hits a 95% service level |
| **v7 — Ask ORACLE** | *(natural language)* | Type a question → ORACLE runs the right engines, then a language model turns the results into a plain‑English answer for a non‑technical reader |

### The v7 principle

The engines calculate **every** number, trend, percentage and anomaly *before* the
language model is involved. The model is the **interpretation and communication
layer** only — it explains what the analysis means, why it matters, and what to
watch. It never invents a figure, a cause, or a prediction, and it says so when the
data doesn't support a conclusion.

---

## Running it locally

Requires Node 18+.

```bash
npm run dev          # serves http://localhost:4173 (static files + /api/ask)
```

Then open http://localhost:4173.

The dashboard (v1–v6) works with no configuration. **Ask ORACLE (v7)** needs an
API key:

```bash
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY=...   (from https://openrouter.ai/keys)
npm run dev
```

`.env` is gitignored. On start you should see
`serving on http://localhost:4173  (agent: OPENROUTER_API_KEY loaded)`.

### Environment variables

| Variable | Required | Purpose |
|----------|:--------:|---------|
| `OPENROUTER_API_KEY` | for v7 | Server‑side key for the `/api/ask` endpoint |
| `OPENROUTER_MODEL` | no | Model to use (default: `openrouter/free`) |
| `ALLOWED_ORIGIN` | no | Extra origin(s) allowed to call `/api/ask`, comma‑separated |
| `PORT` | no | Local dev server port (default `4173`) |

---

## Architecture

```
spreadsheet ─► browser (ES modules, no build step)
                 │
                 ├─ v1  dashboard.js / ingest.js / columns.js
                 ├─ v2  timeseries.js  → forecast.js
                 ├─ v3  stockout.js         (seeded Monte-Carlo)
                 ├─ v4  anomaly.js
                 ├─ v5  reasoning.js
                 ├─ v6  whatif.js
                 └─ v7  agent.js  ─ gathers a computed "analysis bundle"
                                     │
                                     ▼  POST { question, analysis }
                        /api/ask  ◄── openrouter-proxy.mjs
                        (server)      · origin gate · rate limit · size caps
                                      · adds OPENROUTER_API_KEY
                                      · one chat/completions call
                                      · strips any chain-of-thought
                                     │
                                     ▼
                              OpenRouter → free model → plain-English answer
```

- **No backend for v1–v6.** Pure client‑side JavaScript; forecasting and simulation
  run in the tab.
- **`/api/ask`** runs as a [Vercel serverless function](api/ask.mjs) in production
  and inside the [local dev server](.claude/serve.mjs) in development — both share
  [`js/openrouter-proxy.mjs`](js/openrouter-proxy.mjs). It only accepts a
  `{ question, analysis }` payload carrying ORACLE's own engine output, is
  origin‑gated and rate‑limited, and never lets the client choose the model — so it
  can't be repurposed as a general‑purpose LLM proxy.

---

## Data

`data/dairy_dataset.csv` — an open dairy dataset from Kaggle (~4,300 transaction
rows, 10 products, 2019–2022, with per‑transaction location, brand, channel, and
sales figures). It is **synthetic**, so demand‑driver breakdowns often look
near‑even and the forecasts should be read as illustrative. ORACLE says as much in
its answers.

You can also upload your own `.xlsx` / `.xls` / `.csv` — click **"Download a blank
template"** for the expected columns.

---

## Deploying

Static site + one serverless function → deploys to Vercel with zero config
(`api/*.mjs` become functions, everything else is served static). Set
`OPENROUTER_API_KEY` in the Vercel project's **Environment Variables**.

---

## Roadmap

- **v7b — Investigate:** multi‑step analysis ("look into Cheese") that chains
  detect → explain → forecast → recommend into a short written brief.
