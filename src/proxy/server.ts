import { RefreshHttpError } from '../refresh.ts'
import {
  createStrippedStream,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from '../transform.ts'
import { asMessage, fields, type Logger } from './logger.ts'
import { NotAuthenticatedError, type TokenManager } from './token-manager.ts'

/**
 * Headers that must not be forwarded between client/upstream:
 * - RFC 7230 hop-by-hop headers (connection, keep-alive, etc.)
 * - `host` would otherwise leak the proxy's bind address
 * - `content-length` is wrong in both directions: outbound because
 *   `rewriteRequestBody` changes the body length, inbound because Bun
 *   re-encodes the streamed body before sending it to the client.
 */
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export const UPSTREAM_URL = 'https://api.anthropic.com/v1/messages'

export type ProxyServerOptions = {
  host: string
  port: number
  tokenManager: TokenManager
  logger: Logger
}

/**
 * Refuse to start unless bound to a loopback address. The proxy has no
 * authentication of its own — exposing it on a non-loopback interface
 * would hand any peer on the network a free /v1/messages endpoint billed
 * against the user's Anthropic subscription.
 */
export function assertLoopback(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `host "${host}" is not a loopback address; refusing to start. Allowed: ${[...LOOPBACK_HOSTS].join(', ')}`,
    )
  }
}

function stripHopByHop(headers: Headers): Headers {
  const out = new Headers(headers)
  for (const name of HOP_BY_HOP_HEADERS) out.delete(name)
  return out
}

function generateRequestId(): string {
  return crypto.randomUUID().slice(0, 8)
}

type BodySummary = {
  model?: string
  system_blocks: number
  tools: number
  stream: boolean
  messages: number
}

function summarizeBody(body: string): BodySummary {
  try {
    const parsed = JSON.parse(body) as {
      model?: string
      system?: unknown
      tools?: unknown[]
      messages?: unknown[]
      stream?: boolean
    }
    let systemBlocks = 0
    if (Array.isArray(parsed.system)) systemBlocks = parsed.system.length
    else if (parsed.system != null) systemBlocks = 1
    return {
      model: parsed.model,
      system_blocks: systemBlocks,
      tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      messages: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
      stream: Boolean(parsed.stream),
    }
  } catch {
    return { system_blocks: 0, tools: 0, messages: 0, stream: false }
  }
}

/**
 * Start the proxy server and return Bun's Server handle. Caller is
 * responsible for `server.stop()` on shutdown.
 */
