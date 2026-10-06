/**
 * pollWith - a 202 Accepted followed to its end (RFC 9110 15.3.3).
 *
 * The dispatch resolves at once: a 202 is the answer, accepted and not done.
 * When the bridge's reply was a 202 with a `Location` (`meta.response`), this
 * polls it, waiting each `Retry-After`, and emits `<action>$done` with
 * `{ command, result }` when the job ends. A monitor answers by the wire
 * contract (`{ state }` or `{ problem }`). Cross-origin, the backend must list
 * `Location` and `Retry-After` in `Access-Control-Expose-Headers`.
 * Log s35.140.
 *
 * @example
 * bus.use(pollWith({ bus, actions: ['report*'] }));
 * bus.on('reportExport$done', (e) => e.target.result);
 */
import { type ActionScope, type AsyncPlugin, type BaseBus, type Command, type CommandResult, _errResult, _failures, _okResult } from './command-bus';
import type { ActionFilter } from './action-filter';
import { MAX_TIMEOUT_MS, countOption } from './bounds';
import { type HttpClient, _parseRetryAfter, _remoteProblem, createHttpClient } from './http';

export type PollWithOptions = {
  /** The bus `<action>$done` is emitted on. */
  bus: Pick<BaseBus, 'emit'>;
  /** Follow only these actions (patterns as elsewhere). An {@link ActionScope}. */
  actions?: ActionScope;
  /** Selects actions by name, ANDed with `actions`: an {@link ActionFilter} (`createActionFilter`). Log s35.152. */
  actionFilter?: ActionFilter;
  /** The wait when a response carries no `Retry-After`, in ms. Default: 1000. */
  interval?: number;
  /** Give up after this long, in ms: `pollWith:timeout:job`. Default: 300_000. */
  maxWait?: number;
  /** The client that polls. Default: `createHttpClient({ retry: 0 })`. */
  httpClient?: Pick<HttpClient, 'get'>;
};

/** What `<action>$done` carries. */
export type PollDone = { command: Command; result: CommandResult };

const fail = _failures('pollWith');

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

export function pollWith(options: PollWithOptions): AsyncPlugin & { dispose(): void } {
  const { bus } = options;
  // A NaN behaves like a missing option (bounds.ts): never a hot loop or an endless wait.
  const interval = countOption(options.interval, 1000, 0, MAX_TIMEOUT_MS);
  const maxWait = countOption(options.maxWait, 300_000);
  const http = options.httpClient ?? createHttpClient({ retry: 0 });
  const live = new Set<AbortController>();

  async function follow(cmd: Command, url: string, firstWait: number): Promise<void> {
    const ctrl = new AbortController();
    live.add(ctrl);
    cmd.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
    const end = Date.now() + maxWait;
    let wait = firstWait;
    let result: CommandResult;
    try {
      for (;;) {
        if (Date.now() + wait > end) {
          result = _errResult(fail('timeout:job', `"${cmd.action}" was not done within ${maxWait}ms.`, { action: cmd.action, context: { location: url, maxWait } }));
          break;
        }
        await sleep(wait, ctrl.signal);
        if (ctrl.signal.aborted) return;
        const r = await http.get<{ state?: unknown; problem?: Record<string, unknown> }>(url, { signal: ctrl.signal, dedupe: false });
        if (r.status !== 202) {
          result = r.data?.problem ? _errResult(_remoteProblem(r.data.problem as never)) : _okResult(r.data?.state);
          break;
        }
        wait = _parseRetryAfter(r.headers['retry-after']) ?? interval;
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      result = _errResult(e as Error);
    } finally {
      live.delete(ctrl);
    }
    bus.emit(`${cmd.action}$done`, { command: cmd, result } satisfies PollDone);
  }

  const plugin = async (cmd: Command, next: () => CommandResult | Promise<CommandResult>): Promise<CommandResult> => {
    const result = await next();
    const res = cmd.meta?.response;
    const location = res?.status === 202 ? res.headers.location : undefined;
    if (result.ok && location) {
      const url = res!.url ? new URL(location, res!.url).href : location;
      void follow(cmd, url, _parseRetryAfter(res!.headers['retry-after']) ?? interval);
    }
    return result;
  };

  return Object.assign(plugin, {
    id: 'pollWith',
    actions: options.actions,
    actionFilter: options.actionFilter,
    dispose() { for (const c of live) c.abort(); live.clear(); },
  });
}
