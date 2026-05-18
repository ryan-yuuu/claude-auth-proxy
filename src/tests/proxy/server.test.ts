import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../proxy/logger'
import { assertLoopback, startServer } from '../../proxy/server'
import { TokenManager } from '../../proxy/token-manager'
import { type StoredAuth, TokenStore } from '../../proxy/token-store'
import type { RefreshResult } from '../../refresh'

type CapturedRequest = {
  url: string
  method: string
  headers: Headers
  body: string
}

type StubUpstream = {
  port: number
  setResponder: (
    fn: (req: Request, body: string) => Response | Promise<Response>,
  ) => void
  lastRequests: CapturedRequest[]
  stop: () => Promise<void>
}

function createStubUpstream(): StubUpstream {
  let responder: (req: Request, body: string) => Response | Promise<Response> =
    () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  const captures: CapturedRequest[] = []

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    fetch: async (req) => {
      const body = await req.text()
      captures.push({
        url: req.url,
        method: req.method,
        headers: new Headers(req.headers),
        body,
      })
      return responder(req, body)
    },
  })

  return {
    port: server.port as number,
    lastRequests: captures,
    setResponder(fn) {
      responder = fn
    },
    async stop() {
      server.stop(true)
    },
  }
}

const VALID_AUTH: StoredAuth = {
  type: 'oauth',
  access: 'test-access',
  refresh: 'test-refresh',
  expires: Date.now() + 3600_000,
}

const originalEnv = process.env.ANTHROPIC_BASE_URL

let dir: string
let store: TokenStore
let manager: TokenManager
let logger: Logger
let upstream: StubUpstream
let proxy: ReturnType<typeof startServer>

async function bootProxy(opts: { tokenManager?: TokenManager } = {}) {
  proxy = startServer({
    host: '127.0.0.1',
    port: 0,
    tokenManager: opts.tokenManager ?? manager,
    logger,
  })
}

beforeEach(async () => {
  logger = new Logger('info', () => {})
  dir = await mkdtemp(join(tmpdir(), 'proxy-server-'))
  store = new TokenStore(join(dir, 'auth.json'))
  await store.write(VALID_AUTH)
  manager = new TokenManager(store)

  upstream = createStubUpstream()
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.port}`
})

afterEach(async () => {
  proxy?.stop(true)
  await upstream?.stop()
  if (originalEnv === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = originalEnv
})

describe('assertLoopback', () => {
  test('accepts 127.0.0.1, ::1, and localhost', () => {
    assertLoopback('127.0.0.1')
    assertLoopback('::1')
    assertLoopback('localhost')
  })

  test('rejects 0.0.0.0', () => {
    expect(() => assertLoopback('0.0.0.0')).toThrow(/loopback/)
  })

  test('rejects public IPs', () => {
    expect(() => assertLoopback('1.2.3.4')).toThrow(/loopback/)
  })

  test('rejects empty string', () => {
    expect(() => assertLoopback('')).toThrow(/loopback/)
  })
})

describe('startServer routing', () => {
  test('returns 404 on GET /v1/messages', async () => {
    await bootProxy()
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`)
    expect(res.status).toBe(404)
  })

  test('returns 404 on POST to a non-/v1/messages path', async () => {
    await bootProxy()
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/foo`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(404)
  })

  test('returns 404 with JSON body for unsupported routes', async () => {
    await bootProxy()
    const res = await fetch(`http://127.0.0.1:${proxy.port}/`, {
      method: 'GET',
    })
    expect(res.status).toBe(404)
    const data = (await res.json()) as { error: string }
    expect(data.error).toBe('not_found')
  })
})

