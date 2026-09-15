# Security Policy

## Supported versions

Security fixes are backported to:

| Version | Supported          |
|---------|--------------------|
| <!-- vc:version -->1.20.0<!-- /vc:version --> (latest minor) | ✅ active |
| earlier 1.x minors   | ✅ critical fixes only |
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

| Stage                            | Target                       |
|----------------------------------|------------------------------|
| Initial acknowledgement          | within 72 hours              |
| Severity assessment + advisory   | within 7 days                |
| Patch released                   | within 30 days for high/critical, 90 days for medium/low |
| Public disclosure                | coordinated, ≤ 90 days after report unless agreed otherwise |

## Scope: areas that touch security-relevant surface

Several parts of the lib touch security-adjacent concerns by design. PRs in
these areas get extra review:

- **CSRF token reading** (`http.ts`, `transports.ts`) - reads the token from a
  meta tag, a cookie or a custom function and attaches it to outgoing requests.
- **Auth guard plugin** (`plugins-core.ts#authGuard`) - gates dispatches.
- **Persistence plugin** (`plugins-io.ts#persist`) - writes to localStorage
  and similar stores; its `validate` option exists to reject deserialized
  state after a schema-changing deploy.
- **Schema / LLM layer** (`schema.ts`) - exposes bus actions as tool calls;
  consumers should restrict which actions are exposed.
- **HMR plugin** (`vite-hmr.ts`) - preserves bus state across reloads via a
  `globalThis` symbol; not a production-runtime concern, but worth auditing
  if used outside dev.

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
