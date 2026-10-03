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
 * The host's SFTP chroot switch. Root-owned and outside every tree tp-host's
 * generic verbs may write, so only `tp-host sftp-chroot on` (which refuses
 * while any `tpsftp` member is off the root-owned home layout) and
 * `sftp-chroot off` change it. The daemon asks `tp-host sftp-chroot status`,
 * which also names the chroot root it validated.
 */
export const SFTP_CHROOT_SWITCH_PATH = "/etc/ssh/turbopanel-sftp-chroot";

/** Where a jailed SFTP session starts, relative to its chroot. */
export const SFTP_CHROOT_START_DIR = "home";

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
    ...forwardingDirectives(),
    "PermitUserRC no",
  ];
}

/**
 * Every way an authenticated session could carry traffic other than its own
 * files or shell. `AllowTcpForwarding no` alone leaves Unix-socket forwarding
 * (`AllowStreamLocalForwarding`) open, and `PermitOpen` / `PermitListen` are
 * the second lock should a later block or an administrator's `Match` turn TCP
 * forwarding back on for one of these accounts.
 */
function forwardingDirectives(): readonly string[] {
  return [
    "AllowTcpForwarding no",
    "AllowStreamLocalForwarding no",
    "PermitOpen none",
    "PermitListen none",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "PermitTunnel no",
    // The assertion demands `gatewayports no`; set it so an administrator's global
    // `GatewayPorts clientspecified` cannot wedge every reconcile.
    "GatewayPorts no",
  ];
}

/**
 * The files-only level.
 *
 * With `chrootRoot` set (the host's SFTP chroot switch is on), members are
 * jailed at `<chrootRoot>/<user>` — the root-owned principal home, which is
 * what `sshd` demands of every component of a `ChrootDirectory` — and start in
 * `home/`. `%u`, not `%h`: the passwd home is `<chrootRoot>/<user>/home`, one
 * level below the jail. `-d` is resolved inside the chroot.
 *
 * Only this block ever carries the chroot: on the shell level it would need a
 * populated root, and on the backstop it would apply to shell members too (see
 * {@link principalBackstopDirectives}).
 */
function sftpLevelDirectives(
  authorizedKeysDir: string,
  chrootRoot: string | undefined,
): readonly string[] {
  // Required, not optional: the host's `Subsystem sftp` may point at
  // `/usr/lib/openssh/sftp-server`, which is exec'd through the account's
  // login shell and therefore dies on `/usr/sbin/nologin`. `internal-sftp`
  // runs in the `sshd` process and needs no shell at all.
  if (chrootRoot === undefined) {
    return [
      ...commonDirectives(authorizedKeysDir),
      "ForceCommand internal-sftp",
    ];
  }
  return [
    ...commonDirectives(authorizedKeysDir),
    `ChrootDirectory ${chrootRoot}/%u`,
    `ForceCommand internal-sftp -d /${SFTP_CHROOT_START_DIR}`,
  ];
}

/**
 * The backstop for every principal, matched on a group every principal holds.
 *
 * It comes **after** the level blocks, and `sshd` keeps the first value it
 * sees for each keyword across all matching blocks. So for a `tpsftp` /
 * `tpshell` member every keyword here was already decided by the level block
 * and this block changes nothing. For a principal with **no** level — the
 * default for a site owner — this is the only block that applies, and it
 * refuses every authentication method: without it that account falls through
 * to the host's global defaults, which on Debian means its own
 * `~/.ssh/authorized_keys` is honoured and TCP forwarding is on, so a key
 * planted in the home is a tunnel into the host's loopback and LAN.
 *
 * Never put a keyword here that a level block leaves unset (`ForceCommand`,
 * later `ChrootDirectory`): it would apply to that level's members as well.
 */
function principalBackstopDirectives(): readonly string[] {
  return [
    "PubkeyAuthentication no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "AuthorizedKeysFile none",
    "AuthorizedKeysCommand none",
    ...forwardingDirectives(),
    "PermitUserRC no",
  ];
}

