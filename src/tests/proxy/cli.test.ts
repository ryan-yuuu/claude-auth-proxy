import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliDeps } from '../../proxy/cli'
import {
  parseArgs,
  runCli,
  runLogin,
  runLogout,
  runServe,
  runStatus,
} from '../../proxy/cli'
import { Logger } from '../../proxy/logger'
import { type StoredAuth, TokenStore } from '../../proxy/token-store'

let dir: string
let store: TokenStore
let logged: string[]
let deps: CliDeps

function buildDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  logged = []
  return {
    store,
    logger: new Logger('info', (line) => logged.push(line)),
    readLine: async () => '',
    confirm: async () => false,
    installSignalHandlers: () => () => {},
    authorize: async () => ({
      url: 'https://test.example/oauth/authorize?state=stub',
      redirectUri: 'https://test.example/callback',
      state: 'stub-state',
      verifier: 'stub-verifier',
    }),
    exchange: async () => ({ type: 'failed' as const }),
    ...overrides,
  }
}

const VALID_AUTH: StoredAuth = {
  type: 'oauth',
  access: 'a',
  refresh: 'r',
  expires: Date.now() + 3600_000,
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cli-'))
  store = new TokenStore(join(dir, 'auth.json'))
  deps = buildDeps()
})

describe('parseArgs', () => {
  test('extracts command and positional arguments', () => {
    expect(parseArgs(['serve'])).toEqual({
      command: 'serve',
      positional: [],
      flags: {},
    })
  })

  test('handles boolean flags', () => {
    expect(parseArgs(['serve', '--verbose'])).toEqual({
      command: 'serve',
      positional: [],
      flags: { verbose: true },
    })
  })

  test('handles value flags', () => {
    expect(
      parseArgs(['serve', '--port', '4000', '--host', 'localhost']),
    ).toEqual({
      command: 'serve',
      positional: [],
      flags: { port: '4000', host: 'localhost' },
    })
  })

  test('combines boolean and value flags', () => {
    expect(parseArgs(['serve', '--port', '4000', '--verbose'])).toEqual({
      command: 'serve',
      positional: [],
      flags: { port: '4000', verbose: true },
    })
  })

  test('throws when value flag is missing its value', () => {
    expect(() => parseArgs(['serve', '--port'])).toThrow(/Missing value/)
  })

  test('handles short flags as boolean', () => {
    expect(parseArgs(['logout', '-y'])).toEqual({
      command: 'logout',
      positional: [],
      flags: { y: true },
    })
  })

  test('returns no command when argv is empty', () => {
    expect(parseArgs([])).toEqual({
      command: undefined,
      positional: [],
      flags: {},
    })
  })
})

describe('runStatus', () => {
  test('reports not authenticated when auth.json is missing', async () => {
    const code = await runStatus(deps)
    expect(code).toBe(0)
    expect(logged.join('')).toContain('not authenticated')
  })

  test('reports validity and expiry for a valid auth.json', async () => {
    await store.write(VALID_AUTH)
    const code = await runStatus(deps)
    expect(code).toBe(0)
    const out = logged.join('')
    expect(out).toContain('present:    yes')
    expect(out).toContain('mode:       0600')
    expect(out).toContain('valid_now:  yes')
  })

  test('reports expired token as invalid', async () => {
    await store.write({ ...VALID_AUTH, expires: Date.now() - 1000 })
    const code = await runStatus(deps)
    expect(code).toBe(0)
    const out = logged.join('')
    expect(out).toContain('valid_now:  no')
    expect(out).toContain('ago')
  })

  test('warns and returns 1 on insecure mode', async () => {
    await store.write(VALID_AUTH)
    const { chmod } = await import('node:fs/promises')
    await chmod(store.path, 0o644)
    const code = await runStatus(deps)
    expect(code).toBe(1)
    const out = logged.join('')
    expect(out).toContain('INSECURE')
    expect(out).toContain('chmod 600')
  })

  test('never prints the access or refresh token', async () => {
    await store.write({
      type: 'oauth',
      access: 'sk-ant-oat01-supersecret',
      refresh: 'sk-ant-ort01-alsosecret',
      expires: Date.now() + 3600_000,
    })
    await runStatus(deps)
    const out = logged.join('')
    expect(out).not.toContain('supersecret')
    expect(out).not.toContain('alsosecret')
  })
})

