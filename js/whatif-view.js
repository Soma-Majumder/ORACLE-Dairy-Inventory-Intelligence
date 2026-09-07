// What-If Simulator panel (ORACLE v6). Interactive: adjust demand, add an
// order, change the delivery date or look-ahead window, and see the stockout
// outlook move vs the untouched baseline. Bundled dataset only.
import { escapeHtml } from './utils.js';
import { forecastProduct } from './forecast.js';
import { compareScenario, recommendReorder } from './whatif.js';

const fcCache = new Map();
let wired = false;
let ctx = null;            // { demand, stockByProduct }
let debounceTimer = null;

function getForecast(product) {
  if (!fcCache.has(product.product)) {
    fcCache.set(product.product, forecastProduct(product, { horizon: 6 }));
  }
  return fcCache.get(product.product);
}

function num(n) { return Math.round(n).toLocaleString(); }

function pctBadge(p) {
  const cls = p >= 0.5 ? 'critical' : p >= 0.2 ? 'serious' : p >= 0.05 ? 'warning' : 'good';
  return '<span class="badge ' + cls + '">' + Math.round(p * 100) + '%</span>';
}

function runOutText(sim, H) {
  return (sim.pStockout < 0.5 || sim.daysUntilStockout.p50 == null)
    ? 'beyond ' + H + ' days'
    : '~ day ' + sim.daysUntilStockout.p50;
}

function row(label, a, b, changed) {
  return '<tr><td>' + label + '</td><td>' + a + '</td><td>' +
    (changed ? b : '<span class="muted">no change</span>') + '</td></tr>';
}

function recommendationText(rec, demandPct) {
  const demandNote = demandPct !== 0
    ? ' (assuming demand ' + (demandPct > 0 ? '+' : '') + demandPct + '%)'
    : '';
  if (!rec.needed) {
    return '<strong>&#10003; No order needed.</strong> Current stock covers the window' + demandNote +
      ' — stockout risk is about ' + Math.round(rec.currentP * 100) + '%.';
  }
  if (rec.achievable === false) {
    const faster = rec.fasterLead
      ? ' A delivery within <strong>' + rec.fasterLead + ' day' + (rec.fasterLead === 1 ? '' : 's') + '</strong> would.'
      : ' You would need a faster delivery.';
    return '<strong>&#9888; A bigger order alone won’t fix this.</strong> With a ' + rec.leadDays +
      '-day delivery there’s still about <strong>' + Math.round(rec.floorP * 100) +
      '%</strong> chance of running out before it arrives' + demandNote + '.' + faster;
  }
  return '<strong>Recommended:</strong> order about <strong>' + num(rec.qty) + ' units</strong> arriving within ' +
    rec.leadDays + ' day' + (rec.leadDays === 1 ? '' : 's') + ' — that pulls stockout risk down to ~' +
    Math.round(rec.resultingP * 100) + '%' + demandNote + '.';
}

function renderResults() {
  const results = document.getElementById('wiResults');
  if (!results || !ctx) return;

  const sel = document.getElementById('wiProduct').value;
  const product = ctx.demand.products.find(p => p.product === sel);
  const stock = ctx.stockByProduct[sel];
  if (!product || stock == null) { results.innerHTML = ''; return; }

  const demandPct = Number(document.getElementById('wiDemand').value) || 0;
  const qty = Math.max(0, Number(document.getElementById('wiQty').value) || 0);
  const lead = Math.max(0, Number(document.getElementById('wiLead').value) || 0);
  const H = Math.min(120, Math.max(7, Number(document.getElementById('wiHorizon').value) || 30));
  document.getElementById('wiDemandVal').textContent = (demandPct > 0 ? '+' : '') + demandPct + '%';

  const f = getForecast(product);
  const mult = 1 + demandPct / 100;
  const scenario = { demandMultiplier: mult, reorderQty: qty, reorderInDays: lead };
  const { baseline, scenario: sc } = compareScenario(f, stock, scenario, { horizonDays: H });
  const rec = recommendReorder(f, stock, {
    horizonDays: H, leadDays: lead || 7, targetService: 0.95, demandMultiplier: mult
  });
  const changed = demandPct !== 0 || qty > 0;

  results.innerHTML =
    '<div class="wi-stockline">On hand: <strong>' + num(stock) + ' units</strong> &middot; ' +
    'forecast use ~' + num(f.mean[0] / 30.44 * mult) + '/day</div>' +
    '<table class="wi-table"><thead><tr>' +
    '<th>Outcome over ' + H + ' days</th><th>As forecast</th><th>With your changes</th>' +
    '</tr></thead><tbody>' +
    row('Chance of stockout', pctBadge(baseline.pStockout), pctBadge(sc.pStockout), changed) +
    row('Runs out', runOutText(baseline, H), runOutText(sc, H), changed) +
    row('Expected unmet demand', num(baseline.expectedUnitsShort) + ' units',
      num(sc.expectedUnitsShort) + ' units', changed) +
    '</tbody></table>' +
    '<div class="wi-rec">' + recommendationText(rec, demandPct) + '</div>';
}

function scheduleRender() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(renderResults, 110);
}

export function renderWhatIfView(demand, stockByProduct) {
  const section = document.getElementById('sectionWhatIf');
  const subtitle = document.getElementById('whatifSubtitle');
  const sel = document.getElementById('wiProduct');
  if (!section || !sel) return;

  if (!demand || !demand.products.length || !stockByProduct) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  fcCache.clear();
  ctx = { demand, stockByProduct };

  const products = demand.products.filter(p => stockByProduct[p.product] != null);
  const prev = sel.value;
  sel.innerHTML = products.map(p => '<option>' + escapeHtml(p.product) + '</option>').join('');
  if (products.some(p => p.product === prev)) sel.value = prev;

  subtitle.innerHTML = 'Change the assumptions and watch the stockout outlook move. Baseline uses the ' +
    'v2 forecast and current stock; each scenario re-runs 4,000 simulated futures.';

  if (!wired) {
    ['wiProduct', 'wiDemand', 'wiQty', 'wiLead', 'wiHorizon'].forEach(id => {
      document.getElementById(id).addEventListener('input', scheduleRender);
    });
    wired = true;
  }
  renderResults();
}
