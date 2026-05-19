# Anthropic Auth Proxy / OpenCode Anthropic Auth Plugin

This repository contains two related artifacts that share the same OAuth-impersonation transform layer (`src/auth.ts`, `src/transform.ts`, `src/refresh.ts`, `src/constants.ts`, `src/cch.ts`):

1. **`@ex-machina/opencode-anthropic-auth`** — an [OpenCode](https://github.com/anomalyco/opencode) plugin that lets Claude Pro/Max subscribers use their existing subscription inside OpenCode. See [Plugin usage](#plugin-usage) below.
2. **`anthropic-auth-proxy`** — a local HTTP proxy (loopback only) that accepts standard Anthropic API requests and routes them through the same OAuth-impersonation pattern. Intended as a **learning project**. See [Proxy usage](#proxy-usage) below.

> [!WARNING]
> Both artifacts come with no guarantees. You may be banned for breaking Anthropic's terms; I don't work at Anthropic, nor am I an attorney.
>
> Use your best judgment and don't try to abuse the subscriptions. Ralph loops or unusually heavy usage patterns are well-known triggers for account suspensions.

> [!IMPORTANT]
> Plugin troubleshooting: try `rm -rf ~/.cache/opencode` and verify the version pinned in your `opencode.json` first.

## Proxy usage

> [!CAUTION]
> **Learning project. Not for production. Not for shared use.**
>
> This proxy applies OAuth-impersonation patterns to bill Anthropic API traffic against a Pro/Max subscription. It likely violates Anthropic's consumer terms when used to bill third-party traffic against a subscription. The implementation is for personal study only:
> - Do not share OAuth tokens.
> - Do not bind to anything other than loopback.
> - Do not bill production workloads through it.
> - After June 15, 2026, the legitimate path for subscription-backed programmatic use is the Agent SDK credit; this proxy is a learning exercise, not a replacement for that path.

### Quick start

Five steps from cloning to forwarding requests.

#### 1. Install Bun

The project pins Bun 1.3.14 (see `mise.toml`). Install via one of:

```bash
# Recommended: mise (https://mise.jdx.dev)
mise install

# Or the official installer
curl -fsSL https://bun.sh/install | bash

# Or via npm
npm install -g bun
```

Verify with `bun --version`.

#### 2. Clone and install dependencies

```bash
git clone https://github.com/ex-machina-co/opencode-anthropic-auth
cd opencode-anthropic-auth
bun install
```

#### 3. Run the OAuth flow

```bash
bun run proxy login
```

The CLI prints an Anthropic authorization URL. Open it in your browser, complete the Anthropic login, then copy the code (or the full callback URL) from the redirect page and paste it back into the terminal. On success, credentials land at `~/.config/anthropic-auth-proxy/auth.json` with mode `0600` (or `$XDG_CONFIG_HOME/anthropic-auth-proxy/auth.json` if `XDG_CONFIG_HOME` is set).

Confirm:

```bash
bun run proxy status
# auth.json: /Users/you/.config/anthropic-auth-proxy/auth.json
#   present:    yes
#   mode:       0600
#   valid_now:  yes
```

#### 4. Start the proxy

```bash
bun run proxy serve
# → Listening on http://127.0.0.1:3457 (auth.json: ~/.config/anthropic-auth-proxy/auth.json)
```

Leave this running. Ctrl-C to stop.

#### 5. Send a request

From a second terminal — anything that speaks Anthropic's API works.

With `curl`:

```bash
curl -sS http://127.0.0.1:3457/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-opus-4-7",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "say hi"}]
  }'
```

With the official Python SDK (no modifications other than `base_url`):

```python
from anthropic import Anthropic
client = Anthropic(
    api_key="ignored-by-proxy",
    base_url="http://127.0.0.1:3457",
)
resp = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.content[0].text)
```

Streaming (`stream=True`) is supported.

### Run as a global binary (optional)

If you prefer `anthropic-auth-proxy …` over `bun run proxy …`:

```bash
bun run build       # compiles src/ → dist/, adds the shebang to dist/proxy/main.js
bun link            # symlinks the binary into Bun's global bin directory
anthropic-auth-proxy --help
```

After that the subcommands below work without the `bun run proxy` prefix.

### Commands

| Command | Purpose |
|---|---|
| `login` | Run the OAuth code-paste flow; persist credentials to `auth.json`. |
| `serve` | Start the loopback HTTP proxy. Refuses non-loopback hosts. |
| `status` | Print whether `auth.json` exists, its mode, and its expiry. Never prints the token. |
| `logout` | Delete `auth.json` (with confirmation). Pass `--yes` to skip the prompt. |

`serve` flags:

- `--port <number>` — default `3457`
- `--host <address>` — must be `127.0.0.1`, `::1`, or `localhost`
- `--verbose` — emit per-request rewrite diagnostics to stderr (logs the rewritten body with tokens redacted; useful for studying what the transforms actually do to each request)

### Architecture

```
client (anthropic SDK)  ──HTTP──▶  proxy (127.0.0.1:3457)  ──HTTPS──▶  api.anthropic.com
                                          │
                                  ┌───────┴────────┐
                                  │ intercept/     │  ← shared with the OpenCode plugin
                                  │   transform.ts │  ← prepends Claude Code identity,
                                  │   refresh.ts   │     prefixes mcp_ tools, injects
                                  │   constants.ts │     billing fingerprint, manages
                                  │   ...          │     OAuth tokens
                                  └────────────────┘
                                          │
                                  ┌───────┴────────┐
                                  │ ~/.config/     │
                                  │  anthropic-    │
                                  │  auth-proxy/   │
                                  │  auth.json     │
                                  └────────────────┘
```

The transform layer is the same code OpenCode runs in-process; the proxy is a thin shell that adapts it to an HTTP socket and a file-backed token store. The proxy never modifies the intercept code — pulling upstream transform changes is `git pull` plus running the test suite.

### Known limitations

- **SSE chunk-boundary tool-name rewriting** is per-chunk (inherited from upstream `createStrippedStream`). The regex requires the entire `"name":"mcp_…"` JSON span to land in a single decoded chunk; if a chunk boundary falls inside that span — even one byte off — the strip silently misses the tool name and the client receives a `mcp_`-prefixed name it doesn't recognize. Anthropic's SSE chunking has so far kept these spans intact in practice, but a different proxy in the path, a constrained TCP window, or unusually small chunk sizes can surface this. Documented as a real bug rather than fixed because doing so requires buffering until `\n\n` SSE event boundaries.
- **Forced Claude Code identity block.** Every outbound request has a `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` system block prepended whether you asked for it or not. This is required by Anthropic's classifier; the proxy doesn't expose a way to disable it.
- **Silent prompt rewriting.** Paragraphs containing OpenCode-identifying URLs and short branded strings are removed from your system prompt before it reaches Anthropic. See `src/constants.ts` (`PARAGRAPH_REMOVAL_ANCHORS`, `TEXT_REPLACEMENTS`) for the full list. The annotations there explain the bisection methodology used to isolate each filter.
- **No authentication on the proxy endpoint.** Loopback-only is the security boundary. Do not bind to a non-loopback interface.
- **No multi-account support.** One `auth.json`, one Anthropic identity at a time.
- **No retry beyond token refresh.** Anthropic's response is the source of truth — including 429/5xx.
- **Token refresh races other processes that share `auth.json`.** Inflight dedup prevents the proxy from racing itself, but if you run the OpenCode plugin and the proxy against the same `auth.json` at once, they can each rotate the refresh token. Pick one or the other per machine.

### When this proxy stops working

It will. Anthropic ships classifier updates without notice. When that happens:

1. Check the upstream commits in `ex-machina-co/opencode-anthropic-auth` for a recent fix.
2. If there's a fix, `git pull` and run the tests — the proxy code shouldn't need to change.
3. If there's no fix yet, you've found a fresh classifier change in the wild. The bisection methodology documented in `src/constants.ts` is the playbook.
4. If you've been broken for more than a week with no upstream fix, the pattern may be dead. Anthropic may have shipped a detection that can't be defeated without genuine Claude Code binary attestation. That outcome is also informative.

The proxy is built to survive an unreachable Anthropic — `serve` and `status` still work, only the actual request forwarding fails. Anthropic errors are surfaced as 4xx/5xx with the upstream response body intact so debugging is possible.

## Plugin usage

An [OpenCode](https://github.com/anomalyco/opencode) plugin that provides Anthropic OAuth authentication, enabling Claude Pro/Max users to use their subscription directly with OpenCode.

## Usage

Add the plugin to your OpenCode configuration:

```json
{
  "plugin": ["@ex-machina/opencode-anthropic-auth"]
}
```

> [!TIP]
> It is STRONGLY advised that you pin the plugin to a version. This will keep you from getting automatic updates; however, this will protect you from nefarious updates.
>
> This holds true for ANY OpenCode plugin. If you do not pin them, OpenCode will automatically update them on startup. It's a massive vulnerability waiting to happen.

#### Example of pinned version

```json
{
  "plugin": ["@ex-machina/opencode-anthropic-auth@1.8.0"]
}
```

## Authentication Methods

The plugin provides three authentication options:

- **Claude Pro/Max** - OAuth flow via `claude.ai` for Pro/Max subscribers. Uses your existing subscription at no additional API cost.
- **Create an API Key** - OAuth flow via `console.anthropic.com` that creates an API key on your behalf.
- **Manually enter API Key** - Standard API key entry for users who already have one.

## Configuration

The plugin supports the following environment variables:

| Variable                          | Description                                                                                                                                                                                 |
|-----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ANTHROPIC_BASE_URL`              | Override the API endpoint URL (e.g. for proxying). Must be a valid HTTP(S) URL.                                                                                                             |
| `ANTHROPIC_INSECURE`              | Set to `1` or `true` to skip TLS certificate verification. Only effective when `ANTHROPIC_BASE_URL` is also set.                                                                            |

## How It Works

For Claude Pro/Max authentication, the plugin:

1. Initiates a PKCE OAuth flow against Anthropic's authorization endpoint
2. Exchanges the authorization code for access and refresh tokens
3. Automatically refreshes expired tokens
4. Injects the required OAuth headers and beta flags into API requests
5. Sanitizes the system prompt for compatibility (see below)
6. Zeros out model costs (since usage is covered by the subscription)

### System Prompt Sanitization

The Anthropic API for Max subscriptions has specific requirements for the system prompt to identify as Claude Code. The plugin rewrites the system prompt on each request using an **anchor-based** approach that minimizes what gets changed:

1. **Identity swap** — The OpenCode identity line is removed and replaced with the Claude Code identity.
2. **Paragraph removal by anchor** — Any paragraph containing a known URL anchor (e.g. `github.com/anomalyco/opencode`, `opencode.ai/docs`) is removed entirely. This is resilient to upstream rewording — as long as the anchor URL appears somewhere in the paragraph, the removal works regardless of surrounding text changes.
3. **Inline text replacements** — Short branded strings inside paragraphs we want to keep are replaced (e.g. "OpenCode" → "the assistant" in the professional objectivity section).

Everything else in the system prompt is preserved: tone/style guidance, task management instructions, tool usage policy, environment info, skills, user/project instructions, and file paths containing "opencode". The sanitized system prompt is structured as three blocks in `system[]`: the billing header, the Claude Code identity line, and the remaining system content.

## Development

### Local Testing

Use `bun run dev` to test plugin changes locally without publishing to npm:

```bash
bun run dev
```

This does three things:

1. Builds the plugin
2. Symlinks the build output into `.opencode/plugins/` so OpenCode loads it as a local plugin
3. Starts `tsc --watch` for automatic rebuilds on source changes

After starting the dev script, restart OpenCode in this project directory to pick up the local build. Any edits to `src/` will trigger a rebuild — restart OpenCode again to load the new version.

Ctrl+C stops the watcher and cleans up the symlink. If the process was killed without cleanup (e.g. `kill -9`), you can manually remove the symlink:

```bash
bun run dev:clean
```

> [!NOTE]
> If you have the npm version of this plugin in your global OpenCode config, both will load. The local version takes precedence for auth handling.

### Publishing

This project uses [changesets](https://github.com/changesets/changesets) for versioning and publishing. See the [changeset README](.changeset/README.md) for more details.

```bash
bun change          # create a changeset describing your changes
```

When changesets are merged to `main`, CI will automatically open a release PR. Merging that PR publishes to npm.

## License

MIT
