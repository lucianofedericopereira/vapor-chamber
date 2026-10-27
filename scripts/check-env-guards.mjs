#!/usr/bin/env node
/**
 * Gate: no unguarded `process.env` reads in src/.
 *
 * Scope: every `.ts` file under src/, comments stripped, a read counted when no
 * `typeof process !== 'undefined'` appears on its line or the WINDOW lines above.
 * It does not check that the guard belongs to that read, and it does not look at
 * bin/, scripts/ or tests/.
 *
 * A bare `process.env.NODE_ENV` is a ReferenceError anywhere this library is
 * delivered without a bundler - Blade inline payloads, plain ESM + import map
 * (examples/router-demo), pattern-1 no-build. The guarded form is
 * `typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'`.
 *
 * Five files are allowlisted, each with its reason on ALLOWLIST below. Two keep
 * bare literals because the literal is load-bearing for bundler dead-code
 * elimination, and both are bundler-only surfaces.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// `fileURLToPath`, not `.pathname`, which yields `/C:/...` on Windows.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

/**
 * Documented exceptions:
 * - command-bus.ts / devtools.ts - bundler-only surfaces where the bare
 *   literal is load-bearing for dead-code elimination (commented at the site).
 * - vite-hmr.ts - a Vite plugin; it only ever executes inside Node.
 * - vitest-pure.ts - test tooling, never delivered to a page; `stubEnv` writes
 *   the `process.env` a Vitest Node worker reads `import.meta.env` from.
 * - vitest-mcp.ts - an MCP server that runs in Node; it passes its environment,
 *   less Vitest's worker variables, to the coverage run it starts.
 */
const ALLOWLIST = new Set(['src/command-bus.ts', 'src/devtools.ts', 'src/vite-hmr.ts', 'src/vitest-pure.ts', 'src/vitest-mcp.ts']);

const TYPEOF_GUARD = /typeof\s+process\s*!==\s*['"]undefined['"]/;
const READ = /\bprocess\.env\b/;
/** How many lines above a read a `typeof process` guard may sit (multi-line `if (...)`). */
const WINDOW = 4;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts')) yield full;
  }
}

const offenders = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (ALLOWLIST.has(rel)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  // Block-comment state is tracked ACROSS lines: a `process.env` in prose on a
  // continuation line of a block comment would otherwise trip the rule that
  // documents it.
  let inBlockComment = false;
  lines.forEach((line, i) => {
    let code = line;
    if (inBlockComment) {
      const close = code.indexOf('*/');
      if (close === -1) return;            // wholly inside a comment
      code = code.slice(close + 2);
      inBlockComment = false;
    }
    code = code.replace(/\/\*[\s\S]*?\*\//g, '');
    const open = code.indexOf('/*');
    if (open !== -1) { inBlockComment = true; code = code.slice(0, open); }
    code = code.replace(/\/\/.*$/, '');
    if (!READ.test(code)) return;
    // The guard may sit on this line or a few lines above, inside a wrapped
    // `if (...)` condition - scan a small window rather than the line alone.
    const window = lines.slice(Math.max(0, i - WINDOW), i + 1).join('\n');
    if (!TYPEOF_GUARD.test(window)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
  });
}

if (offenders.length > 0) {
  console.error('Unguarded process.env reads (ReferenceError in no-bundler delivery):\n');
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error(
    "\nUse the shared `DEV` flag: import { DEV } from './dev' (build-time const-folded).",
  );
  process.exit(1);
}

console.log(`process.env guards: OK (${ALLOWLIST.size} documented exceptions allowlisted)`);