describe('runLogin', () => {
  test('persists credentials on a successful exchange', async () => {
    const expectedExpires = Date.now() + 3600_000
    const authorizeCalls: string[] = []
    const exchangeArgs: unknown[] = []
    deps = buildDeps({
      authorize: async (mode: 'max' | 'console') => {
        authorizeCalls.push(mode)
        return {
          url: 'https://test.example/oauth/authorize',
          redirectUri: 'https://test.example/callback',
          state: 'expected-state',
          verifier: 'pkce-verifier',
        }
      },
      exchange: async (code, verifier, redirectUri, state) => {
        exchangeArgs.push({ code, verifier, redirectUri, state })
        return {
          type: 'success' as const,
          access: 'new-access',
          refresh: 'new-refresh',
          expires: expectedExpires,
        }
      },
      readLine: async () => '  pasted-code  ',
    })

    const code = await runLogin(deps)

    expect(code).toBe(0)
    expect(authorizeCalls).toEqual(['max'])
    expect(exchangeArgs).toEqual([
      {
        code: 'pasted-code',
        verifier: 'pkce-verifier',
        redirectUri: 'https://test.example/callback',
        state: 'expected-state',
      },
    ])
    const stored = await store.read()
    expect(stored).toEqual({
      type: 'oauth',
      access: 'new-access',
      refresh: 'new-refresh',
      expires: expectedExpires,
    })
    expect(logged.join('')).toContain('Authenticated')
  })

  test('forwards the state from authorize to exchange (CSRF check)', async () => {
    let receivedState: string | undefined
    deps = buildDeps({
      authorize: async () => ({
        url: 'https://test.example/auth',
        redirectUri: 'https://test.example/cb',
        state: 'csrf-state-12345',
        verifier: 'v',
      }),
      exchange: async (_code, _verifier, _redirectUri, state) => {
        receivedState = state
        return { type: 'failed' as const }
      },
      readLine: async () => 'some-code',
    })

    await runLogin(deps)

    expect(receivedState).toBe('csrf-state-12345')
  })

  test('returns 1 and does not call exchange when code is blank', async () => {
    let exchangeCalled = false
    deps = buildDeps({
      exchange: async () => {
        exchangeCalled = true
        return { type: 'failed' as const }
      },
      readLine: async () => '   ',
    })

    const code = await runLogin(deps)

    expect(code).toBe(1)
    expect(exchangeCalled).toBe(false)
    expect(await store.read()).toBeNull()
    expect(logged.join('')).toContain('No code provided')
  })

  test('returns 1 and does not write store when exchange returns failed', async () => {
    deps = buildDeps({
      exchange: async () => ({ type: 'failed' as const }),
      readLine: async () => 'code',
    })

    const code = await runLogin(deps)

    expect(code).toBe(1)
    expect(await store.read()).toBeNull()
    expect(logged.join('')).toContain('Exchange failed')
  })

  test('returns 1 with a clear message when authorize throws', async () => {
    deps = buildDeps({
      authorize: async () => {
        throw new Error('network down')
      },
    })

    const code = await runLogin(deps)

    expect(code).toBe(1)
    expect(logged.join('')).toContain('Failed to start authorization')
    expect(logged.join('')).toContain('network down')
  })

  test('returns 1 with a clear message when exchange throws', async () => {
    deps = buildDeps({
      exchange: async () => {
        throw new Error('upstream 500')
      },
      readLine: async () => 'code',
    })

    const code = await runLogin(deps)

    expect(code).toBe(1)
    expect(logged.join('')).toContain('Exchange failed')
    expect(logged.join('')).toContain('upstream 500')
  })

  test('prints the authorization URL to stdout', async () => {
    deps = buildDeps({
      authorize: async () => ({
        url: 'https://test.example/oauth/very-specific-url',
        redirectUri: 'r',
        state: 's',
        verifier: 'v',
      }),
    })
    await runLogin(deps)
    expect(logged.join('')).toContain(
      'https://test.example/oauth/very-specific-url',
    )
  })
})

