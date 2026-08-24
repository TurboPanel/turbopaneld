/**
 * Optional wire fields without one guard per key.
 *
 * The deploy payload and the release manifests are JSON documents where an
 * absent field means "nothing to say" — never `null`. Written literally that is
 * a `...(x === undefined ? {} : { x })` (or an `if` and a mutation) per key,
 * which is most of what made those builders and parsers unreadable.
 *
 * The return type is the input type: the caller states the shape once, and the
 * target's own optional properties absorb whatever was dropped.
 */

/** Drop keys whose value is `undefined`. */
export function definedFields<T extends Record<string, unknown>>(fields: T): T {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as T;
}
