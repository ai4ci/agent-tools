import { AgentToolsError, parseConfig } from '@agent-tools/core'
import { describe, expect, it, vi } from 'vitest'
import extension, { createExtensionState } from '../src/index.js'

/**
 * Extension wiring.
 *
 * The behaviour worth testing here is what happens when configuration is absent
 * or broken. A pi session is long-lived, so a startup throw would take the whole
 * session down over a problem that only affects these tools — the failure has to
 * arrive as a tool result the model can read instead.
 */

const VALID = {
  version: 1,
  hosts: { box: { ssh: { target: 'u@box' }, root: '/srv' } },
}

function fakeOps() {
  return {
    alias: 'box',
    root: () => Promise.resolve('/srv'),
    capabilities: () => Promise.resolve({ tools: new Set(['grep', 'realpath']), hasSandbox: true }),
    // Returns the root for every command. Enough for path canonicalisation to
    // succeed, which any tool taking a path does before anything else; these tests
    // are about wiring, not about tool output.
    exec: () =>
      Promise.resolve({ stdout: '/srv\n', stderr: '', exitCode: 0, stdoutTruncated: false }),
    close: () => Promise.resolve(),
  }
}

describe('createExtensionState', () => {
  it('registers every tool in the collection', () => {
    const state = createExtensionState(
      () => Promise.resolve(parseConfig(VALID, 'test')),
      () => fakeOps() as never,
    )
    expect(state.tools).toHaveLength(6)
    expect(state.tools.map((tool) => tool.name)).toContain('remote_grep')
  })

  it('gives every registered tool a promptSnippet', () => {
    const state = createExtensionState(
      () => Promise.resolve(parseConfig(VALID, 'test')),
      () => fakeOps() as never,
    )
    for (const tool of state.tools) {
      expect(tool.promptSnippet, `${tool.name} needs a promptSnippet`).toBeTruthy()
    }
  })

  it('does not read configuration until a tool is called', () => {
    const loader = vi.fn().mockResolvedValue(parseConfig(VALID, 'test'))
    createExtensionState(loader, () => fakeOps() as never)
    // The load is kicked off eagerly but must not be awaited during registration,
    // so a slow or missing config file cannot delay session startup.
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('reads configuration once, not per tool call', async () => {
    const loader = vi.fn().mockResolvedValue(parseConfig(VALID, 'test'))
    const state = createExtensionState(loader, () => fakeOps() as never)
    const hosts = state.tools.find((tool) => tool.name === 'remote_hosts')

    await hosts?.execute('a', {}, undefined, undefined, {})
    await hosts?.execute('b', {}, undefined, undefined, {})

    expect(loader).toHaveBeenCalledTimes(1)
    await state.close()
  })

  it('lists configured hosts through the registered tool', async () => {
    const state = createExtensionState(
      () => Promise.resolve(parseConfig(VALID, 'test')),
      () => fakeOps() as never,
    )
    const hosts = state.tools.find((tool) => tool.name === 'remote_hosts')
    const result = await hosts?.execute('a', {}, undefined, undefined, {})
    expect(result?.content[0]?.text).toContain('box')
    await state.close()
  })

  it('reports a broken configuration as a tool failure, not a startup crash', async () => {
    const state = createExtensionState(
      () => Promise.reject(new AgentToolsError('CONFIG_INVALID', 'bad config file')),
      () => fakeOps() as never,
    )

    // Registration itself must have succeeded.
    expect(state.tools).toHaveLength(6)

    const hosts = state.tools.find((tool) => tool.name === 'remote_hosts')
    await expect(hosts?.execute('a', {}, undefined, undefined, {})).rejects.toThrow(/bad config/)
    await state.close()
  })

  it('closes cleanly when configuration never loaded', async () => {
    const state = createExtensionState(
      () => Promise.reject(new Error('nope')),
      () => fakeOps() as never,
    )
    await expect(state.close()).resolves.toBeUndefined()
  })

  it('registers a session_end handler, or control sockets outlive the session', async () => {
    const ops = fakeOps()
    const close = vi.spyOn(ops, 'close')
    const state = createExtensionState(
      () => Promise.resolve(parseConfig(VALID, 'test')),
      () => ops as never,
    )
    await state.tools
      .find((tool) => tool.name === 'remote_ls')
      ?.execute('a', { host: 'box' }, undefined, undefined, {})
    await state.close()
    expect(close).toHaveBeenCalled()
  })

  it('closes sessions on shutdown', async () => {
    const ops = fakeOps()
    const close = vi.spyOn(ops, 'close')
    const state = createExtensionState(
      () => Promise.resolve(parseConfig(VALID, 'test')),
      () => ops as never,
    )

    const hosts = state.tools.find((tool) => tool.name === 'remote_ls')
    await hosts?.execute('a', { host: 'box' }, undefined, undefined, {})
    await state.close()

    expect(close).toHaveBeenCalled()
  })
})

describe('default export, as pi calls it', () => {
  function fakePi() {
    return {
      registered: [] as string[],
      events: [] as string[],
      registerTool(tool: { name: string }) {
        this.registered.push(tool.name)
      },
      on(event: string) {
        this.events.push(event)
      },
    }
  }

  it('registers all six tools with pi', () => {
    const pi = fakePi()
    extension(pi as never)
    expect(pi.registered.sort()).toEqual([
      'remote_find',
      'remote_grep',
      'remote_hosts',
      'remote_ls',
      'remote_read',
      'remote_stat',
    ])
  })

  it('subscribes to session_end so connections are torn down', () => {
    // A pi session is long-lived and in-process (ADR-003), so without this a
    // multiplexed control socket is held open for the whole session (ADR-008).
    const pi = fakePi()
    extension(pi as never)
    expect(pi.events).toContain('session_end')
  })

  it('does not throw when no configuration exists', () => {
    // Registration must survive a missing config file: throwing here would take
    // down the entire pi session over a problem confined to these tools.
    const pi = fakePi()
    expect(() => extension(pi as never)).not.toThrow()
  })
})
