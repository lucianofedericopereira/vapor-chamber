/**
 * vapor-chamber - status messages for assistive technology.
 *
 * `announce(message)` says something to a screen reader without moving focus
 * (WCAG 4.1.3, status messages): a failed command, a saved form, a page that
 * changed. Every feature that needs it goes through here, so a document has
 * ONE pair of live regions (polite, assertive), created on first use, instead
 * of one per feature. That is the pattern of Angular CDK's LiveAnnouncer and
 * React Aria's announce(), and the reason a region is not the router's or the
 * directive's own.
 *
 * The library holds no words: what is announced is data (a failure's message,
 * a backend problem's `detail`, already localized; a page's
 * title). An app that wants its own words or its own status bar takes the
 * announcing over with `setAnnouncer(fn)`, and `setAnnouncer(null)` hands it
 * back. A no-op outside a browser. tests/a11y-announce.test.ts.
 */

export type AnnounceOptions = {
  /** Interrupt what is being read (a failure); default polite (a success, a page change). */
  assertive?: boolean;
};

export type Announcer = (message: string, options: { assertive: boolean }) => void;

let custom: Announcer | null = null;
const regions: { polite?: HTMLElement; assertive?: HTMLElement } = {};

function region(kind: 'polite' | 'assertive'): HTMLElement {
  const existing = regions[kind];
  if (existing?.isConnected) return existing;
  const el = document.createElement('div');
  el.setAttribute('data-vc-announcer', kind);
  el.setAttribute('aria-live', kind);
  el.setAttribute('aria-atomic', 'true');
  // Hidden visually, NOT from the accessibility tree: display:none or
  // aria-hidden would silence it. CSSOM rather than a style attribute, so it
  // works under a CSP without 'unsafe-inline'.
  Object.assign(el.style, {
    position: 'absolute', width: '1px', height: '1px', margin: '-1px', padding: '0',
    overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: '0',
  });
  document.body.append(el);
  regions[kind] = el;
  return el;
}

/** Say `message` to assistive technology, politely unless `assertive`. */
export function announce(message: string, options: AnnounceOptions = {}): void {
  if (!message) return;
  const assertive = options.assertive === true;
  if (custom) {
    custom(message, { assertive });
    return;
  }
  if (typeof document === 'undefined') return;
  const el = region(assertive ? 'assertive' : 'polite');
  // Cleared, then set one frame later: a screen reader announces a CHANGE, so
  // the same message twice ("Saved", "Saved") would otherwise be heard once.
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = message; });
}

/** Take the announcing over (an app's status bar, its words); `null` hands it back. */
export function setAnnouncer(fn: Announcer | null): void {
  custom = fn;
}
