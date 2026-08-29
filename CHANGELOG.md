# Changelog

All notable changes to **browser-mcp-bridge** are documented in this file.
The version number is the bridge's own `VERSION` constant, reported in the
`clientInfo` / `serverInfo` handshake and in the startup log line.

## [1.1.0] — 2026-08-28

Security-hardening release from the 2026-08-28 code audit (findings M1, M2,
F3, F4, F5). Typical local use is unchanged: same endpoints, same protocol,
same client-visible behavior — the changes add a request timeout, a
response-size limit, and stricter upstream handling, all of which are now
visible in the startup log line.

### Added

- **Project version `1.1.0`**, reported in the bridge's `clientInfo` and
  `serverInfo` handshake, in the self-test banner, and in the startup log
  line (`neo-mcp-bridge v1.1.0 on stdio -> … (timeout …, response cap …)`).
- **`BROWSEROS_BRIDGE_TIMEOUT_MS`** (default `120000`, i.e. 120 s) —
  maximum milliseconds a single upstream HTTP request may take before the
  bridge aborts it and returns a clean JSON-RPC error to the client.
  `0` disables the timeout.
- **`BROWSEROS_BRIDGE_MAX_RESPONSE_MB`** (default `10`, i.e. 10 MiB) —
  maximum upstream response body size the bridge will buffer. Larger
  responses are rejected and the upstream connection is aborted before the
  body can exhaust memory. `0` disables the limit entirely; an invalid
  default.
- **`BROWSEROS_BRIDGE_ALLOW_REMOTE`** (default: unset) — set to `1`,
  `true`, `yes`, or `on` to silence the startup warning shown when
  `BROWSEROS_MCP_URL` points at a non-localhost host.
- **`CHANGELOG.md`** (this file).
- **`.gitattributes`** — `* text=auto eol=lf`, keeping the repository in LF
  on all platforms (prevents CRLF regression on Windows clones).
- **Expanded self-test (`bridge-test.mjs`)** — the security audit's
  mock-upstream checks now ship with the project: 34 hermetic checks
  covering the v1.1.0 hardening (timeout, response cap, redirects,
  serialization, URL validation) that run **without neo**, plus the existing
  live end-to-end. Flags: `--mock-only` / `--live-only`; the live suite
  auto-skips with a notice when neo is unreachable.

### Fixed (security)

- **M1 — upstream request timeout (availability / DoS).** A stalled
  upstream (wedged neo, or a bad `BROWSEROS_MCP_URL`) could leave a request
  pending forever, which wedged the entire stdio connection. Every upstream
  `fetch()` now carries an `AbortSignal` with the `BROWSEROS_BRIDGE_TIMEOUT_MS`
  budget; a timed-out request returns a JSON-RPC error to the client and the
  bridge stays fully operational for subsequent requests.
- **M2 — unbounded upstream response (memory DoS).** The response body was
  buffered with `res.text()` and no size limit. The body is now capped at
  `BROWSEROS_BRIDGE_MAX_RESPONSE_MB` — first via the `Content-Length` header
  before reading, then chunk-by-chunk while reading (catches responses that
  omit or lie about `Content-Length`). Oversized responses produce a clean
  JSON-RPC error and the upstream connection is aborted. Set `0` to disable
  the limit.
- **F3 — unvalidated upstream URL (SSRF / misconfiguration).**
  `BROWSEROS_MCP_URL` is now validated at startup: non-`http(s)` schemes and
  unparseable URLs fail fast with a clear error and exit code 1. When the
  host is not loopback (`127.0.0.1`, `localhost`, `0.0.0.0`, `::1`), the
  bridge logs a prominent warning at startup. **Remote use is supported** —
  the warning is advisory, not a block; set `BROWSEROS_BRIDGE_ALLOW_REMOTE=1`
  when the remote endpoint is intentional. Note that tool calls and their
  results transit the remote host, and the bridge performs no upstream
  authentication and sends no credentials.
- **F4 — HTTP redirect following (session-id exfiltration path).**
  `fetch()` follows redirects by default, so a 3xx from a compromised
  upstream could have carried the `Mcp-Session-Id` header to the redirect
  target and returned an attacker-controlled response to the client.
  Upstream requests now use `redirect: "manual"`: a 3xx is returned to the
  client as an error instead of being followed.
- **F5 — concurrent stdin handlers (state race).** stdin line handlers used
  to run concurrently, so overlapping requests could race the
  stale-session re-initialization path (which resets shared session state).
  stdin handling is now serialized through a promise queue — at most one
  request in flight at a time — which also makes the documented
  "one request in flight" behavior a guaranteed property of the code.

### Notes

- No changes to the protocol, headers sent to neo, the method allowlist
  (`initialize` / `tools/list` / `tools/call`), or the stdio wire format.
- The stale-session re-init + one-retry behavior is unchanged.
- Every fix was verified independently against a scripted mock upstream,
  and the standard end-to-end self-test (`node bridge-test.mjs`) was
  re-run against a live neo server after the changes.

## [1.0.0] — 2026-08-26

- Initial release: zero-dependency stdio↔HTTP MCP bridge for BrowserOS neo,
  self-test, MCP config examples, README, GPLv2-only license.
