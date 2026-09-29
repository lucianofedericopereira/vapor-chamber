import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

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
 * The default config excludes `tests/browser/**`, so these never run in Node.
 */
const mode = process.env.VC_MODE === 'development' ? 'development' : 'production';

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
    ],
  },
  test: {
    include: ['tests/browser/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
