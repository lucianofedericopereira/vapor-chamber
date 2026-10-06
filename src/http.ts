/**
 * vapor-chamber - HTTP client
 *
 * Adapted and improved from useFetch (2026-02-05A).
 * TypeScript rewrite aligned with vapor-chamber conventions and CDCC thresholds.
 *
 * Improvements over the original:
 *  - Full TypeScript types
 *  - CDCC-compliant function sizes
 *  - `AbortSignal.any` with manual fallback for older environments
 *  - Jitter on exponential backoff (avoids thundering herd)
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
   * and a general-purpose GET have different patience). Stating only the first
   * made this tooltip wrong for every `http.get()` caller.
   *
   * Bounds: a value that does not compare as a number (NaN, a non-numeric
   * string) takes that default; anything above
   * 2_147_483_647 ms (`setTimeout`'s ceiling, where it would fire at once)
   * is capped there, so `Infinity` means "as long as a timer can wait"; 0 or
   * a negative value times out immediately.
   */
  timeout?: number;
  /**
   * Max re-sends of a failure the bus's rule allows (`retryClass`): a
   * transient one (408, 429, 503) for any method; an uncertain one, or an
   * answer with a declared wait, only for an idempotent method or an
   * `Idempotency-Key`. An unidentified request with no reply, a 502 or a 504
   * fails with `context.outcome: 'unknown'`. **0 through `postCommand`**, and
   * through a client **2 for reads (GET), 0 for other methods**.
   */
  retry?: number;
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
   * Stamps a thrown error's `.silent` so a caller-provided global error
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
  if (cookieMatch) return { token: decodeURIComponent(cookieMatch[1]), headerName: 'X-XSRF-TOKEN' };
  return null;
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

let _csrfRefreshPromise: Promise<CsrfResult> | null = null;

function refreshCsrfOnce(cookieUrl: string): Promise<CsrfResult> {
  // Coalesce: concurrent 419s share the single in-flight refresh promise -
  // waiters resolve/reject the instant it settles, no polling.
  //
  // RETURNS the token rather than leaving callers to re-read it: a re-read
  // after the await sits across a microtask boundary that several coalesced
  // waiters resume across, and a waiter that ran first could invalidate the
  // cache or clear the DOM, so a later one would retry with no CSRF header.
  // Every waiter gets the SAME token; this throws when none is found.
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
      const freshToken = readCsrfAfterRefresh();
      if (!freshToken) {
        throw transportFail('missing:csrf', `No CSRF token after refreshing it from "${cookieUrl}".`, { context: { url: cookieUrl } });
      }
      return freshToken;
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
 * read asctime as LOCAL time and took any form it knew (ISO, `10/1/2026`).
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
 * @internal - also read by the bridges (transports.ts), for `context.retryIn`.
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

/** Exponential backoff plus 0-200ms of jitter to avoid thundering herd. */
function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000) + Math.random() * 200;
}

// ---------------------------------------------------------------------------
// AbortSignal utilities
// ---------------------------------------------------------------------------

type CombinedSignal = { signal: AbortSignal; detach: () => void };

function combineSignals(a: AbortSignal, b: AbortSignal): CombinedSignal {
  // AbortSignal.any listeners are platform-managed (GC-safe) - nothing to detach.
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([a, b]), detach: () => {} };
  }
  // Fallback for environments without AbortSignal.any. Callers MUST detach()
  // when the request settles - the user signal is typically component-lifetime,
  // so listeners left behind accrete once per request until unmount.
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return {
    signal: ctrl.signal,
    detach: () => {
      a.removeEventListener('abort', abort);
      b.removeEventListener('abort', abort);
    },
  };
}

// The caller's own abort, wherever it lands: a code, never a raw DOMException.
function abortedRequest(url: string): BusError {
  return transportFail('aborted:request', `"${url}" was aborted.`, { context: { url } });
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
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
 * @internal - the failure a backend declared: `remote:<condition>:<code>`, the
 * condition from the problem's own `status` (else the response's), `detail` the
 * message, the rest `context`. `retryIn` is the response's `Retry-After` (RFC
 * 9110), never a body member: it is set after the spread, so a body cannot
 * supply it. One reader for the client and every bridge (log s35.131).
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
  const retryIn = _parseRetryAfter(headers?.['retry-after']);
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
// Used by createHttpBridge - not intended as a general-purpose HTTP client.
// ---------------------------------------------------------------------------

