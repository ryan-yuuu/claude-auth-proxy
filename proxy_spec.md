# Anthropic OAuth-Impersonation Proxy — Implementation Spec

## Project context

This is a **learning project** to understand how OAuth-impersonation against Anthropic's API works in practice. The goal is to build a local HTTP proxy that accepts standard Anthropic API requests and routes them through the same OAuth-impersonation pattern that OpenCode's `opencode-anthropic-auth` plugin uses internally.

**Not for production.** Not for shared/multi-user use. Not for circumventing Anthropic's billing on anything that matters. The point is to learn:

1. How Anthropic distinguishes Claude Code traffic from third-party harness traffic
2. What signals the server-side classifier looks for (system prompt content, fingerprint headers, tool name shapes, identity blocks)
3. How OAuth tokens are minted, refreshed, and used as bearer credentials against `/v1/messages`
4. What the wire-level differences are between API-key auth and subscription OAuth auth

**Compliance posture.** This pattern likely violates Anthropic's consumer terms of service when used to bill third-party traffic against a subscription. The implementation is for personal study only. Do not share OAuth tokens. Do not run this on a server reachable from anywhere except loopback. Do not bill production workloads through it. After June 15, 2026, the legitimate path for subscription-backed programmatic use is the Agent SDK credit (`$20–$200/mo`); this proxy is a learning exercise, not a replacement for that path.

## High-level architecture

```
┌────────────────┐   HTTPS-shaped HTTP    ┌──────────────────────┐   HTTPS    ┌──────────────────┐
│  Python /      │  POST /v1/messages     │  Local proxy         │  POST      │  api.anthropic   │
│  curl / any    │  with standard         │  127.0.0.1:<port>    │  /v1/      │  .com            │
│  Anthropic     │  Anthropic API JSON    │                      │  messages  │                  │
│  client        │ ─────────────────────▶ │  ┌────────────────┐  │ ─────────▶ │                  │
│                │                        │  │ interception   │  │            │                  │
│                │                        │  │ logic (from    │  │            │                  │
│                │ ◀───────────────────── │  │ upstream fork) │  │ ◀───────── │                  │
└────────────────┘   SSE / JSON response  │  └────────────────┘  │  response  └──────────────────┘
                                          └──────────────────────┘
                                                    ▲
                                                    │
                                          ┌──────────────────────┐
                                          │  OAuth token store   │
                                          │  ~/.config/<name>/   │
                                          │  auth.json           │
                                          └──────────────────────┘
```

**Design principle: the proxy is a thin shell around the interception logic.** The transformation code from the upstream `opencode-anthropic-auth` project is the brain. The proxy is the body that wires it to a network socket and a token store. If the upstream project updates its impersonation countermeasures, you should be able to pull those changes in and the proxy code itself shouldn't need to change.

## Modularity contract

The interception logic and the proxy server must remain cleanly separable. Two reasons:

1. The upstream project (or its successor) updates frequently in response to Anthropic's classifier changes. Pulling those updates should be a `git merge` on the transforms folder, nothing more.
2. The educational value is in seeing the transformation logic in isolation. Mixing proxy/server concerns into the transforms muddies what's actually being learned.

**Boundary**: every function the proxy calls from the interception module operates on standard Web Fetch types (`Headers`, `Request`, `Response`, body strings/streams) or plain message objects. The interception module imports nothing from the proxy. The proxy imports only the transform functions it needs.

```
src/
├── intercept/                  # ← unchanged from upstream; vendored or git submodule
│   ├── constants.ts            # CLIENT_ID, scopes, beta headers, USER_AGENT, identity strings
│   ├── pkce.ts                 # PKCE challenge/verifier helpers
│   ├── auth.ts                 # authorize(), exchange() — pure OAuth flow
│   ├── cch.ts                  # billing fingerprint computation
│   └── transform.ts            # setOAuthHeaders, rewriteRequestBody, rewriteUrl,
│                               #   createStrippedStream, mergeHeaders
│
├── proxy/                      # ← new code, this is what you write
│   ├── server.ts               # HTTP server, request handler, response streaming
│   ├── token-store.ts          # File-based persistence of OAuth credentials
│   ├── token-manager.ts        # Refresh logic, inflight-promise dedup, expiry check
│   └── cli.ts                  # Subcommands: login, serve, status, logout
│
└── index.ts                    # CLI entrypoint
```

