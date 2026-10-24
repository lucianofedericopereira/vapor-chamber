/**
 * The wire contract's cases (docs/contract.md section 4), as data: the one
 * table both sides read. scripts/generate-contract.mjs writes the Pact V4
 * files in contract/ from it, which `pact-verifier` replays against any
 * backend. tests/wire-contract.test.ts replays the same files against the
 * client, over a real server, and checks `sees`, what the app sees.
 *
 * A row:
 * - `request`: a single command `{ command, target?, payload?, key? }`, sent
 *   to POST /api/vc, a batch `{ batch: [{ id, command, target, payload, key? }] }`
 *   to POST /api/vc/batch, or `{ get: path }`. A row with no `target` sends
 *   `{}`. A `key` is an idempotency key: a single request carries it as the
 *   `Idempotency-Key` header, a batch item as that name in its `headers` member.
 * - `state`: the provider state the backend sets first, `{ name, params }`.
 * - `response`: `{ status, headers?, body? }`, or `{ status, headers?,
 *   problem: { code, errors?, type?, title? } }` for an RFC 9457 problem. A
 *   problem's `detail` and an error's `detail` match any string. Every batched
 *   result carries its own `status` and `headers`.
 * - `sees`: what the app sees, for the client test only.
 *
 * The test commands (`vcContractEcho`, `vcContractFail`, `vcContractValidate`,
 * `vcContractAccepted`) and the monitor exist in development only. The
 * monitor sits under the development prefix, so it cannot shadow an app
 * route. `vcContractGen` is the generated fixture action (`fixtureSchema`).
 */

/** Where a backend serves its development routes: the monitor and the state route. */
export const DEV_PREFIX = '/api/vc/contract';

/** The fixture action's schema. scripts/generate-laravel.mjs writes its Laravel class. */
export const fixtureSchema = {
  vcContractGen: { target: { id: 'number' }, payload: { name: 'string', qty: 'number' } },
};

const RUNNING = `${DEV_PREFIX}/jobs/running`;
const DONE = `${DEV_PREFIX}/jobs/done`;

