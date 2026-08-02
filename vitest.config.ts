import { defineConfig } from 'vitest/config'

/**
 * Test tiers (ADR-011). Tiers are selected by file suffix so that a slow tier can
 * be excluded without hunting for individual files:
 *
 *   *.test.ts          tier 1/2 — TestRemoteOps and the escaper round-trip. No SSH,
 *                      no bwrap. Always run.
 *   *.sandbox.test.ts  tier 3 — requires a working bwrap on this machine.
 *   *.ssh.test.ts      tier 4 — requires sshd on localhost with passwordless auth.
 *
 * Tiers 3 and 4 are opt-in via AGENT_TOOLS_TEST_TIERS so that a developer without
 * the prerequisites gets a green run rather than a misleading failure.
 */
const tiers = (process.env.AGENT_TOOLS_TEST_TIERS ?? '1,2,3').split(',')

const exclude = ['**/node_modules/**', '**/dist/**']
if (!tiers.includes('3')) exclude.push('**/*.sandbox.test.ts')
if (!tiers.includes('4')) exclude.push('**/*.ssh.test.ts')

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'adapters/*/test/**/*.test.ts'],
    exclude,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
