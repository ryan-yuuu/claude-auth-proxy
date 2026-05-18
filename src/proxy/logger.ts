export type LogLevel = 'info' | 'debug'

/**
 * Replace any value that looks like an Anthropic access/refresh token,
 * a Bearer credential, or a JSON `access`/`refresh` field with a
 * `<redacted>` placeholder.
 *
 * Belt-and-suspenders: the proxy is structurally arranged so tokens
 * never reach a logger call, but a single unguarded string interpolation
 * later in the codebase shouldn't be enough to leak a credential to
 * stderr.
 */
export function redact(input: string): string {
  return input
    .replace(/sk-ant-oat\d+-[A-Za-z0-9_-]+/g, 'sk-ant-oat<redacted>')
    .replace(/sk-ant-api\d+-[A-Za-z0-9_-]+/g, 'sk-ant-api<redacted>')
    .replace(/sk-ant-ort\d+-[A-Za-z0-9_-]+/g, 'sk-ant-ort<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9_.~+/=-]+/gi, '$1<redacted>')
    .replace(
      /("(?:access|refresh)(?:_token)?"\s*:\s*")[^"]*"/g,
      '$1<redacted>"',
    )
}

/**
 * Coerce an unknown thrown value to a string for logging. Tolerates
 * non-Error throws (a misbehaving library throwing a string or a plain
 * object) so the catch site never accidentally interpolates `undefined`.
 */
export function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Format a flat record as `key=value key2=value2` for log line bodies.
 * Values containing whitespace or quotes are JSON-quoted.
 */
export function fields(record: Record<string, unknown>): string {
  return Object.entries(record)
    .map(([k, v]) => {
      if (v === undefined || v === null) return `${k}=`
      const s = String(v)
      return /[\s"]/.test(s) ? `${k}=${JSON.stringify(s)}` : `${k}=${s}`
    })
    .join(' ')
}

export type LogWriter = (line: string) => void

const defaultWriter: LogWriter = (line) => {
  process.stderr.write(line)
}

/**
 * Stderr-only logger. Stamps every line with an ISO timestamp and
 * runs it through `redact` before emitting. `info` is the default
 * level; `debug` is gated behind `--verbose`.
 */
export class Logger {
  constructor(
    public level: LogLevel = 'info',
    private writer: LogWriter = defaultWriter,
  ) {}

  info(line: string): void {
    this.emit(line)
  }

  debug(line: string): void {
    if (this.level !== 'debug') return
    this.emit(line)
  }

  /** Print without a timestamp prefix — used for human-facing CLI messages. */
  plain(line: string): void {
    this.writer(`${redact(line)}\n`)
  }

  private emit(line: string): void {
    const ts = new Date().toISOString()
    this.writer(`${redact(`[${ts}] ${line}`)}\n`)
  }
}
