/**
 * vapor-chamber - HTTP client
 *
 * Written to the CDCC guideline of small, single-purpose functions
 * (docs/whitepaper.md 3.5). It is a guideline: no lint rule checks it.
 *
 * What it does beyond a bare `fetch`:
 *  - `AbortSignal.any` with manual fallback for older environments
 *  - The async bus's retry schedule (full jitter, docs/retry.md) for a re-send it decides itself
 *  - A declared wait sets when to re-send, never whether: `Retry-After` (RFC 9110), else `RateLimit` `t`, else `X-RateLimit-Reset`
 *  - 419 CSRF refresh coalesces concurrent requests (no duplicate refreshes)
 *  - `session-expired` CustomEvent + configurable callback
 *  - The caller's abort (`transport:aborted:request`) distinct from no reply in time (`transport:timeout:reply`)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HttpConfig = {
  /**
   * Request timeout in ms.
   *
   * Two consumers, two defaults - this type is shared by `postCommand` and by
   * `createHttpClient` (via `HttpRequestConfig`), and they do not agree:
   * **10_000 through `postCommand`, 30_000 through a client** (a command POST
   * and a general-purpose GET have different patience).
   *
   * Bounds: a value that does not compare as a number (NaN, a non-numeric
   * string) takes that default; anything above
   * 2_147_483_647 ms (`setTimeout`'s ceiling, where it would fire at once)
   * is capped there, so `Infinity` means "as long as a timer can wait"; 0 or
   * a negative value times out immediately.
   */
  timeout?: number;
  /**
   * Re-sends by the bus's rule (`retryClass`): a transient failure (408, 429,
   * 503) for any method; an uncertain one, or an answer with a declared wait,
   * only for an idempotent method or an `Idempotency-Key`. `maxAttempts` is
   * the bus's bound (`RetryOptions`): attempts in total, the first included,
   * default 3. `false` sends once. Default: **on for a GET through a client,
   * off for any other method and through `postCommand`**; `{}` turns it on.
   * While on, an unidentified request (no idempotent method, no key) that got
   * no reply, a 502 or a 504 is not re-sent and fails with
   * `context.outcome: 'unknown'`. A re-send waits the declared wait, else the
   * async bus's schedule: random under 200 ms x 2^n, capped at 20 s
   * (docs/retry.md). tests/one-client.test.ts.
   */
  retry?: Pick<RetryOptions, 'maxAttempts'> | false;
  /** External abort signal (e.g. from component unmount) */
  signal?: AbortSignal;
  /** Read the CSRF token from the DOM and attach it as a header. An app header of that name, in any spelling, goes out once with the token. Default: false */
  csrf?: boolean;
  /**
   * URL to fetch when a CSRF-expiry response (HTTP 419) occurs, to obtain a
   * fresh token. The default targets the Laravel Sanctum SPA convention
   * because it's the most common backend issuing 419 - override for other
   * frameworks, or set to '' to disable the auto-refresh entirely (the lib
   * will then only re-read the token from the DOM on retry).
   * Default: '/sanctum/csrf-cookie'.
   */
  csrfCookieUrl?: string;
  /** Additional headers merged into every request. A name matches in any case: its first spelling is kept and the last value wins (the Fetch Standard's "set"), so it goes out once. */
  headers?: Record<string, string>;
  /** Called when a 401 session-expired response is received */
  onSessionExpired?: (status: number) => void;
  /**
   * Stamps `context.silent` on a thrown error so a caller-provided global error
   * handler can skip it - for fire-and-forget requests (best-effort
   * telemetry, background prefetch) that shouldn't surface UI noise.
   * Default: false.
   */
  silent?: boolean;
  /**
   * Resolve a 304 Not Modified instead of throwing it. A 304 answers a
   * conditional request the app sent itself (`If-None-Match`,
   * `If-Modified-Since`): "what you hold is current", not a failure. Opted
   * in, the response resolves as it is (`status` 304, `ok` false as Fetch
   * says, `data` the empty body); off, it throws its `remote:` failure like
   * any non-2xx. Never cached. Default: false.
   * tests/http-not-modified.test.ts.
   */
  resolveNotModified?: boolean;
};