Nothing in `proxy/` may modify files in `intercept/`. If you find yourself wanting to, the right move is either to (a) submit a PR upstream, or (b) wrap the upstream function rather than fork it.

## Functional requirements

### FR-1: Accept standard Anthropic API requests on loopback

The proxy listens on `127.0.0.1:<port>` (default `3457`, configurable via `--port`).

It accepts `POST /v1/messages` with the request body and headers shaped exactly like a real Anthropic API call. Clients should be able to use the official `anthropic` Python SDK with no modifications other than `base_url`:

```python
from anthropic import Anthropic
client = Anthropic(
    api_key="ignored-by-proxy",
    base_url="http://127.0.0.1:3457"
)
resp = client.messages.create(
    model="claude-opus-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
```

The proxy ignores any `x-api-key` or `Authorization` header from the client. Auth is solely from the local token store.

### FR-2: Run all requests through the interception logic

For every `POST /v1/messages` request the proxy receives, it must:

1. Resolve a valid OAuth access token from the token store (refresh if needed via `token-manager`).
2. Build a `Headers` object from the incoming request, dropping `x-api-key` and `Authorization`.
3. Call `intercept.setOAuthHeaders(headers, accessToken)` — adds `Authorization: Bearer`, `anthropic-beta`, `user-agent`.
4. Call `intercept.rewriteRequestBody(bodyString)` — handles billing header injection, identity prepend, content sanitization, tool name prefixing.
5. Call `intercept.rewriteUrl()` to resolve the upstream URL with the `?beta=true` query param.
6. Forward to `api.anthropic.com` with the rewritten headers and body using native `fetch`.
7. Wrap the response with `intercept.createStrippedStream()` to strip `mcp_` prefixes from tool names in the SSE stream.
8. Pipe the wrapped response back to the client, preserving status code, headers (minus hop-by-hop), and stream boundaries.

**The proxy is not allowed to skip any of these steps for performance.** If something feels redundant, that's the upstream's design choice — leave it. The point of the proxy is to be a thin pass-through.

### FR-3: OAuth login flow

`proxy login` subcommand:

1. Calls `intercept.authorize('max')` to get the OAuth URL and PKCE verifier.
2. Prints the URL. User opens it in browser, completes Anthropic login, copies the authorization code from the callback page.
3. User pastes the code into the terminal.
4. Proxy calls `intercept.exchange(code, verifier, redirectUri, state)` to swap for tokens.
5. Persists `{ access, refresh, expires }` to `~/.config/anthropic-proxy/auth.json` with `0600` file mode.

This is identical to how `pi setup-token` and the OpenCode plugin work. Token format is `sk-ant-oat01-...`.

### FR-4: Token refresh

Refresh is on-demand, triggered when:
- Expiry timestamp is within 60 seconds of now, or
- An upstream call returns `401`.

Refresh must use an **inflight-promise dedup pattern** (lift this verbatim from upstream `index.ts` lines 42–137): if N requests arrive while a refresh is in flight, all N await the same promise. Concurrent independent refresh calls will race against each other and clobber the refresh token because Anthropic rotates refresh tokens on each use.

On successful refresh, write the new credentials back to `auth.json` atomically (write to `auth.json.tmp`, then `rename`).

### FR-5: Subcommands

