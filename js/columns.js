// Column detection for user-uploaded inventory spreadsheets.
import { normalizeHeader } from './utils.js';

export const COLUMN_ALIASES = {
  name: ['product name', 'product', 'item', 'item name', 'name', 'sku name', 'product/item', 'description'],
  stock: ['current stock', 'stock', 'quantity', 'qty', 'current qty', 'on hand', 'stock on hand', 'inventory', 'current inventory', 'units in stock', 'stock level'],
  minStock: ['min stock', 'minimum stock', 'safety stock', 'min qty', 'low stock threshold', 'minimum quantity', 'critical stock level', 'min level'],
  reorderPoint: ['reorder point', 'reorder level', 'rop', 'reorder threshold', 'reorder trigger', 'reorder qty threshold'],
  expiration: ['expiration date', 'expiry date', 'exp date', 'best by', 'use by', 'sell by', 'expires', 'expiration', 'best before', 'best before date'],
  reorderQty: ['reorder qty', 'reorder quantity', 'order qty', 'order quantity', 'suggested order qty'],
  parLevel: ['par level', 'max stock', 'target stock', 'max qty', 'par', 'target quantity'],
  unit: ['unit', 'uom', 'units', 'unit of measure'],
  category: ['category', 'type', 'product type', 'product category'],
  salesRate: ['sales rate', 'avg daily sales', 'average daily sales', 'daily sales', 'daily sales rate', 'units sold per day', 'avg sales per day', 'sales velocity', 'avg daily usage', 'daily usage', 'usage rate', 'avg daily demand', 'daily demand']
};

export function detectColumns(headers) {
  const normalized = headers.map(normalizeHeader);
  const map = {};
  for (const field of Object.keys(COLUMN_ALIASES)) {
    const aliases = COLUMN_ALIASES[field];
    let foundIdx = -1;
    for (let i = 0; i < normalized.length; i++) {
      if (aliases.includes(normalized[i])) { foundIdx = i; break; }
    }
    if (foundIdx !== -1) map[field] = headers[foundIdx];
  }
  return map;
}