export type SshdDropInOpts = {
  /** Group whose members get file transfer only. */
  sftpGroup: string;
  /** Group whose members get an interactive shell. */
  shellGroup: string;
  /**
   * Group whose members may authenticate with a password. Additive: a member
   * always also holds `sftpGroup` or `shellGroup`, which carry the rest of the
   * tenant restrictions.
   */
  passwordGroup: string;
  /**
   * Group every principal holds, whatever its level. Selects the backstop
   * block that refuses authentication to a principal with no level.
   */
  principalGroup: string;
  /** Managed key directory; defaulted so tests can render against a temp tree. */
  authorizedKeysDir?: string;
  /**
   * The principal home root to jail `sftpGroup` members under, or absent for
   * no chroot. Set only while the host's switch is on — see
   * {@link SFTP_CHROOT_SWITCH_PATH}.
   */
  sftpChrootRoot?: string;
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
  const keysDir = opts.authorizedKeysDir ?? AUTHORIZED_KEYS_DIR;
  const indent = (lines: readonly string[]) => lines.map((line) => `  ${line}`);
  const lines: string[] = [
    "# Managed by TurboPanel. Edits are overwritten on the next reconcile.",
    "#",
    "# Only Match blocks, and no global directives: this file is included from",
    "# the top of sshd_config, so a global set here would override the",
    "# administrator's own value for the whole host.",
    "",
    // First on purpose: when several Match blocks apply, sshd uses the first
    // instance of each keyword, so this block's `yes` wins over the `no` in
    // the level blocks below for members of the password group — and only the
    // one keyword. Everything else still comes from the member's level block.
    `Match Group ${opts.passwordGroup}`,
    "  PasswordAuthentication yes",
    "",
    `Match Group ${opts.sftpGroup}`,
    ...indent(sftpLevelDirectives(keysDir, opts.sftpChrootRoot)),
    "",
    `Match Group ${opts.shellGroup}`,
    ...indent(commonDirectives(keysDir)),
    "",
    "# Every principal. Last on purpose: a level member above already has every",
    "# keyword set, so this refuses sign-in only to principals with no level.",
    `Match Group ${opts.principalGroup}`,
    ...indent(principalBackstopDirectives()),
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

/**
 * Account names the root helper will pass to `sshd -T -C user=<name>`. The same
 * shape `tp-host` enforces (`tp_name_shape_ok`): no leading `-`, at most 32
 * characters of `[A-Za-z0-9_.-]`.
 */
export const SSHD_SAMPLE_NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,31}$/;

/**
 * The only connection spec `tp-host sshd -T -C` accepts. Match `Group` needs a
 * real account (sshd resolves the user's groups from the account database), so
 * a sample is always an existing member of the group under test.
 */
export function sshdEffectiveSpec(user: string): string {
  if (!SSHD_SAMPLE_NAME.test(user)) {
    throw new Error(`not a valid account name for sshd -T: ${user}`);
  }
  return `user=${user},host=localhost,addr=127.0.0.1`;
}

/**
 * What `sshd -T` must report for every managed account, whatever its level.
 * `PermitOpen` / `PermitListen` are `none` because that is the intent
 * {@link forwardingDirectives} states; the rest are plain `no`.
 */
const REQUIRED_EFFECTIVE: ReadonlyArray<readonly [string, string]> = [
  ["allowtcpforwarding", "no"],
  ["allowstreamlocalforwarding", "no"],
  ["allowagentforwarding", "no"],
  ["x11forwarding", "no"],
  ["permittunnel", "no"],
  ["gatewayports", "no"],
  ["permitopen", "none"],
  ["permitlisten", "none"],
];

/**
 * Findings for one account's `sshd -T` output: every forwarding keyword whose
 * effective value is not the forbidden-off value. A keyword `sshd` did not
 * report counts too — an assertion that cannot see the setting has not passed.
 */
export function sshdForwardingViolations(effective: string): string[] {
  const seen = new Map<string, string>();
  for (const raw of effective.split("\n")) {
    const line = raw.trim().toLowerCase();
    const space = line.indexOf(" ");
    if (space > 0 && !seen.has(line.slice(0, space))) {
      seen.set(line.slice(0, space), line.slice(space + 1).trim());
    }
  }
  const found: string[] = [];
  for (const [keyword, wanted] of REQUIRED_EFFECTIVE) {
    const value = seen.get(keyword);
    if (value === undefined) found.push(`${keyword} not reported`);
    else if (value !== wanted) found.push(`${keyword} is ${value}`);
  }
  return found;
}
