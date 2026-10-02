/**
 * Fragments a config parser on the path could read as syntax: line breaks
 * (ASCII, NEL and the Unicode separators), NUL, Caddy/OLS braces, the Traefik
 * rule quote, shell and ini metacharacters, quotes, comment starts, the token
 * separator and the Traefik list separator. Shared by the validator and sink
 * suites so both prove the same set.
 */
export const HOSTILE_CONFIG_FRAGMENTS: readonly string[] = Object.freeze([
  "\n",
  "\r",
  "\0",
  "\t",
  "\u0085",
  " ",
  " ",
  "{",
  "}",
  "`",
  "$",
  ";",
  '"',
  "'",
  "#",
  " ",
  ",",
]);
