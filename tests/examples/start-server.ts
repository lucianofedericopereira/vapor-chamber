/** Starts a real example server script on a free port, for tests that fetch it. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

export interface ExampleServer {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  origin: string;
  port: number;
  child: ChildProcess;
  /** stdout and stderr so far. */
  output: () => string;
  /** False once the process has exited, for any reason. */
  alive: () => boolean;
  stop: () => Promise<void>;
}

/** A port the OS just handed out and released. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/**
 * Runs `node <script> <port>` from the repo root and resolves once the script
 * prints `ready` on stdout. Rejects with the output if it exits first.
 */
export async function startExampleServer(script: string, ready: string): Promise<ExampleServer> {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve(process.cwd(), script), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let exited = false;
  child.stdout!.on('data', (c) => { out += c; });
  child.stderr!.on('data', (c) => { out += c; });
  const gone = new Promise<void>((r) => child.once('exit', () => { exited = true; r(); }));
  await new Promise<void>((ok, fail) => {
    const check = () => { if (out.includes(ready)) { child.stdout!.off('data', check); ok(); } };
    child.stdout!.on('data', check);
    child.once('exit', () => fail(new Error(`${script} exited before listening:\n${out}`)));
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    child,
    output: () => out,
    alive: () => !exited,
    stop: async () => { if (!exited) { child.kill(); await gone; } },
  };
}
