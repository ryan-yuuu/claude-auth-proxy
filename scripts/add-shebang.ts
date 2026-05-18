import { chmod, readFile, writeFile } from 'node:fs/promises'

const TARGETS = ['dist/proxy/main.js']
const SHEBANG = '#!/usr/bin/env bun\n'

for (const target of TARGETS) {
  const contents = await readFile(target, 'utf8')
  if (!contents.startsWith('#!')) {
    await writeFile(target, `${SHEBANG}${contents}`)
  }
  await chmod(target, 0o755)
}
