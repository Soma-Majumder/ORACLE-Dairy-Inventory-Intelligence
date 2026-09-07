// ORACLE — dashboard shell: app state, rendering, and DOM wiring.
import { daysBetween, escapeHtml, toNumber } from './utils.js';
import {
  IngestError,
  readFileToWorkbook,
  workbookToJson,
  normalizeInventoryRows,
  aggregateOpenSourceRows,
  fetchSampleRawRows
} from './ingest.js';
import { buildDemandSeries } from './timeseries.js';
import { renderDemandPreview } from './demand-preview.js';
import { renderStockoutView } from './stockout-view.js';
import { renderAnomalyView } from './anomaly-view.js';
import { buildFactorIndex } from './reasoning.js';
import { renderReasoningView } from './reasoning-view.js';
import { renderWhatIfView } from './whatif-view.js';

const state = {
  rows: [],
  columns: {},
  fileName: '',
  reviewed: new Set(),
  referenceDate: null,
  demand: null,          // output of buildDemandSeries when the bundled dataset is loaded
  stockByProduct: null,  // current stock summed across brands, keyed by base product name
  factorIndex: null      // per-product transactions by channel/region/brand (v5)
};

// "Milk (Amul)" -> "Milk"
function baseProductName(name) {
  return String(name).replace(/\s*\([^()]*\)\s*$/, '').trim();
}

function sumStockByProduct(aggregatedRows) {
  const map = {};
  for (const row of aggregatedRows) {
    const base = baseProductName(row['Product Name']);
    const stock = toNumber(row['Current Stock']);
    if (!base || stock == null) continue;
    map[base] = (map[base] || 0) + stock;
  }
  return map;
}

function renderPredictivePanels() {
  renderDemandPreview(state.demand);
  const horizon = Number($('stockoutHorizon') && $('stockoutHorizon').value) || 30;
  renderStockoutView(state.demand, state.stockByProduct, horizon);
  renderAnomalyView(state.demand);
  renderReasoningView(state.demand, state.factorIndex);
  renderWhatIfView(state.demand, state.stockByProduct);
}

const $ = (id) => document.getElementById(id);

// --- Error banner --------------------------------------------------------

