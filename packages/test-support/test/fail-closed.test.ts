import { createLocalSandboxRemoteOps } from '@agent-tools/test-support'
import { describe, expect, it } from 'vitest'

/**
 * The fail-closed path (ADR-006, ENV-005).
 *
 * This is the case that makes fail-closed non-trivial: `bwrap` is installed and
 * on PATH, but the kernel refuses the namespace. A `command -v bwrap` check would
 * report a sandbox that does not exist, and every containment guarantee would be
 * silently void.
 *
 * It cannot be reproduced on a machine where namespaces work, so this runs only
 * where the environment declares that they are denied — a CI job that leaves
 * `kernel.apparmor_restrict_unprivileged_userns` enabled. Elsewhere it skips
 * rather than passing vacuously.
 */

const expectDenied = process.env.AGENT_TOOLS_EXPECT_NO_SANDBOX === '1'

describe.skipIf(!expectDenied)('a host whose namespaces are denied', () => {
  it('is refused rather than silently running unsandboxed', async () => {
    await expect(createLocalSandboxRemoteOps()).rejects.toThrow(
      expect.objectContaining({ code: 'SANDBOX_UNAVAILABLE' }),
    )
  })

  it('explains what is missing and how to fix it', async () => {
    await expect(createLocalSandboxRemoteOps()).rejects.toThrow(/bubblewrap|namespace/i)
  })

  it('offers no unsandboxed fallback', async () => {
    // ADR-006 has no degraded mode. If this ever resolves, something has grown a
    // fallback path that was explicitly decided against.
    await expect(createLocalSandboxRemoteOps()).rejects.toThrow()
  })
})