describe('runLogout', () => {
  test('returns 0 with message when no auth.json exists', async () => {
    const code = await runLogout(deps, {})
    expect(code).toBe(0)
    expect(logged.join('')).toContain('No auth.json to remove')
  })

  test('prompts for confirmation and aborts on no', async () => {
    await store.write(VALID_AUTH)
    deps = buildDeps({ confirm: async () => false })
    const code = await runLogout(deps, {})
    expect(code).toBe(1)
    expect(logged.join('')).toContain('Aborted')
    expect(await store.read()).not.toBeNull()
  })

  test('deletes on yes confirmation', async () => {
    await store.write(VALID_AUTH)
    deps = buildDeps({ confirm: async () => true })
    const code = await runLogout(deps, {})
    expect(code).toBe(0)
    expect(logged.join('')).toContain('Logged out')
    expect(await store.read()).toBeNull()
  })

  test('skips confirmation when --yes is set', async () => {
    await store.write(VALID_AUTH)
    let confirmCalled = false
    deps = buildDeps({
      confirm: async () => {
        confirmCalled = true
        return true
      },
    })
    const code = await runLogout(deps, { yes: true })
    expect(code).toBe(0)
    expect(confirmCalled).toBe(false)
    expect(await store.read()).toBeNull()
  })
})

describe('runServe', () => {
  test('refuses to start when no auth.json', async () => {
    const code = await runServe(deps, {})
    expect(code).toBe(1)
    expect(logged.join('')).toContain('No auth.json')
  })

  test('refuses to start on insecure mode', async () => {
    await store.write(VALID_AUTH)
    const { chmod } = await import('node:fs/promises')
    await chmod(store.path, 0o644)
    const code = await runServe(deps, {})
    expect(code).toBe(1)
    expect(logged.join('')).toContain('insecure mode')
  })

  test('refuses to start on non-loopback host', async () => {
    await store.write(VALID_AUTH)
    const code = await runServe(deps, { host: '0.0.0.0' })
    expect(code).toBe(1)
    expect(logged.join('')).toContain('loopback')
  })

  test('rejects invalid --port values', async () => {
    await store.write(VALID_AUTH)
    const code = await runServe(deps, { port: 'not-a-number' })
    expect(code).toBe(2)
    expect(logged.join('')).toContain('Invalid --port')
  })

  test('starts and stops cleanly on signal', async () => {
    await store.write(VALID_AUTH)
    let shutdownFn: (() => void) | null = null
    deps = buildDeps({
      installSignalHandlers: (onShutdown) => {
        shutdownFn = onShutdown
        return () => {}
      },
    })
    const promise = runServe(deps, { port: '0' })
    // Yield until the signal handler is installed
    while (!shutdownFn) {
      await new Promise((r) => setTimeout(r, 5))
    }
    ;(shutdownFn as () => void)()
    const code = await promise
    expect(code).toBe(0)
    expect(logged.join('')).toContain('Listening on http://')
    expect(logged.join('')).toContain('Shutting down')
  })
})

describe('runCli dispatch', () => {
  test('returns help and non-zero when no command is given', async () => {
    const code = await runCli([])
    expect(code).toBe(1)
  })

  test('returns 0 with --help', async () => {
    const code = await runCli(['serve', '--help'])
    expect(code).toBe(0)
  })

  test('returns 2 on unknown command', async () => {
    const code = await runCli(['frobnicate'])
    expect(code).toBe(2)
  })

  test('routes to status', async () => {
    await store.write(VALID_AUTH)
    const code = await runCli(['status'], () => buildDeps())
    expect(code).toBe(0)
    expect(logged.join('')).toContain('present:    yes')
  })

  test('routes to logout with --yes', async () => {
    await store.write(VALID_AUTH)
    const code = await runCli(['logout', '--yes'], () => buildDeps())
    expect(code).toBe(0)
    expect(await store.read()).toBeNull()
  })
})
