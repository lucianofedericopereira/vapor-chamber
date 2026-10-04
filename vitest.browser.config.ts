import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { chromium } from 'playwright';
import { defineConfig } from 'vitest/config';
import { browserChannel } from './scripts/browser-channel.mjs';

/**
 * Real-browser project, opt-in: `npm run test:browser`.
 *
 * WHY A THIRD CONFIG. Some questions have no answer outside a browser engine:
 * focus behaviour (HTML's focus fixup rule), the HTTP cache (RFC 9111
 * revalidation through `fetch`), form-associated custom elements. happy-dom
 * implements none of them, so a green happy-dom test is not evidence about any
 * of them. docs/plan-failures-and-contract.md, section 7.2, lists the questions.
 *
 * PRODUCTION BY DEFAULT. A browser test measures what users ship: `__VC_DEV__`
 * is defined false and `NODE_ENV` is 'production', so every `if (DEV)` branch
 * folds away exactly as in a consumer's production build. `VC_MODE=development`
 * runs the same tests on the dev paths.
 *
 * CHROMIUM ONLY, headless shell. A result here is evidence for Chromium, not
 * for Firefox or WebKit; add instances when a finding needs them.
 *
 * WHEN THE HEADLESS SHELL IS NOT INSTALLED the run falls back to the system
 * Chrome (`channel: 'chrome'`) and says so on stderr: `browserChannel` below.
 *
 * The default config excludes `tests/browser/**`, so these never run in Node.
 */
const mode = process.env.VC_MODE === 'development' ? 'development' : 'production';

// The rule, and why it reads a path, is scripts/browser-channel.mjs.
const fallback = browserChannel(chromium.executablePath(), existsSync, process.platform);
if (fallback) {
  console.warn(
    `[test:browser] Playwright's headless shell r${fallback.revision} is not installed: running on the system Chrome (channel 'chrome'). ` +
      'Install the shell with: npx playwright install chromium --only-shell',
  );
}

export default defineConfig({
  define: {
    __VC_DEV__: JSON.stringify(mode === 'development'),
    'process.env.NODE_ENV': JSON.stringify(mode),
  },
  resolve: {
    alias: [
      // Same reason as vitest.config.ts: the suite measures src/, not the
      // workspace self-link to dist/.
      { find: /^vapor-chamber$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
      // Tests import the router's source as `@router/...`; tsconfig.tests.json maps the same.
      { find: /^@router\//, replacement: fileURLToPath(new URL('./src/router/', import.meta.url)) },
    ],
  },
  test: {
    include: ['tests/browser/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      provider: fallback ? playwright({ launchOptions: { channel: fallback.channel } }) : playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