export type HttpResponse<T = unknown> = {
  data: T;
  status: number;
  headers: Record<string, string>;
  ok: boolean;
  /**
   * The final URL, after any redirect Fetch followed (Fetch's `Response.url`).
   * Always set by `createHttpClient` and `postCommand`; optional for an app's
   * own client.
   */
  url?: string;
  /** True when Fetch followed a redirect to reach `url` (`Response.redirected`). */
  redirected?: boolean;
  /** True when this response was served from a stale (past-fresh) cache entry. */
  stale?: boolean;
  /** Present on a stale hit: resolves with the fresh response once the background revalidation lands. */
  revalidation?: Promise<HttpResponse<T>>;
  /** True when this is a retained cache entry served in place of a transient failure (`cache.serveStaleOnError`). */
  servedOnError?: boolean;
  /** The transient error `servedOnError` masked - surfaced alongside the stale data, never silently dropped. */
  error?: unknown;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_EXPIRED_STATUS = [401]; // 419 is CSRF expiry, not session expiry
// The longest declared wait the client sleeps INSIDE one request; a longer one
// ends the request (the header stays on the failure for the caller).
const MAX_RETRY_AFTER_MS = 30_000;
const CSRF_TTL_MS = 300_000; // 5 min
const DEFAULT_CSRF_COOKIE_URL = '/sanctum/csrf-cookie';
// What every request asks for: JSON, or an RFC 9457 problem. Laravel 13
// answers JSON on it (`Request::wantsJson`), as on X-Requested-With (log 36.47).
const ACCEPT = 'application/json, application/problem+json';

// ---------------------------------------------------------------------------
// CSRF - multi-source with TTL cache
// ---------------------------------------------------------------------------

type CsrfResult = { token: string; headerName: string };
type CsrfCacheEntry = CsrfResult & { expiresAt: number };

let _csrfCache: CsrfCacheEntry | null = null;

/** Read CSRF token from DOM: meta tag -> cookie -> hidden input. TTL-cached for 5 min. */
export function readCsrfToken(): CsrfResult | null {
  const now = Date.now();
  if (_csrfCache && now < _csrfCache.expiresAt) {
    return { token: _csrfCache.token, headerName: _csrfCache.headerName };
  }
  if (typeof document === 'undefined') return null;
  const result = readCsrfFromDom();
  if (result) _csrfCache = { ...result, expiresAt: now + CSRF_TTL_MS };
  return result;
}

/** Every CSRF header this library may set - both are cleared before a refresh
 *  attaches the fresh one, so a stale header cannot outrank it (Laravel reads
 *  X-CSRF-TOKEN before X-XSRF-TOKEN; getTokenFromRequest, verified at source).
 *  Lowercase: deleted in any spelling. */
const CSRF_HEADER_NAMES = ['x-csrf-token', 'x-xsrf-token'];

/** Set `token` as the csrf header. An app's other spelling of that name is merged by `oneSpelling`. */
function attachCsrf(headers: Record<string, string>): void {
  const token = readCsrfToken();
  if (token) headers[token.headerName] = token.token;
}

function setCsrfHeader(headers: Record<string, string>, result: CsrfResult): void {
  dropHeaders(headers, CSRF_HEADER_NAMES);
  headers[result.headerName] = result.token;
}

/**
 * A request's headers with one spelling per name, merged as the Fetch
 * Standard's header list "set": a name matches case-insensitively (RFC 9110
 * 5.1), its first spelling is kept and the last value wins, so one name is
 * one header, never two joined "a, b". Two spellings of one name have one
 * length, so one pass sets a bit per length (mod 32) and a request whose
 * names all differ in length does no string work. Measured: a merge into a
 * prototype-free dictionary cost every request about 200 ns, a pairwise
 * check over the names about 60 ns (log s35.163).
 * tests/header-one-spelling.test.ts.
 */
function oneSpelling(headers: Record<string, string>): Record<string, string> {
  let lengths = 0;
  for (const name in headers) {
    const bit = 1 << (name.length & 31);
    if (lengths & bit) return spelledOnce(headers);
    lengths |= bit;
  }
  return headers;
}

// Two names share a length: first spelling, last value. `fromEntries` defines
// own properties, so a `__proto__` name stays a header (src/dict.ts).
function spelledOnce(headers: Record<string, string>): Record<string, string> {
  const kept = new Map<string, [string, string]>();
  const names = Object.keys(headers);
  for (const name of names) {
    const low = name.toLowerCase();
    const entry = kept.get(low);
    if (entry) entry[1] = headers[name];
    else kept.set(low, [name, headers[name]]);
  }
  return kept.size === names.length ? headers : Object.fromEntries(kept.values());
}

// The names lowercased, into a prototype-free dictionary (src/dict.ts), for a key.
function lowerNames(headers: Record<string, string> | undefined): Record<string, string> {
  const low = dict<string>();
  for (const name in headers) low[name.toLowerCase()] = headers[name];
  return low;
}

/** Delete every spelling of each lowercase name (the Fetch Standard's "delete"). */
function dropHeaders(headers: Record<string, string>, names: string[]): void {
  for (const key of Object.keys(headers)) if (names.includes(key.toLowerCase())) delete headers[key];
}

/**
 * The `XSRF-TOKEN` cookie only. Split out of `readCsrfFromDom` because the
 * post-refresh re-read needs it FIRST (see `readCsrfAfterRefresh`). The cookie
 * name comes from `<meta name="xsrf-cookie">` or defaults to `XSRF-TOKEN`.
 */
function readCsrfFromCookie(): CsrfResult | null {
  if (typeof document === 'undefined') return null;
  const q = typeof document.querySelector === 'function'
    ? (sel: string) => document.querySelector(sel)
    : null;
  const cookieNameMeta = q?.('meta[name="xsrf-cookie"]') as HTMLMetaElement | null;
  const cookieName = cookieNameMeta?.content || 'XSRF-TOKEN';
  const escaped = cookieName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cookieMatch = document.cookie?.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  if (!cookieMatch) return null;
  // A value that is not percent-encoding is no token we can send: it reads as
  // no cookie (tests/csrf-malformed-cookie.test.ts).
  try { return { token: decodeURIComponent(cookieMatch[1]), headerName: 'X-XSRF-TOKEN' }; } catch { return null; }
}

function readCsrfFromDom(): CsrfResult | null {
  const q = typeof document.querySelector === 'function'
    ? (sel: string) => document.querySelector(sel)
    : null;

  // 1. Meta tag - `<meta name="csrf-token" content="...">`. Common in
  //    server-rendered frameworks (Laravel Blade, Rails, others).
  if (q) {
    const meta = q('meta[name="csrf-token"]') as HTMLMetaElement | null;
    if (meta?.content) return { token: meta.content, headerName: 'X-CSRF-TOKEN' };
  }

  // 2. Cookie - `XSRF-TOKEN` (or the name in `<meta name="xsrf-cookie">`).
  const fromCookie = readCsrfFromCookie();
  if (fromCookie) return fromCookie;

  // 3. Hidden input - `<input name="_token">`. Emitted by Laravel's `@csrf`
  //    Blade directive, also appears in Rails forms and other stacks.
  if (q) {
    const input = q('input[name="_token"]') as HTMLInputElement | null;
    if (input?.value) return { token: input.value, headerName: 'X-CSRF-TOKEN' };
  }

  return null;
}

/**
 * Re-read the token AFTER a 419 refresh, cookie FIRST.
 *
 * The initial read prefers the `<meta name="csrf-token">` tag. But a 419 means
 * that token expired, and the meta tag is rendered ONCE per page load, so it
 * stays stale for the life of the page - re-reading it would retry with the
 * same dead token and 419 again (a long-open panel hit exactly this). The
 * refresh fetch makes the backend set a fresh `XSRF-TOKEN` cookie (Laravel's
 * CSRF middleware sets it on every response), so after a refresh the cookie is
 * the live source. Fall back to the full DOM read for a page with no cookie
 * (a `@csrf` hidden-input form).
 */
function readCsrfAfterRefresh(): CsrfResult | null {
  const fromCookie = readCsrfFromCookie();
  if (fromCookie) {
    _csrfCache = { ...fromCookie, expiresAt: Date.now() + CSRF_TTL_MS };
    return fromCookie;
  }
  // No cookie: fall back to `readCsrfToken`, NOT `readCsrfFromDom` directly -
  // readCsrfToken guards `typeof document` (a 419 refresh can run on a server,
  // where document is undefined) and caches its own result.
  return readCsrfToken();
}

/** Invalidate the CSRF token cache (e.g. after logout). */
export function invalidateCsrfCache(): void {
  _csrfCache = null;
}

let _csrfRefreshPromise: Promise<CsrfResult | null> | null = null;

function refreshCsrfOnce(cookieUrl: string): Promise<CsrfResult | null> {
  // Coalesce: concurrent 419s share the single in-flight refresh promise -
  // waiters resolve the instant it settles, no polling.
  //
  // RETURNS the token rather than leaving callers to re-read it: a re-read
  // after the await sits across a microtask boundary that several coalesced
  // waiters resume across, and a waiter that ran first could invalidate the
  // cache or clear the DOM, so a later one would retry with no CSRF header.
  // Every waiter gets the SAME token, or null when none is found: never a
  // shared failure, since each request marks its own (`silent`), and a mark
  // on one shared error reached every waiter (tests/silent-csrf-refresh.test.ts).
  if (_csrfRefreshPromise) return _csrfRefreshPromise;
  _csrfRefreshPromise = (async () => {
    try {
      // Fetch the CSRF cookie endpoint so the backend issues a fresh
      // XSRF-TOKEN cookie (Laravel Sanctum's `/sanctum/csrf-cookie` is the
      // most common shape; other frameworks expose equivalent endpoints).
      // Only fetch if cookieUrl is a non-empty string.
      if (typeof cookieUrl === 'string' && cookieUrl.length > 0) {
        try { await fetch(cookieUrl, { method: 'GET', credentials: 'same-origin' }); } catch { /* ignore network errors */ }
      }
      invalidateCsrfCache();
      // Cookie FIRST here: the fetch above just made the backend set a fresh
      // XSRF-TOKEN cookie, while the meta tag is still the stale one the page
      // was rendered with. See readCsrfAfterRefresh.
      return readCsrfAfterRefresh();
    } finally {
      _csrfRefreshPromise = null;
    }
  })();
  return _csrfRefreshPromise;
}

// ---------------------------------------------------------------------------
// Retry timing
// ---------------------------------------------------------------------------

/**
 * RFC 9110 5.6.7's three HTTP-date forms, all GMT: IMF-fixdate
 * (`Sun, 06 Nov 1994 08:49:37 GMT`), and the obsolete rfc850-date
 * (`Sunday, 06-Nov-94 08:49:37 GMT`) and asctime-date
 * (`Sun Nov  6 08:49:37 1994`) a recipient MUST still accept. `Date.parse`
 * alone would read asctime as LOCAL time and take any form it knows (ISO,
 * `10/1/2026`).
 */
const HTTP_DATE =
  /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d\d) (\w{3}) (\d{4})|(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (\d\d)-(\w{3})-(\d\d)|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\w{3}) ([ \d]\d)) (\d\d):(\d\d):(\d\d) (?:GMT|(\d{4}))$/;
const MONTHS = 'JanFebMarAprMayJunJulAugSepOctNovDec';

/** An HTTP-date in ms since the epoch, or NaN for anything else. */
function httpDate(value: string): number {
  const m = HTTP_DATE.exec(value);
  // asctime ends in its year; the other two end in GMT.
  if (!m || (m[7] === undefined) !== (m[12] === undefined)) return NaN;
  const month = MONTHS.indexOf(m[2] ?? m[5] ?? m[7]);
  if (month % 3) return NaN;
  let year = Number(m[3] ?? m[12] ?? m[6]);
  if (m[6] !== undefined) {
    // A two-digit year is its next occurrence: `00` sent late in 2099 is
    // 2100. RFC 9110 5.6.7's 50-year rule only moves a year into the past,
    // which no wait reads (a past date is ignored either way).
    const now = new Date(Date.now()).getUTCFullYear();
    year += now - (now % 100);
    if (year < now) year += 100;
  }
  return Date.UTC(year, month / 3, Number(m[1] ?? m[4] ?? m[8]), Number(m[9]), Number(m[10]), Number(m[11]));
}

/**
 * @internal - Retry-After's grammar, for `_declaredWait`.
 * RFC 9110: `delay-seconds = 1*DIGIT`, else an HTTP-date; anything else is
 * ignored. `Number()` alone would read `-5`, `1.5`, `1e1`, `0x10` as waits.
 * No ceiling of its own (Retry-After is a minimum, RFC 9110): each caller
 * applies its policy. Only a wait no timer can hold is ignored.
 * tests/retry-after-long.test.ts, tests/retry-after-grammar.test.ts.
 */
export function _parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header)) {
    const ms = Number(header) * 1000;
    return ms <= MAX_TIMEOUT_MS ? ms : undefined;
  }
  const ms = httpDate(header) - Date.now();
  return ms > 0 && ms <= MAX_TIMEOUT_MS ? ms : undefined;
}

// ---------------------------------------------------------------------------
// AbortSignal utilities
// ---------------------------------------------------------------------------

export type CombinedSignal = { signal: AbortSignal; detach: () => void };

