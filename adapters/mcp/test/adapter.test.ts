import { AgentToolsError } from '@agent-tools/core'
import {
  remoteExplorerTools,
  type ToolContext,
  type ToolDefinition,
} from '@agent-tools/remote-explorer'
import { describe, expect, it, vi } from 'vitest'
import { callTool, listTools, toJsonSchema } from '../src/adapter.js'

/**
 * MCP adapter mapping (ADR-002, ADR-003).
 *
 * The contrast with the pi adapter is the point worth pinning down. pi flags an
 * error only when `execute` throws; MCP carries `isError` on the result itself.
 * So the same `ToolResult` must be mapped two different ways, and each adapter's
 * way is wrong for the other host.
 */

const emptyContext: ToolContext = {
  hosts: () => [],
  session: () => Promise.reject(new Error('not used')),
  close: () => Promise.resolve(),
}

function fakeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'remote_fake',
    label: 'Fake',
    summary: 'A fake tool',
    description: 'A fake tool used to test the adapter mapping.',
    parameters: { type: 'object', properties: {} } as never,
    handler: vi.fn().mockResolvedValue({ text: 'ok', details: { a: 1 } }),
    ...overrides,
  } as ToolDefinition
}

describe('toJsonSchema', () => {
  it('produces plain JSON Schema from a TypeBox schema', () => {
    const find = remoteExplorerTools.find((tool) => tool.name === 'remote_find')
    const schema = toJsonSchema(find?.parameters as never)
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['host'])
  })

  it('preserves enum parameters', () => {
    const find = remoteExplorerTools.find((tool) => tool.name === 'remote_find')
    const schema = toJsonSchema(find?.parameters as never)
    const properties = schema.properties as Record<string, { enum?: string[] }>
    expect(properties.type?.enum).toEqual(['file', 'directory', 'symlink'])
  })

  it('strips TypeBox internal keys', () => {
    // TypeBox marks schemas with a `~kind` property. It is non-enumerable, so it
    // does not survive serialisation — but relying on that silently would break
    // if TypeBox ever made it enumerable, so the conversion is explicit.
    const find = remoteExplorerTools.find((tool) => tool.name === 'remote_find')
    const serialised = JSON.stringify(toJsonSchema(find?.parameters as never))
    expect(serialised).not.toContain('~kind')
    expect(serialised).not.toContain('Symbol(')
  })

  it('returns a structure that survives a JSON round trip unchanged', () => {
    // MCP sends this over stdio as JSON, so anything that does not round trip is
    // silently lost in transit.
    const schema = toJsonSchema(
      remoteExplorerTools.find((tool) => tool.name === 'remote_grep')?.parameters as never,
    )
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema)
  })
})

describe('listTools', () => {
  it('lists every tool with name, description and input schema', () => {
    const tools = listTools(remoteExplorerTools)
    expect(tools).toHaveLength(6)
    for (const tool of tools) {
      expect(tool.name).toMatch(/^remote_/)
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('uses the bare tool name; namespacing is the host’s job', () => {
    // Claude Code presents these as mcp__<server>__<name>. The server must not
    // pre-namespace them or the prefix would appear twice.
    const tools = listTools(remoteExplorerTools)
    expect(tools.map((tool) => tool.name)).toContain('remote_ls')
    expect(tools.every((tool) => !tool.name.includes('mcp__'))).toBe(true)
  })
})

describe('callTool', () => {
  it('returns text content on success', async () => {
    const result = await callTool([fakeTool()], 'remote_fake', {}, () => emptyContext)
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(result.isError).toBeFalsy()
  })

  it('carries isError on the result rather than throwing', async () => {
    // The inverse of the pi adapter: MCP expects the flag on the result, and
    // throwing would surface as a protocol error instead of a tool failure the
    // model can read.
    const handler = vi.fn().mockResolvedValue({ text: 'it went wrong', isError: true })
    const result = await callTool([fakeTool({ handler })], 'remote_fake', {}, () => emptyContext)
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe('it went wrong')
  })

  it('reports an unknown tool name as an error result', async () => {
    const result = await callTool([fakeTool()], 'remote_nonexistent', {}, () => emptyContext)
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('remote_nonexistent')
  })

  it('converts a thrown handler error into an error result', async () => {
    const handler = vi.fn().mockRejectedValue(new AgentToolsError('TIMEOUT', 'took too long'))
    const result = await callTool([fakeTool({ handler })], 'remote_fake', {}, () => emptyContext)
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('took too long')
  })

  it('does not leak a stack trace into the result', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'))
    const result = await callTool([fakeTool({ handler })], 'remote_fake', {}, () => emptyContext)
    expect(result.content[0]?.text).not.toContain('at ')
  })

  it('passes arguments through to the handler', async () => {
    const handler = vi.fn().mockResolvedValue({ text: 'ok' })
    await callTool(
      [fakeTool({ handler })],
      'remote_fake',
      { host: 'box', path: 'src' },
      () => emptyContext,
    )
    expect(handler).toHaveBeenCalledWith({ host: 'box', path: 'src' }, emptyContext)
  })

  it('treats missing arguments as an empty object', async () => {
    const handler = vi.fn().mockResolvedValue({ text: 'ok' })
    await callTool([fakeTool({ handler })], 'remote_fake', undefined, () => emptyContext)
    expect(handler).toHaveBeenCalledWith({}, emptyContext)
  })
})

describe('schema parity between adapters (ADR-002)', () => {
  it('exposes the same tool names as the definitions', () => {
    expect(
      listTools(remoteExplorerTools)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(remoteExplorerTools.map((tool) => tool.name).sort())
  })

  it('exposes the same descriptions as the definitions', () => {
    for (const tool of listTools(remoteExplorerTools)) {
      const definition = remoteExplorerTools.find((entry) => entry.name === tool.name)
      expect(tool.description).toBe(definition?.description)
    }
  })

  it('exposes the same parameters the pi adapter would', () => {
    // Both adapters read `definition.parameters`; this asserts the MCP conversion
    // is lossless rather than a second, drifting copy.
    for (const tool of listTools(remoteExplorerTools)) {
      const definition = remoteExplorerTools.find((entry) => entry.name === tool.name)
      expect(tool.inputSchema).toEqual(JSON.parse(JSON.stringify(definition?.parameters)))
    }
  })
})
