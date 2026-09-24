/**
 * A stubbed backend for the bridge and client suites: the reference
 * controller's two endpoints, with only `fetch` replaced.
 *
 * Each file that drove a real bridge used to write these itself - `json()`,
 * a `batchServer` reading `commands` back out of the POST, a `singleServer` -
 * and the copies were the same lines. One owner now, so the wire shape a test
 * asserts against is the one every other test answers with.
 */

import { vi } from 'vitest';

/** A sent command, as the batching bridge puts it on the wire. */
export type SentCommand = { id: string; command: string; target?: unknown; payload?: unknown };

/** A Response with a JSON body. `type` is the media type, `application/json` by default. */
export function reply(status: number, body: unknown, type = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
}

/** An RFC 9457 failure: the problem as the body, sent as `application/problem+json`. */
export function problemReply(status: number, problem: Record<string, unknown>): Response {
  return reply(status, problem, 'application/problem+json');
}

/**
 * The reference `batch()`: one 200, one result per command, in order.
 * `answer` gives a result's body without its `id`. Returns the command
 * names as they were sent, for tests that count re-sends.
 */
export function batchServer(answer: (command: string, sent: SentCommand) => Record<string, unknown>): string[] {
  const sent: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const { commands } = JSON.parse(init.body as string) as { commands: SentCommand[] };
    for (const c of commands) sent.push(c.command);
    return reply(200, { results: commands.map((c) => ({ id: c.id, ...answer(c.command, c) })) });
  });
  return sent;
}

/**
 * The reference `__invoke()`: one command per request, answered with the
 * command's own status. `answer` gives `[status, body]` for a JSON reply, or
 * a whole Response (`problemReply()`, a custom media type). Returns the
 * command names as they were sent.
 */
export function singleServer(answer: (command: string, sent: SentCommand) => [number, unknown] | Response): string[] {
  const sent: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as SentCommand;
    sent.push(body.command);
    const answered = answer(body.command, body);
    return answered instanceof Response ? answered : reply(answered[0], answered[1]);
  });
  return sent;
}

/**
 * A WebSocket that opens on the next microtask and records what it was sent.
 * `receive()` plays a server frame into `onmessage`. Stub it in with
 * `vi.stubGlobal('WebSocket', ...)`, subclassed when a test needs the
 * instance the bridge created.
 */
export class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    Promise.resolve().then(() => this.onopen?.());
  }

  send(data: string) { this.sent.push(data); }
  close() { this.readyState = MockWebSocket.CLOSED; }

  /** Play a server frame into the bridge. */
  receive(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