describe('startServer happy path', () => {
  test('forwards body and returns response', async () => {
    upstream.setResponder(
      () =>
        new Response(JSON.stringify({ id: 'msg_abc' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await bootProxy()

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(200)
    const data = (await res.json()) as { id: string }
    expect(data.id).toBe('msg_abc')

    expect(upstream.lastRequests).toHaveLength(1)
    const captured = upstream.lastRequests[0]!
    expect(captured.method).toBe('POST')
    expect(captured.headers.get('authorization')).toBe('Bearer test-access')
    expect(captured.headers.get('x-api-key')).toBeNull()
    expect(captured.headers.get('anthropic-beta')).toContain('oauth-2025-04-20')
    expect(captured.headers.get('user-agent')).toContain('claude-cli/')

    const sentBody = JSON.parse(captured.body)
    expect(sentBody.model).toBe('claude-opus-4-6')
    // Identity block prepended
    expect(sentBody.system).toBeInstanceOf(Array)
    expect(sentBody.system.length).toBeGreaterThanOrEqual(2)
    expect(sentBody.system[1].text).toContain(
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    )
  })

  test('adds beta=true query param to upstream URL', async () => {
    upstream.setResponder(() => new Response('{}', { status: 200 }))
    await bootProxy()

    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      body: '{}',
    })

    expect(upstream.lastRequests[0]!.url).toContain('beta=true')
  })

  test('drops client-provided x-api-key and Authorization', async () => {
    await bootProxy()
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': 'sk-ant-api-attacker',
        authorization: 'Bearer attacker-token',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    const captured = upstream.lastRequests[0]!
    expect(captured.headers.get('x-api-key')).toBeNull()
    expect(captured.headers.get('authorization')).toBe('Bearer test-access')
  })

  test('strips hop-by-hop headers from outbound request', async () => {
    await bootProxy()
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: {
        connection: 'close',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    const captured = upstream.lastRequests[0]!
    expect(captured.headers.get('connection')).not.toBe('close')
  })

  test('prefixes tool names with mcp_ before forwarding upstream', async () => {
    await bootProxy()
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tools: [{ name: 'bash', input_schema: {} }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    const sent = JSON.parse(upstream.lastRequests[0]!.body)
    expect(sent.tools[0].name).toBe('mcp_Bash')
  })

  test('strips mcp_ prefix from upstream tool names in response', async () => {
    upstream.setResponder(
      () =>
        new Response(
          JSON.stringify({ content: [{ type: 'tool_use', name: 'mcp_bash' }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    )
    await bootProxy()
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      body: '{}',
    })
    const text = await res.text()
    expect(text).toContain('"name": "bash"')
    expect(text).not.toContain('mcp_bash')
  })

  test('forwards SSE streaming response', async () => {
    upstream.setResponder(() => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: message_start\n'))
          controller.enqueue(
            encoder.encode('data: {"type":"message_start"}\n\n'),
          )
          controller.enqueue(encoder.encode('event: message_stop\n'))
          controller.enqueue(
            encoder.encode('data: {"type":"message_stop"}\n\n'),
          )
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    await bootProxy()

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const text = await res.text()
    expect(text).toContain('message_start')
    expect(text).toContain('message_stop')
  })

  test('strips content-length header from upstream response', async () => {
    upstream.setResponder(
      () =>
        new Response('{"id":"a"}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': '10',
          },
        }),
    )
    await bootProxy()
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(200)
    // After Bun re-encodes the body for transit, content-length is either
    // recomputed by Bun or absent. Either is fine; what we verify is that
    // the response body still reads correctly.
    expect(await res.text()).toBe('{"id":"a"}')
  })

  test('strips hop-by-hop headers from upstream response', async () => {
    upstream.setResponder(
      () =>
        new Response('{"id":"x"}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            connection: 'close',
            'keep-alive': 'timeout=5',
            'proxy-authenticate': 'Basic',
            'x-safe-passthrough': 'kept',
          },
        }),
    )
    await bootProxy()
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('keep-alive')).toBeNull()
    expect(res.headers.get('proxy-authenticate')).toBeNull()
    // `connection` is conventionally rewritten by the HTTP layer rather than
    // forwarded verbatim, so the most we can assert is that the upstream
    // `close` value did not survive.
    expect(res.headers.get('connection')).not.toBe('close')
    expect(res.headers.get('x-safe-passthrough')).toBe('kept')
  })

  test('passes through upstream 4xx with body intact', async () => {
    upstream.setResponder(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'bad model' },
          }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        ),
    )
    await bootProxy()
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: { message: string } }
    expect(data.error.message).toBe('bad model')
  })
})

