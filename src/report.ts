/**
 * vapor-chamber - the reporter: every warning and error the library detects
 * and does not return goes through `_report`, as one report with its code.
 *
 * A report is formatted once, by one formatter, and handed to every sink. The
 * app replaces the formatter, or replaces and adds sinks, with
 * `configureReport`; the default formatter prints the house diagnostic shape
 * (vitest-pure.ts prints it too), and the default sink is the console. The
 * level comes from the call site, and the formatter reads no registry: a
 * bundler that cannot fold `DEV` across modules (esbuild) would otherwise keep
 * the whole registry in every bundle that reports (log 36.121). In development
 * the formatter adds the docs link, whose section lists the code's fix.
 * tests/report.test.ts.
 */
import { DEV } from './dev';
import { ERRORS_PAGE } from './error-registry';

/** One warning or error the library detected. `code` is `owner:condition:subject`. */
export type Report = {
  readonly code: string;
  readonly level: 'warn' | 'error';
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly error?: unknown;
};
/** Turns a report into the arguments a sink prints, as `console.warn(...args)` takes them. */
export type ReportFormat = (report: Report) => readonly unknown[];
/** Receives every report with the formatter's arguments. */
export type ReportSink = (report: Report, args: readonly unknown[]) => void;

/** The level's tag, one width for both, so a scan of a busy console finds them. */
const TAG = { warn: '[ WARN ]', error: '[ FAIL ]' } as const;

/**
 * The default formatter. The first line is
 * `[vapor-chamber] [ WARN ] <code>: <message>` (`[ FAIL ]` for an error); in
 * development a `docs:` line links the code's section of docs/errors.md. An
 * error rides as its own argument, so the console keeps its stack.
 */
export function formatReport(report: Report): readonly unknown[] {
  let text = `[vapor-chamber] ${TAG[report.level]} ${report.code}: ${report.message}`;
  if (DEV) text += `\n  docs: ${ERRORS_PAGE}${report.code.split(':')[1]}`;
  return report.error === undefined ? [text] : [text, report.error];
}

/** The default sink: the console method of the report's level. */
export const consoleSink: ReportSink = (report, args) => { console[report.level](...args); };

/** The lowest level reported: `'warn'` reports both, `'error'` errors only, `'silent'` nothing. */
export type ReportLevel = 'warn' | 'error' | 'silent';

let format: ReportFormat = formatReport;
let sinks: readonly ReportSink[] = [consoleSink];
// The floor as a number: a warning passes at 0, an error below 2.
let floor = 0;

/**
 * Replace the formatter, the sinks or the level floor; an option left out, or
 * `null`, takes its default (`formatReport`, `[consoleSink]`, `'warn'`). An app
 * that adds a sink keeps `consoleSink` in its list.
 *
 * @example
 * configureReport({ sinks: [consoleSink, (r) => telemetry.send(r.code, r.context)] });
 * configureReport({ level: 'error' }); // warnings dropped, errors reported
 */
export function configureReport(options: { format?: ReportFormat; sinks?: readonly ReportSink[]; level?: ReportLevel } | null): void {
  format = options?.format ?? formatReport;
  sinks = options?.sinks ?? [consoleSink];
  const level = options?.level ?? 'warn';
  floor = level === 'warn' ? 0 : level === 'error' ? 1 : 2;
}

/**
 * @internal Report a warning or an error. Cold: a misuse, or a throw the
 * library caught. A formatter's or a sink's throw prints the report and the
 * throw through the defaults, and the caller goes on: a reported listener
 * error never becomes a failed dispatch.
 */
export function _report(level: Report['level'], code: string, message: string, error?: unknown, context?: Record<string, unknown>): void {
  if ((level === 'warn' ? 0 : 1) < floor) return;
  const report: Report = { code, level, message, context, error };
  let args: readonly unknown[];
  try { args = format(report); }
  catch (e) { args = formatReport(report); broke(report, args, e); }
  for (const sink of sinks) {
    try { sink(report, args); }
    catch (e) { broke(report, args, e); }
  }
}

/** A formatter or a sink threw: the report and the throw, through the defaults. */
function broke(report: Report, args: readonly unknown[], e: unknown): void {
  consoleSink(report, args);
  console.error('[vapor-chamber] [ FAIL ] core:failed:report: a report formatter or sink threw', e);
}
