const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g');
const ZERO_WIDTH = /[̀-ͯ​-‏⁠﻿]/;
const NUMERIC = /^[+-]?[\d,_]*\.?\d+(?:[eE][+-]?\d+)?\s*(?:%|ms|s|m|h|B|KB|MB|GB|x)?$/;

const BOX = {
  topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘',
  left: '├', right: '┤', top: '┬', bottom: '┴', cross: '┼', h: '─', v: '│',
};

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function visualWidth(text) {
  let width = 0;
  for (const char of String(text).replace(ANSI, '')) {
    if (ZERO_WIDTH.test(char)) continue;
    width += isWide(char.codePointAt(0)) ? 2 : 1;
  }
  return width;
}

export function truncate(text, max, ellipsis = '…') {
  const str = String(text);
  if (visualWidth(str) <= max) return str;
  const room = Math.max(0, max - visualWidth(ellipsis));
  let out = '';
  let width = 0;
  for (const char of str.replace(ANSI, '')) {
    const w = isWide(char.codePointAt(0)) ? 2 : 1;
    if (width + w > room) break;
    out += char;
    width += w;
  }
  return out + ellipsis;
}

function pad(text, width, align) {
  const gap = Math.max(0, width - visualWidth(text));
  if (align === 'right') return ' '.repeat(gap) + text;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + text + ' '.repeat(gap - left);
  }
  return text + ' '.repeat(gap);
}

function cell(value) {
  return value === null || value === undefined ? '' : String(value);
}

function columnsOf(data) {
  const seen = new Set();
  for (const row of data) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

function alignmentOf(data, header, override) {
  if (override?.[header]) return override[header];
  const values = data.map((row) => cell(row[header]).replace(ANSI, '').trim()).filter(Boolean);
  if (values.length === 0) return 'left';
  return values.every((v) => NUMERIC.test(v)) ? 'right' : 'left';
}

export function asciiTable(data, title = null, options = {}) {
  if (!Array.isArray(data) || data.length === 0) return '';

  const { maxWidth = Number.POSITIVE_INFINITY, align: alignOverride, footer } = options;
  const headers = options.columns ?? columnsOf(data);
  if (headers.length === 0) return '';

  const align = Object.fromEntries(headers.map((h) => [h, alignmentOf(data, h, alignOverride)]));
  const rows = data.map((row) =>
    Object.fromEntries(headers.map((h) => [h, truncate(cell(row[h]), maxWidth)])),
  );

  const widths = headers.map((header) =>
    Math.max(visualWidth(header), ...rows.map((row) => visualWidth(row[header]))),
  );

  let inner = widths.reduce((sum, w) => sum + w + 3, -1);
  if (title) {
    const needed = visualWidth(title) + 2;
    if (needed > inner) {
      widths[widths.length - 1] += needed - inner;
      inner = needed;
    }
  }

  const rule = (left, join, right) =>
    left + widths.map((w) => BOX.h.repeat(w + 2)).join(join) + right;
  const line = (cells) =>
    `${BOX.v} ${headers.map((h, i) => pad(cells[h], widths[i], align[h])).join(` ${BOX.v} `)} ${BOX.v}`;

  const out = [];
  if (title) {
    out.push(BOX.topLeft + BOX.h.repeat(inner) + BOX.topRight);
    out.push(`${BOX.v} ${pad(title, inner - 2, 'center')} ${BOX.v}`);
    out.push(rule(BOX.left, BOX.top, BOX.right));
  } else {
    out.push(rule(BOX.topLeft, BOX.top, BOX.topRight));
  }
  out.push(line(Object.fromEntries(headers.map((h) => [h, h]))));
  out.push(rule(BOX.left, BOX.cross, BOX.right));
  for (const row of rows) out.push(line(row));
  if (footer) {
    out.push(rule(BOX.left, BOX.bottom, BOX.right));
    out.push(`${BOX.v} ${pad(footer, inner - 2, 'left')} ${BOX.v}`);
    out.push(BOX.bottomLeft + BOX.h.repeat(inner) + BOX.bottomRight);
  } else {
    out.push(rule(BOX.bottomLeft, BOX.bottom, BOX.bottomRight));
  }
  return out.join('\n');
}

export function logTable(data, title = null, options = {}) {
  const table = asciiTable(data, title, options);
  if (table) console.log(table);
  return table;
}

export default asciiTable;
