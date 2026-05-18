import { CLIENT_ID, TOKEN_URL } from './constants.ts'

/**
 * Anthropic rotates the refresh token on every successful refresh —
 * `refresh` here is the new value the caller must persist; reusing the
 * old one returns 401.
 */
export type RefreshResult = {
  access: string
  refresh: string
  expires: number
}

/**
 * Thrown when the OAuth token endpoint returns a non-2xx that retries
 * cannot recover from (any 4xx, or a 5xx after retries exhaust).
 *
 * The proxy's request handler routes this back to the client with
 * `status` and `body` intact so a `400 invalid_grant` doesn't look
 * the same as a `5xx` upstream outage. Caller-visible billing of
 * "log in again" vs "Anthropic is down" depends on this.
 */
export class RefreshHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Token refresh failed: ${status} — ${body}`)
    this.name = 'RefreshHttpError'
    Object.setPrototypeOf(this, RefreshHttpError.prototype)
  }
}

/**
 * Perform an OAuth refresh against Anthropic's token endpoint.
 *
 * Pure with respect to storage: the caller passes a `loadRefreshToken`
 * callback and is responsible for persisting the returned credentials
 * and for inflight-promise dedup. The separation lets caller-specific
 * persistence (plugin host, on-disk file, in-memory test fake) live
 * outside this function.
 *
 * Retries on 5xx and transient connect errors so a one-shot socket
 * blip doesn't break a long-lived agent loop. 4xx surfaces immediately
 * as a `RefreshHttpError` with status/body — retrying a bad credential
 * won't fix it.
 *
 * `loadRefreshToken` is invoked on every attempt: if another caller
 * has rotated the token in the interim, this call picks up the new
 * value rather than burning a retry on a stale one.
 */
export async function performTokenRefresh(
  loadRefreshToken: () => Promise<string | undefined>,
): Promise<RefreshResult> {
  const maxRetries = 2
  const baseDelayMs = 500

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * 2 ** (attempt - 1)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }

      const refreshToken = await loadRefreshToken()
      if (!refreshToken || typeof refreshToken !== 'string') {
        throw new Error('No refresh token available')
      }

      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'axios/1.13.6',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }),
      })

      if (!response.ok) {
        if (response.status >= 500 && attempt < maxRetries) {
          await response.body?.cancel().catch(() => {})
          continue
        }

        const body = await response
          .text()
          .catch(
            (e) =>
              `<body unreadable: ${e instanceof Error ? e.message : String(e)}>`,
          )
        throw new RefreshHttpError(response.status, body)
      }

      const parsed = (await response.json()) as unknown
      return validateRefreshResponse(parsed)
    } catch (error) {
      const code =
        error instanceof Error &&
        'code' in error &&
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : undefined
      const isNetworkError =
        error instanceof Error &&
        (error.message.includes('fetch failed') ||
          code === 'ECONNRESET' ||
          code === 'ECONNREFUSED' ||
          code === 'ETIMEDOUT' ||
          code === 'UND_ERR_CONNECT_TIMEOUT')

      if (attempt < maxRetries && isNetworkError) {
        continue
      }

      throw error
    }
  }
  // Unreachable: TypeScript exhaustiveness guard.
  throw new Error('Token refresh exhausted all retries')
}

/**
 * Validate the upstream JSON before constructing a RefreshResult.
 * A garbled response should fail loudly here rather than write
 * empty strings or NaN expiries to disk for a downstream caller to
 * trip over later.
 */
function validateRefreshResponse(parsed: unknown): RefreshResult {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Token refresh response was not a JSON object')
  }
  const p = parsed as Record<string, unknown>
  if (typeof p.access_token !== 'string' || p.access_token.length === 0) {
    throw new Error('Token refresh response missing access_token')
  }
  if (typeof p.refresh_token !== 'string' || p.refresh_token.length === 0) {
    throw new Error('Token refresh response missing refresh_token')
  }
  if (
    typeof p.expires_in !== 'number' ||
    !Number.isFinite(p.expires_in) ||
    p.expires_in <= 0
  ) {
    throw new Error('Token refresh response missing or invalid expires_in')
  }
  return {
    access: p.access_token,
    refresh: p.refresh_token,
    expires: Date.now() + p.expires_in * 1000,
  }
}
