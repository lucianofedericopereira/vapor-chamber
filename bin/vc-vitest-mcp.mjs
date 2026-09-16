#!/usr/bin/env node
// vc-vitest-mcp: the Vitest MCP server of vapor-chamber/vitest/mcp, on stdio.
//
//   vc-vitest-mcp [--root <dir>] [--config <file>]
//
// Started by an MCP client in the project root. The root and the config are
// fixed here, by whoever configures the client; an agent only picks test files.
import { parseArgs } from 'node:util';
import { serveVitestMcp } from '../dist/vitest-mcp.js';

const { values } = parseArgs({ options: { root: { type: 'string' }, config: { type: 'string' } } });
const stop = await serveVitestMcp({ root: values.root, config: values.config });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void stop().then(() => process.exit(0));
  });
}
process.stdin.on('end', () => {
  void stop().then(() => process.exit(0));
});
