# TypeScript in this repository

Two TypeScript versions are installed, each for what it can do. TypeScript 7 runs every `tsc`:
the build's declaration files, `npm run typecheck`, `npm run dev`. TypeScript 6 is the library
API: the scripts and tests that read source through `import ts from 'typescript'`, and
`vue-tsc` in the two Vite apps. The decision is in [decisions.md](./decisions.md) (2026-11-13),
the measurements in the log (36.F58).

| Package name | Version | Used by |
|---|---|---|
| `typescript7` (`npm:typescript@^7.0.2`) | 7.0.2 | `build`, `build:types`, `dev`, `typecheck`, by path: `node node_modules/typescript7/bin/tsc` |
| `typescript` | 6.0.3 | `scripts/generate-api-docs.mjs`, `scripts/check-console-shape.mjs`, four tests (below), `vue-tsc` |

## Why two

TypeScript 7 is the native compiler. Its package exports no compiler API: `import ts from
'typescript'` returns a version string (the main export is `lib/version.cjs`), and the API exists
only under `typescript/unstable/*`, which may change in any release. Run on 7.0.2, everything that
reads TypeScript as a library failed:

| Use | Failure on 7.0.2 |
|---|---|
| `scripts/generate-api-docs.mjs` (the gate's `docs` step) | `ts.parseJsonConfigFileContent is not a function` |
| `scripts/check-console-shape.mjs` (in `lint:check`) | `ts.TypeFlags` is undefined |
| `tests/timer-delays.test.ts`, `tests/vitest-entry.test.ts`, `tests/vitest-consumer.test.ts`, `tests/vitest-plugin.test.ts` | 52 type errors, and each fails when run |
| `vue-tsc` (the `vapor-sfc` and `vapor-island-cart` builds) | `Package subpath './lib/tsc' is not defined by "exports"` |

`vue-tsc` is not ours to change: `@volar/typescript`, which it depends on, declares
`typescript <7` as a peer (2.4.31, its latest). It resolves the package named `typescript` from
its own location, so that name stays TypeScript 6. An npm `overrides` entry giving `vue-tsc` a
TypeScript 6 of its own was tried: npm marked the hoisted TypeScript 7 invalid for it and still
did not place a separate copy, short of regenerating the whole lockfile. Hence TypeScript 7 under
its own name.

## Why `tsc` by path

The `typescript` and `typescript7` packages both provide a `tsc` command. npm links one of them
to `node_modules/.bin/tsc` (it linked TypeScript 7's), and nothing guarantees which one. The
scripts call `node node_modules/typescript7/bin/tsc`, a launcher that finds the native binary for
the platform among the optional `@typescript/typescript-<os>-<cpu>` packages.

## What changes, and what does not

- **The JavaScript that ships is the same.** `tsc` only emits the declaration files
  (`emitDeclarationOnly`); Vite and rolldown write the JavaScript. A TypeScript 6 and a
  TypeScript 7 build of one commit have byte-identical `.js` files, so nothing changes for V8 or
  for speed at runtime.
- **The declaration files read the same.** Five `.d.ts` files differ, in the order of union
  members, of `Pick` keys and of optional properties, and in quote style (`'push'` for
  `"push"`): `command-binding`, `router/engine`, `router/outlet`, `router/vapor`,
  `transitions/vapor`. None changes a type. A strict consumer importing all 31 public entries
  (`skipLibCheck: false`) type-checks clean under TypeScript 6 and under TypeScript 7; the same
  consumer fails on a declaration made broken on purpose, under both. The other 16 files that
  differ are `.d.ts.map` source maps.
- **Type checking is about five times faster.** Median of five runs, Apple M3, Node 26.13.0,
  2026-11-13:

  | `tsc --noEmit` on | TypeScript 6.0.3 | TypeScript 7.0.2 |
  |---|---|---|
  | `tsconfig.json` | 1.31 s | 0.26 s |
  | `tsconfig.typecheck.json` | 1.29 s | 0.24 s |
  | `examples/snippets/tsconfig.patterns.json` | 1.11 s | 0.22 s |

  `npm run typecheck`, five projects: 9.0 s before, 1.8 s after. `npm run build`: 2.3 s, 1.7 s.

- **Watch mode** (`npm run dev`) runs on TypeScript 7.

## When to revisit

TypeScript 6 can go when both hold: `@volar/typescript` admits TypeScript 7 (then `vue-tsc`
can use it), and TypeScript 7 publishes a stable compiler API (then the two scripts and four
tests can move to it). Until then, a TypeScript bump is two bumps: `typescript7` for the
compiler, `typescript` for the API, each read in the lockfile.