/**
 * @internal - `AbortSignal.any([a, b])`, and the same result where a platform
 * lacks it (Chrome before 116, Firefox before 124, Safari before 17.4): an
 * input already aborted gives a result already aborted, else the first input
 * to abort aborts it, each with that input's `reason`. The client, the
 * transports, the bus's tickets and supersede combine through it
 * (tests/combine-signals.test.ts).
 *
 * The native result's listeners are the platform's: nothing to detach. The
 * fallback's sit on both inputs until one aborts; a caller whose result
 * outlives its use (one request on a transport's signal) calls `detach` when it
 * settles, or they accrete once per request.
 */
export function _combineSignals(a: AbortSignal, b: AbortSignal): CombinedSignal {
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any([a, b]), detach: () => {} };
  const ctrl = new AbortController();
  const detach = (): void => {
    a.removeEventListener('abort', abort);
    b.removeEventListener('abort', abort);
  };
  const abort = (e: Event): void => {
    detach();
    ctrl.abort((e.target as AbortSignal).reason);
  };
  if (a.aborted || b.aborted) ctrl.abort((a.aborted ? a : b).reason);
  else {
    a.addEventListener('abort', abort);
    b.addEventListener('abort', abort);
  }
  return { signal: ctrl.signal, detach };
}

// The caller's own abort, wherever it lands: a code, never a raw DOMException.
function abortedRequest(url: string): BusError {
  return transportFail('aborted:request', `"${url}" was aborted.`, { context: { url } });
}

/** @internal - a wait the signal cuts short with a rejection: the client's re-send and a transport's poll. */
export function _sleepMs(ms: Delay, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    // Detach on normal resolve too - the signal outlives this sleep, and the
    // listener would otherwise pin the timer closure per retry sleep.
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Error constructors
// ---------------------------------------------------------------------------

const remoteFail = _failures('remote');
const transportFail = _failures('transport');

/**
 * @internal - a request body as JSON, or the failure that says it cannot be
 * one: `transport:invalid:json` (a BigInt, a cycle; the platform's TypeError
 * is its cause). Nothing was sent, and `invalid` is never re-sent. Returned,
 * not thrown, so each caller settles it its own way. The client, postCommand
 * and every bridge encode through it (tests/invalid-json.test.ts).
 */
export function _encodeJson(value: unknown, url: string, action?: string): string | BusError {
  try {
    return JSON.stringify(value);
  } catch (e) {
    return transportFail('invalid:json', `The request to "${url}" cannot be encoded as JSON.`, { action, context: { url }, cause: e });
  }
}

/**
 * @internal - the failure a backend declared: `remote:<condition>:<code>`, the
 * condition from the problem's own `status` (else the response's), `detail` the
 * message, the rest `context`. `retryIn` is the response's `Retry-After` (RFC
 * 9110), never a body member: it is set after the spread, so a body cannot
 * supply it. A batched result or a frame has no response of its own: the
 * `headers` it carries stand for one (OData JSON batch; transports.ts,
 * answerOf). One reader for the client and every bridge (log s35.131).
 */
export function _remoteProblem(p: ProblemDetails, status?: number, retryIn?: number): BusError {
  const s = typeof p.status === 'number' ? p.status : status;
  const { status: _status, code, detail, ...params } = p;
  return remoteFail(
    `${s === undefined ? 'unknown' : conditionOfStatus(s)}:${code ?? 'problem'}` as FailCode,
    detail ?? (s === undefined ? 'The backend answered with no status.' : `HTTP ${s}`),
    { context: { ...params, status: s, code, retryIn } },
  );
}

/** @internal - a non-2xx: its problem, or, for a body that is not one, the status alone. */
export function _answered(status: number, data: unknown, headers?: Record<string, string>): BusError {
  const retryIn = headers && _declaredWait(headers);
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    ? _remoteProblem(data as ProblemDetails, status, retryIn)
    : remoteFail(`${conditionOfStatus(status)}:http` as FailCode, `HTTP ${status}`, { context: { status, retryIn } });
}

/** A request marked `silent` (skip a global error handler) says so on its failure. */
function asSilent(e: BusError, silent: boolean | undefined): BusError {
  if (silent) (e as { context?: Record<string, unknown> }).context = { ...e.context, silent: true };
  return e;
}

// ---------------------------------------------------------------------------
// Session expiry
// ---------------------------------------------------------------------------

function handleSessionExpiry(status: number, url: string, onSessionExpired?: (s: number) => void): void {
  onSessionExpired?.(status);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('session-expired', { detail: { status, url } }));
  }
}

// ---------------------------------------------------------------------------
// Core: postCommand
//
// Sends a single POST request with retry, CSRF, timeout and session detection.
// Used by httpTransport - not intended as a general-purpose HTTP client.
// ---------------------------------------------------------------------------

/**
 * A Response's headers as a plain object with lower-cased keys, tolerating a
 * double or polyfill that has no `headers` at all.
 *
 * The one place that normalizes a Response's headers, for `doFetch` and
 * `doClientFetch`. Every consumer reads this snapshot case-sensitively -
 * `res.headers['retry-after']` in the retry loops, `['content-disposition']`
 * in the download path - so a `Headers` whose `entries()` yields `Retry-After`
 * would make all of them miss with NO error: backoff silently not honoured,
 * filename silently lost.
 *
 * The Fetch spec stores header names lower-cased, so against a compliant
 * implementation this is a no-op, and it costs +6 bytes brotli in the minimal
 * consumer bundle (measured: 6_539 -> 6_545). Taken deliberately: a
 * non-compliant `Headers` would cause a SILENT mis-behaviour rather than a
 * crash.
 *
 * The content-type read in `doClientFetch` goes through `Headers.get()`
 * instead of this snapshot: `get()` is case-insensitive BY SPEC and joins
 * repeated headers, while `resHeaders['content-type']` would miss on odd
 * casing and silently hand the caller a STRING where they asked for JSON.
 */
function headersToObject(headers: Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of headers.entries()) out[key.toLowerCase()] = value;
  return out;
}

// The one reader of a JSON body, sync so a response pays no extra async frame.
// Empty is no data. A body that does not parse is off-protocol on a 2xx; on
// any other status the status already answers.
function parseJson(text: string, ok: boolean): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { if (ok) throw e; return null; }
}

// The bus's one rule (retryClass): a transient failure for any request; an
// uncertain one, or a declared wait, only when the request is identified,
// safe to send twice - an idempotent method, or an Idempotency-Key (any case,
// RFC 9110 5.1), the bus's keyed command.
function resendable(failure: BusError, method: string, headers: Record<string, string>, declared?: number): boolean {
  const cls = retryClass(failure);
  return cls === 'transient' || ((cls === 'uncertain' || declared !== undefined)
    && (IDEMPOTENT_METHODS.has(method) || _headerOf(headers, 'idempotency-key') !== undefined));
}

/**
 * The re-sends a request may make, from its `retry`: the bus's bound less the
 * first attempt for an object (`maxAttempts` by the count rule: NaN the
 * default 3, at least 1, a fraction truncated), none for `false`, else
 * `fallback`, its method's default. tests/one-client.test.ts,
 * tests/http-retry-count.test.ts.
 */
function resendsOf(retry: HttpConfig['retry'], fallback: number): number {
  return retry ? countOption(retry.maxAttempts, _RETRY_ATTEMPTS, 1) - 1 : retry === false ? 0 : fallback;
}

/**
 * @internal - the wait an answer declares, its `context.retryIn`: Retry-After
 * (RFC 9110 10.2.3), else the RateLimit field's `t` seconds for a policy with
 * no quota left (`r=0`), else `X-RateLimit-Reset` (docs/retry.md).
 * draft-ietf-httpapi-ratelimit-headers-11: a List of items, each
 * `"policy";r=<n>;t=<s>`. Retry-After "MUST take precedence". Names in lower
 * case. The one reader: the client and every bridge, through `_answered`, and
 * a batched result's own headers. tests/declared-wait.test.ts.
 */
export function _declaredWait(headers: Record<string, string>): number | undefined {
  let t: number | undefined;
  // Scanned only when sent: a failure with no RateLimit field builds no array.
  const limits = headers.ratelimit;
  if (limits !== undefined) {
    for (const item of limits.split(',')) {
      const m = /;\s*t=(\d+)/.exec(item);
      if (m && /;\s*r=0\b/.test(item)) t = Math.max(t ?? 0, +m[1]);
    }
  }
  const after = headers['retry-after'];
  return after !== undefined || t !== undefined ? _parseRetryAfter(after ?? String(t)) : resetWait(headers['x-ratelimit-reset']);
}

/**
 * @internal - headers an app's own client or a batched result carries, read
 * as a response's: names in lower case (RFC 9110 5.1), the first spelling
 * kept, string values only. The client's own are lower case already
 * (`headersToObject`). tests/declared-wait.test.ts, tests/batch-retry-after.test.ts.
 */
