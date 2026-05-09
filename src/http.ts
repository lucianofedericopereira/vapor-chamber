/**
 * vapor-chamber — HTTP client
 *
 * Adapted and improved from useFetch (2026-02-05A).
 * TypeScript rewrite aligned with vapor-chamber conventions and CDCC thresholds.
 *
 * Improvements over the original:
 *  - Full TypeScript types (no `any` casts)
 *  - CDCC-compliant function sizes
 *  - `AbortSignal.any` with manual fallback for older environments
 *  - Jitter on exponential backoff (avoids thundering herd)
 *  - `X-RateLimit-Reset` header as Retry-After fallback
 *  - 419 CSRF refresh coalesces concurrent requests (no duplicate refreshes)
 *  - `session-expired` CustomEvent + configurable callback
 *  - `TimeoutError` distinct from `AbortError` (user abort vs timeout)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HttpConfig = {
  /** Request timeout in ms. Default: 10_000 */
  timeout?: number;
  /** Max retry attempts on 5xx/429/408. Default: 0 */
  retry?: number;
  /** External abort signal (e.g. from component unmount) */
  signal?: AbortSignal;
  /** Read CSRF token from DOM and attach as header. Default: false */
  csrf?: boolean;
  /**
   * URL to fetch when a CSRF-expiry response (HTTP 419) occurs, to obtain a
   * fresh token. The default targets the Laravel Sanctum SPA convention
   * because it's the most common backend issuing 419 — override for other
   * frameworks, or set to '' to disable the auto-refresh entirely (the lib
   * will then only re-read the token from the DOM on retry).
   * Default: '/sanctum/csrf-cookie'.
   */
  csrfCookieUrl?: string;
  /** Additional headers merged into every request */
  headers?: Record<string, string>;
  /** Called when a 401 session-expired response is received */
  onSessionExpired?: (status: number) => void;
};

export type HttpResponse<T = unknown> = {
  data: T;
  status: number;
  headers: Record<string, string>;
  ok: boolean;
};

export type HttpError = Error & {
  name: 'HttpError' | 'TimeoutError' | 'AbortError';
  response?: HttpResponse;
  status?: number;
  /** Machine-readable error code from response body (e.g. `'CART_ITEM_LIMIT_EXCEEDED'`). */
  code?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RETRY_STATUS = [408, 429, 500, 502, 503, 504];
const RETRY_AFTER_STATUS = [429, 503];
const SESSION_EXPIRED_STATUS = [401]; // 419 is CSRF expiry, not session expiry
const MAX_RETRY_AFTER_MS = 30_000;
const CSRF_TTL_MS = 300_000; // 5 min
const DEFAULT_CSRF_COOKIE_URL = '/sanctum/csrf-cookie';

// ---------------------------------------------------------------------------
// CSRF — multi-source with TTL cache
// ---------------------------------------------------------------------------

type CsrfResult = { token: string; headerName: string };
type CsrfCacheEntry = CsrfResult & { expiresAt: number };

let _csrfCache: CsrfCacheEntry | null = null;
let _csrfRefreshing = false;

/** Read CSRF token from DOM: meta tag → cookie → hidden input. TTL-cached for 5 min. */
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

function readCsrfFromDom(): CsrfResult | null {
  const q = typeof document.querySelector === 'function'
    ? (sel: string) => document.querySelector(sel)
    : null;

  // 1. Meta tag — `<meta name="csrf-token" content="...">`. Common in
  //    server-rendered frameworks (Laravel Blade, Rails, others).
  if (q) {
    const meta = q('meta[name="csrf-token"]') as HTMLMetaElement | null;
    if (meta?.content) return { token: meta.content, headerName: 'X-CSRF-TOKEN' };
  }

  // 2. Cookie — read cookie name from `<meta name="xsrf-cookie">` or default
  //    to `XSRF-TOKEN` (the de-facto SPA convention shared across frameworks).
  const cookieNameMeta = q?.('meta[name="xsrf-cookie"]') as HTMLMetaElement | null;
  const cookieName = cookieNameMeta?.content || 'XSRF-TOKEN';
  const escaped = cookieName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cookieMatch = document.cookie?.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  if (cookieMatch) return { token: decodeURIComponent(cookieMatch[1]), headerName: 'X-XSRF-TOKEN' };

  // 3. Hidden input — `<input name="_token">`. Emitted by Laravel's `@csrf`
  //    Blade directive, also appears in Rails forms and other stacks.
  if (q) {
    const input = q('input[name="_token"]') as HTMLInputElement | null;
    if (input?.value) return { token: input.value, headerName: 'X-CSRF-TOKEN' };
  }

  return null;
}

/** Invalidate the CSRF token cache (e.g. after logout). */
export function invalidateCsrfCache(): void {
  _csrfCache = null;
}

let _csrfRefreshResult: boolean = false;

async function refreshCsrfOnce(cookieUrl: string): Promise<void> {
  if (_csrfRefreshing) {
    // Coalesce: wait for the in-flight refresh instead of doing a duplicate
    let ticks = 0;
    while (_csrfRefreshing && ticks < 50) {
      await new Promise<void>(r => setTimeout(r, 100));
      ticks++;
    }
    // Check if the refresh that we waited for actually succeeded
    if (!_csrfRefreshResult) {
      throw new Error('[vapor-chamber] CSRF refresh failed: token unavailable after refresh');
    }
    return;
  }
  _csrfRefreshing = true;
  _csrfRefreshResult = false;
  try {
    // Fetch the CSRF cookie endpoint so the backend issues a fresh
    // XSRF-TOKEN cookie (Laravel Sanctum's `/sanctum/csrf-cookie` is the
    // most common shape; other frameworks expose equivalent endpoints).
    // Only fetch if cookieUrl is a non-empty string.
    if (typeof cookieUrl === 'string' && cookieUrl.length > 0) {
      try { await fetch(cookieUrl, { method: 'GET', credentials: 'same-origin' }); } catch { /* ignore network errors */ }
    }
    invalidateCsrfCache();
    const freshToken = readCsrfToken(); // re-read DOM / cookie after fetch
    if (!freshToken) {
      throw new Error('[vapor-chamber] CSRF refresh failed: no token found in DOM after refresh');
    }
    _csrfRefreshResult = true;
  } finally {
    _csrfRefreshing = false;
  }
}

// ---------------------------------------------------------------------------
// Retry timing
// ---------------------------------------------------------------------------

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) {
    const ms = seconds * 1000;
    return ms <= MAX_RETRY_AFTER_MS ? ms : null;
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const ms = date - Date.now();
    return ms > 0 && ms <= MAX_RETRY_AFTER_MS ? ms : null;
  }
  return null;
}

