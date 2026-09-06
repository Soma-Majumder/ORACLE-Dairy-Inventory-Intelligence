// Reading spreadsheets and turning them into normalized inventory rows.
// No DOM here — callers handle state and rendering.
import { parseDate, toNumber, computeStockoutDays } from './utils.js';
import { detectColumns } from './columns.js';

export const SAMPLE_CSV_PATH = 'data/dairy_dataset.csv';

// Thrown when a spreadsheet can't be used. `.message` is user-facing.
export class IngestError extends Error {}

export function readFileToWorkbook(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        resolve(XLSX.read(data, { type: 'array', cellDates: true }));
      } catch (err) {
        reject(new IngestError('Could not read that file. Make sure it is a valid .xlsx, .xls, or .csv spreadsheet.'));
      }
    };
    reader.onerror = () => reject(new IngestError('Could not read that file.'));
    reader.readAsArrayBuffer(file);
  });
}

export function workbookToJson(workbook) {
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
}

// json: array of plain objects (first sheet). Returns { rows, columns }.
// Throws IngestError with a user-facing message when the sheet is unusable.
export function normalizeInventoryRows(json) {
  if (!json.length) {
    throw new IngestError('That spreadsheet looks empty — no rows were found on the first sheet.');
  }
  const headers = Object.keys(json[0]);
  const columns = detectColumns(headers);

  if (!columns.name || !columns.stock) {
    throw new IngestError(
      'Could not find a product name and/or current stock column. Detected headers: ' +
      headers.join(', ') + '. Try the template for the expected column names.'
    );
  }

  const rows = json.map((row, idx) => {
    const stock = toNumber(row[columns.stock]);
    const minStockRaw = columns.minStock ? toNumber(row[columns.minStock]) : null;
    const reorderPointRaw = columns.reorderPoint ? toNumber(row[columns.reorderPoint]) : null;
    const minStock = minStockRaw !== null ? minStockRaw : reorderPointRaw;
    const reorderPoint = reorderPointRaw !== null ? reorderPointRaw : minStockRaw;
    const parLevel = columns.parLevel ? toNumber(row[columns.parLevel]) : null;
    const reorderQty = columns.reorderQty ? toNumber(row[columns.reorderQty]) : null;
    const salesRate = columns.salesRate ? toNumber(row[columns.salesRate]) : null;
    return {
      id: idx,
      name: String(row[columns.name] ?? '').trim() || '(unnamed product)',
      stock,
      minStock,
      reorderPoint,
      expiration: columns.expiration ? parseDate(row[columns.expiration]) : null,
      reorderQty,
      parLevel,
      salesRate,
      stockoutDays: computeStockoutDays(stock, salesRate),
      unit: columns.unit ? String(row[columns.unit] ?? '').trim() : '',
      category: columns.category ? String(row[columns.category] ?? '').trim() : ''
    };
  }).filter(r => r.stock !== null || r.expiration !== null);

  return { rows, columns };
}

// --- Bundled open-source dairy dataset (Kaggle) -----------------------------

// Collapse the transactional dairy dataset into one row per Product+Brand,
// using the latest batch for stock levels and deriving a sales rate from history.
export function aggregateOpenSourceRows(rawRows) {
  const groups = new Map();
  for (const row of rawRows) {
    const productName = String(row['Product Name'] ?? '').trim();
    const brand = String(row['Brand'] ?? '').trim();
    if (!productName) continue;
    const key = productName + '|' + brand;
    if (!groups.has(key)) groups.set(key, { productName, brand, batches: [] });
    groups.get(key).batches.push(row);
  }

  const aggregated = [];
  for (const { productName, brand, batches } of groups.values()) {
    const withDate = batches
      .map(b => ({ row: b, date: parseDate(b['Date']) }))
      .filter(b => b.date !== null)
      .sort((a, b) => b.date.getTime() - a.date.getTime());
    const latest = (withDate.length ? withDate[0].row : batches[batches.length - 1]);

    let salesRate = null;
    if (withDate.length >= 2) {
      const oldest = withDate[withDate.length - 1].date;
      const newest = withDate[0].date;
      const spanDays = Math.max(Math.round((newest - oldest) / (24 * 60 * 60 * 1000)), 1);
      const totalSold = withDate.reduce((sum, b) => sum + (toNumber(b.row['Quantity Sold (liters/kg)']) || 0), 0);
      salesRate = totalSold / spanDays;
    }

    aggregated.push({
      'Product Name': productName + (brand ? ' (' + brand + ')' : ''),
      'Category': String(latest['Storage Condition'] ?? '').trim(),
      'Current Stock': latest['Quantity in Stock (liters/kg)'],
      'Min Stock': latest['Minimum Stock Threshold (liters/kg)'],
      'Reorder Qty': latest['Reorder Quantity (liters/kg)'],
      'Expiration Date': parseDate(latest['Expiration Date']),
      'Sales Rate': salesRate !== null ? Math.round(salesRate * 100) / 100 : '',
      'Unit': 'kg/L'
    });
  }
  return aggregated;
}

// Fetch and parse the bundled CSV. Returns { rawRows, referenceDate }.
export async function fetchSampleRawRows() {
  let response;
  try {
    response = await fetch(SAMPLE_CSV_PATH);
  } catch (err) {
    throw new IngestError(
      'Could not load ' + SAMPLE_CSV_PATH + '. If you opened this file directly from disk, browsers block that ' +
      'fetch for security reasons — serve the folder with a local web server (e.g. "python3 -m http.server") and reload.'
    );
  }
  if (!response.ok) throw new IngestError('Could not load ' + SAMPLE_CSV_PATH + ' (HTTP ' + response.status + ').');

  const text = await response.text();
  const workbook = XLSX.read(text, { type: 'string' });
  const sheetName = workbook.SheetNames[0];
  const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true })
    .map(row => {
      const trimmed = {};
      for (const key of Object.keys(row)) trimmed[key.trim()] = row[key];
      return trimmed;
    });

  if (!rawRows.length) throw new IngestError('The open-source dataset file appears to be empty.');

  const allDates = rawRows.map(r => parseDate(r['Date'])).filter(d => d !== null);
  const referenceDate = allDates.length ? new Date(Math.max(...allDates.map(d => d.getTime()))) : null;
  return { rawRows, referenceDate };
}
