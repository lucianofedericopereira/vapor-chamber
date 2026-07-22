/**
 * vapor-chamber — streaming JSON parser
 *
 * Adapted from a dependency-free incremental JSON parser (bytes → state
 * machine → values), for progressively consuming a `fetch()` response body
 * (LLM/AI streaming completions, SSE tokens, large exports) without
 * buffering the whole payload. Framework-agnostic — no Vue imports; pair
 * with `http.ts`'s `HttpClient` or a bare `fetch()`.
 *
 * Reorganized from the source's one large dispatch switch into small
 * per-state-group handlers (CDCC: functions stay near cyclomatic complexity
 * 10) — notably, the keyword states (`true`/`false`/`null`) collapse from
 * ten near-duplicate `S_TRUE_1`/`S_FALSE_2`/… cases into one target-string
 * index walk.
 *
 * @example
 * const parser = createStreamParser({ onValue: (key, value, path) => console.log(key, value) });
 * const response = await fetch('/api/stream');
 * await parser.stream(response);
 *
 * @example Manual chunk feeding
 * const parser = createStreamParser({ onValue: (k, v) => items.push(v) });
 * parser.write('{"items":[');
 * parser.write('1,2,3]}');
 * parser.end();
 */

// ============================================================
// Codepoint constants (pre-computed, zero runtime cost)
// ============================================================

const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const QUOTE = 0x22;
const COLON = 0x3a;
const COMMA = 0x2c;
const BACKSLASH = 0x5c;
const SLASH = 0x2f;
const DOT = 0x2e;
const PLUS = 0x2b;
const MINUS = 0x2d;
const ZERO = 0x30;
const ONE = 0x31;
const NINE = 0x39;
const LOWER_A = 0x61;
const LOWER_F = 0x66;
const UPPER_A = 0x41;
const UPPER_F = 0x46;
const LOWER_E = 0x65;
const LOWER_N = 0x6e;
const LOWER_T = 0x74;
const LOWER_U = 0x75;
const SPACE = 0x20;
const TAB = 0x09;
const NEWLINE = 0x0a;
const RETURN = 0x0d;

function isWhitespace(cp: number): boolean {
  return cp === SPACE || cp === TAB || cp === NEWLINE || cp === RETURN;
}

function isDigit(cp: number): boolean {
  return cp >= ZERO && cp <= NINE;
}

// ============================================================
// Parser states
// ============================================================

// Plain numeric constants, not `const enum` — esbuild/Rolldown (this
// project's bundlers) don't support const enums in isolated-file transpiles.
const S_VALUE = 0;
const S_AFTER_VALUE = 1;
const S_KEY = 2;
const S_AFTER_KEY = 3;
const S_STRING = 4;
const S_ESCAPE = 5;
const S_HEX = 6;
const S_NUM_MINUS = 7;
const S_NUM_ZERO = 8;
const S_NUM_DIGIT = 9;
const S_NUM_DOT = 10;
const S_NUM_FRAC = 11;
const S_NUM_EXP = 12;
const S_NUM_EXP_SIGN = 13;
const S_NUM_EXP_DIGIT = 14;
const S_KEYWORD = 15;
const S_DONE = 16;

const PARENT_TOP = 0;
const PARENT_OBJECT = 1;
const PARENT_ARRAY = 2;

// ============================================================
// String buffer — avoids += string-concat GC pressure
// ============================================================

class StringBuffer {
  private buf: Uint16Array;
  private len = 0;

  constructor(initialSize = 256) {
    this.buf = new Uint16Array(initialSize);
  }

