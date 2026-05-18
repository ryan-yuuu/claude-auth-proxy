import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultAuthPath,
  InvalidStoredAuthError,
  type StoredAuth,
  TokenStore,
} from '../../proxy/token-store'

const VALID_AUTH: StoredAuth = {
  type: 'oauth',
  access: 'access-abc',
  refresh: 'refresh-xyz',
  expires: 1_900_000_000_000,
}

let tmpRoot: string
let store: TokenStore

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'token-store-'))
  store = new TokenStore(join(tmpRoot, 'subdir', 'auth.json'))
})

describe('TokenStore.read', () => {
  test('returns null when file is missing', async () => {
    expect(await store.read()).toBeNull()
  })

  test('round-trips through write/read', async () => {
    await store.write(VALID_AUTH)
    expect(await store.read()).toEqual(VALID_AUTH)
  })

  test('refuses to read a file with insecure mode 0644', async () => {
    await store.write(VALID_AUTH)
    await chmod(store.path, 0o644)
    expect(store.read()).rejects.toThrow(/insecure mode 644/)
  })

  test('refuses to read a file with insecure mode 0660', async () => {
    await store.write(VALID_AUTH)
    await chmod(store.path, 0o660)
    expect(store.read()).rejects.toThrow(/insecure mode 660/)
  })

  test('throws on malformed JSON', async () => {
    await store.write(VALID_AUTH)
    await writeFile(store.path, 'not json{', { mode: 0o600 })
    await chmod(store.path, 0o600)
    expect(store.read()).rejects.toThrow(/not valid JSON/)
  })

  test('throws on missing required fields', async () => {
    await store.write(VALID_AUTH)
    await writeFile(store.path, JSON.stringify({ access: 'a' }), {
      mode: 0o600,
    })
    await chmod(store.path, 0o600)
    expect(store.read()).rejects.toThrow(
      /missing or has invalid required fields/,
    )
  })

  test('throws on wrong type discriminant', async () => {
    await store.write(VALID_AUTH)
    await writeFile(
      store.path,
      JSON.stringify({ ...VALID_AUTH, type: 'api' }),
      { mode: 0o600 },
    )
    await chmod(store.path, 0o600)
    expect(store.read()).rejects.toThrow(
      /missing or has invalid required fields/,
    )
  })

  test('rejects empty access string', async () => {
    await store.write(VALID_AUTH)
    await writeFile(store.path, JSON.stringify({ ...VALID_AUTH, access: '' }), {
      mode: 0o600,
    })
    await chmod(store.path, 0o600)
    expect(store.read()).rejects.toBeInstanceOf(InvalidStoredAuthError)
  })

  test('rejects empty refresh string', async () => {
    await store.write(VALID_AUTH)
    await writeFile(
      store.path,
      JSON.stringify({ ...VALID_AUTH, refresh: '' }),
      {
        mode: 0o600,
      },
    )
    await chmod(store.path, 0o600)
    expect(store.read()).rejects.toBeInstanceOf(InvalidStoredAuthError)
  })

  test('rejects non-finite expires', async () => {
    await store.write(VALID_AUTH)
    await writeFile(
      store.path,
      // JSON.stringify converts NaN/Infinity to null, so embed as a raw literal
      `{"type":"oauth","access":"a","refresh":"r","expires":null}`,
      { mode: 0o600 },
    )
    await chmod(store.path, 0o600)
    expect(store.read()).rejects.toBeInstanceOf(InvalidStoredAuthError)
  })

  test('rejects negative expires', async () => {
    await store.write(VALID_AUTH)
    await writeFile(
      store.path,
      JSON.stringify({ ...VALID_AUTH, expires: -1 }),
      { mode: 0o600 },
    )
    await chmod(store.path, 0o600)
    expect(store.read()).rejects.toBeInstanceOf(InvalidStoredAuthError)
  })

  test('uses InvalidStoredAuthError for the insecure-mode case too', async () => {
    await store.write(VALID_AUTH)
    await chmod(store.path, 0o644)
    expect(store.read()).rejects.toBeInstanceOf(InvalidStoredAuthError)
  })
})

describe('TokenStore.write', () => {
  test('creates parent directory if missing', async () => {
    await store.write(VALID_AUTH)
    const dirStat = await stat(join(tmpRoot, 'subdir'))
    expect(dirStat.isDirectory()).toBe(true)
  })

  test('sets file mode 0600', async () => {
    await store.write(VALID_AUTH)
    const info = await stat(store.path)
    expect(info.mode & 0o777).toBe(0o600)
  })

  test('persists JSON the same way after a second write', async () => {
    await store.write(VALID_AUTH)
    const updated = { ...VALID_AUTH, access: 'updated-access' }
    await store.write(updated)
    expect(await store.read()).toEqual(updated)
    const info = await stat(store.path)
    expect(info.mode & 0o777).toBe(0o600)
  })

  test('does not leave a .tmp file behind on success', async () => {
    await store.write(VALID_AUTH)
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(join(tmpRoot, 'subdir'))
    expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0)
  })

  test('writes are formatted as pretty JSON for human inspection', async () => {
    await store.write(VALID_AUTH)
    const raw = await readFile(store.path, 'utf8')
    expect(raw).toContain('\n')
    expect(raw).toContain('"access": "access-abc"')
  })
})

describe('TokenStore.remove', () => {
  test('deletes an existing file', async () => {
    await store.write(VALID_AUTH)
    await store.remove()
    expect(await store.read()).toBeNull()
  })

  test('is idempotent when file is missing', async () => {
    await store.remove()
    await store.remove()
  })
})

describe('TokenStore.inspect', () => {
  test('reports present + secure mode', async () => {
    await store.write(VALID_AUTH)
    const info = await store.inspect()
    expect(info.present).toBe(true)
    expect(info.mode).toBe(0o600)
    expect(info.insecureMode).toBe(false)
    expect(info.mtime).toBeInstanceOf(Date)
  })

  test('reports insecure mode without throwing', async () => {
    await store.write(VALID_AUTH)
    await chmod(store.path, 0o644)
    const info = await store.inspect()
    expect(info.present).toBe(true)
    expect(info.insecureMode).toBe(true)
    expect(info.mode).toBe(0o644)
  })

  test('reports missing when file does not exist', async () => {
    const info = await store.inspect()
    expect(info.present).toBe(false)
    expect(info.mode).toBeUndefined()
  })
})

describe('defaultAuthPath', () => {
  const original = process.env.XDG_CONFIG_HOME

  afterEach(() => {
    if (original === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = original
    }
  })

  test('honors XDG_CONFIG_HOME when set', () => {
    process.env.XDG_CONFIG_HOME = '/custom/xdg'
    expect(defaultAuthPath()).toBe('/custom/xdg/anthropic-auth-proxy/auth.json')
  })

  test('falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    delete process.env.XDG_CONFIG_HOME
    expect(defaultAuthPath()).toContain(
      '/.config/anthropic-auth-proxy/auth.json',
    )
  })

  test('ignores empty XDG_CONFIG_HOME', () => {
    process.env.XDG_CONFIG_HOME = '   '
    expect(defaultAuthPath()).toContain(
      '/.config/anthropic-auth-proxy/auth.json',
    )
  })
})
