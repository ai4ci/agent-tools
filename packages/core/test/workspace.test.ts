import { describe, expect, it } from 'vitest'

/**
 * Phase 0 smoke test.
 *
 * Asserts that the workspace is wired up: every package builds, is symlinked into
 * node_modules under its published name, and is importable by that name rather
 * than by relative path. A failure here means the workspace layout is broken, not
 * that any tool logic is wrong.
 */
describe('workspace wiring', () => {
  it('resolves every package by its published name', async () => {
    const packages = [
      '@agent-tools/core',
      '@agent-tools/remote-explorer',
      '@agent-tools/test-support',
      '@agent-tools/pi-remote-explorer',
      '@agent-tools/mcp-remote-explorer',
    ]

    for (const name of packages) {
      const module = (await import(name)) as { PACKAGE_NAME?: string }
      expect(module.PACKAGE_NAME, `${name} should export PACKAGE_NAME`).toBe(name)
    }
  })
})