  push(cp: number): void {
    if (this.len >= this.buf.length) {
      const next = new Uint16Array(this.buf.length << 1);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = cp;
  }

  pushCodePoint(cp: number): void {
    if (cp <= 0xffff) {
      this.push(cp);
      return;
    }
    const adjusted = cp - 0x10000;
    this.push(0xd800 + (adjusted >> 10));
    this.push(0xdc00 + (adjusted & 0x3ff));
  }

  flush(): string {
    const str = String.fromCharCode.apply(null, this.buf.subarray(0, this.len) as unknown as number[]);
    this.len = 0;
    return str;
  }

  clear(): void {
    this.len = 0;
  }
}

// ============================================================
// Public types
// ============================================================

export type StreamParserPath = ReadonlyArray<string | number>;

export type StreamParserError = { message: string; state: number; depth: number; path: StreamParserPath };

export type StreamParserCallbacks = {
  /** Emitted for each complete value (object/array members and top-level scalars). */
  onValue?: (key: string, value: unknown, path: StreamParserPath) => void;
  onObjectStart?: (path: StreamParserPath) => void;
  onObjectEnd?: (path: StreamParserPath) => void;
  onArrayStart?: (path: StreamParserPath) => void;
  onArrayEnd?: (path: StreamParserPath) => void;
  onError?: (error: StreamParserError) => void;
  onEnd?: () => void;
};

export type StreamParserOptions = {
  /** Max nesting depth. Default: 256. */
  maxDepth?: number;
};

export type ParserSnapshot = { state: number; depth: number; path: StreamParserPath };

// ============================================================
// StreamParser
// ============================================================

export class StreamParser {
  private state = S_VALUE;
  private isKey = false;
  private hexIndex = 0;
  private readonly hexBuf = new Uint8Array(4);
  private readonly parents: number[] = [PARENT_TOP];
  private readonly path: Array<string | number> = [];
  private readonly arrayIndices: number[] = [];
  private readonly strBuf = new StringBuffer(512);
  private numStr = '';
  private currentKey = '';
  private keywordTarget = '';
  private keywordIndex = 0;
  private readonly maxDepth: number;

  constructor(private readonly callbacks: StreamParserCallbacks = {}, options: StreamParserOptions = {}) {
    this.maxDepth = options.maxDepth ?? 256;
  }

  /** Feed a string chunk to the parser. */
  write(chunk: string): void {
    for (let i = 0, len = chunk.length; i < len; i++) {
      this.codepoint(chunk.charCodeAt(i));
    }
  }

  /** Signal end of input. Flushes any pending number. */
  end(): void {
    if (this.state >= S_NUM_ZERO && this.state <= S_NUM_EXP_DIGIT && this.numStr) {
      this.closeNumber();
    }
    if (this.parents.length > 1) {
      this.err('Unexpected end: unclosed structure');
    }
    this.state = S_DONE;
    this.callbacks.onEnd?.();
  }

