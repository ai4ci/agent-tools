import { remoteExplorerTools } from '@agent-tools/remote-explorer'
import { describe, expect, it } from 'vitest'

/**
 * Schema shape invariants.
 *
 * Both adapters consume these schemas — pi takes TypeBox directly, MCP takes the
 * emitted JSON Schema (ADR-002) — so a schema construct that one provider rejects
 * breaks the tool everywhere, not just in one host. These invariants are cheaper
 * to assert here than to discover through a provider error at run time.
 */

/** Walk every nested schema node. */
function nodes(schema: unknown): unknown[] {
  if (schema === null || typeof schema !== 'object') return []
  const found: unknown[] = [schema]
  for (const value of Object.values(schema as Record<string, unknown>)) {
    if (Array.isArray(value)) for (const entry of value) found.push(...nodes(entry))
    else found.push(...nodes(value))
  }
  return found
}

describe('every tool', () => {
  it('is registered exactly once', () => {
    const names = remoteExplorerTools.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('has all six remote tools plus the host listing', () => {
    expect(remoteExplorerTools.map((tool) => tool.name).sort()).toEqual([
      'remote_find',
      'remote_grep',
      'remote_hosts',
      'remote_ls',
      'remote_read',
      'remote_stat',
    ])
  })

  for (const tool of remoteExplorerTools) {
    describe(tool.name, () => {
      it('uses the remote_ prefix so it is recognisable among built-in tools', () => {
        expect(tool.name.startsWith('remote_')).toBe(true)
      })

      it('has a description that does not assume a namespace prefix', () => {
        // In Claude Code the tool is exposed as mcp__remote-explorer__remote_ls,
        // in pi as remote_ls (ADR-003), so a description must not claim either.
        expect(tool.description.length).toBeGreaterThan(40)
        expect(tool.description).not.toContain('mcp__')
      })

      it('has a one-line summary for hosts that show one', () => {
        expect(tool.summary.length).toBeGreaterThan(0)
        expect(tool.summary).not.toContain('\n')
      })

      it('declares an object schema', () => {
        expect(tool.parameters.type).toBe('object')
      })

      it('avoids anyOf, oneOf and const, which Google rejects', () => {
        // pi's docs are explicit: Type.Union/Type.Literal do not work with
        // Google's API, so string choices must be expressed as an enum.
        for (const node of nodes(tool.parameters)) {
          if (node !== null && typeof node === 'object') {
            const keys = Object.keys(node as Record<string, unknown>)
            expect(keys, `${tool.name} schema contains a rejected construct`).not.toContain('anyOf')
            expect(keys).not.toContain('oneOf')
            expect(keys).not.toContain('const')
          }
        }
      })

      it('describes every parameter, since the description is the model’s only guide', () => {
        const properties = (tool.parameters.properties ?? {}) as Record<
          string,
          { description?: string }
        >
        for (const [name, schema] of Object.entries(properties)) {
          expect(schema.description, `${tool.name}.${name} needs a description`).toBeTruthy()
        }
      })

      it('requires a host unless it is the host listing itself', () => {
        if (tool.name === 'remote_hosts') return
        expect(tool.parameters.required).toContain('host')
      })
    })
  }
})

describe('enum parameters', () => {
  it('expresses remote_find type as a string enum', () => {
    const find = remoteExplorerTools.find((tool) => tool.name === 'remote_find')
    const properties = find?.parameters.properties as
      | Record<string, { type?: string; enum?: string[] }>
      | undefined
    const type = properties?.type
    expect(type?.type).toBe('string')
    expect(type?.enum).toEqual(['file', 'directory', 'symlink'])
  })
})
