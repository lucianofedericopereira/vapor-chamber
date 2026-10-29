# Security Policy

## Supported versions

Security fixes are backported to:

| Version | Supported          |
|---------|--------------------|
| <!-- vc:version -->1.34.0<!-- /vc:version --> (latest minor) | yes, active |
| earlier 1.x minors, from 1.1 | critical fixes only |
| < 1.1   | no longer maintained |

v1.x receives security fixes for at least 6 months after v2.0 ships.

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Use one of the private channels below.

- **Preferred:** GitHub Security Advisories. Go to the repo's Security tab and click "Report a
  vulnerability". That routes the report through GitHub's private disclosure flow.
- **Fallback:** if the GitHub flow is unavailable, open an issue asking for a private contact
  channel.

A report includes:

- The affected version or versions.
- A minimal reproduction. A failing test in `tests/` is ideal.
- The realistic impact: what data, action or component is exposed?
- Any mitigations you have already found.

## Response timeline

| Stage                            | Target, from the day the report arrives |
|----------------------------------|------------------------------|
| Initial acknowledgement          | within 72 hours              |
| Severity assessment + advisory   | within 7 days                |
| Patch released                   | within 30 days for high/critical, 90 days for medium/low |
| Public disclosure                | coordinated, within 90 days unless agreed otherwise |

## Scope: areas that touch security-relevant surface

Several parts of the library touch security-adjacent concerns by design. Pull requests in these
areas get extra review.

- **CSRF token reading** (`http.ts`, `transports.ts`). It reads the token from a
  `<meta name="csrf-token">` tag, the `XSRF-TOKEN` cookie, then an `<input name="_token">` hidden
  input, and attaches it to outgoing requests.
  - Those three are the whole list. There is no option to supply a reader of your own.
  - Attaching is opt-in: `csrf: false` is the default on both HTTP bridges. An Inertia app on
    Laravel passes `true`, and with no meta tag the bridge reads the `XSRF-TOKEN` cookie Laravel
    sets.
- **The auth guard plugin** (`plugins-core.ts#authGuard`) gates dispatches.
- **Saved store state** (`store-persist.ts#saveTo`, a store's `persist` option) writes to
  localStorage and similar stores. Its `validate` option exists to reject deserialized state
  after a deploy that changed its shape.
- **The schema and LLM layer** (`schema.ts`) exposes bus actions as tool calls. Restrict which
  actions are exposed.
- **The MCP server** (`mcp.ts`) turns every schema action into an MCP tool, and a `tools/call`
  request dispatches through the bus. That is the widest exposure surface in the package:
  whatever reaches the handler can run a command.
  - Restrict the set with `actionFilter`. Without it every schema action is exposed, and
    development warns.
  - Listing is not the only gate. `tools/call` checks the name against `actionFilter` and the
    schema's own keys (`Object.hasOwn`), so a tool that is not listed is not callable.
  - The test-run server (`vitest-mcp.ts`) has the same shape and is dev-only.
- **The offline outbox** (`outbox.ts#createOutbox`) persists the QUEUE of pending commands, as
  one JSON value under its `name` in its `storage` (localStorage by default). It has the same
  storage caveat as `saveTo` above, over more sensitive contents: these are mutations waiting to
  be replayed, not rendered state.
- **The HMR plugin** (`vite-hmr.ts`) keeps the bus across reloads on a `globalThis` STRING key
  (`__VAPOR_CHAMBER_BUS__`), so anything running on the page can reach it by name. It is not a
  production-runtime concern, because the plugin declares `apply: 'serve'` and never runs on a
  build. Audit it if it is used outside dev.

## Out of scope

These are not vulnerabilities in vapor-chamber:

- Issues in Vue, Vite or `@vitejs/plugin-vue` themselves. Report them upstream.
- Browser-level CSRF or XSS issues that do not involve the library's CSRF-token-reading code
  path.
- localStorage or sessionStorage being readable by other scripts on the same origin. That is a
  browser invariant, not a library concern.
- An `authGuard` misconfigured so that it permits a dispatch it should reject. That is a
  consumer-side configuration bug.

## Credit

Security reporters are credited in the GitHub Security Advisory, unless they prefer to remain
anonymous. A report that results in a CVE is also credited in the CHANGELOG entry.
