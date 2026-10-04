/**
 * Which browser `npm run test:browser` launches when Playwright's headless
 * shell for the installed Playwright is not on the machine.
 *
 * A Playwright upgrade pins a new browser revision, and until somebody runs
 * `npx playwright install chromium --only-shell` the launch fails with
 * "Executable doesn't exist" and no test runs. A suite that does not run for
 * want of a download is worth less than one that runs on the Chrome the
 * machine has.
 *
 * Playwright exports no "is it installed". `chromium.executablePath()` is
 * public and ends in `<browsers dir>/chromium-<revision>/...`; the headless
 * shell of the same revision lives beside it, as
 * `chromium_headless_shell-<revision>`. Both the path and the `exists` check
 * are passed in, so the rule is tested without a browser
 * (tests/browser-channel.test.ts).
 *
 * Returns `{ channel: 'chrome', revision }` when the shell is missing and a
 * system Chrome is there. Returns `undefined`, the stock launch, when the
 * shell is installed, when there is no system Chrome to fall back to (so
 * Playwright's own message says what to install), or when the path is not the
 * shape above.
 */
export function browserChannel(chromiumPath, exists, platform) {
  const found = /^(.*[\\/])chromium-(\d+)[\\/]/.exec(chromiumPath);
  if (!found || exists(`${found[1]}chromium_headless_shell-${found[2]}`)) return undefined;
  return exists(SYSTEM_CHROME[platform] ?? SYSTEM_CHROME.linux) ? { channel: 'chrome', revision: found[2] } : undefined;
}

/** Where Chrome's stable channel installs, per `process.platform`. */
export const SYSTEM_CHROME = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/opt/google/chrome/chrome',
};
