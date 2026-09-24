# Security Policy

## Supported versions

Security fixes are backported to:

| Version | Supported          |
|---------|--------------------|
| <!-- vc:version -->1.23.0<!-- /vc:version --> (latest minor) | ✅ active |
| earlier 1.x minors, from 1.1 | ✅ critical fixes only |
| < 1.1   | ❌ no longer maintained |

v1.x will receive security fixes for at least 6 months after v2.0 ships.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Use one of the private
channels below.

- **Preferred:** GitHub Security Advisories - go to the repo's Security tab
  and click "Report a vulnerability". This routes the report through GitHub's
  private disclosure flow.
- **Email fallback:** if the GitHub flow is unavailable, open an issue asking
  for a private contact channel.

When reporting, include:

- Affected version(s).
- A minimal reproduction (a failing test in `tests/` is ideal).
- The realistic impact - what data, action, or component is exposed?
- Any mitigations you've already identified.

## Response timeline

| Stage                            | Target, from the day the report arrives |
|----------------------------------|------------------------------|
| Initial acknowledgement          | within 72 hours              |
| Severity assessment + advisory   | within 7 days                |
| Patch released                   | within 30 days for high/critical, 90 days for medium/low |
| Public disclosure                | coordinated, within 90 days unless agreed otherwise |

## Scope: areas that touch security-relevant surface

Several parts of the lib touch security-adjacent concerns by design. PRs in
these areas get extra review:

- **CSRF token reading** (`http.ts`, `transports.ts`) - reads the token from a
  `<meta name="csrf-token">` tag, the `XSRF-TOKEN` cookie, then an
  `<input name="_token">` hidden input, and attaches it to outgoing requests.
  Those three are the whole list: there is no option for supplying a reader of
  your own. Attaching is opt-in (`csrf: false` is the default on both HTTP
  bridges), and `csrf: 'inertia'` turns our reading off again and leaves the
  token to Inertia's own client.
- **Auth guard plugin** (`plugins-core.ts#authGuard`) - gates dispatches.
- **Persistence plugin** (`plugins-io.ts#persist`) - writes to localStorage
  and similar stores; its `validate` option exists to reject deserialized
  state after a schema-changing deploy.
- **Schema / LLM layer** (`schema.ts`) - exposes bus actions as tool calls;
  consumers should restrict which actions are exposed.
- **MCP server** (`mcp.ts`) - turns every schema action into an MCP tool, and a
  `tools/call` request dispatches through the bus. That is the widest exposure
  surface in the package: whatever reaches the handler can run a command.
  Restrict the advertised set, and remember that advertising is not the gate -
  v1.15.0 fixed a tool that was never advertised and was still callable. The
  test-run server (`vitest-mcp.ts`) has the same shape and is dev-only.
- **Offline outbox** (`outbox.ts#localStorageOutbox`) - persists the QUEUE of
  pending commands, as one JSON value in localStorage. Same storage caveat as
  `persist` above, over more sensitive contents: these are mutations waiting to
  be replayed, not rendered state.
- **HMR plugin** (`vite-hmr.ts`) - preserves the bus across reloads on a
  `globalThis` STRING key (`__VAPOR_CHAMBER_BUS__`), so anything running on the
  page can reach it by name. Not a production-runtime concern, because the
  plugin declares `apply: 'serve'` and never runs on a build; worth auditing if
  used outside dev.

## Out of scope

The following are not vulnerabilities in vapor-chamber:

- Issues in Vue, Vite, or `@vitejs/plugin-vue` themselves - report upstream.
- Browser-level CSRF / XSS issues that don't involve the lib's
  CSRF-token-reading code path.
- localStorage / sessionStorage being readable by other scripts on the
  same origin - this is a browser invariant, not a lib concern.
- An `authGuard` misconfigured so that it permits a dispatch it should
  reject - that's a consumer-side configuration bug.

## Credit

We acknowledge security reporters in the GitHub Security Advisory unless you
prefer to remain anonymous. If your report results in a CVE, you'll be
credited in the CHANGELOG entry as well.
