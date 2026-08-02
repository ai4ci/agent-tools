/**
 * Dependency boundary check.
 *
 * npm's hoisted node_modules does not enforce dependency boundaries (ADR-001
 * amendment), so a shipped package importing @agent-tools/test-support would
 * resolve happily and ship an unsandboxed local command executor into a release
 * (ADR-011). This check is the thing standing in the way of that, so it runs in
 * `npm run verify` and in CI.
 *
 * Rules:
 *   1. No shipped package may list test-support as a runtime `dependencies` entry.
 *   2. No shipped package's `src/` may import test-support at all.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const TEST_SUPPORT = '@agent-tools/test-support'
const WORKSPACE_DIRS = ['packages', 'adapters']

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

/** @type {string[]} */
const violations = []

for (const wsDir of WORKSPACE_DIRS) {
  let pkgDirs
  try {
    pkgDirs = readdirSync(join(root, wsDir))
  } catch {
    continue
  }

  for (const pkgDir of pkgDirs) {
    const pkgPath = join(root, wsDir, pkgDir)
    const manifestPath = join(pkgPath, 'package.json')

    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    if (manifest.name === TEST_SUPPORT) continue

    if (manifest.dependencies?.[TEST_SUPPORT]) {
      violations.push(
        `${manifest.name}: lists ${TEST_SUPPORT} in "dependencies" (must be devDependencies at most)`,
      )
    }

    for (const file of walk(join(pkgPath, 'src'))) {
      const source = readFileSync(file, 'utf8')
      if (source.includes(TEST_SUPPORT)) {
        violations.push(`${relative(root, file)}: imports ${TEST_SUPPORT} from shipped source`)
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Dependency boundary violations (ADR-011):\n')
  for (const violation of violations) console.error(`  - ${violation}`)
  console.error('')
  process.exit(1)
}

console.log('Dependency boundaries OK')