export function _headersOf(headers: unknown): Record<string, string> | undefined {
  if (headers === null || typeof headers !== 'object') return undefined;
  const out: Record<string, string> = dict();
  for (const k of Object.keys(headers)) {
    const value = (headers as Record<string, unknown>)[k];
    const name = k.toLowerCase();
    if (typeof value === 'string' && !Object.hasOwn(out, name)) out[name] = value;
  }
  return out;
}

/**
 * @internal - one header of those `_headersOf` reads, by its lower-case name,
 * with no copy: `_headersOf`'s rule (any case, the first spelling, a string
 * value) for one name. A 202's answer reads only its `Location`: the copy cost
 * every 202 about 115 ns (log 36.49). tests/accepted.test.ts.
 */
export function _headerOf(headers: unknown, name: string): string | undefined {
  if (headers === null || typeof headers !== 'object') return undefined;
  for (const k of Object.keys(headers)) {
    if (k.length === name.length && k.toLowerCase() === name) {
      const value = (headers as Record<string, unknown>)[k];
      if (typeof value === 'string') return value;
    }
  }
  return undefined;
}

// One member of an RFC 9651 List, for the reader below: a String (captured)
// or another bare item, its parameters (a String in one may hold a comma), the
// separator. An inner list is no group, and its field is ignored whole.
const SF_MEMBER = /(?:"((?:[ !#-[\]-~]|\\["\\])*)"|[^\s",;()][^",;]*)(?:;[^",;]*(?:"(?:[^"\\]|\\.)*"[^",;]*)*)*[ \t]*(?:,[ \t]*|$)/y;

/**
 * @internal - the groups a `Cache-Groups` or `Cache-Group-Invalidation` field
 * names (RFC 9875): a Structured Field List of Strings (RFC 9651). Parameters
 * and a member that is not a String are skipped unread. A String that does not
 * parse, two members with no comma, a trailing comma or an inner list ignore
 * the field whole (RFC 9651 4.2: a failed parse ignores the field).
 * The one reader: the client,
 * the transports and fetchLoaders. tests/cache-groups.test.ts.
 */
export function _groupsOf(value: string | undefined): string[] {
  const groups: string[] = [];
  if (!value || /,[ \t]*$/.test(value)) return groups;
  let i = /^ */.exec(value)![0].length;
  while (i < value.length) {
    SF_MEMBER.lastIndex = i;
    const m = SF_MEMBER.exec(value);
    if (!m) return [];
    if (m[1] !== undefined) groups.push(m[1].replace(/\\(["\\])/g, '$1'));
    i = SF_MEMBER.lastIndex;
  }
  return groups;
}

// `Cache-Control: no-store` (RFC 9111 5.2.2.5): the response is not kept.
const NO_STORE = /(?:^|,)[ \t]*no-store[ \t]*(?:,|$)/i;

/**
 * `X-RateLimit-Reset`, which no standard defines: draft -11 lists four
 * readings. Digits a timer can wait are delay seconds. Larger ones are Unix
 * seconds, as Laravel 13 (`availableAt`) and GitHub send them: read as a
 * delay, such a value was past every timer and dropped (log 36.42).
 */
function resetWait(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) * 1000 <= MAX_TIMEOUT_MS) return _parseRetryAfter(value);
  const ms = Number(value) * 1000 - Date.now();
  return ms > 0 && ms <= MAX_TIMEOUT_MS ? ms : undefined;
}

async function doFetch<T>(url: string, method: string, serialized: string | undefined, headers: Record<string, string>, signal: AbortSignal): Promise<HttpResponse<T>> {
  const raw = await fetch(url, { method, headers, body: serialized, credentials: 'same-origin', signal });
  const resHeaders = headersToObject(raw.headers);
  const data = parseJson(await raw.text(), raw.ok) as T;
  return { data, status: raw.status, headers: resHeaders, ok: raw.ok, url: raw.url, redirected: raw.redirected };
}

/**
 * The retry / timeout / CSRF-refresh / session-expiry loop, shared by
 * `postCommand` and `clientRequest`. The only per-caller difference is the
 * fetch itself (passed as `doRequest`) and whether thrown errors are stamped
 * `silent`.
 *
 * ONE policy, correct for both (whitepaper 6.2): 401 = session expiry, fires
 * `onSessionExpired`; 419 = CSRF expiry, refreshed and retried ONCE and NEVER
 * escalated to session expiry.
 *
 * `headers` is the object the request sends; on a 419 the fresh token replaces
 * the stale one on it via `setCsrfHeader`, which clears the other csrf header
 * name so Laravel's `X-CSRF-TOKEN`-first read cannot keep the dead one.
 */
async function runWithRetry<T>(
  doRequest: (signal: AbortSignal) => Promise<HttpResponse<T>>,
  headers: Record<string, string>,
  opts: {
    retry: number;
    timeout: Delay;
    userSignal?: AbortSignal;
    csrfCookieUrl: string;
    onSessionExpired?: (status: number) => void;
    url: string;
    method: string;
    silent?: boolean;
    notModified?: boolean;
  },
): Promise<HttpResponse<T>> {
  const { retry, timeout, userSignal, csrfCookieUrl, onSessionExpired, url, silent = false, notModified = false } = opts;
  let csrfRetried = false;

  // Every attempt ends in a return, a throw, or a re-send while `attempt <
  // retry` (the re-sends left, by resendsOf): the loop needs no test of its own.
  for (let attempt = 0; ; attempt++) {
    if (userSignal?.aborted) throw asSilent(abortedRequest(url), silent);

    // Each attempt ends in a response, or in one failure for the rule below.
    let failure: BusError;
    let declared: number | undefined;
    try {
      const res = await send(doRequest, timeout, userSignal);
      // Opted in: a 304 is the answer to the app's conditional request.
      if (res.ok || (notModified && res.status === 304)) return res;
      if (SESSION_EXPIRED_STATUS.includes(res.status)) handleSessionExpiry(res.status, url, onSessionExpired);

      // 419 = CSRF expiry: refresh once (off the retry budget), then retry.
      // It NEVER fires onSessionExpired - that is 401's job (whitepaper 6.2).
      if (res.status === 419 && !csrfRetried) {
        csrfRetried = true;
        const fresh = await refreshCsrfOnce(csrfCookieUrl);
        if (!fresh) throw asSilent(transportFail('missing:csrf', `No CSRF token after refreshing it from "${csrfCookieUrl}".`, { context: { url: csrfCookieUrl } }), silent);
        setCsrfHeader(headers, fresh);
        attempt--;
        continue;
      }
      failure = _answered(res.status, res.data, res.headers);
      // The wait the failure carries is the one slept: one reading.
      declared = failure.context?.retryIn as number | undefined;
    } catch (e) {
      // A failure thrown above was already judged; it leaves as it is.
      if (e instanceof BusError) throw e;
      if (userSignal?.aborted) throw asSilent(abortedRequest(url), silent);
      // A timeout-triggered abort is no reply in time; a body that is not the
      // JSON it declared is an off-protocol answer; anything else is no
      // response. The first and the last may have landed.
      failure = (e as Error)?.name === 'AbortError'
        ? transportFail('timeout:reply', `"${url}" timed out after ${timeout}ms.`, { context: { url, timeout } })
        : e instanceof SyntaxError
          ? remoteFail('unexpected:json', `"${url}" answered a body that is not valid JSON.`, { context: { url }, cause: e })
          : transportFail('lost:reply', `No response from "${url}".`, { context: { url }, cause: e });
    }

    // Re-send after a wait, or leave marked. A declared wait sets when, never
    // whether: the rule decides. Waiting what it says, never less; a declared
    // wait over 30 s is not slept inside the request, it ends it.
    if (attempt < retry && !((declared ?? 0) > MAX_RETRY_AFTER_MS)) {
      if (resendable(failure, opts.method, headers, declared)) {
        try {
          await _sleepMs(delayOption(declared ?? _backoff(attempt), 0), userSignal);
        } catch {
          throw asSilent(abortedRequest(url), silent);
        }
        continue;
      }
      _heldBack(failure, declared, opts.method, url);
    }
    throw asSilent(failure, silent);
  }
}

// One request under the timeout and the caller's signal. The timer and the
// combined signal are released however it ends.
async function send<T>(
  doRequest: (signal: AbortSignal) => Promise<HttpResponse<T>>,
  timeout: Delay,
  userSignal: AbortSignal | undefined,
): Promise<HttpResponse<T>> {
  const timeoutCtrl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtrl.abort(), timeout);
  const combined = userSignal ? _combineSignals(userSignal, timeoutCtrl.signal) : null;
  try {
    return await doRequest(combined ? combined.signal : timeoutCtrl.signal);
  } finally {
    clearTimeout(timeoutId);
    combined?.detach();
  }
}

export function postCommand<T = unknown>(
  url: string,
  body: unknown,
  config: HttpConfig = {},
): Promise<HttpResponse<T>> {
  const serialized = _encodeJson(body, url);
  return typeof serialized === 'string' ? _postJson<T>(url, serialized, config, resendsOf(config.retry, 0)) : Promise.reject(asSilent(serialized, config.silent));
}

/**
 * @internal - postCommand with its body already JSON: a batching transport
 * joins its commands' parts. `retry` is the re-sends, already read: a
 * transport sends once (the bus re-sends), so it reads no `retry` option.
 * Not `async`: it returns runWithRetry's promise itself, and a throw in its
 * body is a rejection by its `try` (tests/post-json-turns.test.ts).
 */
export function _postJson<T = unknown>(
  url: string,
  serialized: string,
  config: HttpConfig = {},
  retry = 0,
): Promise<HttpResponse<T>> {
  try {
    const { timeout: rawTimeout = 10_000, signal: userSignal, csrf = false, csrfCookieUrl = DEFAULT_CSRF_COOKIE_URL, headers: extra = {}, onSessionExpired, silent = false } = config;
    // setTimeout fires a delay it cannot hold AT ONCE: NaN reads as 0, and past
    // MAX_TIMEOUT_MS Node clamps to 1ms and browsers wrap. So `timeout: NaN`
    // (a failed `Number(config.x)`) or `timeout: Infinity` ("no timeout")
    // would abort every request as it started. NaN takes the default, a larger
    // value the ceiling, 0 and negatives fire now (delayOption, the rule every
    // timer takes: tests/timer-delays.test.ts). Pinned by
    // tests/http-timeout-bounds.test.ts.
    const timeout = delayOption(rawTimeout, 10_000);

    const merged: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': ACCEPT,
      ...extra,
    };
    if (csrf) attachCsrf(merged);
    const headers = oneSpelling(merged);

    return runWithRetry<T>(
      (signal) => doFetch<T>(url, 'POST', serialized, headers, signal),
      headers,
      { retry, timeout, userSignal, csrfCookieUrl, onSessionExpired, url, method: 'POST', silent, notModified: config.resolveNotModified },
    );
  } catch (e) { return Promise.reject(e); }
}