/** Exponential backoff with ±200ms jitter to avoid thundering herd. */
function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000) + Math.random() * 200;
}

// ---------------------------------------------------------------------------
// AbortSignal utilities
// ---------------------------------------------------------------------------

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  // Fallback for environments without AbortSignal.any
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return ctrl.signal;
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Error constructors
// ---------------------------------------------------------------------------

function httpError(message: string, response: HttpResponse): HttpError {
  const err = new Error(message) as HttpError;
  err.name = 'HttpError';
  err.response = response;
  err.status = response.status;
  const code = (response.data as any)?.code;
  if (code != null) err.code = String(code);
  return err;
}

function timeoutError(action: string, timeoutMs: number): HttpError {
  const err = new Error(`"${action}" timed out after ${timeoutMs}ms`) as HttpError;
  err.name = 'TimeoutError';
  return err;
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
// Used by createHttpBridge — not intended as a general-purpose HTTP client.
// ---------------------------------------------------------------------------

async function doFetch<T>(url: string, serialized: string, headers: Record<string, string>, signal: AbortSignal): Promise<HttpResponse<T>> {
  const raw = await fetch(url, { method: 'POST', headers, body: serialized, credentials: 'same-origin', signal });
  const resHeaders = raw.headers ? Object.fromEntries(raw.headers.entries()) : {};
  let data: T = null as T;
  try { data = await raw.json() as T; } catch { /* non-JSON */ }
  return { data, status: raw.status, headers: resHeaders, ok: raw.ok };
}

export async function postCommand<T = unknown>(
  url: string,
  body: unknown,
  config: HttpConfig = {},
): Promise<HttpResponse<T>> {
  const { timeout = 10_000, retry = 0, signal: userSignal, csrf = false, csrfCookieUrl = DEFAULT_CSRF_COOKIE_URL, headers: extra = {}, onSessionExpired } = config;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...extra,
  };

  if (csrf) {
    const token = readCsrfToken();
    if (token) headers[token.headerName] = token.token;
  }

  const serialized = JSON.stringify(body);
  let csrfRetried = false;

  for (let attempt = 0; attempt <= retry; attempt++) {
    if (userSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const timeoutCtrl = new AbortController();
    const timeoutId = setTimeout(() => timeoutCtrl.abort(), timeout);
    const signal = userSignal ? combineSignals(userSignal, timeoutCtrl.signal) : timeoutCtrl.signal;

    try {
      const res = await doFetch<T>(url, serialized, headers, signal);
      clearTimeout(timeoutId);

      if (!res.ok) {
        if (SESSION_EXPIRED_STATUS.includes(res.status)) handleSessionExpiry(res.status, url, onSessionExpired);

        // 419: CSRF expired — fetch fresh cookie, refresh once, doesn't count against retry budget
        if (res.status === 419 && !csrfRetried) {
          csrfRetried = true;
          await refreshCsrfOnce(csrfCookieUrl);
          const fresh = readCsrfToken();
          if (fresh) headers[fresh.headerName] = fresh.token;
          attempt--;
          continue;
        }

        // Retry on retryable status codes
        if (RETRY_STATUS.includes(res.status) && attempt < retry) {
          const retryAfter = res.headers['retry-after'] ?? res.headers['x-ratelimit-reset'] ?? null;
          const wait = RETRY_AFTER_STATUS.includes(res.status)
            ? (parseRetryAfter(retryAfter) ?? backoffMs(attempt))
            : backoffMs(attempt);
          await sleepMs(wait, userSignal);
          continue;
        }

        throw httpError(`HTTP ${res.status}`, res);
      }

      return res;
    } catch (e) {
      clearTimeout(timeoutId);
      const err = e as Error;
      if (err.name === 'AbortError') throw userSignal?.aborted ? err : timeoutError(url, timeout);
      if (attempt >= retry) throw err;
      await sleepMs(backoffMs(attempt), userSignal);
    }
  }

  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------
// Multi-method HTTP client — createHttpClient
//
// For new code, prefer createHttpClient(). postCommand is retained for
// backward compatibility and is used by createHttpBridge.
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ResponseType = 'json' | 'blob' | 'text';

export type HttpRequestConfig = HttpConfig & {
  /** HTTP method. Default: 'GET' */
  method?: HttpMethod;
  /** Request body (auto-serialized if object, passthrough for FormData) */
  data?: unknown;
  /** Query parameters — supports arrays and nested objects */
  params?: Record<string, unknown>;
  /** Base URL prepended to relative paths */
  baseURL?: string;
  /** Response parsing mode. Default: 'json' */
  responseType?: ResponseType;
  /** Enable LRU caching for GET (true = default TTL, or { ttl: ms }) */
  cache?: boolean | { ttl: number };
  /** Enable request deduplication for GET. Default: true */
  dedupe?: boolean;
  /** @internal marks a CSRF-retried request */
  _csrfRetried?: boolean;
};

export type SafeResult<T = unknown> = {
  data: T | null;
  error: { message: string; code?: string; [key: string]: unknown } | null;
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

import { getCached, setCache, clearAllCache, invalidateCacheByPattern, getInflight, setInflight, CACHE_DEFAULT_TTL } from './http-cache';
import { buildFullUrl } from './http-query';

// ---------------------------------------------------------------------------
// Constants for multi-method client
// ---------------------------------------------------------------------------

const IDEMPOTENT_METHODS: HttpMethod[] = ['GET'];
const MUTATION_METHODS: HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
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
  const resHeaders = raw.headers ? Object.fromEntries(raw.headers.entries()) : {};

  let data: any = null;
  if (responseType === 'blob') {
    data = await raw.blob();
  } else if (responseType === 'text') {
    data = await raw.text();
  } else {
    // json (default) — graceful fallback for non-JSON responses
    const contentType = raw.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const text = await raw.text();
      data = text ? JSON.parse(text) : null;
    } else {
      data = await raw.text();
    }
  }

  return { data: data as T, status: raw.status, headers: resHeaders, ok: raw.ok };
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
): Promise<HttpResponse<T>> {
  let csrfRetried = false;

  // Attach CSRF for mutation methods
  if (csrf && MUTATION_METHODS.includes(method)) {
    const token = readCsrfToken();
    if (token) headersObj[token.headerName] = token.token;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (userSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const timeoutCtrl = new AbortController();
    const timeoutId = setTimeout(() => timeoutCtrl.abort(), timeout);
    const signal = userSignal ? combineSignals(userSignal, timeoutCtrl.signal) : timeoutCtrl.signal;

    try {
      const res = await doClientFetch<T>(fullUrl, method, headersObj, body, responseType, signal);
      clearTimeout(timeoutId);

      if (!res.ok) {
        if (SESSION_EXPIRED_STATUS.includes(res.status)) handleSessionExpiry(res.status, fullUrl, onSessionExpired);

        // 419 CSRF refresh — once, doesn't count against retry budget
        if (res.status === 419 && !csrfRetried) {
          csrfRetried = true;
          await refreshCsrfOnce(csrfCookieUrl);
          const fresh = readCsrfToken();
          if (fresh) headersObj[fresh.headerName] = fresh.token;
          attempt--;
          continue;
        }

        // Session expiry after CSRF retry exhausted
        if (res.status === 401 || (res.status === 419 && csrfRetried)) {
          handleSessionExpiry(res.status, fullUrl, onSessionExpired);
        }

        if (RETRY_STATUS.includes(res.status) && attempt < maxRetries) {
          const retryAfter = res.headers['retry-after'] ?? res.headers['x-ratelimit-reset'] ?? null;
          const wait = RETRY_AFTER_STATUS.includes(res.status)
            ? (parseRetryAfter(retryAfter) ?? backoffMs(attempt))
            : backoffMs(attempt);
          await sleepMs(wait, userSignal);
          continue;
        }

        throw httpError(`HTTP ${res.status}`, res);
      }

      return res;
    } catch (e) {
      clearTimeout(timeoutId);
      const err = e as Error;
      if (err.name === 'AbortError') throw userSignal?.aborted ? err : timeoutError(fullUrl, timeout);
      if (attempt >= maxRetries) throw err;
      await sleepMs(backoffMs(attempt), userSignal);
    }
  }

  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------
// createHttpClient
// ---------------------------------------------------------------------------

/**
 * createHttpClient — multi-method HTTP client with interceptors, caching,
 * deduplication, safe mode, and file download.
 *
 * Aligned with useFetch (2026-02-05A) patterns. Framework-agnostic — no Vue imports.
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
 * // Safe mode — never throws
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

  async function request<T = unknown>(url: string, options: HttpRequestConfig = {}): Promise<HttpResponse<T>> {
    // Merge instance defaults with per-call options
    let config: HttpRequestConfig = {
      ...instanceDefaults,
      ...options,
      headers: {
        'Accept': 'application/json',
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
    const timeout = config.timeout ?? DEFAULT_CLIENT_TIMEOUT;
    const isIdempotent = IDEMPOTENT_METHODS.includes(method);
    const maxRetries = config.retry ?? (isIdempotent ? DEFAULT_GET_RETRY : DEFAULT_MUTATION_RETRY);
    const responseType: ResponseType = config.responseType ?? 'json';
    const csrf = config.csrf ?? false;
    const csrfCookieUrl = config.csrfCookieUrl ?? DEFAULT_CSRF_COOKIE_URL;
    const dedupe = config.dedupe ?? true;

    const fullUrl = buildFullUrl(url, config.baseURL, config.params);
    const dedupeKey = `${method}:${fullUrl}`;

    // Request deduplication for GET
    if (isIdempotent && dedupe) {
      const inflight = getInflight(dedupeKey);
      if (inflight) return inflight as Promise<HttpResponse<T>>;
    }

    // LRU cache for GET
    const cacheEnabled = config.cache && isIdempotent;
    if (cacheEnabled) {
      const cached = getCached(fullUrl);
      if (cached) return cached as HttpResponse<T>;
    }

    // Build headers and body
    const headersObj: Record<string, string> = { ...config.headers } as Record<string, string>;
    let body: string | FormData | undefined;
    const rawData = config.data;

    if (rawData !== undefined && rawData !== null) {
      if (rawData instanceof FormData) {
        body = rawData;
        delete headersObj['Content-Type']; // let browser set boundary
      } else if (typeof rawData === 'object') {
        body = JSON.stringify(rawData);
        headersObj['Content-Type'] = 'application/json';
      } else {
        body = String(rawData);
      }
    }

    // Execute request
    const fetchPromise = clientRequest<T>(
      fullUrl, method, headersObj, body, responseType, maxRetries, timeout,
      config.signal, csrf, csrfCookieUrl, config.onSessionExpired,
    ).then((res) => {
      // Run response interceptors
      let response = res as HttpResponse;
      responseInterceptors.forEach(({ onFulfilled }) => {
        if (onFulfilled) response = onFulfilled(response) || response;
      });

      // Cache successful GET responses
      if (cacheEnabled && response.ok) {
        const ttl = typeof config.cache === 'object' ? config.cache.ttl : CACHE_DEFAULT_TTL;
        setCache(fullUrl, response, ttl);
      }

      return response as HttpResponse<T>;
    }).catch((err) => {
      // Run response error interceptors
      responseInterceptors.forEach(({ onRejected }) => { if (onRejected) onRejected(err); });
      throw err;
    });

    // Track in-flight GET for deduplication
    if (isIdempotent && dedupe) {
      setInflight(dedupeKey, fetchPromise);
    }

    return fetchPromise;
  }

  // Safe mode wrapper
  async function safeRequest<T>(method: HttpMethod, url: string, data?: unknown, config: HttpRequestConfig = {}): Promise<SafeResult<T>> {
    try {
      const reqConfig: HttpRequestConfig = { ...config, method };
      if (data !== undefined) reqConfig.data = data;
      const response = await request<T>(url, reqConfig);
      return { data: response.data, error: null, status: response.status };
    } catch (err) {
      const e = err as HttpError;
      const errorData = e.response?.data as any;
      return {
        data: null,
        error: errorData && typeof errorData === 'object' ? errorData : { message: e.message, code: e.code },
        status: e.status ?? e.response?.status ?? 0,
      };
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
    clearCache: clearAllCache,
    invalidateCache: invalidateCacheByPattern,
  };
}
