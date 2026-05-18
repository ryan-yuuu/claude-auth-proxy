import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotAuthenticatedError, TokenManager } from '../../proxy/token-manager'
import { type StoredAuth, TokenStore } from '../../proxy/token-store'
import type { RefreshResult } from '../../refresh'

let dir: string
let store: TokenStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'token-manager-'))
  store = new TokenStore(join(dir, 'auth.json'))
})

type RefreshOptions = {
  result?: () => Promise<RefreshResult> | RefreshResult
  delay?: () => Promise<void>
}

function makeRefreshFn(opts: RefreshOptions = {}) {
  const state = { calls: 0, loaderInvocations: 0 }
  const fn = async (load: () => Promise<string | undefined>) => {
    state.calls += 1
    const refresh = await load()
    state.loaderInvocations += 1
    if (opts.delay) await opts.delay()
    if (opts.result) return opts.result()
    return {
      access: `access-${state.calls}`,
      refresh: refresh ?? 'r',
      expires: Date.now() + 3600_000,
    }
  }
  return { fn, state }
}

const validAuth: StoredAuth = {
  type: 'oauth',
  access: 'valid-access',
  refresh: 'r1',
  expires: Date.now() + 3600_000,
}

describe('getAccessToken', () => {
  test('throws NotAuthenticatedError when no auth.json exists', async () => {
    const { fn } = makeRefreshFn()
    const mgr = new TokenManager(store, fn)
    expect(mgr.getAccessToken()).rejects.toThrow(NotAuthenticatedError)
  })

  test('returns cached access token when not near expiry', async () => {
    const { fn, state } = makeRefreshFn()
    await store.write(validAuth)
    const mgr = new TokenManager(store, fn)
    expect(await mgr.getAccessToken()).toBe('valid-access')
    expect(state.calls).toBe(0)
  })

  test('refreshes when token is past expiry', async () => {
    const { fn, state } = makeRefreshFn()
    await store.write({ ...validAuth, expires: Date.now() - 1000 })
    const mgr = new TokenManager(store, fn)
    expect(await mgr.getAccessToken()).toBe('access-1')
    expect(state.calls).toBe(1)
  })

  test('refreshes when token is within 60s buffer of expiry', async () => {
    const { fn, state } = makeRefreshFn()
    await store.write({ ...validAuth, expires: Date.now() + 30_000 })
    const mgr = new TokenManager(store, fn)
    expect(await mgr.getAccessToken()).toBe('access-1')
    expect(state.calls).toBe(1)
  })

  test('does NOT refresh just outside the buffer window', async () => {
    const { fn, state } = makeRefreshFn()
    await store.write({ ...validAuth, expires: Date.now() + 90_000 })
    const mgr = new TokenManager(store, fn)
    expect(await mgr.getAccessToken()).toBe('valid-access')
    expect(state.calls).toBe(0)
  })

  test('persists rotated credentials after a refresh', async () => {
    const newExpires = Date.now() + 7200_000
    const { fn } = makeRefreshFn({
      result: () => ({
        access: 'rotated-access',
        refresh: 'rotated-refresh',
        expires: newExpires,
      }),
    })
    await store.write({ ...validAuth, expires: Date.now() - 1000 })
    const mgr = new TokenManager(store, fn)
    await mgr.getAccessToken()
    const stored = await store.read()
    expect(stored).toEqual({
      type: 'oauth',
      access: 'rotated-access',
      refresh: 'rotated-refresh',
      expires: newExpires,
    })
  })

  test('passes the current refresh token through the loader callback', async () => {
    const { fn, state } = makeRefreshFn()
    await store.write({
      ...validAuth,
      refresh: 'token-A',
      expires: Date.now() - 1000,
    })
    const mgr = new TokenManager(store, fn)
    const access = await mgr.getAccessToken()
    expect(access).toBe('access-1')
    // makeRefreshFn echoes the loaded refresh back into the result
    const stored = await store.read()
    expect(stored?.refresh).toBe('token-A')
    expect(state.loaderInvocations).toBe(1)
  })

  test('throws NotAuthenticatedError when stored auth has empty refresh', async () => {
    const { fn } = makeRefreshFn()
    // Bypass store.write's serialization by writing the file directly —
    // the tightened isStoredAuth would reject this content on read.
    const { writeFile, chmod } = await import('node:fs/promises')
    const { mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(store.path), { recursive: true })
    await writeFile(store.path, JSON.stringify({ ...validAuth, refresh: '' }), {
      mode: 0o600,
    })
    await chmod(store.path, 0o600)
    const mgr = new TokenManager(store, fn)
    expect(mgr.getAccessToken()).rejects.toThrow(NotAuthenticatedError)
  })

  test('translates InvalidStoredAuthError from insecure mode to NotAuthenticatedError', async () => {
    const { fn } = makeRefreshFn()
    await store.write(validAuth)
    const { chmod } = await import('node:fs/promises')
    await chmod(store.path, 0o644)
    const mgr = new TokenManager(store, fn)
    expect(mgr.getAccessToken()).rejects.toThrow(NotAuthenticatedError)
  })

  test('dedupes 5 concurrent refresh calls to a single refresh', async () => {
    let resolveRefresh!: (r: RefreshResult) => void
    const refreshPromise = new Promise<RefreshResult>((r) => {
      resolveRefresh = r
    })
    let calls = 0
    const fn = async (load: () => Promise<string | undefined>) => {
      calls += 1
      await load()
      return refreshPromise
    }
    await store.write({ ...validAuth, expires: Date.now() - 1000 })
    const mgr = new TokenManager(store, fn)

    const pending = Promise.all(
      Array.from({ length: 5 }, () => mgr.getAccessToken()),
    )

    // Allow microtasks to drain so all 5 callers reach refresh()
    await new Promise((r) => setTimeout(r, 10))

    resolveRefresh({
      access: 'shared',
      refresh: 'shared-r',
      expires: Date.now() + 100_000,
    })
    const results = await pending
    expect(results).toEqual(['shared', 'shared', 'shared', 'shared', 'shared'])
    expect(calls).toBe(1)
  })

  test('persists rotated token exactly once even with concurrent callers', async () => {
    const { fn, state } = makeRefreshFn({
      result: () => ({
        access: 'one-shot',
        refresh: 'one-shot-r',
        expires: Date.now() + 3600_000,
      }),
    })
    await store.write({ ...validAuth, expires: Date.now() - 1000 })
    const mgr = new TokenManager(store, fn)
    await Promise.all(Array.from({ length: 5 }, () => mgr.getAccessToken()))
    expect(state.calls).toBe(1)
    const stored = await store.read()
    expect(stored?.access).toBe('one-shot')
  })

  test('two sequential refreshes each use the refresh token written by the previous one', async () => {
    const sentRefreshTokens: string[] = []
    let serial = 0
    const fn = async (load: () => Promise<string | undefined>) => {
      const t = await load()
      sentRefreshTokens.push(t!)
      serial += 1
      return {
        access: `access-${serial}`,
        refresh: `rotated-${serial}`,
        expires: Date.now() + 3600_000,
      }
    }
    await store.write({
      ...validAuth,
      refresh: 'initial',
      expires: Date.now() - 1000,
    })
    const mgr = new TokenManager(store, fn)
    await mgr.getAccessToken()

    // Force-expire the freshly-rotated token to compel a second refresh.
    const persisted = await store.read()
    await store.write({ ...persisted!, expires: Date.now() - 1000 })
    await mgr.getAccessToken()

    expect(sentRefreshTokens).toEqual(['initial', 'rotated-1'])
  })

  test('clears inflight after success so a later expiry can refresh again', async () => {
    const { fn, state } = makeRefreshFn()
    await store.write({ ...validAuth, expires: Date.now() - 1000 })
    const mgr = new TokenManager(store, fn)
    await mgr.getAccessToken()
    expect(state.calls).toBe(1)

    const stored = await store.read()
    await store.write({ ...stored!, expires: Date.now() - 1000 })
    await mgr.getAccessToken()
    expect(state.calls).toBe(2)
  })

  test('clears inflight after failure so a caller can retry', async () => {
    let attempts = 0
    const fn = async (load: () => Promise<string | undefined>) => {
      attempts += 1
      await load()
      if (attempts === 1) throw new Error('refresh boom')
      return {
        access: 'recovered',
        refresh: 'r',
        expires: Date.now() + 3600_000,
      }
    }
    await store.write({ ...validAuth, expires: Date.now() - 1000 })
    const mgr = new TokenManager(store, fn)
    expect(mgr.getAccessToken()).rejects.toThrow('refresh boom')

    // Wait for the inflight promise to fully settle, including the .finally hook
    await new Promise((r) => setTimeout(r, 0))

    expect(await mgr.getAccessToken()).toBe('recovered')
    expect(attempts).toBe(2)
  })
})

