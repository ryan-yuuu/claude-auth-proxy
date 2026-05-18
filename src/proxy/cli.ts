import { createInterface } from 'node:readline/promises'
import { authorize, exchange } from '../auth.ts'
import { performTokenRefresh } from '../refresh.ts'
import { asMessage, Logger, type LogLevel } from './logger.ts'
import { startServer } from './server.ts'
import { TokenManager } from './token-manager.ts'
import { defaultAuthPath, TokenStore } from './token-store.ts'

const DEFAULT_PORT = 3457
const DEFAULT_HOST = '127.0.0.1'

const BOOLEAN_FLAGS = new Set(['verbose', 'help', 'yes', 'h', 'v', 'y'])

export type ParsedArgs = {
  command: string | undefined
  positional: string[]
  flags: Record<string, string | boolean>
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (raw === undefined) continue
    if (raw.startsWith('--') || raw.startsWith('-')) {
      const name = raw.replace(/^-+/, '')
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`Missing value for flag --${name}`)
      }
      flags[name] = next
      i++
    } else {
      positional.push(raw)
    }
  }
  return {
    command: positional[0],
    positional: positional.slice(1),
    flags,
  }
}

export type CliDeps = {
  store: TokenStore
  logger: Logger
  readLine: (prompt: string) => Promise<string>
  confirm: (prompt: string) => Promise<boolean>
  installSignalHandlers: (onShutdown: () => void) => () => void
  // OAuth seams: injected so tests can drive the login flow without
  // hitting Anthropic's authorization or token endpoints.
  authorize: typeof authorize
  exchange: typeof exchange
}

export function createDefaultDeps(args: {
  level?: LogLevel
  authPath?: string
}): CliDeps {
  const logger = new Logger(args.level ?? 'info')
  const readLine = async (prompt: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return await rl.question(prompt)
    } finally {
      rl.close()
    }
  }
  return {
    store: new TokenStore(args.authPath ?? defaultAuthPath()),
    logger,
    readLine,
    confirm: async (prompt: string) => {
      const answer = (await readLine(`${prompt} [y/N] `)).trim().toLowerCase()
      return answer === 'y' || answer === 'yes'
    },
    installSignalHandlers: (onShutdown) => {
      const handler = () => onShutdown()
      process.once('SIGINT', handler)
      process.once('SIGTERM', handler)
      return () => {
        process.off('SIGINT', handler)
        process.off('SIGTERM', handler)
      }
    },
    authorize,
    exchange,
  }
}

const HELP_TEXT = `anthropic-auth-proxy — local OAuth-impersonation proxy for Anthropic's API

USAGE
  anthropic-auth-proxy <command> [flags]

COMMANDS
  login                 Run the OAuth flow and persist credentials.
  serve                 Start the proxy server (default: 127.0.0.1:${DEFAULT_PORT}).
                          --port <number>   Override the listen port.
                          --host <address>  Loopback host (127.0.0.1, ::1, or localhost).
                          --verbose         Emit per-request rewrite diagnostics.
  status                Print whether auth.json exists, its expiry, and validity.
  logout                Remove the persisted auth.json (with confirmation).
                          --yes             Skip the confirmation prompt.

LEARNING-PROJECT DISCLAIMER
  This proxy applies OAuth-impersonation patterns to bill Anthropic API
  traffic against a Pro/Max subscription. It likely violates Anthropic's
  consumer terms when used for non-personal workloads. Use loopback-only,
  for personal study, with the understanding that it can stop working at
  any time when Anthropic's classifier ships a change.
`

export async function runCli(
  argv: readonly string[],
  depsFactory: (level: LogLevel) => CliDeps = (level) =>
    createDefaultDeps({ level }),
): Promise<number> {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`${asMessage(err)}\n`)
    process.stderr.write(HELP_TEXT)
    return 2
  }

  if (args.flags.help || args.flags.h || !args.command) {
    process.stdout.write(HELP_TEXT)
    return args.command ? 0 : 1
  }

  const level: LogLevel = args.flags.verbose || args.flags.v ? 'debug' : 'info'
  const deps = depsFactory(level)

  switch (args.command) {
    case 'login':
      return runLogin(deps)
    case 'serve':
      return runServe(deps, args.flags)
    case 'status':
      return runStatus(deps)
    case 'logout':
      return runLogout(deps, args.flags)
    default:
      process.stderr.write(`Unknown command: ${args.command}\n`)
      process.stderr.write(HELP_TEXT)
      return 2
  }
}

