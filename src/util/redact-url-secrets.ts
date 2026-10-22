/**
 * Strip query strings, fragments and user info from every http(s) URL in
 * `text`. A failed update fetch can quote the full signed release-asset URL
 * (`X-Amz-Signature`, `token`, ...); those are bearer credentials, so errors
 * and logs keep the host and path and drop the rest. Twin of the control
 * plane's `redactUrlSecrets` (src/features/upgrades/redact-url-secrets.ts),
 * which also scrubs bare tokens; here the deny-set covers known secret values.
 *
 * The optional tail swallows the `]` of a `?[redacted]` marker, so text that is
 * redacted twice (daemon, then control plane) comes out the same.
 */
const URL_WITH_SECRETS =
  /\bhttps?:\/\/[^\s"'<>`)\]]+(?:(?<=\?\[redacted)\])?/gi;

/**
 * Where the host starts inside `rest` (the URL after `//`): just past the last
 * `@` of the authority, which ends at the first `/`. A `?` or `#` before that
 * `@` belongs to a password (`user:pa?ss@host`) when a `:` comes before it; with
 * no `:` it is a query that holds an address (`host?mail=a@b`), so only an `@`
 * before the `?` or `#` (`token@host?mail=a@b`) ends the user info.
 * When in doubt the part is treated as user info: a lost host is better than a
 * leaked password.
 */
function hostStart(rest: string): number {
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const at = authority.lastIndexOf("@");
  if (at === -1) return 0;
  const before = authority.slice(0, at);
  const cut = before.search(/[?#]/);
  if (cut === -1) return at + 1;
  const head = before.slice(0, cut);
  if (head.includes(":")) return at + 1;
  return head.lastIndexOf("@") + 1;
}

function redactOne(match: string): string {
  const schemeEnd = match.indexOf("//") + 2;
  const scheme = match.slice(0, schemeEnd);
  const rest = match.slice(schemeEnd);
  const target = rest.slice(hostStart(rest));
  const cut = target.search(/[?#]/);
  return cut === -1
    ? `${scheme}${target}`
    : `${scheme}${target.slice(0, cut)}?[redacted]`;
}

export function redactUrlSecrets(text: string): string {
  return text.replaceAll(URL_WITH_SECRETS, redactOne);
}