function showError(msg) {
  const el = $('errorBanner');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearError() {
  $('errorBanner').classList.add('hidden');
  $('errorBanner').textContent = '';
}

// --- Loading data -------------------------------------------------------

function applyInventory({ rows, columns }, fileName, referenceDate) {
  state.columns = columns;
  state.fileName = fileName;
  state.referenceDate = referenceDate || null;
  state.rows = rows;
  state.reviewed = new Set();

  clearError();
  $('fileName').textContent = fileName;
  $('uploadCard').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  render();
}

async function loadFile(file) {
  try {
    const workbook = await readFileToWorkbook(file);
    const json = workbookToJson(workbook);
    const normalized = normalizeInventoryRows(json);
    state.demand = null;
    state.stockByProduct = null;
    state.factorIndex = null;
    renderPredictivePanels();
    applyInventory(normalized, file.name);
  } catch (err) {
    showError(err instanceof IngestError ? err.message
      : 'Could not read that file. Make sure it is a valid .xlsx, .xls, or .csv spreadsheet.');
  }
}

async function loadOpenSourceDataset() {
  try {
    const { rawRows, referenceDate } = await fetchSampleRawRows();

    // Snapshot view (existing dashboard).
    const aggregated = aggregateOpenSourceRows(rawRows);
    const normalized = normalizeInventoryRows(aggregated);
    const asOf = referenceDate ? ', as of ' + referenceDate.toLocaleDateString() : '';
    const label = 'dairy_dataset.csv (' + aggregated.length +
      ' products by brand, latest batch each' + asOf + ')';

    // Demand history (v2 data-prep) + current stock by product (v3 join)
    // + per-product factor breakdown for reasoning (v5).
    state.demand = buildDemandSeries(rawRows, { bucket: 'month' });
    state.stockByProduct = sumStockByProduct(aggregated);
    state.factorIndex = buildFactorIndex(rawRows);

    applyInventory(normalized, label, referenceDate);
    renderPredictivePanels();
  } catch (err) {
    showError(err instanceof IngestError ? err.message
      : 'Could not load the open-source dataset.');
  }
}

// --- Cell + badge helpers ---------------------------------------------

function badge(label, level) {
  return '<span class="badge ' + level + '">' + label + '</span>';
}

function nameCell(r) {
  return '<span class="name' + (state.reviewed.has(r.id) ? ' is-reviewed' : '') + '">' +
    escapeHtml(r.name) + '</span>';
}

function stockoutNameCell(r) {
  let html = nameCell(r);
  if (r.minStock !== null && r.stock !== null && r.stock > r.minStock) {
    html += '<div class="stockout-hint">Above min stock &mdash; selling fast</div>';
  }
  return html;
}

function stockoutBadge(days) {
  if (days === null) return '&mdash;';
  const label = days + (days === 1 ? ' DAY LEFT' : ' DAYS LEFT');
  if (days <= 3) return badge(label, 'critical');
  if (days <= 7) return badge(label, 'serious');
  if (days <= 14) return badge(label, 'warning');
  return badge(label, 'good');
}

function reorderStatusBadge(r, stockoutThreshold) {
  const isUrgent = r.stockoutDays === null || r.stockoutDays <= stockoutThreshold;
  return isUrgent ? badge('REORDER NOW', 'serious') : badge('BELOW REORDER POINT', 'warning');
}

function rateCell(rate, unit) {
  if (rate === null) return '&mdash;';
  const formatted = Number.isInteger(rate) ? rate : rate.toFixed(2);
  return formatted + ' ' + (unit ? escapeHtml(unit) : 'units') + '/day';
}

function statusCell(id, originalBadgeHtml) {
  return state.reviewed.has(id) ? badge('REVIEWED', 'good') : originalBadgeHtml;
}

function reviewCell(id) {
  if (state.reviewed.has(id)) {
    return '<span class="review-done">&#10003; Reviewed <button type="button" class="undo-link" ' +
      'data-action="undo-review" data-id="' + id + '">undo</button></span>';
  }
  return '<button type="button" class="review-btn" data-action="mark-review" data-id="' + id + '">Mark reviewed</button>';
}

function renderMissingNote(field, label) {
  return '<div class="missing-note">No <code>' + label + '</code> column was found, so this section can\'t be ' +
    'calculated. Add one to your spreadsheet and re-upload to see it.</div>';
}

function renderEmpty(msg) {
  return '<div class="empty-section"><span class="check">&#10003;</span>' + msg + '</div>';
}

function numCell(n, unit) {
  if (n === null || n === undefined) return '&mdash;';
  const formatted = Number.isInteger(n) ? n : n.toFixed(2);
  return formatted + (unit ? ' ' + escapeHtml(unit) : '');
}

function renderTable(headers, rowsData, numericCols, mutedCols) {
  let html = '<table><thead><tr>';
  headers.forEach((h, i) => { html += '<th class="' + (numericCols[i] ? 'num' : '') + '">' + h + '</th>'; });
  html += '</tr></thead><tbody>';
  rowsData.forEach(({ id, cells }) => {
    const muted = state.reviewed.has(id);
    html += '<tr>';
    cells.forEach((c, i) => {
      const classes = [numericCols[i] ? 'num' : '', muted && mutedCols[i] ? 'is-reviewed-muted' : '']
        .filter(Boolean).join(' ');
      html += '<td class="' + classes + '">' + c + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  return html;
}

// --- Main render -------------------------------------------------------

function render() {
  const rows = state.rows;
  const cols = state.columns;
  const today = state.referenceDate || new Date();
  const expiryThreshold = Number($('expiryDays').value) || 7;
  const stockoutThreshold = Number($('stockoutDays').value) || 14;

  $('totalCount').textContent = rows.length;

  // Stockout forecast
  const stockoutBody = $('stockoutBody');
  if (!cols.salesRate) {
    stockoutBody.innerHTML = renderMissingNote('salesRate', 'Sales Rate (or Avg Daily Sales)');
    $('statStockout').textContent = '—';
  } else {
    const stockoutRows = rows
      .filter(r => r.stockoutDays !== null && r.stockoutDays <= stockoutThreshold)
      .sort((a, b) => a.stockoutDays - b.stockoutDays);
    $('statStockout').textContent = stockoutRows.length;
    if (!stockoutRows.length) {
      stockoutBody.innerHTML = renderEmpty('No products are projected to run out soon.');
    } else {
      stockoutBody.innerHTML = renderTable(
        ['Product', 'Category', 'Current Stock', 'Sales Rate', 'Days Until Stockout', 'Review'],
        stockoutRows.map(r => ({ id: r.id, cells: [
          stockoutNameCell(r),
          escapeHtml(r.category) || '&mdash;',
          numCell(r.stock, r.unit),
          rateCell(r.salesRate, r.unit),
          statusCell(r.id, stockoutBadge(r.stockoutDays)),
          reviewCell(r.id)
        ] })),
        [false, false, true, true, false, false],
        [false, true, true, true, false, false]
      );
    }
  }

  // Low stock
  const lowStockBody = $('lowStockBody');
  if (!cols.minStock && !cols.reorderPoint) {
    lowStockBody.innerHTML = renderMissingNote('minStock', 'Min Stock (or Reorder Point)');
    $('statLowStock').textContent = '—';
  } else {
    const lowStockRows = rows
      .filter(r => r.stock !== null && r.minStock !== null && r.stock <= r.minStock)
      .sort((a, b) => (a.stock - a.minStock) - (b.stock - b.minStock));
    $('statLowStock').textContent = lowStockRows.length;
    if (!lowStockRows.length) {
      lowStockBody.innerHTML = renderEmpty('No products are low on stock.');
    } else {
      const headers = ['Product', 'Category', 'Current Stock', 'Min Stock'];
      const numericCols = [false, false, true, true];
      const mutedCols = [false, true, true, true];
      if (cols.salesRate) { headers.push('Days Until Stockout'); numericCols.push(true); mutedCols.push(false); }
      headers.push('Status', 'Review'); numericCols.push(false, false); mutedCols.push(false, false);

      lowStockBody.innerHTML = renderTable(
        headers,
        lowStockRows.map(r => {
          const cells = [
            nameCell(r),
            escapeHtml(r.category) || '&mdash;',
            numCell(r.stock, r.unit),
            numCell(r.minStock, r.unit)
          ];
          if (cols.salesRate) cells.push(stockoutBadge(r.stockoutDays));
          cells.push(
            statusCell(r.id, r.stock <= 0 ? badge('OUT OF STOCK', 'critical') : badge('LOW STOCK', 'serious')),
            reviewCell(r.id)
          );
          return { id: r.id, cells };
        }),
        numericCols,
        mutedCols
      );
    }
  }

  // Nearing expiration
  const expiringBody = $('expiringBody');
  $('expiringSubtitle').textContent = 'Products expired or expiring within ' + expiryThreshold +
    ' day' + (expiryThreshold === 1 ? '' : 's') + '.';
  if (!cols.expiration) {
    expiringBody.innerHTML = renderMissingNote('expiration', 'Expiration Date');
    $('statExpiring').textContent = '—';
  } else {
    const expiringRows = rows
      .filter(r => r.expiration !== null)
      .map(r => ({ ...r, daysLeft: daysBetween(today, r.expiration) }))
      .filter(r => r.daysLeft <= expiryThreshold)
      .sort((a, b) => a.daysLeft - b.daysLeft);
    $('statExpiring').textContent = expiringRows.length;
    if (!expiringRows.length) {
      expiringBody.innerHTML = renderEmpty('No products are expiring soon.');
    } else {
      const headers = ['Product', 'Category', 'Expiration Date', 'Days Left'];
      const numericCols = [false, false, false, true];
      const mutedCols = [false, true, true, true];
      if (cols.salesRate) { headers.push('Days Until Stockout'); numericCols.push(true); mutedCols.push(false); }
      headers.push('Status', 'Review'); numericCols.push(false, false); mutedCols.push(false, false);

      expiringBody.innerHTML = renderTable(
        headers,
        expiringRows.map(r => {
          const cells = [
            nameCell(r),
            escapeHtml(r.category) || '&mdash;',
            r.expiration.toLocaleDateString(),
            r.daysLeft < 0
              ? (Math.abs(r.daysLeft) + (Math.abs(r.daysLeft) === 1 ? ' day ago' : ' days ago'))
              : (r.daysLeft === 0 ? 'Today' : r.daysLeft + (r.daysLeft === 1 ? ' day' : ' days'))
          ];
          if (cols.salesRate) cells.push(stockoutBadge(r.stockoutDays));
          cells.push(
            statusCell(r.id, r.daysLeft < 0 ? badge('EXPIRED', 'critical') : badge('EXPIRING SOON', 'warning')),
            reviewCell(r.id)
          );
          return { id: r.id, cells };
        }),
        numericCols,
        mutedCols
      );
    }
  }

  // Needs reordering
  const reorderBody = $('reorderBody');
  if (!cols.reorderPoint && !cols.minStock) {
    reorderBody.innerHTML = renderMissingNote('reorderPoint', 'Reorder Point (or Min Stock)');
    $('statReorder').textContent = '—';
  } else {
    const reorderRows = rows
      .filter(r => r.stock !== null && r.reorderPoint !== null && r.stock <= r.reorderPoint)
      .map(r => {
        let suggested = null;
        if (r.reorderQty !== null) suggested = r.reorderQty;
        else if (r.parLevel !== null) suggested = Math.max(0, r.parLevel - r.stock);
        return { ...r, suggested };
      })
      .sort((a, b) => (a.stock - a.reorderPoint) - (b.stock - b.reorderPoint));
    $('statReorder').textContent = reorderRows.length;
    if (!reorderRows.length) {
      reorderBody.innerHTML = renderEmpty('No products need reordering right now.');
    } else {
      const headers = ['Product', 'Category', 'Current Stock', 'Reorder Point', 'Suggested Order'];
      const numericCols = [false, false, true, true, true];
      const mutedCols = [false, true, true, true, true];
      if (cols.salesRate) { headers.push('Days Until Stockout'); numericCols.push(true); mutedCols.push(false); }
      headers.push('Status', 'Review'); numericCols.push(false, false); mutedCols.push(false, false);

      reorderBody.innerHTML = renderTable(
        headers,
        reorderRows.map(r => {
          const cells = [
            nameCell(r),
            escapeHtml(r.category) || '&mdash;',
            numCell(r.stock, r.unit),
            numCell(r.reorderPoint, r.unit),
            r.suggested !== null ? numCell(r.suggested, r.unit) : '&mdash;'
          ];
          if (cols.salesRate) cells.push(stockoutBadge(r.stockoutDays));
          cells.push(
            statusCell(r.id, reorderStatusBadge(r, stockoutThreshold)),
            reviewCell(r.id)
          );
          return { id: r.id, cells };
        }),
        numericCols,
        mutedCols
      );
    }
  }

  // Total needing action (union, de-duplicated by name)
  const actionNames = new Set();
  rows.forEach(r => {
    const isLow = r.stock !== null && r.minStock !== null && r.stock <= r.minStock;
    const isExpiring = r.expiration !== null && daysBetween(today, r.expiration) <= expiryThreshold;
    const isReorder = r.stock !== null && r.reorderPoint !== null && r.stock <= r.reorderPoint;
    const isStockoutRisk = r.stockoutDays !== null && r.stockoutDays <= stockoutThreshold;
    if (isLow || isExpiring || isReorder || isStockoutRisk) actionNames.add(r.name + '|' + rows.indexOf(r));
  });
  $('statTotalAction').textContent = actionNames.size;
}

// --- Template download ------------------------------------------------

function downloadTemplate() {
  const data = [
    ['Product Name', 'Category', 'Current Stock', 'Min Stock', 'Reorder Point', 'Reorder Qty', 'Expiration Date', 'Unit', 'Sales Rate'],
    ['Whole Milk 1 Gal', 'Milk', 24, 20, 35, 60, '2026-08-01', 'gal', 5],
    ['Cheddar Cheese Block', 'Cheese', 12, 10, 16, 25, '2026-10-15', 'block', 0.5]
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
  XLSX.writeFile(wb, 'dairy-inventory-template.xlsx');
}

// --- Wiring ----------------------------------------------------------

function init() {
  const dropzone = $('dropzone');
  const fileInput = $('fileInput');

  $('browseBtn').addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
  });
  ['dragover', 'dragenter'].forEach(evt => dropzone.addEventListener(evt, (e) => {
    e.preventDefault(); dropzone.classList.add('drag-over');
  }));
  ['dragleave', 'drop'].forEach(evt => dropzone.addEventListener(evt, (e) => {
    e.preventDefault(); dropzone.classList.remove('drag-over');
  }));
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });
  $('sampleBtn').addEventListener('click', loadOpenSourceDataset);
  $('templateBtn').addEventListener('click', downloadTemplate);
  $('newFileBtn').addEventListener('click', () => {
    state.rows = []; state.columns = {}; state.reviewed = new Set();
    state.referenceDate = null; state.demand = null; state.stockByProduct = null;
    state.factorIndex = null;
    fileInput.value = '';
    clearError();
    renderPredictivePanels();
    $('dashboard').classList.add('hidden');
    $('uploadCard').classList.remove('hidden');
  });
  $('expiryDays').addEventListener('input', render);
  $('stockoutDays').addEventListener('input', render);
  if ($('stockoutHorizon')) {
    $('stockoutHorizon').addEventListener('input', () => {
      renderStockoutView(state.demand, state.stockByProduct, Number($('stockoutHorizon').value) || 30);
    });
  }
  $('dashboard').addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const id = Number(target.dataset.id);
    if (target.dataset.action === 'mark-review') state.reviewed.add(id);
    else if (target.dataset.action === 'undo-review') state.reviewed.delete(id);
    render();
  });

  // Expose for console inspection / future modules.
  window.ORACLE = { state, buildDemandSeries };
}

init();