/**
 * A Response's headers as a plain object, tolerating a double or polyfill that
 * has no `headers` at all.
 *
 * Extracted because this line existed TWICE, written out longhand - once in
 * `doFetch` and once in `doClientFetch`. That duplication is what let the two
 * drift: `doFetch` never touched `raw.headers` again and stayed correct, while
 * `doClientFetch` grew responseType handling whose content-type read went back
 * to the raw object and reintroduced the crash this guard exists to prevent.
 * One owner for "normalize a Response's headers" removes that channel.
 *
 * Keys are lower-cased here, and this is the only place that should do it.
 * Every consumer reads this snapshot case-sensitively -
 * `res.headers['retry-after']` in the retry
 * loops, `['content-disposition']` in the download path - so a `Headers` whose
 * `entries()` yields `Retry-After` makes all of them miss with NO error:
 * backoff silently not honoured, filename silently lost.
 *
 * The Fetch spec does store header names lower-cased, so against a compliant
 * implementation this is a no-op, and it costs +6 bytes brotli in the minimal
 * consumer bundle (measured: 6_539 -> 6_545). Taken deliberately: the argument
 * for skipping it assumes every Headers implementation in every consumer's
 * environment is compliant, and the price of being wrong is a SILENT
 * mis-behaviour rather than a crash. Six bytes to make a silent failure
 * impossible is the trade this library wants - correctness over the byte.
 * Normalizing at the four call sites instead would re-create exactly the
 * duplication this helper exists to remove.
 *
 * The content-type read in `doClientFetch` goes through `Headers.get()` rather
 * than this snapshot for the same reason from the other direction: `get()` is
 * case-insensitive BY SPEC and joins repeated headers, so delegating keeps
 * both guarantees the platform's problem rather than ours. Reading
 * `resHeaders['content-type']` instead would miss on odd casing - and a miss
 * there does not throw, it silently hands the caller a STRING where they asked
 * for JSON.
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
    && (IDEMPOTENT_METHODS.has(method) || Object.keys(headers).some((k) => k.toLowerCase() === 'idempotency-key')));
}

/**
 * The wait an answer declares: Retry-After (RFC 9110 10.2.3), else the
 * RateLimit field's `t` seconds for a policy with no quota left (`r=0`),
 * else `X-RateLimit-Reset` (docs/plan-shape.md 4). draft-ietf-httpapi-
 * ratelimit-headers-11: a List of items, each `"policy";r=<n>;t=<s>`.
 * Retry-After "MUST take precedence". tests/retry-unidentified.test.ts.
 */
function declaredWait(headers: Record<string, string>): number | undefined {
  let t: number | undefined;
  for (const item of headers.ratelimit?.split(',') ?? []) {
    const m = /;\s*t=(\d+)/.exec(item);
    if (m && /;\s*r=0\b/.test(item)) t = Math.max(t ?? 0, +m[1]);
  }
  return _parseRetryAfter(headers['retry-after'] ?? (t === undefined ? headers['x-ratelimit-reset'] : String(t)));
}

