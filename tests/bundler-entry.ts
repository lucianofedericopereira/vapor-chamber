/**
 * The names `vue`'s bundler entry exports, resolved as a consumer's build resolves it.
 *
 * Bundled by esbuild and read off its metafile, so nothing is evaluated: a star re-export has no name to grep for, and `export *` is followed here. Importing the file under vitest is not the same thing. Its nested `@vue/*` imports then resolve through the `node` condition to CJS builds, and Vue 3.6.0-rc.14 calls `createInternalObject`, which only the ESM builds export, at module load (#16059): the import throws where no consumer's build does.
 */

import { resolve } from 'node:path';
import { build } from 'esbuild';

export async function bundlerEntryExports(): Promise<string[]> {
  const entry = resolve(process.cwd(), 'node_modules', 'vue', 'dist', 'vue.runtime.esm-bundler.js');
  const { metafile } = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    outfile: 'vue-entry.js',
    metafile: true,
    logLevel: 'silent',
  });
  return Object.values(metafile.outputs).flatMap((output) => output.exports);
}
