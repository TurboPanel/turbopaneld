/**
 * A hostname in the one form names are compared in: lowercase, and an
 * internationalized name as its punycode (`xn--`) spelling, which is what Caddy
 * and DNS use. A wildcard keeps its `*.` and folds the rest. A name that cannot
 * be folded is only lowercased, so it can still be refused later by whatever
 * validates it.
 */
export function foldHostname(name: string): string {
  const lowered = name.trim().toLowerCase();
  if ([...lowered].every((ch) => ch.charCodeAt(0) < 128)) return lowered;
  const wildcard = lowered.startsWith("*.");
  const host = wildcard ? lowered.slice(2) : lowered;
  try {
    const ascii = new URL(`http://${host}`).hostname;
    return wildcard ? `*.${ascii}` : ascii;
  } catch {
    return lowered;
  }
}
