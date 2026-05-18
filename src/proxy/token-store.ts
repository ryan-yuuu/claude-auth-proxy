import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type StoredAuth = {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
}

/**
 * Thrown by `TokenStore.read()` when auth.json exists but cannot be
 * trusted: insecure mode, malformed JSON, or content that doesn't
 * satisfy `isStoredAuth`. The proxy translates this into a
 * "log in again" response rather than masking it as a transient
 * upstream failure.
 */
export class InvalidStoredAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidStoredAuthError'
    Object.setPrototypeOf(this, InvalidStoredAuthError.prototype)
  }
}

/**
 * Default location for auth.json:
 *   ${XDG_CONFIG_HOME or ~/.config}/anthropic-auth-proxy/auth.json
 */
export function defaultAuthPath(): string {
  const configHome =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config')
  return join(configHome, 'anthropic-auth-proxy', 'auth.json')
}

/**
 * Persistent OAuth credential store backed by a single JSON file.
 *
 * The file is always written 0600 and is refused on read if its mode
 * permits group or world access — a single rogue `chmod` is the only
 * thing standing between a curious user on the same machine and a
 * working subscription token, so we surface that loudly rather than
 * silently using a credential that should have been protected.
 *
 * Writes go through a tmp-file + rename to keep the on-disk file in
 * one of two valid states: the previous contents or the new contents.
 * A crash mid-write leaves a stray `*.tmp` file but never a half-written
 * `auth.json`.
 */
export class TokenStore {
  constructor(public readonly path: string = defaultAuthPath()) {}

  /**
   * Read and validate auth.json.
   * Returns null if the file does not exist.
   * Throws if the file exists but has unsafe permissions or is malformed.
   */
  async read(): Promise<StoredAuth | null> {
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(this.path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }

    if ((info.mode & 0o077) !== 0) {
      const octal = (info.mode & 0o777).toString(8).padStart(3, '0')
      throw new InvalidStoredAuthError(
        `auth.json at ${this.path} has insecure mode ${octal}; refusing to read. Run: chmod 600 ${this.path}`,
      )
    }

    const raw = await readFile(this.path, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new InvalidStoredAuthError(
        `auth.json at ${this.path} is not valid JSON`,
      )
    }

    if (!isStoredAuth(parsed)) {
      throw new InvalidStoredAuthError(
        `auth.json at ${this.path} is missing or has invalid required fields (type, access, refresh, expires)`,
      )
    }

    return parsed
  }

  /**
   * Atomically write auth.json with mode 0600. Creates the parent
   * directory (mode 0700) if it does not already exist.
   */
  async write(auth: StoredAuth): Promise<void> {
    await this.ensureDir()
    const tmpPath = `${this.path}.${crypto.randomUUID()}.tmp`
    try {
      // `wx` creates the file or fails if it exists. The random suffix in
      // tmpPath makes that condition effectively unreachable in practice,
      // but the flag prevents reusing a stale tmp file in the pathological
      // case of a UUID collision.
      await writeFile(tmpPath, JSON.stringify(auth, null, 2), {
        mode: 0o600,
        flag: 'wx',
      })
      // umask can mask off bits from the `mode` arg to writeFile, so we
      // re-chmod explicitly before exposing the file under its real name.
      await chmod(tmpPath, 0o600)
      await rename(tmpPath, this.path)
    } catch (err) {
      await unlink(tmpPath).catch(() => {})
      throw err
    }
  }

  /** Delete auth.json. No-op if the file does not exist. */
  async remove(): Promise<void> {
    try {
      await unlink(this.path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  /**
   * Stat-only inspection for the `status` subcommand: returns presence,
   * current mode, and mtime without parsing the file or refusing on
   * bad permissions.
   */
  async inspect(): Promise<{
    present: boolean
    mode?: number
    insecureMode?: boolean
    mtime?: Date
  }> {
    try {
      const info = await stat(this.path)
      const mode = info.mode & 0o777
      return {
        present: true,
        mode,
        insecureMode: (info.mode & 0o077) !== 0,
        mtime: info.mtime,
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { present: false }
      }
      throw err
    }
  }

  private async ensureDir(): Promise<void> {
    const dir = dirname(this.path)
    await mkdir(dir, { recursive: true })
    // Tighten the leaf directory we own. Parents (e.g. ~/.config) keep
    // whatever mode the user already has — we don't want to surprise
    // other apps that share that directory.
    await chmod(dir, 0o700).catch(() => {})
  }
}

function isStoredAuth(value: unknown): value is StoredAuth {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.type === 'oauth' &&
    typeof v.access === 'string' &&
    v.access.length > 0 &&
    typeof v.refresh === 'string' &&
    v.refresh.length > 0 &&
    typeof v.expires === 'number' &&
    Number.isFinite(v.expires) &&
    v.expires > 0
  )
}
