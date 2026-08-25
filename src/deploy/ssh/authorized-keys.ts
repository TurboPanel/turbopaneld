/**
 * Pure renderers for the panel-managed `authorized_keys` files.
 *
 * Nothing here touches the host — `./apply.ts` owns every write, the same split
 * `native/unit.ts` uses, and for the same reason: the bytes that decide who can
 * log in should be assertable without a host.
 *
 * **Why the files are root-owned and live outside the home.** The obvious
 * location is `~/.ssh/authorized_keys`, and it is wrong here: that file is
 * principal-*writable*, so a tenant could add keys the panel cannot see and
 * panel-side revocation would stop meaning anything. Under
 * `/etc/ssh/turbopanel/authorized_keys/<username>`, root owns the file and the
 * panel is authoritative.
 *
 * The trade-off is real and belongs in the product copy too: a tenant cannot
 * add their own key over SSH, they add it in the panel. If self-service is
 * wanted later it is a panel feature, not a file permission.
 */

import { isCanonicalSshPublicKey } from "./key-types.ts";

/**
 * Root of the panel-managed key files. `root:root 0755`.
 *
 * Every helper takes it as a defaulted argument rather than reading this
 * constant directly, so host-free tests can write into a temp tree without an
 * env override that would also exist in production — the same discipline
 * `native/unit.ts` uses for `SYSTEMD_UNIT_DIR`.
 */
export const AUTHORIZED_KEYS_DIR = "/etc/ssh/turbopanel/authorized_keys";

/** Cap per file, so one account cannot make `sshd` read an unbounded list. */
export const MAX_KEYS_PER_PRINCIPAL = 64;

/**
 * `/etc/ssh/turbopanel/authorized_keys/<username>`.
 *
 * `%u` in `AuthorizedKeysFile` expands to the login name, and usernames are
 * already constrained to `^[A-Za-z_][A-Za-z0-9_-]*$` with the `tp` prefix
 * reserved — no separator, no dot, no traversal — which is what makes it safe
 * as a path segment. The caller is expected to have asserted that; this helper
 * refuses anything else rather than trusting it twice.
 */
export function authorizedKeysPath(
  username: string,
  dir: string = AUTHORIZED_KEYS_DIR,
): string {
  assertSafeKeyFileUsername(username);
  return `${dir}/${username}`;
}

/**
 * The `%u` safety rule, in one place.
 *
 * Exported because the removal sweep needs the same predicate: it decides what
 * in the managed directory is a key file it may delete, and "anything whose
 * name could be a username" has to mean exactly what it means here.
 */
export function isKeyFileUsername(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(value);
}

function assertSafeKeyFileUsername(username: string): void {
  if (!isKeyFileUsername(username)) {
    throw new Error(`Invalid principal username for key file: ${username}`);
  }
}

export class AuthorizedKeyRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizedKeyRejected";
  }
}

/**
 * Render one account's key file.
 *
 * Throws rather than skipping a bad line. A silently dropped key is an account
 * that half-works — the operator sees the key listed in the panel and cannot
 * log in with it — and a silently *kept* one is worse. Neither is a state to
 * deliver quietly, so a malformed set fails the whole reconcile and the
 * previous file stays in place.
 *
 * An empty set renders a header and no keys. Writing an empty file rather than
 * deleting it keeps "TurboPanel manages this account and the answer is none"
 * distinguishable from "TurboPanel has never touched this account", which is
 * the difference between a revocation that worked and one that never ran.
 */
export function authorizedKeysContent(
  keys: readonly string[],
): string {
  if (keys.length > MAX_KEYS_PER_PRINCIPAL) {
    throw new AuthorizedKeyRejected(
      `too many keys (${keys.length} > ${MAX_KEYS_PER_PRINCIPAL})`,
    );
  }
  const seen = new Set<string>();
  const lines: string[] = [
    "# Managed by TurboPanel. Edits are overwritten on the next reconcile.",
    "# Keys are added and removed in the panel, not here.",
  ];
  for (const key of keys) {
    if (!isCanonicalSshPublicKey(key)) {
      // Deliberately does not echo the value: this runs on a rejected
      // credential and the message reaches a deploy transcript.
      throw new AuthorizedKeyRejected(
        `refusing to write a public key that is not in canonical \`<type> <base64>\` form (${key.length} chars)`,
      );
    }
    // Two identical lines are harmless to `sshd` but make the file lie about
    // how many keys the account has.
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(key);
  }
  return `${lines.join("\n")}\n`;
}
