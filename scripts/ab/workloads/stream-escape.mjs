// Workload for scripts/ab/ab.mjs (log 36.F57): the stream parser over a document of `\uXXXX` escapes,
// as an ensure_ascii encoder writes CJK text. Rows: escapes; plain, the same length with no escape,
// is the control (handleHex does not run).
import { StreamParser } from '__DIST__/stream-parser.js';

const escaped = `{"text":"${'\\u4f60\\u597d\\u4e16\\u754c'.repeat(16)}"}`;
const plainDoc = `{"text":"${'abcdefghijklmnopqrstuvwx'.repeat(16)}"}`;
let seen = 0;
const parser = new StreamParser({ onValue: (_p, v) => { seen += v.length; } });
const run = (doc, n) => { for (let i = 0; i < n; i++) { parser.reset(); parser.write(doc); parser.end?.(); } return seen; };
export const N = { escapes: 5_000, plain_doc: 5_000 };
export const escapes = (n) => run(escaped, n);
export const plain_doc = (n) => run(plainDoc, n);
export const check = () => { seen = 0; run(escaped, 1); if (seen === 0) throw new Error('no value parsed'); return [seen]; };