/** @type {Array<{ id: string, group: string, request: object, state?: object, response: object, sees: object }>} */
export const cases = [
  // core: every backend runs it.
  {
    id: 'core-1', group: 'core',
    request: { command: 'vcContractEcho', target: { id: 1 }, payload: { n: 1 } },
    response: { status: 200, body: { state: { n: 1 } } },
    sees: { value: { n: 1 } },
  },
  {
    id: 'core-2', group: 'core',
    request: { command: 'vcContractFail', payload: { status: 409, code: 'stale' } },
    response: { status: 409, problem: { code: 'stale' } },
    sees: { code: 'remote:conflict:stale' },
  },
  {
    id: 'core-3', group: 'core',
    request: { command: 'vcContractFail', payload: { status: 429, code: 'busy', retryAfter: 3 } },
    response: { status: 429, headers: { 'Retry-After': '3' }, problem: { code: 'busy' } },
    sees: { code: 'remote:limited:busy', retryIn: 3000 },
  },
  {
    id: 'core-4', group: 'core',
    request: { command: 'vcContractFail', payload: { status: 500, code: 'boom' } },
    response: { status: 500, problem: { code: 'boom' } },
    sees: { code: 'remote:failed:boom' },
  },
  {
    id: 'core-5', group: 'core',
    request: { command: 'vcContractValidate', payload: {} },
    response: { status: 422, problem: { code: 'validation_failed', errors: ['/payload/name'] } },
    sees: { code: 'remote:invalid:validation_failed', field: 'name' },
  },
  {
    id: 'core-6', group: 'core',
    request: { command: 'vcContractNope' },
    response: { status: 404, problem: { code: 'unknown_command' } },
    sees: { code: 'remote:missing:unknown_command' },
  },
  {
    id: 'core-7', group: 'core',
    request: { command: 'vcContractEcho', payload: { s: ' a ', e: '' } },
    response: { status: 200, body: { state: { s: ' a ', e: '' } } },
    sees: { value: { s: ' a ', e: '' } },
  },
  // A backend's own `type` and `title` are kept (docs/contract.md rule 3).
  {
    id: 'core-8', group: 'core',
    request: { command: 'vcContractFail', payload: { status: 409, code: 'stale', type: 'https://example.com/problems/stale', title: 'Stale write' } },
    response: { status: 409, problem: { code: 'stale', type: 'https://example.com/problems/stale', title: 'Stale write' } },
    sees: { code: 'remote:conflict:stale', type: 'https://example.com/problems/stale' },
  },

  // batch: a backend with the batch endpoint. Ids are literal: the backend
  // echoes the ids it receives, and the client mints its own.
  {
    id: 'batch-1', group: 'batch',
    request: { batch: [
      { id: '1', command: 'vcContractEcho', target: {}, payload: { n: 1 } },
      { id: '2', command: 'vcContractFail', target: {}, payload: { status: 404, code: 'gone' } },
    ] },
    response: { status: 200, body: { results: [{ id: '1', status: 200, headers: {}, state: { n: 1 } }, { id: '2', status: 404, headers: {}, problem: { status: 404, code: 'gone' } }] } },
    sees: { results: [{ value: { n: 1 } }, { code: 'remote:missing:gone' }] },
  },
  {
    id: 'batch-2', group: 'batch',
    request: { batch: [{ id: '1', command: 'vcContractFail', target: {}, payload: { status: 429, code: 'busy', retryAfter: 3 } }] },
    response: { status: 200, body: { results: [{ id: '1', status: 429, headers: { 'Retry-After': '3' }, problem: { status: 429, code: 'busy' } }] } },
    sees: { results: [{ code: 'remote:limited:busy', retryIn: 3000 }] },
  },

  // redirect
  {
    id: 'redirect-1', group: 'redirect',
    request: { command: 'vcContractEcho', payload: { redirect: '/login' } },
    response: { status: 200, body: { redirect: '/login' } },
    sees: { code: 'transport:refused:redirect', url: '/login' },
  },

  // stores: a `stores` value is an object, the only value a store writes
  // (src/store-base.ts fromServer).
  {
    id: 'stores-1', group: 'stores',
    request: { command: 'vcContractEcho', payload: { state: { n: 1 }, stores: { contract: { n: 1 } } } },
    response: { status: 200, body: { state: { n: 1 }, stores: { contract: { n: 1 } } } },
    sees: { value: { n: 1 }, store: { n: 1 } },
  },
  {
    id: 'stores-2', group: 'stores',
    request: { command: 'vcContractEcho', payload: { stores: { contract: { n: 1 } } } },
    response: { status: 200, body: { stores: { contract: { n: 1 } } } },
    sees: { value: undefined, store: { n: 1 } },
  },

  // idempotency: core-4 without a key fails with 500, the control of both.
  {
    id: 'idem-1', group: 'idempotency',
    state: { name: 'key answered', params: { command: 'vcContractFail', key: 'k1', target: {}, payload: { status: 500, code: 'boom' }, answer: { n: 1 } } },
    request: { command: 'vcContractFail', payload: { status: 500, code: 'boom' }, key: 'k1' },
    response: { status: 200, body: { state: { n: 1 } } },
    sees: { value: { n: 1 } },
  },
  {
    id: 'idem-2', group: 'idempotency',
    state: { name: 'key in progress', params: { command: 'vcContractFail', key: 'k2' } },
    request: { command: 'vcContractFail', payload: { status: 500, code: 'boom' }, key: 'k2' },
    response: { status: 409, headers: { 'Retry-After': '1' }, problem: { code: 'in_progress' } },
    sees: { code: 'remote:conflict:in_progress', retryIn: 1000, resent: true },
  },
  {
    id: 'idem-3', group: 'idempotency',
    state: { name: 'key answered', params: { command: 'vcContractEcho', key: 'k3', target: {}, payload: { n: 1 }, answer: { n: 1 } } },
    request: { command: 'vcContractEcho', payload: { n: 2 }, key: 'k3' },
    response: { status: 422, problem: { code: 'key_reused' } },
    sees: { code: 'remote:invalid:key_reused' },
  },
  // A batched command's key is its item's `headers` member: idem-1 through the batch.
  {
    id: 'idem-5', group: 'idempotency',
    state: { name: 'key answered', params: { command: 'vcContractFail', key: 'k5', target: {}, payload: { status: 500, code: 'boom' }, answer: { n: 1 } } },
    request: { batch: [{ id: '1', command: 'vcContractFail', target: {}, payload: { status: 500, code: 'boom' }, key: 'k5' }] },
    response: { status: 200, body: { results: [{ id: '1', status: 200, headers: {}, state: { n: 1 } }] } },
    sees: { results: [{ value: { n: 1 } }] },
  },

  // accepted: a 202 with a Location, an Accepted whose `done` polls it.
  {
    id: 'accepted-1', group: 'accepted',
    request: { command: 'vcContractAccepted', payload: { location: RUNNING, retryAfter: 2 } },
    response: { status: 202, headers: { Location: RUNNING, 'Retry-After': '2' }, body: {} },
    sees: { accepted: true, polls: RUNNING },
  },
  {
    id: 'accepted-2', group: 'accepted',
    request: { get: RUNNING },
    response: { status: 202, headers: { 'Retry-After': '2' } },
    sees: { waitsAgain: true },
  },
  {
    id: 'accepted-3', group: 'accepted',
    request: { get: DONE },
    response: { status: 200, body: { state: { n: 1 } } },
    sees: { done: { n: 1 } },
  },
  {
    id: 'accepted-4', group: 'accepted',
    request: { command: 'vcContractAccepted', payload: { location: DONE, retryAfter: 2 } },
    response: { status: 202, headers: { Location: DONE, 'Retry-After': '2' }, body: {} },
    sees: { accepted: true, polls: DONE },
  },
  // A batched result carries its own 202 and Location: followed the same way.
  {
    id: 'accepted-5', group: 'accepted',
    request: { batch: [{ id: '1', command: 'vcContractAccepted', target: {}, payload: { location: DONE, retryAfter: 2 } }] },
    response: { status: 200, body: { results: [{ id: '1', status: 202, headers: { Location: DONE, 'Retry-After': '2' } }] } },
    sees: { results: [{ accepted: true }], polls: DONE },
  },

  // middleware: an action's declared middleware runs, as a route's does. Its
  // limit spent, a `throttle:<name>` answers 429. Its `Retry-After` counts
  // down, so no header is matched here.
  {
    id: 'mw-1', group: 'middleware',
    state: { name: 'limit spent', params: {} },
    request: { command: 'vcContractThrottled' },
    response: { status: 429, problem: { code: 'too_many_requests' } },
    sees: { code: 'remote:limited:too_many_requests' },
  },
  {
    id: 'mw-2', group: 'middleware',
    state: { name: 'limit spent', params: {} },
    request: { batch: [{ id: '1', command: 'vcContractThrottled', target: {} }] },
    response: { status: 200, body: { results: [{ id: '1', status: 429, headers: {}, problem: { status: 429, code: 'too_many_requests' } }] } },
    sees: { results: [{ code: 'remote:limited:too_many_requests' }] },
  },
  // gen: the generated fixture action, Laravel's own (the generator's output).
  {
    id: 'gen-0', group: 'gen',
    request: { command: 'vcContractGen', target: { id: 1 }, payload: { name: 'a', qty: 5 } },
    response: { status: 200 },
    sees: { ok: true },
  },
  {
    id: 'gen-1', group: 'gen',
    request: { command: 'vcContractGen', target: { id: 1 }, payload: { qty: 5 } },
    response: { status: 422, problem: { code: 'validation_failed', errors: ['/payload/name'] } },
    sees: { code: 'remote:invalid:validation_failed', field: 'name' },
  },
  {
    id: 'gen-2', group: 'gen',
    request: { command: 'vcContractGen', target: { id: 'x' }, payload: { name: 'a', qty: 5 } },
    response: { status: 422, problem: { code: 'validation_failed', errors: ['/target/id'] } },
    sees: { code: 'remote:invalid:validation_failed', field: null },
  },
  {
    id: 'gen-3', group: 'gen',
    request: { command: 'vcContractGen', target: { id: 1 }, payload: { name: 'a', qty: '5' } },
    response: { status: 422, problem: { code: 'validation_failed', errors: ['/payload/qty'] } },
    sees: { code: 'remote:invalid:validation_failed', field: 'qty' },
  },
  {
    id: 'gen-4', group: 'gen',
    request: { command: 'vcContractGen', target: { id: 1 }, payload: { name: '', qty: 5 } },
    response: { status: 200 },
    sees: { ok: true },
  },
];