async function doFetch<T>(url: string, serialized: string, headers: Record<string, string>, signal: AbortSignal): Promise<HttpResponse<T>> {
  const raw = await fetch(url, { method: 'POST', headers, body: serialized, credentials: 'same-origin', signal });
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
    timeout: number;
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

  for (let attempt = 0; attempt <= retry; attempt++) {
    if (userSignal?.aborted) throw asSilent(abortedRequest(url), silent);

    const timeoutCtrl = new AbortController();
    const timeoutId = setTimeout(() => timeoutCtrl.abort(), timeout);
    const combined = userSignal ? combineSignals(userSignal, timeoutCtrl.signal) : null;
    const signal = combined ? combined.signal : timeoutCtrl.signal;

    try {
      const res = await doRequest(signal);
      clearTimeout(timeoutId);
      combined?.detach();

      if (!res.ok) {
        // Opted in: a 304 is the answer to the app's conditional request.
        if (notModified && res.status === 304) return res;
        if (SESSION_EXPIRED_STATUS.includes(res.status)) handleSessionExpiry(res.status, url, onSessionExpired);

        // 419 = CSRF expiry: refresh once (off the retry budget), then retry.
        // It NEVER fires onSessionExpired - that is 401's job (whitepaper 6.2).
        if (res.status === 419 && !csrfRetried) {
          csrfRetried = true;
          setCsrfHeader(headers, await refreshCsrfOnce(csrfCookieUrl));
          attempt--;
          continue;
        }

        // A declared wait sets when, never whether: the rule decides. Waiting
        // what it says, never less; a declared wait over 30 s is not slept
        // inside the request, it ends it.
        const failure = _answered(res.status, res.data, res.headers);
        const declared = declaredWait(res.headers);
        if (attempt < retry && !((declared ?? 0) > MAX_RETRY_AFTER_MS)) {
          if (resendable(failure, opts.method, headers, declared)) {
            await sleepMs(declared ?? backoffMs(attempt), userSignal);
            continue;
          }
          _heldBack(failure, declared, opts.method, url);
        }
        throw asSilent(failure, silent);
      }

      return res;
    } catch (e) {
      clearTimeout(timeoutId);
      combined?.detach();
      // An answer thrown above was already judged by the rule there; it
      // re-enters here only to leave.
      if (e instanceof BusError) throw e;
      if (userSignal?.aborted) throw asSilent(abortedRequest(url), silent);
      // A timeout-triggered abort is no reply in time; a body that is not the
      // JSON it declared is an off-protocol answer; anything else is no
      // response. The first and the last may have landed.
      const failure = (e as Error)?.name === 'AbortError'
        ? transportFail('timeout:reply', `"${url}" timed out after ${timeout}ms.`, { context: { url, timeout } })
        : e instanceof SyntaxError
          ? remoteFail('unexpected:json', `"${url}" answered a body that is not valid JSON.`, { context: { url }, cause: e })
          : transportFail('lost:reply', `No response from "${url}".`, { context: { url }, cause: e });
      if (attempt >= retry) throw asSilent(failure, silent);
      if (!resendable(failure, opts.method, headers)) {
        _heldBack(failure, undefined, opts.method, url);
        throw asSilent(failure, silent);
      }
      try {
        await sleepMs(backoffMs(attempt), userSignal);
      } catch {
        throw asSilent(abortedRequest(url), silent);
      }
    }
  }

  throw new Error('unreachable');
}

export async function postCommand<T = unknown>(
  url: string,
  body: unknown,
  config: HttpConfig = {},
): Promise<HttpResponse<T>> {
  const { timeout: rawTimeout = 10_000, retry = 0, signal: userSignal, csrf = false, csrfCookieUrl = DEFAULT_CSRF_COOKIE_URL, headers: extra = {}, onSessionExpired, silent = false } = config;
  // setTimeout fires a delay it cannot hold AT ONCE: NaN reads as 0, and past
  // MAX_TIMEOUT_MS Node clamps to 1ms and browsers wrap. So `timeout: NaN`
  // (a failed `Number(config.x)`) and `timeout: Infinity` ("no timeout")
  // aborted every request as it started. Two comparisons: NaN (or anything
  // that does not compare as a number) fails both and takes the default,
  // Infinity fails the first and is capped at the ceiling, and 0 and
  // negatives pass through as an explicit "fire now". Chosen over an inline
  // typeof check and over countOption() by measurement - smallest in the
  // Blade bundle (tests/esm-treeshake.test.ts). Pinned by
  // tests/http-timeout-bounds.test.ts.
  const timeout = rawTimeout < MAX_TIMEOUT_MS ? rawTimeout : rawTimeout > 0 ? MAX_TIMEOUT_MS : 10_000;

  const merged: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...extra,
  };
  if (csrf) attachCsrf(merged);
  const headers = oneSpelling(merged);

  const serialized = JSON.stringify(body);
  return runWithRetry<T>(
    (signal) => doFetch<T>(url, serialized, headers, signal),
    headers,
    { retry, timeout, userSignal, csrfCookieUrl, onSessionExpired, url, method: 'POST', silent, notModified: config.resolveNotModified },
  );
}

// ---------------------------------------------------------------------------
// Multi-method HTTP client - createHttpClient
//
// postCommand is the wire contract's POST, used by the bridges.
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
   * (`tests/http-dedupe-signal.test.ts`)
   */
  dedupe?: boolean;
  /** @internal marks a CSRF-retried request */
  _csrfRetried?: boolean;
};