  /** Stream from a fetch Response (ReadableStream body). */
  async stream(response: Response): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.write(decoder.decode(value, { stream: true }));
    }
    this.write(decoder.decode());
    this.end();
  }

  /** Current parser position (for pause/resume). */
  getState(): ParserSnapshot {
    return { state: this.state, depth: this.parents.length, path: [...this.path] };
  }

  /** Reset to initial state. */
  reset(): void {
    this.state = S_VALUE;
    this.isKey = false;
    this.hexIndex = 0;
    this.parents.length = 1;
    this.parents[0] = PARENT_TOP;
    this.path.length = 0;
    this.arrayIndices.length = 0;
    this.strBuf.clear();
    this.numStr = '';
    this.currentKey = '';
    this.keywordTarget = '';
    this.keywordIndex = 0;
  }

  // ── dispatch ──────────────────────────────────────────────

  private codepoint(cp: number): void {
    switch (this.state) {
      case S_VALUE: this.handleValue(cp); return;
      case S_AFTER_VALUE: this.handleAfterValue(cp); return;
      case S_KEY: this.handleKey(cp); return;
      case S_AFTER_KEY: this.handleAfterKey(cp); return;
      case S_STRING: this.handleString(cp); return;
      case S_ESCAPE: this.handleEscape(cp); return;
      case S_HEX: this.handleHex(cp); return;
      case S_KEYWORD: this.handleKeyword(cp); return;
      default: this.handleNumber(cp); return;
    }
  }

  private handleValue(cp: number): void {
    if (cp === OPEN_BRACE) { this.openObject(); return; }
    if (cp === OPEN_BRACKET) { this.openArray(); return; }
    if (cp === QUOTE) { this.state = S_STRING; this.isKey = false; return; }
    if (cp === LOWER_T) { this.startKeyword('rue', true); return; }
    if (cp === LOWER_F) { this.startKeyword('alse', false); return; }
    if (cp === LOWER_N) { this.startKeyword('ull', null); return; }
    if (cp === MINUS) { this.state = S_NUM_MINUS; this.numStr = '-'; return; }
    if (cp === ZERO) { this.state = S_NUM_ZERO; this.numStr = '0'; return; }
    if (cp >= ONE && cp <= NINE) { this.state = S_NUM_DIGIT; this.numStr = String.fromCharCode(cp); return; }
    if (!isWhitespace(cp)) this.err(`Unexpected character: ${String.fromCodePoint(cp)}`);
  }

  private handleAfterValue(cp: number): void {
    if (cp === COMMA) {
      if (this.parents[this.parents.length - 1] === PARENT_OBJECT) {
        this.isKey = true;
        this.state = S_KEY;
      } else {
        // Array continuation: advance the index HERE, at the element
        // boundary — not in emitValue(), which only fires for scalars and
        // would never advance the slot for an array of objects/arrays (the
        // member's own onValue calls happen at a deeper nesting level, with
        // this array's slot as an ancestor path segment, not the immediate
        // parent).
        const next = ++this.arrayIndices[this.arrayIndices.length - 1]!;
        this.path[this.path.length - 1] = next;
        this.state = S_VALUE;
      }
      return;
    }
    if (cp === CLOSE_BRACE) { this.closeObject(); return; }
    if (cp === CLOSE_BRACKET) { this.closeArray(); return; }
    if (!isWhitespace(cp)) this.err(`Expected , or } or ] got ${String.fromCodePoint(cp)}`);
  }

  private handleKey(cp: number): void {
    if (cp === QUOTE) { this.state = S_STRING; this.isKey = true; return; }
    if (cp === CLOSE_BRACE) { this.closeObject(true); return; }
    if (!isWhitespace(cp)) this.err(`Expected " or } got ${String.fromCodePoint(cp)}`);
  }

  private handleAfterKey(cp: number): void {
    if (cp === COLON) { this.isKey = false; this.state = S_VALUE; return; }
    if (!isWhitespace(cp)) this.err(`Expected : got ${String.fromCodePoint(cp)}`);
  }

  private handleString(cp: number): void {
    if (cp === QUOTE) {
      const str = this.strBuf.flush();
      if (this.isKey) {
        this.currentKey = str;
        this.path[this.path.length - 1] = str;
        this.state = S_AFTER_KEY;
      } else {
        this.emitValue(str);
        this.afterValue();
      }
      return;
    }
    if (cp === BACKSLASH) { this.state = S_ESCAPE; return; }
    this.strBuf.pushCodePoint(cp);
  }

  private handleEscape(cp: number): void {
    this.state = S_STRING;
    const LOWER_R = 0x72;
    const LOWER_B = 0x62;
    const simple: Record<number, number> = {
      [LOWER_N]: NEWLINE, [LOWER_T]: TAB, [LOWER_R]: RETURN, [LOWER_B]: 0x08, [LOWER_F]: 0x0c,
      [QUOTE]: QUOTE, [BACKSLASH]: BACKSLASH, [SLASH]: SLASH,
    };
    if (cp in simple) { this.strBuf.push(simple[cp]); return; }
    if (cp === LOWER_U) { this.state = S_HEX; this.hexIndex = 0; return; }
    this.err(`Invalid escape: \\${String.fromCharCode(cp)}`);
  }

  private handleHex(cp: number): void {
    const isHexDigit = isDigit(cp) || (cp >= LOWER_A && cp <= LOWER_F) || (cp >= UPPER_A && cp <= UPPER_F);
    if (!isHexDigit) { this.err(`Invalid hex digit: ${String.fromCharCode(cp)}`); return; }
    this.hexBuf[this.hexIndex++] = cp;
    if (this.hexIndex === 4) {
      const hex = String.fromCharCode(this.hexBuf[0]!, this.hexBuf[1]!, this.hexBuf[2]!, this.hexBuf[3]!);
      this.strBuf.push(Number.parseInt(hex, 16));
      this.state = S_STRING;
    }
  }

  /** `true`/`false`/`null` — a single target-string index walk instead of
   *  ten near-duplicate per-letter states. */
  private startKeyword(rest: string, value: boolean | null): void {
    this.keywordTarget = rest;
    this.keywordIndex = 0;
    this.state = S_KEYWORD;
    this.pendingKeywordValue = value;
  }

  private pendingKeywordValue: boolean | null = null;

  private handleKeyword(cp: number): void {
    if (cp !== this.keywordTarget.charCodeAt(this.keywordIndex)) {
      this.err(`Expected "${this.pendingKeywordValue === null ? 'null' : this.pendingKeywordValue}"`);
      return;
    }
    this.keywordIndex++;
    if (this.keywordIndex === this.keywordTarget.length) {
      this.emitValue(this.pendingKeywordValue);
      this.afterValue();
    }
  }

  private handleNumber(cp: number): void {
    switch (this.state) {
      case S_NUM_MINUS:
        if (cp === ZERO) { this.state = S_NUM_ZERO; this.numStr += '0'; }
        else if (isDigit(cp)) { this.state = S_NUM_DIGIT; this.numStr += String.fromCharCode(cp); }
        else this.err('Expected digit after -');
        return;
      case S_NUM_ZERO:
      case S_NUM_DIGIT:
        if (isDigit(cp) && this.state === S_NUM_DIGIT) { this.numStr += String.fromCharCode(cp); return; }
        if (cp === DOT) { this.state = S_NUM_DOT; this.numStr += '.'; return; }
        if (cp === LOWER_E || cp === 0x45) { this.state = S_NUM_EXP; this.numStr += String.fromCharCode(cp); return; }
        this.closeNumber();
        this.codepoint(cp);
        return;
      case S_NUM_DOT:
        if (isDigit(cp)) { this.state = S_NUM_FRAC; this.numStr += String.fromCharCode(cp); }
        else this.err('Expected digit after .');
        return;
      case S_NUM_FRAC:
        if (isDigit(cp)) { this.numStr += String.fromCharCode(cp); return; }
        if (cp === LOWER_E || cp === 0x45) { this.state = S_NUM_EXP; this.numStr += String.fromCharCode(cp); return; }
        this.closeNumber();
        this.codepoint(cp);
        return;
      case S_NUM_EXP:
        if (cp === PLUS || cp === MINUS) { this.state = S_NUM_EXP_SIGN; this.numStr += String.fromCharCode(cp); }
        else if (isDigit(cp)) { this.state = S_NUM_EXP_DIGIT; this.numStr += String.fromCharCode(cp); }
        else this.err('Expected digit or sign after exponent');
        return;
      case S_NUM_EXP_SIGN:
        if (isDigit(cp)) { this.state = S_NUM_EXP_DIGIT; this.numStr += String.fromCharCode(cp); }
        else this.err('Expected digit after exponent sign');
        return;
      case S_NUM_EXP_DIGIT:
        if (isDigit(cp)) { this.numStr += String.fromCharCode(cp); return; }
        this.closeNumber();
        this.codepoint(cp);
        return;
      default:
        this.err(`Invalid state: ${this.state}`);
    }
  }

  // ── shared helpers ────────────────────────────────────────

  private openObject(): void {
    if (this.parents.length >= this.maxDepth) { this.err('Max depth exceeded'); return; }
    this.parents.push(PARENT_OBJECT);
    this.isKey = true;
    this.state = S_KEY;
    this.path.push('');
    this.callbacks.onObjectStart?.(this.path);
  }

  private openArray(): void {
    if (this.parents.length >= this.maxDepth) { this.err('Max depth exceeded'); return; }
    this.parents.push(PARENT_ARRAY);
    this.state = S_VALUE;
    this.arrayIndices.push(0);
    this.path.push(0);
    this.callbacks.onArrayStart?.(this.path);
  }

  private closeObject(empty = false): void {
    const popped = this.parents.pop();
    if (popped !== PARENT_OBJECT) { this.err('Unexpected }'); return; }
    if (empty) this.isKey = false;
    this.path.pop();
    this.callbacks.onObjectEnd?.(this.path);
    this.afterValue();
  }

  private closeArray(): void {
    const popped = this.parents.pop();
    if (popped !== PARENT_ARRAY) { this.err('Unexpected ]'); return; }
    this.arrayIndices.pop();
    this.path.pop();
    this.callbacks.onArrayEnd?.(this.path);
    this.afterValue();
  }

  private afterValue(): void {
    this.state = this.parents[this.parents.length - 1] === PARENT_TOP ? S_VALUE : S_AFTER_VALUE;
  }

  private emitValue(value: unknown): void {
    // The array-index path slot is maintained at element boundaries
    // (openArray's initial 0, handleAfterValue's comma-continuation bump),
    // not here — this fires for every value, but an array member's index
    // must already be current before its own onValue call, whether that
    // member is this scalar or something several levels deeper.
    this.callbacks.onValue?.(this.currentKey, value, this.path);
  }

  private closeNumber(): void {
    this.emitValue(+this.numStr);
    this.numStr = '';
    this.afterValue();
  }

  private err(message: string): void {
    this.callbacks.onError?.({ message, state: this.state, depth: this.parents.length, path: [...this.path] });
  }
}

/** Factory matching the rest of vapor-chamber's `createX()` naming convention. */
export function createStreamParser(callbacks: StreamParserCallbacks = {}, options: StreamParserOptions = {}): StreamParser {
  return new StreamParser(callbacks, options);
}
