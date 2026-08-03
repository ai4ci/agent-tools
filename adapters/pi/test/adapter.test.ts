import type { ToolContext, ToolDefinition } from '@agent-tools/remote-explorer'
import { describe, expect, it, vi } from 'vitest'
import { toPiTool } from '../src/adapter.js'

/**
 * pi adapter mapping (ADR-003).
 *
 * The adapter must be thin — no behaviour of its own — but the mapping itself has
 * two rules that are easy to get wrong and impossible to notice without a test:
 *
 *  1. pi sets `isError` on a tool result only when `execute` *throws*. Returning
 *     an object with an error flag is silently treated as success, so our
 *     `ToolResult.isError` has to become a thrown error.
 *  2. `promptSnippet` is what puts a tool in the system prompt's "Available tools"
 *     list; a tool without one is registered but never advertised.
 */

const emptyContext: ToolContext = {
  hosts: () => [],
  session: () => Promise.reject(new Error('not used')),
  close: () => Promise.resolve(),
}

function fakeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  const definition = {
    name: 'remote_fake',
    label: 'Fake',
    summary: 'A fake tool',
    description: 'A fake tool used to test the adapter mapping.',
    parameters: { type: 'object', properties: {} } as never,
    handler: vi.fn().mockResolvedValue({ text: 'ok', details: { a: 1 } }),
    ...overrides,
  }
  return definition as ToolDefinition
}

describe('toPiTool', () => {
  it('carries the name, label and description across unchanged', () => {
    const tool = toPiTool(fakeTool(), () => emptyContext)
    expect(tool.name).toBe('remote_fake')
    expect(tool.label).toBe('Fake')
    expect(tool.description).toContain('fake tool')
  })

  it('supplies promptSnippet so the tool is advertised in the system prompt', () => {
    const tool = toPiTool(fakeTool(), () => emptyContext)
    expect(tool.promptSnippet).toBe('A fake tool')
  })

  it('passes the parameter schema through as TypeBox', () => {
    const parameters = { type: 'object', properties: { x: { type: 'string' } } } as never
    const tool = toPiTool(fakeTool({ parameters }), () => emptyContext)
    expect(tool.parameters).toBe(parameters)
  })

  it('returns text content on success', async () => {
    const tool = toPiTool(fakeTool(), () => emptyContext)
    const result = await tool.execute('call-1', {}, undefined, undefined, {})
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('passes details through for rendering', async () => {
    const tool = toPiTool(fakeTool(), () => emptyContext)
    const result = await tool.execute('call-1', {}, undefined, undefined, {})
    expect(result.details).toEqual({ a: 1 })
  })

  it('always supplies a details object, since pi expects one', async () => {
    const handler = vi.fn().mockResolvedValue({ text: 'no details' })
    const tool = toPiTool(fakeTool({ handler }), () => emptyContext)
    const result = await tool.execute('call-1', {}, undefined, undefined, {})
    expect(result.details).toEqual({})
  })

  it('throws when the tool reports an error, because pi only flags thrown errors', async () => {
    const handler = vi.fn().mockResolvedValue({ text: 'it went wrong', isError: true })
    const tool = toPiTool(fakeTool({ handler }), () => emptyContext)
    await expect(tool.execute('call-1', {}, undefined, undefined, {})).rejects.toThrow(
      'it went wrong',
    )
  })

  it('does not throw for an ordinary result that merely found nothing', async () => {
    const handler = vi.fn().mockResolvedValue({ text: 'No matches.' })
    const tool = toPiTool(fakeTool({ handler }), () => emptyContext)
    await expect(tool.execute('call-1', {}, undefined, undefined, {})).resolves.toBeDefined()
  })

  it('hands the parameters to the handler unchanged', async () => {
    const handler = vi.fn().mockResolvedValue({ text: 'ok' })
    const tool = toPiTool(fakeTool({ handler }), () => emptyContext)
    await tool.execute('call-1', { host: 'box', path: 'src' }, undefined, undefined, {})
    expect(handler).toHaveBeenCalledWith({ host: 'box', path: 'src' }, emptyContext)
  })

  it('resolves the context lazily, so no connection is made at registration', () => {
    const provider = vi.fn().mockReturnValue(emptyContext)
    toPiTool(fakeTool(), provider)
    expect(provider).not.toHaveBeenCalled()
  })

  it('reports cancellation rather than running the handler', async () => {
    const handler = vi.fn().mockResolvedValue({ text: 'ok' })
    const tool = toPiTool(fakeTool({ handler }), () => emptyContext)
    const controller = new AbortController()
    controller.abort()

    const result = await tool.execute('call-1', {}, controller.signal, undefined, {})
    expect(handler).not.toHaveBeenCalled()
    expect(result.content[0]?.text).toMatch(/cancel/i)
  })

  it('surfaces a thrown handler error as a thrown error', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'))
    const tool = toPiTool(fakeTool({ handler }), () => emptyContext)
    await expect(tool.execute('call-1', {}, undefined, undefined, {})).rejects.toThrow('boom')
  })
})
