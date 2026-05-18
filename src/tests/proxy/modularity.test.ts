import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const PROXY_DIR = join(import.meta.dir, '..', '..', 'proxy')

/**
 * The proxy may only import from these intercept modules. The contract
 * is that the proxy is a thin shell around the upstream transform code —
 * if a proxy file needs something from intercept that isn't in this list,
 * either (a) the intercept module should expose it via one of these
 * existing files, or (b) it doesn't belong in the proxy at all.
 *
 * Reaching outside `../` (e.g. into `../scripts/` or anywhere else) is
 * forbidden entirely.
 */
const ALLOWED_INTERCEPT_IMPORTS = new Set([
  '../auth.ts',
  '../constants.ts',
  '../refresh.ts',
  '../transform.ts',
  // cch.ts is allowed but currently only consumed via transform.ts; listing
  // it keeps the door open without a code change if a proxy/ file ever needs
  // it directly.
  '../cch.ts',
  '../pkce.ts',
])

const IMPORT_RE = /^\s*import\s+[^'"]+from\s+['"]([^'"]+)['"]/gm

describe('proxy/ modularity', () => {
  test('each src/proxy/*.ts file only imports from approved intercept modules', async () => {
    const entries = await readdir(PROXY_DIR)
    const tsFiles = entries.filter((e) => e.endsWith('.ts'))
    expect(tsFiles.length).toBeGreaterThan(0)

    const violations: string[] = []

    for (const filename of tsFiles) {
      const filepath = join(PROXY_DIR, filename)
      const source = await readFile(filepath, 'utf8')

      const imports = Array.from(source.matchAll(IMPORT_RE)).map((m) => m[1]!)

      for (const spec of imports) {
        // Allow node: built-ins, third-party packages (no leading '.'),
        // and same-directory imports starting with './'.
        if (!spec.startsWith('.')) continue
        if (spec.startsWith('./')) continue

        // Anything starting with '../' must be in the allowlist.
        if (!ALLOWED_INTERCEPT_IMPORTS.has(spec)) {
          violations.push(
            `src/proxy/${filename}: imports "${spec}" which is not in the intercept allowlist`,
          )
        }
      }
    }

    expect(violations).toEqual([])
  })

  test('no proxy file imports from src/index.ts (the OpenCode plugin)', async () => {
    const entries = await readdir(PROXY_DIR)
    const tsFiles = entries.filter((e) => e.endsWith('.ts'))

    for (const filename of tsFiles) {
      const filepath = join(PROXY_DIR, filename)
      const source = await readFile(filepath, 'utf8')
      expect(source).not.toContain("from '../index")
      expect(source).not.toContain('from "../index')
    }
  })
})