- `proxy login` — interactive OAuth flow, writes `auth.json`.
- `proxy serve [--port N] [--host 127.0.0.1]` — starts the HTTP server. Refuses to bind to anything except a loopback address; reject `0.0.0.0`, `::`, public IPs.
- `proxy status` — prints whether auth.json exists, expiry time, last refresh time, and whether the access token would currently be considered valid. Does *not* print the token itself.
- `proxy logout` — deletes `auth.json` after confirmation prompt.

### FR-6: Logging

Log to stderr only. Structured-ish lines, no fancy framework:

```
[2026-05-17T10:23:45Z] req msg_id=abc123 model=claude-opus-4-6 system_blocks=2 tools=3
[2026-05-17T10:23:45Z]   rewrite: prepended identity block, billing cch=4a2f1
[2026-05-17T10:23:45Z]   rewrite: applied TEXT_REPLACEMENT "Here is some useful information..."
[2026-05-17T10:23:46Z]   upstream 200 stream_bytes=1843
[2026-05-17T10:23:46Z] req msg_id=abc123 done duration_ms=1102
```

Two log levels: `info` (default), `debug` (set with `--verbose`). Debug additionally dumps the rewritten body (with the access token redacted) and the first 500 bytes of the upstream response. Never log the access token or refresh token. Never log to a file by default — stderr only, redirect from the shell if you want a file.

This logging is part of the educational point. Watching what the transforms actually do to each request is the whole reason to build this rather than just running Meridian.

## Non-functional requirements

### NFR-1: Security posture

- Bind only to loopback. Validate the configured host is `127.0.0.1`, `::1`, or `localhost`; reject everything else with an error.
- File mode on `auth.json` must be `0600`. On read, check it and refuse to start if the mode is more permissive.
- No authentication on the proxy endpoint itself — loopback-only is the security boundary.
- Don't include the OAuth token in any log line, error message, or panic trace.

### NFR-2: Streaming correctness

The proxy must support SSE streaming responses (`stream: true` in the request). Specifically:

- The response body is forwarded as a stream, not buffered to a string.
- `createStrippedStream`'s prefix-stripping is per-chunk; **this has a latent bug if a tool name like `mcp_Bash` is split across SSE chunk boundaries**. The simple version of the proxy can inherit this bug. A more correct version buffers until it sees a complete SSE event (`\n\n` separator), transforms the event, then flushes. Document which version you implemented.
- Hop-by-hop headers (`connection`, `transfer-encoding`, `keep-alive`, etc.) must not be forwarded in either direction.

### NFR-3: Concurrency

- The server must handle multiple concurrent requests. Each request gets its own `fetch` call.
- Token refresh dedup as in FR-4.
- No global mutable state besides the token store and the refresh-inflight promise.

### NFR-4: Modularity (restated)

- `proxy/` does not import any constants from `intercept/` except through explicit re-exports. No deep imports like `import { CLAUDE_CODE_VERSION } from '../intercept/constants'` to put it into log lines — if you want it in the log, ask the transform layer to expose it.
- The interception layer must remain a candidate for `npm publish` as a standalone package without changes. If you find yourself adding a dependency or parameter to a transform function, stop and put the new logic in `proxy/` instead.
- Tests for `intercept/` run without the proxy. Tests for `proxy/` use a fake intercept module (a few stub functions) so they don't depend on real Anthropic endpoints.

## Out of scope

Explicitly not building:

- OpenAI-compatible endpoint (`/v1/chat/completions`). If you want that, use Meridian or LiteLLM in front of this proxy.
- Multi-account support. One `auth.json`, one Anthropic identity at a time.
- Caching, rate limiting, retry logic beyond token refresh. Anthropic's own response handling is the source of truth.
- TLS. Loopback only; HTTP is fine.
- Auth on the proxy endpoint. Loopback-only is the boundary.
- Token sharing across machines. The token in `auth.json` works on whatever machine has the file; don't sync it.
- Anything for the `console` OAuth flow (the "create an API key" path). Subscription `max` flow only — that's the one this project is meant to study.

## Deliverables checklist

