# Security Policy

## Supported versions

Security fixes are backported to:

| Version | Supported          |
|---------|--------------------|
| 1.2.x   | ✅ active          |
| 1.1.x   | ✅ critical fixes only (until v1.3.0) |
| < 1.1   | ❌ no longer maintained |

When v2.0 ships, v1.x will receive security fixes for at least 6 months.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Use one of the private
channels below.

- **Preferred:** GitHub Security Advisories — go to the repo's Security tab
  and click "Report a vulnerability". This routes the report through GitHub's
  private disclosure flow.
- **Email fallback:** open an issue asking for a private contact channel
  if the GitHub flow is unavailable.

When reporting, include:

- Affected version(s).
- A minimal reproduction (a failing test in `tests/` is ideal).
- The realistic impact — what data, action, or component is exposed?
- Any mitigations you've already identified.

## Response timeline

| Stage                            | Target                       |
|----------------------------------|------------------------------|
| Initial acknowledgement          | within 72 hours              |
| Severity assessment + advisory   | within 7 days                |
| Patch released                   | within 30 days for high/critical, 90 days for medium/low |
| Public disclosure                | coordinated, ≤ 90 days after report unless agreed otherwise |

## Scope — areas that touch security-relevant surface

The lib intentionally interacts with several security-adjacent concerns. PRs
in these areas get extra review attention:

- **CSRF token reading** (`http.ts`, `transports.ts`) — token is read from
  meta tag / cookie / custom function and attached to outgoing requests.
- **Auth guard plugin** (`plugins-core.ts#authGuard`) — gates dispatches.
- **Persistence plugin** (`plugins-io.ts#persist`) — writes to localStorage
  and similar; `validate` option exists to reject deserialized state after
  schema-changing deploys.
- **Schema / LLM layer** (`schema.ts`) — exposes bus actions as tool calls;
  consumers should restrict which actions are exposed.
- **HMR plugin** (`vite-hmr.ts`) — preserves bus state across reloads via a
  `globalThis` symbol; not a production-runtime concern but worth auditing
  if used outside dev.

## Out of scope

The following are not vulnerabilities in vapor-chamber:

- Issues in Vue, Vite, or `@vitejs/plugin-vue` themselves — report upstream.
- Browser-level CSRF / XSS issues that don't involve the lib's
  CSRF-token-reading code path.
- localStorage / sessionStorage being readable by other scripts on the
  same origin — this is a browser invariant, not a lib concern.
- Configuring `authGuard` incorrectly such that it permits a dispatch that
  shouldn't be permitted — that's a consumer-side configuration bug.

## Credit

We acknowledge security reporters in the GitHub Security Advisory unless you
prefer to remain anonymous. If your report results in a CVE, you'll be
credited in the CHANGELOG entry as well.
