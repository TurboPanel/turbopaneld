/**
 * Parse a SQL boolean cell from client stdout.
 *
 * The same system variable may print as `0`/`1` or `ON`/`OFF` depending on
 * client version, so callers must not compare the raw cell to a single
 * spelling.
 */
export function parseSqlBool(raw: string): boolean | undefined {
  const token = raw.trim().toLowerCase();
  if (token === "1" || token === "on" || token === "true" || token === "yes") {
    return true;
  }
  if (token === "0" || token === "off" || token === "false" || token === "no") {
    return false;
  }
  return undefined;
}