- [ ] Vendored or submoduled `intercept/` directory containing the upstream transform code, unmodified.
- [ ] `proxy/server.ts` — `http.createServer` based handler, ~80 LOC.
- [ ] `proxy/token-store.ts` — read/write/delete `auth.json` with atomic writes, file mode checks.
- [ ] `proxy/token-manager.ts` — refresh-on-demand with inflight dedup; lifted from upstream's index.ts but standalone.
- [ ] `proxy/cli.ts` — `login`, `serve`, `status`, `logout` subcommands.
- [ ] `index.ts` — wires CLI to subcommand handlers.
- [ ] `README.md` — install, login, serve, point a Python client at it. Include the disclaimer from "Project context."
- [ ] Manual test: `anthropic` Python SDK with `base_url="http://127.0.0.1:3457"` against a non-streaming request returns a valid response.
- [ ] Manual test: same client with `stream=True` returns a valid SSE stream that the SDK can iterate.
- [ ] Manual test: kill the access token (edit `auth.json`, set `expires` to a past timestamp), make a request, verify refresh fires once and request succeeds.
- [ ] Manual test: 5 concurrent requests when the token is expired result in exactly one refresh call (verify via logs).
- [ ] Documented in README: known limitations, including the SSE chunk-boundary tool-name bug, the forced identity block side effect, and the silent prompt rewriting.

## Suggested implementation order

1. **Vendor the upstream `src/`** as `intercept/`. Verify TypeScript build succeeds.
2. **Token store + login** (FR-3, FR-4 partial). Confirm you can complete the OAuth flow and have a token in `auth.json`.
3. **Bare-bones server** (FR-1, FR-2 simplified — no streaming yet). Get a non-streaming `messages.create` to work end-to-end. This is the moment you verify the impersonation actually still works against Anthropic today; if it doesn't, fix the imports and revisit upstream before building more.
4. **Streaming support** (NFR-2). Add SSE pass-through.
5. **Token refresh on 401 + expiry-window** (FR-4 complete).
6. **Logging** (FR-6) — adds the educational visibility.
7. **CLI polish** (FR-5) — `status`, `logout`.
8. **Documentation** — README plus inline comments where transforms surprise you.

## Reference reading

Before you start, re-read these in the upstream repo (`ex-machina-co/opencode-anthropic-auth`):

- `src/constants.ts` — especially the long comment block on `TEXT_REPLACEMENTS`, which explains how the content classifier was bisected. This is the most educational artifact in the whole project.
- `src/cch.ts` — the fingerprint algorithm. Understand exactly what's being hashed and why.
- `src/transform.ts` `prependClaudeCodeIdentity()` — the forced system block.
- `src/index.ts` lines 42–137 — the refresh logic with inflight dedup. You will lift this almost verbatim.

Also worth keeping open while you work:
- pi-ai's equivalent code at `earendil-works/pi`, `packages/ai/src/providers/anthropic.ts` — second implementation of the same pattern, lets you cross-reference what's stable and what's project-specific.
- pi-ai issue #3372 — the canonical evidence of what failure looks like in the wild.

## When this proxy stops working

It will. Anthropic updates the classifier without notice. When that happens:

1. Check the upstream `opencode-anthropic-auth` commits for a recent fix.
2. If there's a fix, `git pull` in `intercept/` and the proxy should work again with no proxy-code changes.
3. If there's no fix yet, you've found a fresh classifier change in the wild — congrats, you're doing the same bisection work documented in `constants.ts`. The educational payoff of the project is highest at exactly this moment.
4. If you've been broken for more than a week with no upstream fix, the pattern may be dead — Anthropic may have shipped a detection that can't be defeated without something like genuine Claude Code binary attestation. That outcome is also informative.

The proxy is built to survive being unable to call Anthropic — `proxy serve` still starts, `proxy status` still works, only the actual request forwarding fails. Don't bury Anthropic errors; surface them as 4xx/5xx to the client with the upstream response body intact so debugging is possible.