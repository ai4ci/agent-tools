import type { TUnsafe } from 'typebox'
import { Type } from 'typebox'

/**
 * A string parameter restricted to a fixed set of values.
 *
 * `Type.Union([Type.Literal('a'), Type.Literal('b')])` is the natural TypeBox
 * spelling, but it emits `anyOf` with `const` members, and Google's API rejects
 * both. pi ships a `StringEnum` helper for exactly this reason.
 *
 * This is reimplemented rather than imported from `@earendil-works/pi-ai` so that
 * `remote-explorer` stays host-agnostic: the tool package must not depend on any
 * particular agent host (ADR-002). The helper is six lines, and the plain
 * `{ type: 'string', enum: [...] }` it produces is also the better shape for the
 * MCP adapter's JSON Schema.
 */
export function stringEnum<const Values extends readonly string[]>(
  values: Values,
  options: { description?: string } = {},
): TUnsafe<Values[number]> {
  return Type.Unsafe<Values[number]>({
    type: 'string',
    enum: values,
    ...(options.description === undefined ? {} : { description: options.description }),
  })
}
