import { afterEach, describe, expect, mock, test } from 'bun:test'
import { CLIENT_ID, TOKEN_URL } from '../constants'
import { performTokenRefresh, RefreshHttpError } from '../refresh'

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
})

/** Replace setTimeout with a synchronous mock to avoid real delays in retry tests. */
function mockImmediateSetTimeout() {
  const setTimeoutMock = mock((handler: () => unknown) => {
    handler()
    return 0
  })
  // @ts-expect-error — test override
  globalThis.setTimeout = setTimeoutMock
  return setTimeoutMock
}

function tokenResponse(
  overrides: Partial<{
    access: string
    refresh: string
    expiresIn: number
  }> = {},
) {
  return new Response(
    JSON.stringify({
      access_token: overrides.access ?? 'new-access',
      refresh_token: overrides.refresh ?? 'new-refresh',
      expires_in: overrides.expiresIn ?? 3600,
    }),
    { status: 200 },
  )
}

describe('performTokenRefresh', () => {
  test('returns the new credentials on success', async () => {
    const before = Date.now()

    globalThis.fetch = mock(() =>
      Promise.resolve(
        tokenResponse({ access: 'a1', refresh: 'r1', expiresIn: 7200 }),
      ),
    ) as unknown as typeof fetch

    const result = await performTokenRefresh(async () => 'current-refresh')

    expect(result.access).toBe('a1')
    expect(result.refresh).toBe('r1')
    expect(result.expires).toBeGreaterThanOrEqual(before + 7200 * 1000)
  })

  test('posts the refresh token, grant_type, and client_id to TOKEN_URL', async () => {
    let capturedUrl: string | undefined
    let capturedBody: string | undefined

    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl =
          typeof input === 'string' ? input : (input as URL).toString()
        capturedBody = init?.body as string
        return Promise.resolve(tokenResponse())
      },
    ) as unknown as typeof fetch

    await performTokenRefresh(async () => 'rt-xyz')

    expect(capturedUrl).toBe(TOKEN_URL)
    const body = JSON.parse(capturedBody!)
    expect(body.grant_type).toBe('refresh_token')
    expect(body.refresh_token).toBe('rt-xyz')
    expect(body.client_id).toBe(CLIENT_ID)
  })

  test('retries on 5xx responses with exponential backoff', async () => {
    const setTimeoutMock = mockImmediateSetTimeout()
    let calls = 0

    globalThis.fetch = mock(() => {
      calls += 1
      if (calls === 1)
        return Promise.resolve(new Response('boom', { status: 500 }))
      if (calls === 2)
        return Promise.resolve(new Response('boom', { status: 503 }))
      return Promise.resolve(tokenResponse())
    }) as unknown as typeof fetch

    const result = await performTokenRefresh(async () => 'r')

    expect(result.access).toBe('new-access')
    expect(calls).toBe(3)
    expect(setTimeoutMock).toHaveBeenCalledTimes(2)
    expect(setTimeoutMock).toHaveBeenNthCalledWith(1, expect.any(Function), 500)
    expect(setTimeoutMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      1000,
    )
  })

  test('does not retry on non-5xx error responses', async () => {
    let calls = 0
    globalThis.fetch = mock(() => {
      calls += 1
      return Promise.resolve(new Response('forbidden', { status: 403 }))
    }) as unknown as typeof fetch

    await expect(performTokenRefresh(async () => 'r')).rejects.toThrow(
      RefreshHttpError,
    )
    expect(calls).toBe(1)
  })

  test('throws RefreshHttpError carrying status and body for 4xx', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('invalid_grant', { status: 401 })),
    ) as unknown as typeof fetch

    try {
      await performTokenRefresh(async () => 'r')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(RefreshHttpError)
      const e = err as RefreshHttpError
      expect(e.status).toBe(401)
      expect(e.body).toBe('invalid_grant')
      expect(e.message).toContain('Token refresh failed: 401')
    }
  })

  test('gives up after exhausting all 5xx retries and throws', async () => {
    mockImmediateSetTimeout()
    let calls = 0
    globalThis.fetch = mock(() => {
      calls += 1
      return Promise.resolve(new Response('server down', { status: 502 }))
    }) as unknown as typeof fetch

    await expect(performTokenRefresh(async () => 'r')).rejects.toThrow(
      RefreshHttpError,
    )
    // Initial attempt + 2 retries = 3 total.
    expect(calls).toBe(3)
  })

  test('throws when loadRefreshToken returns undefined', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(tokenResponse()),
    ) as unknown as typeof fetch

    await expect(performTokenRefresh(async () => undefined)).rejects.toThrow(
      'No refresh token available',
    )
  })

  test('throws when loadRefreshToken returns empty string', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(tokenResponse()),
    ) as unknown as typeof fetch

    await expect(performTokenRefresh(async () => '')).rejects.toThrow(
      'No refresh token available',
    )
  })

  test('throws on malformed JSON response (missing access_token)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ refresh_token: 'r', expires_in: 3600 }), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch

    await expect(performTokenRefresh(async () => 'r')).rejects.toThrow(
      /missing access_token/,
    )
  })

  test('throws on malformed JSON response (empty refresh_token)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'a',
            refresh_token: '',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    await expect(performTokenRefresh(async () => 'r')).rejects.toThrow(
      /missing refresh_token/,
    )
  })

  test('throws on malformed JSON response (negative expires_in)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'a',
            refresh_token: 'r',
            expires_in: -1,
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    await expect(performTokenRefresh(async () => 'r')).rejects.toThrow(
      /invalid expires_in/,
    )
  })

  test('retries on transient network errors', async () => {
    mockImmediateSetTimeout()
    let calls = 0
    globalThis.fetch = mock(() => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('fetch failed'))
      return Promise.resolve(tokenResponse())
    }) as unknown as typeof fetch

    const result = await performTokenRefresh(async () => 'r')

    expect(result.access).toBe('new-access')
    expect(calls).toBe(2)
  })

  test('does not retry on non-network errors thrown by fetch', async () => {
    let calls = 0
    globalThis.fetch = mock(() => {
      calls += 1
      return Promise.reject(new Error('JSON parse error in my code'))
    }) as unknown as typeof fetch

    await expect(performTokenRefresh(async () => 'r')).rejects.toThrow(
      'JSON parse error in my code',
    )
    expect(calls).toBe(1)
  })

  test('invokes loadRefreshToken on every attempt, picking up rotated tokens', async () => {
    mockImmediateSetTimeout()
    const sentRefreshTokens: string[] = []
    let calls = 0

    globalThis.fetch = mock(
      (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string)
        sentRefreshTokens.push(body.refresh_token)
        calls += 1
        if (calls === 1)
          return Promise.resolve(new Response('boom', { status: 500 }))
        return Promise.resolve(tokenResponse())
      },
    ) as unknown as typeof fetch

    const tokens = ['first-token', 'rotated-token']
    let i = 0
    await performTokenRefresh(async () => tokens[i++]!)

    expect(sentRefreshTokens).toEqual(['first-token', 'rotated-token'])
  })

  test('does not retry on ECONNRESET-shaped errors beyond the retry cap', async () => {
    mockImmediateSetTimeout()
    let calls = 0
    globalThis.fetch = mock(() => {
      calls += 1
      const err = new Error('connection reset') as Error & { code: string }
      err.code = 'ECONNRESET'
      return Promise.reject(err)
    }) as unknown as typeof fetch

    await expect(performTokenRefresh(async () => 'r')).rejects.toThrow(
      'connection reset',
    )
    expect(calls).toBe(3)
  })
})