/**
 * @internal - one GET outside a client: the client's headers (`X-Requested-With`
 * kept, log 36.47) and its 30 s, the command's fetch and JSON reader, so a body
 * that is not JSON (a sign-in page) fails as `remote:unexpected:json`, and the
 * one loop, with no re-send. A transport's poll of a status monitor (src/accepted.ts).
 */
export function _getJson<T = unknown>(url: string, config: HttpConfig): Promise<HttpResponse<T>> {
  const headers = oneSpelling({ 'Accept': ACCEPT, 'X-Requested-With': 'XMLHttpRequest', ...config.headers });
  return runWithRetry<T>(
    (signal) => doFetch<T>(url, 'GET', undefined, headers, signal),
    headers,
    { retry: 0, timeout: delayOption(undefined, DEFAULT_CLIENT_TIMEOUT), userSignal: config.signal, csrfCookieUrl: DEFAULT_CSRF_COOKIE_URL, onSessionExpired: config.onSessionExpired, url, method: 'GET' },
  );
}

// ---------------------------------------------------------------------------
// Multi-method HTTP client - createHttpClient
//
// postCommand is the wire contract's POST, used by the transports.
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ResponseType = 'json' | 'blob' | 'text';

export type HttpRequestConfig = HttpConfig & {
  /** HTTP method. Default: 'GET' */
  method?: HttpMethod;
  /** Request body (auto-serialized if object, passthrough for FormData) */
  data?: unknown;
  /** Query parameters - supports arrays and nested objects */
  params?: Record<string, unknown>;
  /** Base URL prepended to relative paths */
  baseURL?: string;
  /** Response parsing mode. Default: 'json' */
  responseType?: ResponseType;
  /**
   * Enable LRU caching for GET. `true` = default TTL, no stale window.
   * `{ ttl }` sets the fresh-window duration. `{ staleTtl }` opts into
   * stale-while-revalidate: a hit within `ttl + staleTtl` past `ttl` is
   * served instantly with `{ stale: true, revalidation: Promise }` attached,
   * while a background fetch refreshes the entry. `serveStaleOnError` is a
   * separate opt-in: a transient failure (timeout/network/5xx) with ANY
   * retained entry (even past its stale window) resolves to
   * `{ stale: true, servedOnError: true, error }` instead of rejecting.
   */
  cache?: boolean | { ttl?: number; staleTtl?: number; serveStaleOnError?: boolean };
  /**
   * Enable request deduplication for GET. Default: true. A concurrent GET
   * of the same URL joins the one in flight and shares its outcome, but
   * keeps its own `signal`: aborting it rejects that caller's promise only.
   * The fetch is cancelled once every caller holding it has aborted; a
   * caller without a signal holds it until it lands.
   * (`tests/http-dedupe-signal.test.ts`) A `silent` read and one without
   * `silent` are two requests, even at the same moment: joined, they would
   * share one failure, and one caller's `silent` mark would reach the other
   * (`tests/silent-dedupe.test.ts`).
   */
  dedupe?: boolean;
  /**
   * Fetch's cache mode for this request (`RequestInit.cache`), for the
   * browser's cache and the client's own store (`cache`) alike. `'no-cache'`
   * asks the server before a stored copy is used, sending its `ETag`: a router
   * refresh reads so. `'reload'` reads past a stored copy and stores the
   * answer. `'no-store'` neither reads nor stores. Absent: Fetch's default. A
   * read in one mode never joins a read in another.
   * tests/http-cache-mode.test.ts, tests/cache-groups.test.ts.
   */
  cacheMode?: RequestCache;
  /** @internal marks a CSRF-retried request */
  _csrfRetried?: boolean;
};

/**
 * A `safe` helper's outcome: it never throws. `error` is the failure the call
 * would have thrown, the core's `BusError` (`conditionOf(error)`, and
 * `problemOf(error)` for the backend's RFC 9457 problem). One exception: an
 * app's interceptor that throws reaches it as it was thrown, as an app's own
 * throw does everywhere (docs/contract.md rule 8). `status` is 0 when there
 * was no response.
 */
export type SafeResult<T = unknown> = {
  data: T | null;
  error: BusError | null;
  status: number;
};

export type DownloadResult = {
  data: Blob;
  status: number;
  filename: string;
};

export type Interceptor<T> = {
  onFulfilled?: (value: T) => T | void;
  onRejected?: (error: unknown) => void;
};

export type InterceptorManager<T> = {
  use(onFulfilled?: (value: T) => T | void, onRejected?: (error: unknown) => void): number;
  eject(id: number): void;
};

export type HttpClient = {
  get<T = unknown>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  post<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  put<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  patch<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  delete<T = unknown>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  request<T = unknown>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  download(url: string, filename?: string, config?: HttpRequestConfig): Promise<DownloadResult>;
  safe: {
    get<T = unknown>(url: string, config?: HttpRequestConfig): Promise<SafeResult<T>>;
    post<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<SafeResult<T>>;
    put<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<SafeResult<T>>;
    patch<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<SafeResult<T>>;
    delete<T = unknown>(url: string, config?: HttpRequestConfig): Promise<SafeResult<T>>;
  };
  interceptors: {
    request: InterceptorManager<HttpRequestConfig>;
    response: InterceptorManager<HttpResponse>;
  };
  create(defaults?: Partial<HttpRequestConfig>): HttpClient;
  clearCache(): void;
  /**
   * Drop the cached reads whose response named one of `groups` in its
   * `Cache-Groups` (RFC 9875), and tell each group to `onInvalidateGroup`'s
   * listeners. `groups`: the names, or a `Cache-Group-Invalidation` field
   * value as received. A write's answer runs it, and a transport runs it for a
   * batched result's or a frame's field, so the field reader stays in the
   * client. tests/cache-groups.test.ts.
   */
  invalidateGroups(groups: readonly string[] | string): void;
  /**
   * Hear each group the client invalidates. A listener's throw is logged and
   * the rest still hear. Returns the unsubscribe. The router listens here.
   */
  onInvalidateGroup(listener: (group: string) => void): () => void;
};

// ---------------------------------------------------------------------------
// Interceptor manager
// ---------------------------------------------------------------------------

type InterceptorEntry<T> = Interceptor<T> | null;

