/**
 * Pure renderer for TurboPanel's `sshd` drop-in.
 *
 * TurboPanel never edits `/etc/ssh/sshd_config`. That file is the
 * administrator's, and an SSH lockout is the one failure this platform cannot
 * recover from remotely — so the whole contribution is a single drop-in at
 * `/etc/ssh/sshd_config.d/60-turbopanel.conf`, staged and config-tested like
 * every other managed config file.
 */

import { AUTHORIZED_KEYS_DIR } from "./authorized-keys.ts";

export const SSHD_CONFIG_PATH = "/etc/ssh/sshd_config";
export const SSHD_DROPIN_DIR = "/etc/ssh/sshd_config.d";
/**
 * `60-` so the file sorts after a distro's own drop-ins (Debian ships `50-`)
 * and before anything an administrator numbers higher to override us.
 */
export const SSHD_DROPIN_PATH = `${SSHD_DROPIN_DIR}/60-turbopanel.conf`;

/**
 * Directives shared by both access levels.
 *
 * Forwarding is off across the board: a tenant account is for reaching its own
 * files, and `AllowTcpForwarding yes` on a shared host turns every principal
 * into a tunnel into whatever the host can reach — including the panel's own
 * loopback ports, which is precisely the boundary the loopback engines rely on.
 */
function commonDirectives(authorizedKeysDir: string): readonly string[] {
  return [
    "PubkeyAuthentication yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    `AuthorizedKeysFile ${authorizedKeysDir}/%u`,
    // Never consult the account's own `~/.ssh/authorized_keys`, and never run a
    // helper: the panel-managed file is the whole answer.
    "AuthorizedKeysCommand none",
    "AllowTcpForwarding no",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "PermitTunnel no",
    "PermitUserRC no",
  ];
}

export type SshdDropInOpts = {
  /** Group whose members get file transfer only. */
  sftpGroup: string;
  /** Group whose members get an interactive shell. */
  shellGroup: string;
  /** Managed key directory; defaulted so tests can render against a temp tree. */
  authorizedKeysDir?: string;
};

/**
 * Render the drop-in.
 *
 * **The trailing `Match all` is load-bearing.** Debian puts
 * `Include /etc/ssh/sshd_config.d/*.conf` at the *top* of `sshd_config` and
 * processes it inline, so a `Match` block that runs to the end of this file
 * does **not** end with the file — every global directive below the `Include`
 * line in the administrator's config falls inside our last block. Without the
 * reset, this drop-in silently reinterprets the host's entire SSH
 * configuration as conditional on being a TurboPanel tenant.
 *
 * Only `Match` blocks are emitted, and no global directive appears before the
 * first one. That is deliberate: with the include at the top, a global we set
 * here would win over the administrator's own value for the whole host
 * (`sshd` takes the first occurrence of most keywords), which is not a
 * decision a hosting panel should make on someone's SSH daemon.
 */
export function sshdDropInContent(opts: SshdDropInOpts): string {
  const directives = commonDirectives(
    opts.authorizedKeysDir ?? AUTHORIZED_KEYS_DIR,
  );
  const lines: string[] = [
    "# Managed by TurboPanel. Edits are overwritten on the next reconcile.",
    "#",
    "# Only Match blocks, and no global directives: this file is included from",
    "# the top of sshd_config, so a global set here would override the",
    "# administrator's own value for the whole host.",
    "",
    `Match Group ${opts.sftpGroup}`,
    ...directives.map((line) => `  ${line}`),
    // Required, not optional: the host's `Subsystem sftp` may point at
    // `/usr/lib/openssh/sftp-server`, which is exec'd through the account's
    // login shell and therefore dies on `/usr/sbin/nologin`. `internal-sftp`
    // runs in the `sshd` process and needs no shell at all.
    "  ForceCommand internal-sftp",
    "",
    `Match Group ${opts.shellGroup}`,
    ...directives.map((line) => `  ${line}`),
    "",
    "# Reset the parser to global scope. Without this, every directive after",
    "# the Include line in sshd_config would be swallowed by the block above.",
    "Match all",
    "",
  ];
  return lines.join("\n");
}

/**
 * Does the administrator's `sshd_config` actually include the drop-in
 * directory?
 *
 * Checked rather than assumed, and **never repaired**: adding an `Include` line
 * to someone's `sshd_config` so that TurboPanel's own file starts taking effect
 * is not a move a hosting panel should make silently. Absent, the reconcile
 * fails and names the line to add.
 *
 * The line must appear before any `Match`, or it is itself conditional.
 */
export function sshdConfigIncludesDropIns(sshdConfig: string): boolean {
  for (const raw of sshdConfig.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (/^match\b/i.test(line)) return false;
    if (/^include\s/i.test(line)) {
      const target = line.slice("include".length).trim();
      if (
        target === `${SSHD_DROPIN_DIR}/*.conf` ||
        target === `${SSHD_DROPIN_DIR}/*`
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Host-level restrictions that outrank our `Match` blocks.
 *
 * `AllowUsers` / `AllowGroups` are allowlists evaluated before any `Match`, so
 * a host carrying one will refuse every principal no matter how correct this
 * drop-in is. `DenyUsers` / `DenyGroups` do the same in reverse. None of them
 * can be worked around from a drop-in, and none should be edited away, so the
 * only useful thing to do is name them: the reconcile continues and the
 * transcript says why a tenant with a valid key may still see
 * `Permission denied`.
 */
export function sshdAccessRestrictions(sshdConfig: string): string[] {
  const found: string[] = [];
  for (const raw of sshdConfig.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(allowusers|allowgroups|denyusers|denygroups)\b/i.exec(
      line,
    );
    if (match && !found.includes(match[1].toLowerCase())) {
      found.push(match[1].toLowerCase());
    }
  }
  return found;
}
