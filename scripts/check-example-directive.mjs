/**
 * Step 5 of the RC alignment ritual, past "it builds".
 *
 * WHY THIS EXISTS. Rebuilding the examples proves they compile. Vue 3.6.0-rc.9
 * #15490 changed the compiled directive tuple and `v-vc-command` stopped
 * mounting in every compiled Vapor template - a defect that builds cleanly,
 * type-checks cleanly, and ships a button that does nothing. A build that
 * finishes is not evidence about a directive.
 *
 * So this loads the BUILT production bundle of examples/vapor-sfc into a DOM,
 * lets the app mount, clicks the `v-vc-command` control, and checks that the
 * directive responded: `vc-loading` on the element and the button disabled are
 * what `buildHandler` does at the start of a dispatch.
 *
 * It lives in scripts/ rather than tests/ on purpose: it depends on an
 * example's build output, so it would fail on a fresh clone before anything is
 * built. Run it after the example rebuilds:
 *
 *     npm --prefix examples/vapor-sfc run build
 *     node scripts/check-example-directive.mjs
 *
 * or `npm run check:example`, which does both.
 *
 * `check:example` ALSO BUILDS examples/vapor-island-cart afterwards, which this
 * script has nothing to do with and which is why it is said here rather than
 * nowhere: package.json cannot carry a comment. That example is a workspace
 * with its own `vue-tsc --noEmit && vite build`, and until this was wired in no
 * root script ran it - so the only end-to-end exercise of `sync()` against a
 * real bus and fast lane was checked by nothing. It costs ~1.5s on top of this
 * script's ~2.6s. A build is not a behaviour check, but it does pin the example
 * against the current `sync({ channel, lane, events })` signature, which is the
 * drift that would actually happen.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIST = resolve(process.cwd(), 'examples/vapor-sfc/dist');
const fail = (msg) => {
  console.error(`check-example-directive: ${msg}`);
  process.exit(1);
};

if (!existsSync(resolve(DIST, 'index.html'))) {
  fail(`no build at ${DIST} - run: npm --prefix examples/vapor-sfc run build`);
}

const html = readFileSync(resolve(DIST, 'index.html'), 'utf8');
const src = html.match(/src="([^"]+\.js)"/)?.[1];
if (!src) fail('no module script in the built index.html');

const { Window } = await import('happy-dom');
const win = new Window({ url: 'https://example.test/' });
// The page's own markup minus its script tag, so #app exists to mount into and
// the module is the only thing that runs.
win.document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '');

// The bundle is an ES module written for a browser: it reads DOM globals at
// evaluation time, so they have to be in place before the import.
//
// ADD what node does not have, OVERRIDE only the few that must come from the
// DOM. Two wrong versions preceded this one, and both are worth recording
// because they fail in opposite directions:
//
//   a hand-written list of a dozen names -> `Text is not defined`, because the
//     Vapor runtime uses globals nobody thought to list;
//   every own key of the window       -> node aborts, because that overwrites
//     its builtins (Object, Promise, process...).
//
// So: anything the window has that globalThis lacks is safe to add, and the
// DOM entry points below are overridden deliberately - node defines its own
// `navigator` and `location`, and the bundle must see happy-dom's.
const OVERRIDE = new Set(['window', 'document', 'navigator', 'location', 'customElements']);
for (const key of Object.getOwnPropertyNames(win)) {
  if (!OVERRIDE.has(key) && key in globalThis) continue;
  const value = win[key];
  if (value === undefined) continue;
  try {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  } catch {
    // Non-configurable on globalThis; the bundle does not use those.
  }
}

await import(pathToFileURL(resolve(DIST, src.replace(/^\//, ''))).href);
await new Promise((r) => setTimeout(r, 50));

const buttons = [...win.document.querySelectorAll('button')];
if (buttons.length === 0) fail('the app did not mount - no buttons rendered');

// The control carrying v-vc-command. Matched on its text so this script does
// not need to know the component's internals.
const vc = buttons.find((b) => /v-vc-command/.test(b.textContent ?? ''));
if (!vc) {
  fail(
    `no v-vc-command control in the built page. Rendered: ${JSON.stringify(
      buttons.map((b) => b.textContent?.trim().slice(0, 40)),
    )}`,
  );
}

vc.click();
await new Promise((r) => setTimeout(r, 50));

// What buildHandler does the moment a dispatch starts. If the directive never
// mounted - the rc.9 defect - the click does nothing at all and neither holds.
const loading = vc.classList.contains('vc-loading');
const disabled = vc.disabled === true;
if (!loading || !disabled) {
  fail(
    `the v-vc-command control did not respond to a click ` +
      `(vc-loading=${loading}, disabled=${disabled}). The directive did not mount.`,
  );
}

// ---------------------------------------------------------------------------
// v-vc-payload and v-vc-optimistic, end to end (v1.22.0)
// ---------------------------------------------------------------------------
//
// WHY THESE TWO NEED THE SAME TREATMENT, and why asserting "it rendered" would
// not do it. Vue resolves an SFC directive by camelCasing the WHOLE name, so
// `v-vc-payload` looks for `vVcPayload`. An import aliased to anything shorter
// compiles, type-checks, and falls back to a directive nobody registered. Vue
// warns about that - in DEV. This page is a PRODUCTION build, where the warning
// is stripped, so the failure is a control that renders and quietly does less
// than it says. That is how the same mistake reached this example in rc9/57 on
// the command directive with vue-tsc and vite build both green.
//
// The assertion discriminates rather than merely passing. The optimistic
// function receives the Command and bumps by `cmd.payload?.qty ?? 1`, and the
// payload binding carries `qty: 3`. So ONE observable answers both directives:
// the counter moving at all means v-vc-optimistic mounted, and it moving by
// THREE rather than ONE means v-vc-payload delivered. A check that only asked
// "did the counter change" would pass with a dead payload binding.
const rich = buttons.find((b) => /v-vc-payload/.test(b.textContent ?? ''));
if (!rich) {
  fail(
    `no v-vc-payload control in the built page. Rendered: ${JSON.stringify(
      buttons.map((b) => b.textContent?.trim().slice(0, 48)),
    )}`,
  );
}

/** The optimistic counter, which v-vc-optimistic moves by the payload's qty. */
const optimistic = () => {
  const el = [...win.document.querySelectorAll('span')].find((s) => /optimistic:/.test(s.textContent ?? ''));
  const m = /optimistic:\s*(\d+)/.exec(el?.textContent ?? '');
  return m ? Number(m[1]) : null;
};

// Let the first dispatch settle so this click is measured on its own.
await new Promise((r) => setTimeout(r, 400));
const before = optimistic();
if (before === null) {
  fail('the optimistic counter is not rendered - the example changed shape and this check is stale');
}

rich.click();
// The optimistic update is SYNCHRONOUS - visible before the handler resolves,
// which is the entire point of it - so this reads it mid-flight, deliberately.
await new Promise((r) => setTimeout(r, 20));
const during = optimistic();

if (during === before) {
  fail(
    `v-vc-optimistic did not apply (optimistic stayed at ${before}). The directive did not ` +
      `mount: check that the SFC aliases the import as vVcOptimistic.`,
  );
}
if (during !== before + 3) {
  fail(
    `v-vc-optimistic ran but v-vc-payload did not reach it (optimistic ${before} -> ${during}, ` +
      `expected ${before + 3}). A missing payload falls back to qty 1, so ${before + 1} means the ` +
      `payload binding is dead: check that the SFC aliases the import as vVcPayload.`,
  );
}

console.log(
  `check-example-directive: OK - ${buttons.length} controls rendered, v-vc-command dispatched, ` +
    `v-vc-optimistic applied carrying v-vc-payload's qty (optimistic ${before} -> ${during})`,
);