function createInterceptorManager<T>(): InterceptorManager<T> & { forEach(fn: (h: Interceptor<T>) => void): void } {
  const handlers: InterceptorEntry<T>[] = [];
  return {
    use(onFulfilled, onRejected) {
      handlers.push({ onFulfilled, onRejected });
      return handlers.length - 1;
    },
    eject(id) {
      if (handlers[id]) handlers[id] = null;
    },
    forEach(fn) {
      for (const h of handlers) { if (h) fn(h); }
    },
  };
}

// ---------------------------------------------------------------------------
// Imports from internal helpers
// ---------------------------------------------------------------------------

import { type Delay, MAX_TIMEOUT_MS, countOption, delayOption } from './bounds';
import { _report } from './report';
import { createResponseCache, CACHE_DEFAULT_TTL } from './http-cache';
import { classifyError, type ProblemDetails } from './http-errors';
import { BusError, _RETRY_ATTEMPTS, _backoff, _failures, _heldBack, conditionOfStatus, retryClass, type FailCode } from './failure';
import type { RetryOptions } from './command-bus';
import { buildFullUrl } from './http-query';
import { keyTextFor } from './canonical';
import { dict } from './dict';

// ---------------------------------------------------------------------------
// Constants for multi-method client
// ---------------------------------------------------------------------------

/** A read: re-sent by default and cached; any other method invalidates its URL. */
const READ_METHODS: HttpMethod[] = ['GET'];
const MUTATION_METHODS: HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
/** RFC 9110 9.2.2: safe to send twice, so the retry rule may re-send an uncertain failure. */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const DEFAULT_CLIENT_TIMEOUT = 30_000;
/** The request headers' key writer, built once (./canonical keyTextFor). */
const headersKeyText = /* @__PURE__ */ keyTextFor(String);

// ---------------------------------------------------------------------------
// Internal: generic fetch with retry, CSRF, timeout (multi-method)
// ---------------------------------------------------------------------------

async function doClientFetch<T>(
  fullUrl: string,
  method: HttpMethod,
  headers: Record<string, string>,
  body: string | FormData | undefined,
  responseType: ResponseType,
  signal: AbortSignal,
  cacheMode: RequestCache | undefined,
): Promise<HttpResponse<T>> {
  const init: RequestInit = { method, headers, credentials: 'same-origin', signal };
  if (body !== undefined) init.body = body;
  if (cacheMode !== undefined) init.cache = cacheMode;

  const raw = await fetch(fullUrl, init);
  const resHeaders = headersToObject(raw.headers);

  let data: any = null;
  if (responseType === 'blob') {
    data = await raw.blob();
  } else if (responseType === 'text') {
    data = await raw.text();
  } else {
    // json (default) - graceful fallback for non-JSON responses.
    //
    // `?.get()` rather than the `resHeaders` snapshot above, deliberately: the
    // rationale is on the snapshot helper's docblock (case-insensitive by
    // spec; a miss here hands the caller a string where they asked for JSON).
    //
    // JSON is `application/json` or any `+json` structured suffix (RFC 6839) -
    // `application/problem+json` (RFC 9457) above all, whose `code` would be
    // lost as an unparsed string. A type that only CONTAINS "json"
    // (`application/json-seq`) is not JSON and stays text.
    const contentType = raw.headers?.get('content-type') || '';
    if (/[/+]json\s*(;|$)/i.test(contentType)) {
      data = parseJson(await raw.text(), raw.ok);
    } else {
      data = await raw.text();
    }
  }

  return { data: data as T, status: raw.status, headers: resHeaders, ok: raw.ok, url: raw.url, redirected: raw.redirected };
}

async function clientRequest<T>(
  fullUrl: string,
  method: HttpMethod,
  headersObj: Record<string, string>,
  body: string | FormData | undefined,
  responseType: ResponseType,
  maxRetries: number,
  timeout: Delay,
  userSignal: AbortSignal | undefined,
  csrf: boolean,
  csrfCookieUrl: string,
  onSessionExpired?: (status: number) => void,
  notModified?: boolean,
  cacheMode?: RequestCache,
): Promise<HttpResponse<T>> {
  // Attach CSRF for mutation methods
  if (csrf && MUTATION_METHODS.includes(method)) attachCsrf(headersObj);
  const headers = oneSpelling(headersObj);

  return runWithRetry<T>(
    (signal) => doClientFetch<T>(fullUrl, method, headers, body, responseType, signal, cacheMode),
    headers,
    { retry: maxRetries, timeout, userSignal, csrfCookieUrl, onSessionExpired, url: fullUrl, method, notModified },
  );
}

/**
 * What a write's answer invalidates (RFC 9111 4.4): its target URI, which a
 * cache MUST, and the URIs in `Location` and `Content-Location`, which it MAY,
 * only on the target's origin (scheme, host, port; RFC 9110 4.3.1). A relative
 * value resolves against the target (RFC 9110 10.2.2, 8.7), a client URL
 * against the base fetch resolves it with. The target matches as given.
 * tests/http-location-invalidation.test.ts.
 */
function invalidatedBy(fullUrl: string, res: HttpResponse): (url: string) => boolean {
  const { location, 'content-location': contentLocation } = res.headers;
  if (location || contentLocation) {
    const base = globalThis.document?.baseURI ?? globalThis.location?.href;
    const target = absolute(res.url || fullUrl, base);
    const named: string[] = [];
    for (const value of [location, contentLocation]) {
      const uri = target && absolute(value, target.href);
      // RFC 9111 4.4: "MUST NOT ... if the origin ... differs".
      if (uri && uri.origin === target.origin) named.push(uri.href);
    }
    if (named.length) return (url) => url === fullUrl || named.includes(absolute(url, base)?.href as string);
  }
  return (url) => url === fullUrl;
}