/**
 * A `safe` helper's outcome: it never throws. `error` is the failure the call
 * would have thrown, the core's `BusError` (`conditionOf(error)`, and
 * `problemOf(error)` for the backend's RFC 9457 problem). `status` is 0 when
 * there was no response.
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
  invalidateCache(pattern: string | RegExp): void;
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

import { MAX_TIMEOUT_MS } from './bounds';
import { createResponseCache, CACHE_DEFAULT_TTL } from './http-cache';
import { classifyError, type ProblemDetails } from './http-errors';
import { BusError, _failures, _heldBack, conditionOfStatus, retryClass, type FailCode } from './failure';
import { buildFullUrl } from './http-query';

// ---------------------------------------------------------------------------
// Constants for multi-method client
// ---------------------------------------------------------------------------

/** A read: retried by default and cached; any other method invalidates its URL. */
const READ_METHODS: HttpMethod[] = ['GET'];
const MUTATION_METHODS: HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
/** RFC 9110 9.2.2: safe to send twice, so the retry rule may re-send an uncertain failure. */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const DEFAULT_GET_RETRY = 2;
const DEFAULT_MUTATION_RETRY = 0;
const DEFAULT_CLIENT_TIMEOUT = 30_000;

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
): Promise<HttpResponse<T>> {
  const init: RequestInit = { method, headers, credentials: 'same-origin', signal };
  if (body !== undefined) init.body = body;

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
    // `application/problem+json` (RFC 9457) above all, whose `code` was lost
    // as an unparsed string. A type that only CONTAINS "json"
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
  timeout: number,
  userSignal: AbortSignal | undefined,
  csrf: boolean,
  csrfCookieUrl: string,
  onSessionExpired?: (status: number) => void,
  notModified?: boolean,
): Promise<HttpResponse<T>> {
  // Attach CSRF for mutation methods
  if (csrf && MUTATION_METHODS.includes(method)) attachCsrf(headersObj);
  const headers = oneSpelling(headersObj);

  return runWithRetry<T>(
    (signal) => doClientFetch<T>(fullUrl, method, headers, body, responseType, signal),
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
 * Aligned with useFetch (2026-02-05A) patterns. Framework-agnostic - no Vue imports.
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

  // One caller's promise on a shared read: its own signal rejects it, and only
  // it. The last holder to abort cancels the fetch and removes the in-flight
  // entry at once, so a caller arriving after that starts a fresh request
  // instead of joining one that is already aborted.
  function hold<T>(key: string, url: string, shared: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(abortedRequest(url));
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
    // Merge instance defaults with per-call options
    let config: HttpRequestConfig = {
      ...instanceDefaults,
      ...options,
      headers: {
        'Accept': 'application/json, application/problem+json',
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
    // Same bounds as postCommand's, normalized once before clientRequest's loop.
    const rawTimeout = config.timeout as number;
    const timeout = rawTimeout < MAX_TIMEOUT_MS ? rawTimeout : rawTimeout > 0 ? MAX_TIMEOUT_MS : DEFAULT_CLIENT_TIMEOUT;
    const isRead = READ_METHODS.includes(method);
    const maxRetries = config.retry ?? (isRead ? DEFAULT_GET_RETRY : DEFAULT_MUTATION_RETRY);
    const responseType: ResponseType = config.responseType ?? 'json';
    const csrf = config.csrf ?? false;
    const csrfCookieUrl = config.csrfCookieUrl ?? DEFAULT_CSRF_COOKIE_URL;
    const dedupe = config.dedupe ?? true;

    const fullUrl = buildFullUrl(url, config.baseURL, config.params);
    // responseType is part of both keys - a concurrent get(url) (json) and
    // get(url, { responseType: 'blob' }) must not collapse to one request or
    // one cache slot, or the loser receives the wrong data type.
    // Two reads share one request only when they would get the same answer.
    // The request's headers change the answer (If-None-Match turns a 200 into
    // a 304; Authorization, Accept-Language), so they are in the key: a plain
    // read joining a conditional one received its 304. A read opted in to
    // resolve a 304 never shares with one that is not, either: the same
    // answer resolves for one and throws for the other.
    // tests/http-not-modified.test.ts. (`config.headers` is always the merged
    // object, the instance's defaults included.)
    const dedupeKey = `${method}:${responseType}:${config.resolveNotModified ? '304:' : ''}${JSON.stringify(config.headers)}:${fullUrl}`;
    const cacheKey = `${responseType}:${fullUrl}`;

    // Request deduplication for GET. A caller joins the read in flight, but its
    // signal stays its own: it cancels its promise, never another caller's.
    // A caller with no signal holds the read until it lands.
    const userSignal = config.signal;
    if (isRead && dedupe) {
      const inflight = cache.getInflight(dedupeKey) as Promise<HttpResponse<T>> | undefined;
      if (inflight) {
        if (!userSignal) {
          shares.delete(inflight);
          return inflight;
        }
        if (userSignal.aborted) throw abortedRequest(fullUrl);
        const share = shares.get(inflight);
        if (share) share.live++;
        return hold(dedupeKey, fullUrl, inflight, userSignal);
      }
    }

    // LRU cache for GET. A fresh hit short-circuits; a stale hit (within
    // cache.staleTtl) is captured and served below with a background
    // revalidation attached - the stale-while-revalidate path.
    const cacheEnabled = config.cache && isRead;
    const cacheCfg = typeof config.cache === 'object' ? config.cache : {};
    let staleResponse: HttpResponse | null = null;
    if (cacheEnabled) {
      const cached = cache.get(cacheKey);
      if (cached && !cached.stale) return cached.data as HttpResponse<T>;
      if (cached) staleResponse = cached.data as HttpResponse;
    }

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
        body = JSON.stringify(rawData);
        headersObj['Content-Type'] = 'application/json';
      } else {
        body = String(rawData);
      }
    }

    // Execute request. `ticket`: see ResponseCache.read.
    const ticket = cacheEnabled ? cache.read(fullUrl) : null;
    // A read others may join, started by a signalled caller, fetches under a
    // controller of its own: this caller's abort is then one holder leaving.
    // An already aborted caller is not joinable; it fails on its own below.
    const joinable = isRead && dedupe && !userSignal?.aborted;
    const share = joinable && userSignal ? { ctrl: new AbortController(), live: 1 } : null;
    const fetchPromise = clientRequest<T>(
      fullUrl, method, headersObj, body, responseType, maxRetries, timeout,
      share ? share.ctrl.signal : userSignal, csrf, csrfCookieUrl, config.onSessionExpired, config.resolveNotModified,
    ).then((res) => {
      // Run response interceptors
      let response = res as HttpResponse;
      responseInterceptors.forEach(({ onFulfilled }) => {
        if (onFulfilled) response = onFulfilled(response) || response;
      });

      // Cache successful GET responses, unless an invalidation of this URL
      // happened while it was on the wire: it is returned, not stored.
      if (ticket && cache.done(ticket) && response.ok) {
        cache.set(cacheKey, response, cacheCfg.ttl ?? CACHE_DEFAULT_TTL, cacheCfg.staleTtl ?? 0);
      }
      // A write that resolved invalidates its URL and the URIs its answer
      // names (invalidatedBy). Only a non-error answer gets here: the retry
      // loop throws the rest. The answer as received, before interceptors.
      if (!isRead) cache.invalidate(invalidatedBy(fullUrl, res));

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
    // different promises: the leader was served the retained entry while a
    // follower on the same key received the untouched rejection - the exact
    // opposite of the sentence above. The features were only ever tested
    // apart, every serveStaleOnError case passing `dedupe: false`, so the
    // disagreement never showed up.
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
    const own = share ? hold(dedupeKey, fullUrl, sharedPromise, userSignal!) : sharedPromise;

    // Stale-while-revalidate: serve the stale response now; the fetch above
    // finishes in the background and is cached (cache.set) on success. `revalidation`
    // lets a caller push the fresh data into its own state when it lands.
    if (staleResponse) {
      own.catch(() => {}); // background failure must not surface as an unhandled rejection
      return { ...staleResponse, stale: true, revalidation: fetchPromise } as HttpResponse<T>;
    }

    return own;
  }

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
    interceptors: {
      request: requestInterceptors,
      response: responseInterceptors,
    },
    create: (newDefaults) => createHttpClient({
      ...instanceDefaults,
      ...newDefaults,
      headers: { ...instanceDefaults.headers, ...newDefaults?.headers },
    }),
    clearCache: () => cache.clear(),
    invalidateCache: (pattern) => cache.invalidate(pattern),
  };
}
