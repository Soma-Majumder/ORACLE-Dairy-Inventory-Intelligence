// Pure helpers — no DOM, no app state. Safe to import anywhere.

export function normalizeHeader(h) {
  return String(h || '')
    .toLowerCase()
    .trim()
    .replace(/[_\-]/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ');
}

export function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    try {
      // XLSX is a global from the CDN script tag in index.html.
      const d = XLSX.SSF.parse_date_code(value);
      if (d) return new Date(d.y, d.m - 1, d.d);
    } catch (e) { /* fall through */ }
  }
  const d = new Date(String(value).trim());
  return isNaN(d.getTime()) ? null : d;
}

export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[,$]/g, '').trim());
  return isNaN(n) ? null : n;
}

export function daysBetween(a, b) {
  const MS = 24 * 60 * 60 * 1000;
  const d1 = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const d2 = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((d2 - d1) / MS);
}

export function computeStockoutDays(stock, salesRate) {
  if (stock === null) return null;
  if (stock <= 0) return 0;
  if (salesRate === null || salesRate <= 0) return null;
  return Math.floor(stock / salesRate);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