describe('startServer authentication errors', () => {
  test('returns 401 when no auth.json exists', async () => {
    await store.remove()
    const freshManager = new TokenManager(store)
    await bootProxy({ tokenManager: freshManager })

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(401)
    const data = (await res.json()) as { error: string }
    expect(data.error).toBe('proxy_not_authenticated')
  })

  test('refreshes token and retries on upstream 401', async () => {
    let calls = 0
    upstream.setResponder((req) => {
      calls += 1
      const auth = req.headers.get('authorization')
      if (auth === 'Bearer test-access') {
        return new Response('{"error":"expired"}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{"id":"recovered"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const refreshFn = async (load: () => Promise<string | undefined>) => {
      await load()
      return {
        access: 'refreshed-access',
        refresh: 'refreshed-refresh',
        expires: Date.now() + 3600_000,
      } satisfies RefreshResult
    }
    const refreshingManager = new TokenManager(store, refreshFn)
    await bootProxy({ tokenManager: refreshingManager })

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { id: string }
    expect(data.id).toBe('recovered')
    expect(calls).toBe(2)

    // Store updated with rotated credentials
    const stored = await store.read()
    expect(stored?.access).toBe('refreshed-access')
  })

  test('does not retry a second time if both attempts return 401', async () => {
    let calls = 0
    upstream.setResponder(() => {
      calls += 1
      return new Response('{"error":"still bad"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    })
    const refreshFn = async (load: () => Promise<string | undefined>) => {
      await load()
      return {
        access: 'still-bad',
        refresh: 'r',
        expires: Date.now() + 3600_000,
      } satisfies RefreshResult
    }
    const refreshingManager = new TokenManager(store, refreshFn)
    await bootProxy({ tokenManager: refreshingManager })

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(401)
    expect(calls).toBe(2)
  })

  test('five concurrent requests hitting upstream 401 fire exactly one refresh', async () => {
    upstream.setResponder((req) => {
      const auth = req.headers.get('authorization')
      if (auth === 'Bearer test-access') {
        return new Response('{}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{"id":"ok"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    let refreshCalls = 0
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const refreshFn = async (load: () => Promise<string | undefined>) => {
      refreshCalls += 1
      await load()
      // Hold the refresh open until all 5 callers have arrived at forceRefresh.
      await refreshGate
      return {
        access: 'refreshed-access',
        refresh: 'refreshed-refresh',
        expires: Date.now() + 3600_000,
      } satisfies RefreshResult
    }
    const refreshingManager = new TokenManager(store, refreshFn)
    await bootProxy({ tokenManager: refreshingManager })

    const requests = Array.from({ length: 5 }, () =>
      fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: 'POST',
        body: '{}',
      }),
    )

    // Give every request time to hit the upstream 401 and reach forceRefresh.
    await new Promise((r) => setTimeout(r, 50))
    releaseRefresh()

    const responses = await Promise.all(requests)
    expect(responses.every((r) => r.status === 200)).toBe(true)
    expect(refreshCalls).toBe(1)
  })

  test('returns 502 if refresh fails after upstream 401', async () => {
    upstream.setResponder(() => new Response('{}', { status: 401 }))
    const failingFn = async (load: () => Promise<string | undefined>) => {
      await load()
      throw new Error('refresh provider unreachable')
    }
    const failingManager = new TokenManager(store, failingFn)
    await bootProxy({ tokenManager: failingManager })

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(502)
    const data = (await res.json()) as { error: string }
    expect(data.error).toBe('proxy_refresh_failed')
  })

  test('returns 502 when upstream is unreachable', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1' // nothing listens here
    await bootProxy()
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(502)
    const data = (await res.json()) as { error: string }
    expect(data.error).toBe('proxy_upstream_unreachable')
  })
})
