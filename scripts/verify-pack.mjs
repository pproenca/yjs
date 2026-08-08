import { execFileSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
)

const typeTargets = new Set()

const collectTypeTargets = value => {
  if (value === null || typeof value !== 'object') return

  for (const [key, child] of Object.entries(value)) {
    if (key === 'types' && typeof child === 'string') {
      typeTargets.add(child.replace(/^\.\//, ''))
    } else {
      collectTypeTargets(child)
    }
  }
}

collectTypeTargets(packageJson.exports)

if (typeTargets.size === 0) {
  throw new Error('package exports declare no type targets')
}

for (const target of typeTargets) {
  await access(new URL(`../${target}`, import.meta.url))
}

const packed = JSON.parse(
  execFileSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8' }
  )
)

if (!Array.isArray(packed) || packed.length !== 1) {
  throw new Error('npm pack returned an unexpected result')
}

const packedFiles = new Set(packed[0].files.map(file => file.path))
const missing = [...typeTargets].filter(target => !packedFiles.has(target))

if (missing.length > 0) {
  throw new Error(`tarball is missing exported types: ${missing.join(', ')}`)
}

console.log(`verified ${typeTargets.size} exported type targets in tarball`)