export function startServer(opts: ProxyServerOptions) {
  assertLoopback(opts.host)
  return Bun.serve({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0,
    fetch: (req) => handleRequest(req, opts),
    error: (err) => {
      const message = asMessage(err)
      const name = err instanceof Error ? err.name : 'unknown'
      opts.logger.info(`server error ${fields({ name, message })}`)
      return new Response(
        JSON.stringify({ error: 'proxy_internal', message }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      )
    },
  })
}

async function handleRequest(
  req: Request,
  opts: ProxyServerOptions,
): Promise<Response> {
  const url = new URL(req.url)
  if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
    return new Response(
      JSON.stringify({
        error: 'not_found',
        message: 'Only POST /v1/messages is supported.',
      }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    )
  }

  const reqId = generateRequestId()
  const startedAt = Date.now()

  let bodyText: string
  try {
    bodyText = await req.text()
  } catch (err) {
    const message = asMessage(err)
    opts.logger.info(
      `req ${fields({ id: reqId, error: 'body_read_failed', message })}`,
    )
    return new Response(
      JSON.stringify({ error: 'proxy_body_read_failed', message }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }

  const summary = summarizeBody(bodyText)
  opts.logger.info(
    `req ${fields({
      id: reqId,
      model: summary.model,
      system_blocks: summary.system_blocks,
      tools: summary.tools,
      messages: summary.messages,
      stream: summary.stream,
    })}`,
  )

  let accessToken: string
  try {
    accessToken = await opts.tokenManager.getAccessToken()
  } catch (err) {
    return handleAuthError(err, opts.logger, reqId)
  }

  let upstream: Response
  try {
    upstream = await forwardOnce(req, bodyText, accessToken, opts, reqId)
  } catch (err) {
    return handleUpstreamError(err, opts.logger, reqId)
  }

  if (upstream.status === 401) {
    opts.logger.info(
      `req ${fields({ id: reqId, upstream_status: 401, action: 'refresh-and-retry' })}`,
    )
    await upstream.body?.cancel().catch(() => {})

    let newToken: string
    try {
      newToken = await opts.tokenManager.forceRefresh()
    } catch (err) {
      return handleAuthError(err, opts.logger, reqId)
    }

    try {
      upstream = await forwardOnce(req, bodyText, newToken, opts, reqId)
    } catch (err) {
      return handleUpstreamError(err, opts.logger, reqId)
    }
  }

  const stripped = createStrippedStream(upstream)
  const duration = Date.now() - startedAt
  opts.logger.info(
    `req ${fields({
      id: reqId,
      done: true,
      status: stripped.status,
      duration_ms: duration,
    })}`,
  )

  return new Response(stripped.body, {
    status: stripped.status,
    statusText: stripped.statusText,
    headers: stripHopByHop(stripped.headers),
  })
}

async function forwardOnce(
  req: Request,
  bodyText: string,
  accessToken: string,
  opts: ProxyServerOptions,
  reqId: string,
): Promise<Response> {
  const headers = stripHopByHop(mergeHeaders(req))
  headers.delete('authorization')
  setOAuthHeaders(headers, accessToken)

  const rewrittenBody = rewriteRequestBody(bodyText)

  // ANTHROPIC_BASE_URL is honored via rewriteUrl, which is how the test
  // suite points at a local stub upstream without touching transform.ts.
  const inboundUrl = new URL(req.url)
  const upstreamUrl = new URL(UPSTREAM_URL)
  for (const [k, v] of inboundUrl.searchParams) {
    upstreamUrl.searchParams.set(k, v)
  }
  const { input: rewrittenInput } = rewriteUrl(upstreamUrl.toString())

  opts.logger.debug(
    `rewrite ${fields({
      id: reqId,
      bytes_in: bodyText.length,
      bytes_out: rewrittenBody.length,
    })}`,
  )
  opts.logger.debug(`rewrite-body id=${reqId} body=${rewrittenBody}`)

  // signal: req.signal — when the client aborts (Ctrl-C, SDK cancellation),
  // tear down the upstream socket too. Without this the proxy keeps reading
  // an SSE stream nobody is consuming, which both leaks resources and bills
  // the subscription for tokens the user has stopped reading.
  return fetch(rewrittenInput as string | URL, {
    method: 'POST',
    headers,
    body: rewrittenBody,
    signal: req.signal,
  })
}

function handleAuthError(
  err: unknown,
  logger: Logger,
  reqId: string,
): Response {
  if (err instanceof NotAuthenticatedError) {
    logger.info(`req ${fields({ id: reqId, error: 'not_authenticated' })}`)
    return new Response(
      JSON.stringify({
        error: 'proxy_not_authenticated',
        message: err.message,
      }),
      {
        status: 401,
        headers: { 'content-type': 'application/json' },
      },
    )
  }
  // Preserve upstream OAuth-endpoint failures verbatim. A 400 invalid_grant
  // (refresh token revoked → "log in again") must not look identical to
  // a 5xx Anthropic outage. Pass status + body through; clamp status to
  // a sane HTTP range only as a defensive measure.
  if (err instanceof RefreshHttpError) {
    logger.info(
      `req ${fields({
        id: reqId,
        error: 'refresh_upstream_error',
        upstream_status: err.status,
      })}`,
    )
    const status = err.status >= 400 && err.status < 600 ? err.status : 502
    return new Response(
      err.body || JSON.stringify({ error: 'refresh_failed' }),
      {
        status,
        headers: { 'content-type': 'application/json' },
      },
    )
  }
  const message = asMessage(err)
  logger.info(`req ${fields({ id: reqId, error: 'refresh_failed', message })}`)
  return new Response(
    JSON.stringify({
      error: 'proxy_refresh_failed',
      message,
    }),
    { status: 502, headers: { 'content-type': 'application/json' } },
  )
}

function handleUpstreamError(
  err: unknown,
  logger: Logger,
  reqId: string,
): Response {
  const message = asMessage(err)
  logger.info(
    `req ${fields({ id: reqId, error: 'upstream_unreachable', message })}`,
  )
  return new Response(
    JSON.stringify({ error: 'proxy_upstream_unreachable', message }),
    { status: 502, headers: { 'content-type': 'application/json' } },
  )
}
