/**
 * Strip query strings, fragments and user info from every http(s) URL in
 * `text`. A failed update fetch can quote the full signed release-asset URL
 * (`X-Amz-Signature`, `token`, ...); those are bearer credentials, so errors
 * and logs keep the host and path and drop the rest. Twin of the control
 * plane's `redactUrlSecrets` (src/features/upgrades/redact-url-secrets.ts).
 */
const URL_WITH_SECRETS = /\bhttps?:\/\/[^\s"'<>`)\]]+/gi;

function redactOne(match: string): string {
  const cut = match.search(/[?#]/);
  const base = cut === -1 ? match : match.slice(0, cut);
  const stripped = base.replace(/^(https?:\/\/)[^/@]*@/i, "$1");
  return cut === -1 ? stripped : `${stripped}?[redacted]`;
}

export function redactUrlSecrets(text: string): string {
  return text.replaceAll(URL_WITH_SECRETS, redactOne);
}