describe('forceRefresh', () => {
  test('triggers a refresh even when the token is not expired', async () => {
    const { fn, state } = makeRefreshFn()
    await store.write(validAuth)
    const mgr = new TokenManager(store, fn)
    expect(await mgr.forceRefresh()).toBe('access-1')
    expect(state.calls).toBe(1)
  })

  test('joins an inflight refresh rather than starting a second one', async () => {
    let resolveRefresh!: (r: RefreshResult) => void
    const refreshPromise = new Promise<RefreshResult>((r) => {
      resolveRefresh = r
    })
    let calls = 0
    const fn = async (load: () => Promise<string | undefined>) => {
      calls += 1
      await load()
      return refreshPromise
    }
    await store.write({ ...validAuth, expires: Date.now() - 1000 })
    const mgr = new TokenManager(store, fn)

    const p1 = mgr.getAccessToken()
    const p2 = mgr.forceRefresh()
    const p3 = mgr.forceRefresh()
    await new Promise((r) => setTimeout(r, 10))

    resolveRefresh({
      access: 'shared',
      refresh: 'r',
      expires: Date.now() + 100_000,
    })
    expect(await p1).toBe('shared')
    expect(await p2).toBe('shared')
    expect(await p3).toBe('shared')
    expect(calls).toBe(1)
  })
})