// A target URI has no fragment (RFC 9110 7.1). Undefined when `url` does not
// parse: a relative URL with no base, outside a browser, where fetch refuses it.
function absolute(url: string | undefined, base?: string): URL | undefined {
  if (!url) return undefined;
  try {
    const uri = new URL(url, base);
    uri.hash = '';
    return uri;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// createHttpClient
// ---------------------------------------------------------------------------

/**
 * createHttpClient - multi-method HTTP client with interceptors, caching,
 * deduplication, safe mode, and file download.
 *
 * Framework-agnostic - no Vue imports.
 *
 * @example
 * const http = createHttpClient({ baseURL: '/api', csrf: true });
 *
 * // All methods
 * const users = await http.get('/users', { params: { page: 1 } });
 * await http.post('/cart', { itemId: 1, qty: 2 });
 * await http.put('/cart/1', { qty: 5 });
 * await http.delete('/cart/1');
 *
 * // Safe mode - never throws
 * const result = await http.safe.post('/login', credentials);
 * if (result.error) console.log(result.error.message);
 *
 * // File download
 * await http.download('/export/csv', 'products.csv');
 *
 * // Interceptors
 * http.interceptors.request.use((config) => { config.headers = { ...config.headers, 'X-Custom': '1' }; return config; });
 *
 * // Create scoped instance
 * const adminHttp = http.create({ baseURL: '/admin/api', headers: { 'X-Admin': 'true' } });
 */
export function createHttpClient(instanceDefaults: Partial<HttpRequestConfig> = {}): HttpClient {
  const requestInterceptors = createInterceptorManager<HttpRequestConfig>();
  const responseInterceptors = createInterceptorManager<HttpResponse>();
  // Owned by this client - see http-cache.ts. `create()` below mints a fresh
  // one for the derived client, so one instance's clearCache() can never empty
  // another's, and a per-request client under SSR is genuinely isolated.
  const cache = createResponseCache();
  // A deduped GET that callers may cancel: it fetches under `ctrl`, aborted
  // once every caller holding it has aborted (`live` reaches 0). A read with
  // no entry here is one some caller holds without a signal: nothing cancels it.
  const shares = new WeakMap<Promise<unknown>, { ctrl: AbortController; live: number }>();
  // The client's hub for invalidated groups. A
  // stored response is in a group when its own `Cache-Groups` names it.
  const groups = _groupHub((named) => cache.invalidateStored((res: HttpResponse) => {
    const own = res.headers['cache-groups'];
    return own !== undefined && _groupsOf(own).some((g) => named.includes(g));
  }));

  // One caller's promise on a shared read: its own signal rejects it, and only
  // it. The last holder to abort cancels the fetch and removes the in-flight
  // entry at once, so a caller arriving after that starts a fresh request
  // instead of joining one that is already aborted.
  function hold<T>(key: string, url: string, shared: Promise<T>, signal: AbortSignal, silent: boolean | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(asSilent(abortedRequest(url), silent));
        const share = shares.get(shared);
        if (share && --share.live === 0) {
          shares.delete(shared);
          cache.dropInflight(key, shared);
          share.ctrl.abort();
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // The leader's signal can abort inside the synchronous start of its own
      // fetch, before this listener exists (tests/http-gaps.test.ts).
      if (signal.aborted) onAbort();
      // After an abort, resolve and reject are no-ops; the listener goes either way.
      shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  async function request<T = unknown>(url: string, options: HttpRequestConfig = {}): Promise<HttpResponse<T>> {
    // Merge instance defaults with per-call options. X-Requested-With stays on
    // the client's requests: Laravel 13's StartSession stores a GET without it
    // as the session's previous URL, so `back()` lands on a JSON read (log 36.47).
    let config: HttpRequestConfig = {
      ...instanceDefaults,
      ...options,
      headers: {
        'Accept': ACCEPT,
        'X-Requested-With': 'XMLHttpRequest',
        ...instanceDefaults.headers,
        ...options.headers,
      },
    };

    // Run request interceptors
    requestInterceptors.forEach(({ onFulfilled, onRejected }) => {
      try { if (onFulfilled) config = onFulfilled(config) || config; }
      catch (e) { if (onRejected) onRejected(e); }
    });

    const method: HttpMethod = (config.method ?? 'GET') as HttpMethod;
    // Same bounds as postCommand's (timeout and retry), normalized once before clientRequest's loop.
    const timeout = delayOption(config.timeout, DEFAULT_CLIENT_TIMEOUT);
    const isRead = READ_METHODS.includes(method);
    // A read is on by default (the bus's bound), any other method off.
    const maxRetries = resendsOf(config.retry, isRead ? _RETRY_ATTEMPTS - 1 : 0);
    const responseType: ResponseType = config.responseType ?? 'json';
    const csrf = config.csrf ?? false;
    const csrfCookieUrl = config.csrfCookieUrl ?? DEFAULT_CSRF_COOKIE_URL;
    // Only a read joins one in flight or reads the cache.
    const joins = isRead && (config.dedupe ?? true);
    const cacheEnabled = isRead && !!config.cache;

    const fullUrl = buildFullUrl(url, config.baseURL, config.params);
    // Keys only for a read that dedupes or caches: a write, or a read doing
    // neither, builds none (tests/one-client.test.ts).
    // responseType is part of both keys - a concurrent get(url) (json) and
    // get(url, { responseType: 'blob' }) must not collapse to one request or
    // one cache slot, or the loser receives the wrong data type.
    // Two reads share one request only when they would get the same answer.
    // The request's headers change the answer (If-None-Match turns a 200 into
    // a 304; Authorization, Accept-Language), so they are in the key: a plain
    // read joining a conditional one received its 304. A read opted in to
    // resolve a 304 never shares with one that is not, either: the same
    // answer resolves for one and throws for the other.
    // tests/http-not-modified.test.ts. Nor does a `silent` read with one that
    // is not: they share one failure, marked in place, and a loud caller was
    // handed a silent failure (tests/silent-dedupe.test.ts). (`config.headers`
    // is always the merged object, the instance's defaults included.)
    // Encoded once for both keys below.
    // Names lowercased (RFC 9110 5.1: case-insensitive, and `oneSpelling`
    // left one per name) and sorted (./canonical keyTextFor), so one request
    // on the wire is one key in any spelling or order
    // (tests/http-cache-headers.test.ts).
    // A value goes out as its text, so a stray number keys as that text.
    const headersKey = joins || cacheEnabled ? headersKeyText(lowerNames(config.headers)) : '';
    const dedupeKey = joins ? `${method}:${responseType}:${config.resolveNotModified ? '304:' : ''}${config.silent ? 'silent:' : ''}${config.cacheMode ? `${config.cacheMode}:` : ''}${headersKey}:${fullUrl}` : '';
    // The cache holds the same answer the dedupe would share, so it keys by the
    // same headers: one client whose Authorization or Accept-Language changed
    // must not be served the earlier answer (tests/http-cache-headers.test.ts).
    const cacheKey = cacheEnabled ? `${responseType}:${headersKey}:${fullUrl}` : '';

    // Request deduplication for GET. A caller joins the read in flight, but its
    // signal stays its own: it cancels its promise, never another caller's.
    // A caller with no signal holds the read until it lands.
    const userSignal = config.signal;
    if (joins) {
      const inflight = cache.getInflight(dedupeKey) as Promise<HttpResponse<T>> | undefined;
      if (inflight) {
        if (!userSignal) {
          shares.delete(inflight);
          return inflight;
        }
        if (userSignal.aborted) throw asSilent(abortedRequest(fullUrl), config.silent);
        const share = shares.get(inflight);
        if (share) share.live++;
        return hold(dedupeKey, fullUrl, inflight, userSignal, config.silent);
      }
    }

    // LRU cache for GET. A fresh hit short-circuits; a stale hit (within
    // cache.staleTtl) is captured and served below with a background
    // revalidation attached - the stale-while-revalidate path.
    // Fetch's `cacheMode` means the same here as in the browser's cache:
    // `no-cache` asks the server before using the stored copy (its ETag the
    // validator), `reload` reads past it, `no-store` neither reads nor stores.
    // tests/http-cache-mode.test.ts.
    const cacheCfg = typeof config.cache === 'object' ? config.cache : {};
    let staleResponse: HttpResponse | null = null;
    let validated: HttpResponse | null = null;
    if (cacheEnabled) {
      const mode = config.cacheMode;
      if (mode !== 'no-cache' && mode !== 'reload' && mode !== 'no-store') {
        const cached = cache.get(cacheKey);
        if (cached && !cached.stale) return cached.data as HttpResponse<T>;
        if (cached) staleResponse = cached.data as HttpResponse;
      } else if (mode === 'no-cache') {
        validated = (cache.getAny(cacheKey)?.data as HttpResponse | undefined) ?? null;
      }
    }
    // The copy a 304 confirms: the stale one served now, or the one validated.
    const stored = staleResponse ?? validated;

    // Build headers and body. One spelling per name is settled in
    // clientRequest, after the interceptors, so they see what they always saw.
    const headersObj: Record<string, string> = { ...config.headers } as Record<string, string>;
    let body: string | FormData | undefined;
    const rawData = config.data;

    if (rawData !== undefined && rawData !== null) {
      if (rawData instanceof FormData) {
        body = rawData;
        dropHeaders(headersObj, ['content-type']); // let browser set boundary, in any spelling
      } else if (typeof rawData === 'object') {
        const encoded = _encodeJson(rawData, fullUrl);
        if (typeof encoded !== 'string') throw asSilent(encoded, config.silent);
        body = encoded;
        headersObj['Content-Type'] = 'application/json';
      } else {
        body = String(rawData);
      }
    }

    // A stale entry's refresh asks with the
    // stored `ETag`, unless the app asks itself. Fetch hands the 304 to the page
    // (4.6: a conditional header runs the request in "no-store" mode).
    // tests/http-etag-refresh.test.ts.
    const tag = stored?.headers.etag;
    const conditional = tag !== undefined && _headerOf(headersObj, 'if-none-match') === undefined;
    if (conditional) headersObj['If-None-Match'] = tag;

    // Execute request. `ticket`: see ResponseCache.read.
    const ticket = cacheEnabled && config.cacheMode !== 'no-store' ? cache.read(fullUrl) : null;
    // A read others may join, started by a signalled caller, fetches under a
    // controller of its own: this caller's abort is then one holder leaving.
    // An already aborted caller is not joinable; it fails on its own below.
    const joinable = joins && !userSignal?.aborted;
    const share = joinable && userSignal ? { ctrl: new AbortController(), live: 1 } : null;
    const fetchPromise = clientRequest<T>(
      fullUrl, method, headersObj, body, responseType, maxRetries, timeout,
      share ? share.ctrl.signal : userSignal, csrf, csrfCookieUrl, config.onSessionExpired, config.resolveNotModified || conditional, config.cacheMode,
    ).then((res) => {
      // Our conditional refresh answered 304: what the entry holds is current.
      // The stored response is the answer (it passed the interceptors when
      // stored), so its data stays the same object, and it opens a new window.
      if (conditional && res.status === 304) {
        if (ticket !== null && cache.done(ticket)) cache.set(cacheKey, stored, cacheCfg.ttl ?? CACHE_DEFAULT_TTL, cacheCfg.staleTtl ?? 0, fullUrl);
        return stored as HttpResponse<T>;
      }
      // Run response interceptors
      let response = res as HttpResponse;
      responseInterceptors.forEach(({ onFulfilled }) => {
        if (onFulfilled) response = onFulfilled(response) || response;
      });

      // Cache successful GET responses, unless an invalidation of this URL
      // happened while it was on the wire: it is returned, not stored. A
      // response that says `no-store` is not kept, nor the copy it refreshed.
      if (ticket && cache.done(ticket) && response.ok) {
        const control = res.headers['cache-control'];
        if (control !== undefined && NO_STORE.test(control)) cache.drop(cacheKey);
        else cache.set(cacheKey, response, cacheCfg.ttl ?? CACHE_DEFAULT_TTL, cacheCfg.staleTtl ?? 0, fullUrl);
      }
      // A write that resolved invalidates its URL and the URIs its answer
      // names (invalidatedBy), and the groups it names (RFC 9875). Only a
      // non-error answer gets here: the retry loop throws the rest. The answer
      // as received, before interceptors.
      if (!isRead) {
        cache.invalidate(invalidatedBy(fullUrl, res));
        const named = res.headers['cache-group-invalidation'];
        if (named !== undefined) groups.invalidateGroups(named);
      }

      return response as HttpResponse<T>;
    }).catch((err) => {
      if (ticket) cache.done(ticket);
      // Run response error interceptors
      responseInterceptors.forEach(({ onRejected }) => { if (onRejected) onRejected(err); });
      throw err instanceof BusError ? asSilent(err, config.silent) : err;
    });

    // cache.serveStaleOnError (opt-in): a transient failure (timeout/network/
    // 5xx per classifyError) with ANY retained entry for this URL - even one
    // past its stale window - resolves to { stale, servedOnError, error }
    // instead of rejecting. Business errors (4xx) and user aborts always
    // surface; deduped followers share this promise's outcome.
    //
    // This wrapper is built BEFORE the promise is registered for dedupe, and
    // that ordering is the whole point. Registering the raw `fetchPromise`
    // while handing the caller a `.catch()`-wrapped one gives the two callers
    // different promises: the leader would be served the retained entry while a
    // follower on the same key received the untouched rejection - the exact
    // opposite of the sentence above.
    const sharedPromise: Promise<HttpResponse<T>> =
      cacheEnabled && cacheCfg.serveStaleOnError
        ? fetchPromise.catch((error) => {
            if (classifyError(error).transient) {
              const retained = cache.getAny(cacheKey);
              if (retained) {
                return { ...(retained.data as HttpResponse<T>), stale: true, servedOnError: true, error };
              }
            }
            throw error;
          })
        : fetchPromise;

    // Track in-flight GET for deduplication
    if (joinable) {
      cache.setInflight(dedupeKey, sharedPromise, fullUrl);
      if (share) shares.set(sharedPromise, share);
    }
    // This caller holds its own read like any joiner (see hold).
    const own = share ? hold(dedupeKey, fullUrl, sharedPromise, userSignal!, config.silent) : sharedPromise;

    // Stale-while-revalidate: serve the stale response now; the fetch above
    // finishes in the background and is cached (cache.set) on success. `revalidation`
    // lets a caller push the fresh data into its own state when it lands.
    if (staleResponse) {
      own.catch(() => {}); // background failure must not surface as an unhandled rejection
      return { ...staleResponse, stale: true, revalidation: fetchPromise } as HttpResponse<T>;
    }

    return own;
  }

  return clientOver(request, {
    interceptors: {
      request: requestInterceptors,
      response: responseInterceptors,
    },
    create: (newDefaults) => createHttpClient(underDefaults(instanceDefaults, newDefaults)),
    clearCache: () => cache.clear(),
    invalidateGroups: groups.invalidateGroups,
    onInvalidateGroup: groups.onInvalidateGroup,
  });
}

/**
 * @internal One group namespace's hub (RFC 9875): every source calls
 * `invalidateGroups`, every reader listens with `onInvalidateGroup`. A client
 * is one, and a bus's transport client is that bus's hub; a bus with no
 * client gets its own from its first reader (`cache()`).
 */
export type GroupHub = Pick<HttpClient, 'invalidateGroups' | 'onInvalidateGroup'>;

/**
 * @internal A hub: `drop` first, with the groups (a client's stored reads),
 * then each listener per group. A listener's throw is logged and the rest
 * still hear. No listener emits, so nothing loops.
 * tests/cache-groups.test.ts, tests/cache-groups-hub.test.ts.
 */
export function _groupHub(drop?: (groups: readonly string[]) => void): GroupHub {
  const listeners = new Set<(group: string) => void>();
  return {
    invalidateGroups(named) {
      const groups = typeof named === 'string' ? _groupsOf(named) : named;
      if (groups.length === 0) return;
      drop?.(groups);
      for (const group of groups) {
        for (const listener of listeners) {
          try { listener(group); } catch (e) { _report('error', 'http:failed:listener', `an onInvalidateGroup listener threw on "${group}"`, e, { group }); }
        }
      }
    },
    onInvalidateGroup(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** Defaults under a call's config: the call wins, headers merged by name. */
function underDefaults(defaults: Partial<HttpRequestConfig>, config: Partial<HttpRequestConfig> = {}): HttpRequestConfig {
  return { ...defaults, ...config, headers: { ...defaults.headers, ...config.headers } };
}

type ClientState = Pick<HttpClient, 'interceptors' | 'create' | 'clearCache' | 'invalidateGroups' | 'onInvalidateGroup'>;

// The public methods over one `request`: a client's own, or `_withDefaults`'s
// over another client's, which then shares that client's state.
function clientOver(request: HttpClient['request'], state: ClientState): HttpClient {
  // Safe mode wrapper
  async function safeRequest<T>(method: HttpMethod, url: string, data?: unknown, config: HttpRequestConfig = {}): Promise<SafeResult<T>> {
    try {
      const reqConfig: HttpRequestConfig = { ...config, method };
      if (data !== undefined) reqConfig.data = data;
      const response = await request<T>(url, reqConfig);
      return { data: response.data, error: null, status: response.status };
    } catch (err) {
      // The failure the call would have thrown; `status` 0 when no response.
      const e = err as BusError;
      return { data: null, error: e, status: typeof e.context?.status === 'number' ? e.context.status : 0 };
    }
  }

  // Download helper
  async function download(url: string, filename?: string, config: HttpRequestConfig = {}): Promise<DownloadResult> {
    const response = await request<Blob>(url, { ...config, method: config.method ?? 'GET', responseType: 'blob' });

    let downloadFilename = filename;
    if (!downloadFilename) {
      const disposition = response.headers['content-disposition'];
      if (disposition) {
        const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (match) downloadFilename = match[1].replace(/['"]/g, '');
      }
    }
    downloadFilename = downloadFilename || 'download';

    // Trigger browser download (guarded for SSR)
    if (typeof document !== 'undefined' && response.data instanceof Blob) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(response.data);
      link.download = downloadFilename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    }

    return { data: response.data, status: response.status, filename: downloadFilename };
  }

  return {
    get:     <T>(url: string, config?: HttpRequestConfig) => request<T>(url, { ...config, method: 'GET' }),
    post:    <T>(url: string, data?: unknown, config?: HttpRequestConfig) => request<T>(url, { ...config, method: 'POST', data }),
    put:     <T>(url: string, data?: unknown, config?: HttpRequestConfig) => request<T>(url, { ...config, method: 'PUT', data }),
    patch:   <T>(url: string, data?: unknown, config?: HttpRequestConfig) => request<T>(url, { ...config, method: 'PATCH', data }),
    delete:  <T>(url: string, config?: HttpRequestConfig) => request<T>(url, { ...config, method: 'DELETE' }),
    request,
    download,
    safe: {
      get:    <T>(url: string, config?: HttpRequestConfig) => safeRequest<T>('GET', url, undefined, config),
      post:   <T>(url: string, data?: unknown, config?: HttpRequestConfig) => safeRequest<T>('POST', url, data, config),
      put:    <T>(url: string, data?: unknown, config?: HttpRequestConfig) => safeRequest<T>('PUT', url, data, config),
      patch:  <T>(url: string, data?: unknown, config?: HttpRequestConfig) => safeRequest<T>('PATCH', url, data, config),
      delete: <T>(url: string, config?: HttpRequestConfig) => safeRequest<T>('DELETE', url, undefined, config),
    },
    interceptors: state.interceptors,
    create: state.create,
    clearCache: state.clearCache,
    invalidateGroups: state.invalidateGroups,
    onInvalidateGroup: state.onInvalidateGroup,
  };
}

/**
 * @internal - `client` with `defaults` under every call, as `create` merges
 * them (the call wins, headers by name), but on `client`'s own state: its
 * cache, its in-flight reads and its interceptors. A write through either
 * invalidates a read cached through the other: one client.
 * `routerHttp({ http })` (router/remote.ts). tests/router/one-client.test.ts.
 */
export function _withDefaults(client: HttpClient, defaults: Partial<HttpRequestConfig>): HttpClient {
  return clientOver((url, config) => client.request(url, underDefaults(defaults, config)), {
    interceptors: client.interceptors,
    create: (newDefaults) => client.create(underDefaults(defaults, newDefaults)),
    clearCache: client.clearCache,
    invalidateGroups: client.invalidateGroups,
    onInvalidateGroup: client.onInvalidateGroup,
  });
}
