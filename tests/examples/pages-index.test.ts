/**
 * `examples/index.html` is the entry point `npm run examples` serves: every page
 * under `examples/pages` is linked, and every page link it states resolves.
 * Why: the index is hand-maintained, so a page added or renamed without a row
 * would leave the runner's home incomplete or dead, and nothing else reads it.
 * Shows: each page HTML is linked (directory link or `index.html`), and each
 * `/examples/pages/` href resolves to a file or a directory with an `index.html`.
 * See: examples/index.html, examples/shared/vite.pages.config.mjs, docs/manual/13-examples.md.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd());
const pagesDir = join(root, 'examples/pages');
const indexHtml = readFileSync(join(root, 'examples/index.html'), 'utf8');

/** Every .html under examples/pages, as a POSIX relative path. */
function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pageFiles(full));
    else if (entry.endsWith('.html')) out.push(relative(pagesDir, full).split(sep).join('/'));
  }
  return out;
}

describe('examples index', () => {
  it('links every page under examples/pages', () => {
    const pages = pageFiles(pagesDir);
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const fileHref = `/examples/pages/${page}`;
      const dirHref =
        page.endsWith('/index.html') ? `/examples/pages/${page.slice(0, -'index.html'.length)}` : null;
      const linked = [fileHref, dirHref].some(
        (href) => href !== null && indexHtml.includes(`href="${href}"`),
      );
      expect(linked, `${page} is not linked from examples/index.html`).toBe(true);
    }
  });

  it('resolves every /examples/pages/ link it states', () => {
    const links = [...indexHtml.matchAll(/href="(\/examples\/pages\/[^"]+)"/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const full = join(pagesDir, link.replace(/^\/examples\/pages\//, ''));
      const resolves = existsSync(full)
        ? statSync(full).isDirectory()
          ? existsSync(join(full, 'index.html'))
          : true
        : false;
      expect(resolves, `${link} does not resolve under examples/pages/`).toBe(true);
    }
  });
});