export async function runLogin(deps: CliDeps): Promise<number> {
  let flow: Awaited<ReturnType<typeof authorize>>
  try {
    flow = await deps.authorize('max')
  } catch (err) {
    deps.logger.plain(`Failed to start authorization: ${asMessage(err)}`)
    return 1
  }

  deps.logger.plain('Open this URL to authorize the proxy:')
  deps.logger.plain('')
  deps.logger.plain(`  ${flow.url}`)
  deps.logger.plain('')
  deps.logger.plain(
    'After approving, paste the code (or the full callback URL) below.',
  )

  const code = (await deps.readLine('Code: ')).trim()
  if (!code) {
    deps.logger.plain('No code provided. Aborting.')
    return 1
  }

  let result: Awaited<ReturnType<typeof exchange>>
  try {
    result = await deps.exchange(
      code,
      flow.verifier,
      flow.redirectUri,
      flow.state,
    )
  } catch (err) {
    deps.logger.plain(`Exchange failed: ${asMessage(err)}`)
    return 1
  }

  if (result.type === 'failed') {
    deps.logger.plain(
      'Exchange failed. The code may be invalid, already used, or mismatched on state.',
    )
    return 1
  }

  await deps.store.write({
    type: 'oauth',
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
  })
  deps.logger.plain(
    `Authenticated. Token expires ${new Date(result.expires).toISOString()}.`,
  )
  return 0
}

export async function runServe(
  deps: CliDeps,
  flags: ParsedArgs['flags'],
): Promise<number> {
  const portRaw = flags.port
  const port =
    typeof portRaw === 'string' ? Number.parseInt(portRaw, 10) : DEFAULT_PORT
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    deps.logger.plain(`Invalid --port: ${String(portRaw)}`)
    return 2
  }

  const host = typeof flags.host === 'string' ? flags.host : DEFAULT_HOST

  const inspection = await deps.store.inspect()
  if (!inspection.present) {
    deps.logger.plain(
      `No auth.json at ${deps.store.path}. Run \`anthropic-auth-proxy login\` first.`,
    )
    return 1
  }
  if (inspection.insecureMode) {
    deps.logger.plain(
      `Refusing to serve: auth.json has insecure mode ${formatMode(inspection.mode)}. Fix with: chmod 600 ${deps.store.path}`,
    )
    return 1
  }

  const manager = new TokenManager(deps.store, performTokenRefresh, deps.logger)

  let server: ReturnType<typeof startServer>
  try {
    server = startServer({
      host,
      port,
      tokenManager: manager,
      logger: deps.logger,
    })
  } catch (err) {
    deps.logger.plain(`Server failed to start: ${asMessage(err)}`)
    return 1
  }

  deps.logger.plain(
    `Listening on http://${server.hostname}:${server.port} (auth.json: ${deps.store.path})`,
  )

  return new Promise<number>((resolve) => {
    const stop = deps.installSignalHandlers(() => {
      deps.logger.plain('Shutting down.')
      server.stop(true)
      stop()
      resolve(0)
    })
  })
}

export async function runStatus(deps: CliDeps): Promise<number> {
  const info = await deps.store.inspect()
  deps.logger.plain(`auth.json: ${deps.store.path}`)
  if (!info.present) {
    deps.logger.plain('  present:    no')
    deps.logger.plain(
      '  status:     not authenticated — run `anthropic-auth-proxy login`',
    )
    return 0
  }

  deps.logger.plain('  present:    yes')
  deps.logger.plain(
    `  mode:       ${formatMode(info.mode)}${info.insecureMode ? '  (INSECURE)' : ''}`,
  )
  if (info.mtime) {
    deps.logger.plain(`  modified:   ${info.mtime.toISOString()}`)
  }

  if (info.insecureMode) {
    deps.logger.plain(
      `  status:     refusing to read — chmod 600 ${deps.store.path}`,
    )
    return 1
  }

  try {
    const auth = await deps.store.read()
    if (!auth) {
      deps.logger.plain('  status:     unreadable (file disappeared)')
      return 1
    }
    const now = Date.now()
    const remainingMs = auth.expires - now
    const expiresDate = new Date(auth.expires)
    const isValid = remainingMs > 60_000
    deps.logger.plain(
      `  expires:    ${expiresDate.toISOString()} (${formatDuration(remainingMs)} ${remainingMs >= 0 ? 'remaining' : 'ago'})`,
    )
    deps.logger.plain(
      `  valid_now:  ${isValid ? 'yes' : 'no — refresh will fire'}`,
    )
    return 0
  } catch (err) {
    deps.logger.plain(
      `  status:     error reading auth.json — ${asMessage(err)}`,
    )
    return 1
  }
}

export async function runLogout(
  deps: CliDeps,
  flags: ParsedArgs['flags'],
): Promise<number> {
  const info = await deps.store.inspect()
  if (!info.present) {
    deps.logger.plain('No auth.json to remove.')
    return 0
  }
  if (!flags.yes && !flags.y) {
    const ok = await deps.confirm(`Remove auth.json at ${deps.store.path}?`)
    if (!ok) {
      deps.logger.plain('Aborted.')
      return 1
    }
  }
  await deps.store.remove()
  deps.logger.plain('Logged out.')
  return 0
}

function formatMode(mode: number | undefined): string {
  if (mode === undefined) return '???'
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`
}

function formatDuration(ms: number): string {
  const sec = Math.abs(Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86_400) return `${Math.round(sec / 3600)}h`
  return `${Math.round(sec / 86_400)}d`
}
