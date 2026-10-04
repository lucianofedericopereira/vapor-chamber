/**
 * The fallback rule of `npm run test:browser`: system Chrome when Playwright's
 * headless shell is not installed. Pure, so no browser is needed here.
 */

import { describe, expect, it } from 'vitest';
import { browserChannel, SYSTEM_CHROME } from '../scripts/browser-channel.mjs';

const DIR = '/home/u/.cache/ms-playwright/';
const CHROMIUM = `${DIR}chromium-1243/chrome-linux/chrome`;
const SHELL = `${DIR}chromium_headless_shell-1243`;
const having = (...paths: string[]) => (p: string) => paths.includes(p);

describe('browserChannel', () => {
  it('shell installed: the stock launch, whether or not Chrome is there', () => {
    expect(browserChannel(CHROMIUM, having(SHELL), 'linux')).toBeUndefined();
    expect(browserChannel(CHROMIUM, having(SHELL, SYSTEM_CHROME.linux), 'linux')).toBeUndefined();
  });

  it('shell missing, Chrome there: channel chrome, and the revision that is missing', () => {
    expect(browserChannel(CHROMIUM, having(SYSTEM_CHROME.linux), 'linux')).toEqual({ channel: 'chrome', revision: '1243' });
    expect(browserChannel(CHROMIUM, having(SYSTEM_CHROME.darwin), 'darwin')).toEqual({ channel: 'chrome', revision: '1243' });
  });

  it('shell missing, no Chrome: the stock launch, so Playwright says what to install', () => {
    expect(browserChannel(CHROMIUM, having(), 'linux')).toBeUndefined();
    // Chrome at the OTHER platform's path is not this platform's Chrome.
    expect(browserChannel(CHROMIUM, having(SYSTEM_CHROME.linux), 'darwin')).toBeUndefined();
  });

  it('a revision other than the one the path names does not count as installed', () => {
    expect(browserChannel(CHROMIUM, having(`${DIR}chromium_headless_shell-1228`, SYSTEM_CHROME.linux), 'linux')).toEqual({
      channel: 'chrome',
      revision: '1243',
    });
  });

  it('a Windows-style path is read the same way; an unknown platform uses the Linux location', () => {
    const win = 'C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win\\chrome.exe';
    const winShell = 'C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1243';
    expect(browserChannel(win, having(winShell), 'win32')).toBeUndefined();
    expect(browserChannel(win, having(SYSTEM_CHROME.linux), 'win32')).toEqual({ channel: 'chrome', revision: '1243' });
  });

  it('a path that is not the expected shape: the stock launch', () => {
    expect(browserChannel('/usr/bin/chromium', having(SYSTEM_CHROME.linux), 'linux')).toBeUndefined();
  });
});
