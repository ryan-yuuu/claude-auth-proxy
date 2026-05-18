import { performTokenRefresh } from '../refresh.ts'
import type { Logger } from './logger.ts'
import { InvalidStoredAuthError, type TokenStore } from './token-store.ts'

/**
 * Refresh tokens this many milliseconds before they actually expire.
 * Keeps requests from racing the clock — Anthropic's clock may be
 * a few seconds ahead, and any latency between "we sent the request"
 * and "Anthropic checked the bearer" is room for a server-side 401.
 */
const REFRESH_BUFFER_MS = 60_000

export class NotAuthenticatedError extends Error {
  constructor() {
    super(
      'Not authenticated. Run `anthropic-auth-proxy login` to obtain an OAuth token.',
    )
    this.name = 'NotAuthenticatedError'
  }
}

type RefreshFn = typeof performTokenRefresh

/**
 * Resolves access tokens for the request handler, refreshing them
 * on demand via the OAuth refresh endpoint.
 *
 * Refresh is deduplicated across concurrent callers via a single
 * `inflight` promise: when N requests arrive simultaneously with an
 * expired token, only one network round-trip to /v1/oauth/token is
 * made and all N awaiters share its result. This matters because
 * Anthropic rotates the refresh token on every successful refresh
 * — concurrent independent refreshes would race and most would land
 * with an invalidated refresh token (cascading 401s).
 */
export class TokenManager {
  private inflight: Promise<string> | null = null

  constructor(
    private readonly store: TokenStore,
    private readonly refreshFn: RefreshFn = performTokenRefresh,
    private readonly logger?: Logger,
  ) {}

  /** Return a valid access token, refreshing on demand if expiry is near. */
  async getAccessToken(): Promise<string> {
    const auth = await this.readAuth()
    if (!auth) throw new NotAuthenticatedError()
    if (auth.access && auth.expires > Date.now() + REFRESH_BUFFER_MS) {
      return auth.access
    }
    return this.refresh()
  }

  /**
   * Read auth.json, translating "file exists but is unusable" into
   * `NotAuthenticatedError`. Disk I/O errors propagate as-is so the
   * caller can return 5xx rather than a misleading "log in again."
   */
  private async readAuth() {
    try {
      return await this.store.read()
    } catch (err) {
      if (err instanceof InvalidStoredAuthError) {
        throw new NotAuthenticatedError()
      }
      throw err
    }
  }

  /** Force a refresh regardless of stored expiry. Used after upstream 401. */
  async forceRefresh(): Promise<string> {
    return this.refresh()
  }

  private refresh(): Promise<string> {
    if (this.inflight) return this.inflight
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doRefresh(): Promise<string> {
    this.logger?.info('refresh start')
    const result = await this.refreshFn(async () => {
      // Re-read on every refresh attempt so a rotation triggered by another
      // caller (or the previous attempt of this same retry loop) is picked up.
      const fresh = await this.readAuth()
      if (!fresh?.refresh) throw new NotAuthenticatedError()
      return fresh.refresh
    })
    await this.store.write({
      type: 'oauth',
      access: result.access,
      refresh: result.refresh,
      expires: result.expires,
    })
    const ttlSeconds = Math.max(
      0,
      Math.round((result.expires - Date.now()) / 1000),
    )
    this.logger?.info(`refresh done expires_in_s=${ttlSeconds}`)
    return result.access
  }
}
