/**
 * Apply a rendered firewall to the host: probe the tooling, restore the
 * TurboPanel chains atomically, ensure the two jumps, persist the documents.
 *
 * **Atomicity.** `iptables-restore --noflush` with the chains declared as
 * `:TP-INPUT - [0:0]` / `:TP-FWD - [0:0]` flushes and rebuilds *only those
 * chains*, in one netlink transaction per table, and leaves Docker's and the
 * operator's chains alone (verified on iptables v1.8.11 nf_tables, 2026-09-19).
 * The document is run through `--test` first so a refused line never leaves a
 * half-applied chain; `--test` parses and validates without touching the
 * kernel.
 *
 * **Jumps live outside the document.** `-I INPUT 1 -j TP-INPUT` inside a
 * `--noflush` restore would add one more jump on every apply; the `-C` → `-I`
 * idiom the fabric and managed-listener code already use is idempotent.
 *
 * **A v6 failure fails the reconcile.** A v4 failure throws before anything is
 * kept. A v6 failure after a successful v4 apply keeps v4 applied (and its
 * durable document written) but throws {@link FirewallIpv6ApplyError}: the
 * v6 chains are left exactly as they were, so a `drop` / `reject` the panel
 * just asked for is enforced on IPv4 and not on IPv6 — that must reach the
 * panel as a failed command, not a warning it can scroll past. The durable
 * v6 document is left untouched too, so a reboot restores the same v6 state
 * the kernel holds. No `ip6tables` at all is still a warning: there is
 * nothing to apply against.
 *
 * **`DOCKER-USER` may not exist** (Docker not installed yet; `ip6tables` unless
 * Docker's own ip6tables is on). The renderer is told per family and leaves
 * `TP-FWD` out; {@link reinstallFirewallForwardingIfEnabled} is the hook for
 * the Docker monitor to call when dockerd (re)appears — dockerd rebuilds
 * `DOCKER-USER` on restart, so the jump has to be put back the way the fabric
 * jump already is.
 *
 * **Durable copy.** The applied documents are written to
 * `<configDir>/firewall.v4` and `firewall.v6` (world-readable — they hold no
 * secret and an operator should be able to read what the host enforces). The
 * boot unit that restores them lands with `fw-boot-persistence`; this module
 * only writes them.
 */

import { join } from "@std/path";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { errorText, logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import {
  FIREWALL_FORWARD_CHAIN,
  FIREWALL_INPUT_CHAIN,
  type FirewallFamily,
  type RenderedFirewall,
} from "./render.ts";
import {
  type FirewallRunFn,
  type FirewallRunResult,
  isMissingBinaryText,
  isMissingRuleText,
  runFirewallHost,
} from "./run.ts";

export const FIREWALL_V4_FILENAME = "firewall.v4";
export const FIREWALL_V6_FILENAME = "firewall.v6";

/** The unit `turbopanel-instance.service` is active → this is the control-plane host. */
export const CONTROL_PLANE_UNIT = "turbopanel-instance.service";

const INPUT_BUILTIN = "INPUT";
const DOCKER_USER_CHAIN = "DOCKER-USER";

export type FirewallApplyOptions = {
  run?: FirewallRunFn;
  layout?: LayoutPaths;
};

function binaryFor(family: FirewallFamily, tool: "" | "-restore" | "-save") {
  return `${family === 4 ? "iptables" : "ip6tables"}${tool}`;
}

function failureText(result: FirewallRunResult): string {
  return result.stderr || result.stdout || `exit ${result.code}`;
}

export type XtablesProbe = {
  /** `iptables` runs. Nothing can be applied without it. */
  ok: boolean;
  /** `iptables -V` output, e.g. `iptables v1.8.11 (nf_tables)`. */
  version: string;
  /** `ip6tables` runs too. */
  ipv6: boolean;
  warning?: string;
};

/**
 * `iptables -V` / `ip6tables -V`. On Debian 12+ the binaries are the nft
 * shims; a legacy backend still works and is only noted.
 */
export async function probeXtables(
  run: FirewallRunFn = runFirewallHost,
): Promise<XtablesProbe> {
  const v4 = await run("iptables", ["-V"]);
  if (!v4.success) {
    return {
      ok: false,
      version: "",
      ipv6: false,
      warning: isMissingBinaryText(v4)
        ? "iptables is not installed on this host (apt-get install iptables)"
        : `iptables -V failed: ${failureText(v4)}`,
    };
  }
  const v6 = await run("ip6tables", ["-V"]);
  const probe: XtablesProbe = {
    ok: true,
    version: v4.stdout,
    ipv6: v6.success,
  };
  if (!v4.stdout.includes("nf_tables")) {
    probe.warning =
      `iptables reports a legacy backend (${v4.stdout}); rules apply but do not share a table with nftables tooling`;
  }
  return probe;
}

/** `DOCKER-USER` exists in this family's filter table. */
export async function hasDockerUserChain(
  family: FirewallFamily,
  run: FirewallRunFn = runFirewallHost,
): Promise<boolean> {
  const result = await run(binaryFor(family, ""), ["-S", DOCKER_USER_CHAIN]);
  return result.success;
}

/** `systemctl is-active turbopanel-instance.service` answers `active`. */
export async function isControlPlaneColocated(
  run: FirewallRunFn = runFirewallHost,
): Promise<boolean> {
  const result = await run("systemctl", ["is-active", CONTROL_PLANE_UNIT], {
    timeoutMs: 10_000,
  });
  return result.stdout.trim() === "active";
}

async function ensureJump(
  family: FirewallFamily,
  parent: string,
  child: string,
  run: FirewallRunFn,
): Promise<void> {
  const bin = binaryFor(family, "");
  const exists = await run(bin, ["-C", parent, "-j", child]);
  if (exists.success) return;
  const added = await run(bin, ["-I", parent, "1", "-j", child]);
  if (!added.success) {
    throw new Error(
      `${bin} -I ${parent} 1 -j ${child} failed: ${failureText(added)}`,
    );
  }
}

async function removeJumpBestEffort(
  family: FirewallFamily,
  parent: string,
  child: string,
  run: FirewallRunFn,
): Promise<void> {
  const bin = binaryFor(family, "");
  // A jump may have been inserted more than once by an older tool; take them
  // all, and stop when iptables says there is none left.
  for (let attempt = 0; attempt < 8; attempt++) {
    const removed = await run(bin, ["-D", parent, "-j", child]);
    if (removed.success) continue;
    if (!isMissingRuleText(removed)) {
      logWarn(
        "firewall",
        `${bin} -D ${parent} -j ${child} failed: ${
          sanitizeForLog(failureText(removed))
        }`,
      );
    }
    return;
  }
}

async function restoreDocument(
  family: FirewallFamily,
  document: string,
  run: FirewallRunFn,
): Promise<void> {
  const bin = binaryFor(family, "-restore");
  const tested = await run(bin, ["--noflush", "--test"], { stdin: document });
  if (!tested.success) {
    throw new Error(
      `${bin} --test refused the ruleset: ${failureText(tested)}`,
    );
  }
  const applied = await run(bin, ["--noflush"], { stdin: document });
  if (!applied.success) {
    throw new Error(`${bin} failed: ${failureText(applied)}`);
  }
}

/**
 * v4 applied, v6 did not. Thrown after the v4 durable document is written so
 * the command fails with the host in a known state: v4 on the new generation,
 * v6 on whatever it held before.
 */
export class FirewallIpv6ApplyError extends Error {
  constructor(cause: unknown) {
    super(
      `IPv6 ruleset was not applied (IPv4 is applied; IPv6 left unchanged): ${
        errorText(cause)
      }`,
    );
    this.name = "FirewallIpv6ApplyError";
  }
}

export type FirewallApplyOutcome = {
  ipv6Applied: boolean;
  forwardApplied: boolean;
  warnings: string[];
};

/**
 * Apply both documents. `includeForward` must be the same value the renderer
 * was given — it says which jumps to ensure.
 */
export async function applyRenderedFirewall(
  rendered: RenderedFirewall,
  includeForward: Record<FirewallFamily, boolean>,
  probe: XtablesProbe,
  options: FirewallApplyOptions = {},
): Promise<FirewallApplyOutcome> {
  const run = options.run ?? runFirewallHost;
  const layout = options.layout ?? resolveLayout(Deno.env.toObject());
  const warnings: string[] = [];

  await restoreDocument(4, rendered.v4, run);
  await ensureJump(4, INPUT_BUILTIN, FIREWALL_INPUT_CHAIN, run);
  if (includeForward[4]) {
    await ensureJump(4, DOCKER_USER_CHAIN, FIREWALL_FORWARD_CHAIN, run);
  } else {
    warnings.push(
      "DOCKER-USER is absent (Docker not running yet); published-port rules are deferred until dockerd creates it",
    );
  }

  let ipv6Applied = false;
  let ipv6Failure: unknown = null;
  if (rendered.v6 !== null) {
    if (probe.ipv6) {
      try {
        await applyIpv6(rendered.v6, includeForward[6], run);
        ipv6Applied = true;
      } catch (err) {
        ipv6Failure = err;
      }
    } else {
      warnings.push("ip6tables is not available; IPv6 was left unchanged");
    }
  }

  await writeDurableDocuments(
    layout,
    rendered.v4,
    ipv6Failure === null ? (ipv6Applied ? rendered.v6 : null) : "keep",
  );

  if (ipv6Failure !== null) throw new FirewallIpv6ApplyError(ipv6Failure);
  return { ipv6Applied, forwardApplied: includeForward[4], warnings };
}

async function applyIpv6(
  v6: string,
  includeForward: boolean,
  run: FirewallRunFn,
): Promise<void> {
  await restoreDocument(6, v6, run);
  await ensureJump(6, INPUT_BUILTIN, FIREWALL_INPUT_CHAIN, run);
  if (includeForward) {
    await ensureJump(6, DOCKER_USER_CHAIN, FIREWALL_FORWARD_CHAIN, run);
  }
}

/**
 * `v6`: the document to keep, `null` to forget it, or `"keep"` to leave the
 * existing file alone (the v6 kernel state did not change).
 */
async function writeDurableDocuments(
  layout: LayoutPaths,
  v4: string,
  v6: string | null | "keep",
): Promise<void> {
  await Deno.mkdir(layout.configDir, { recursive: true });
  const v4Path = join(layout.configDir, FIREWALL_V4_FILENAME);
  const v6Path = join(layout.configDir, FIREWALL_V6_FILENAME);
  await Deno.writeTextFile(v4Path, v4, { mode: 0o644 });
  if (v6 === "keep") return;
  if (v6 === null) {
    await removeIfPresent(v6Path);
  } else {
    await Deno.writeTextFile(v6Path, v6, { mode: 0o644 });
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/**
 * `mode: off` — take the jumps out, flush and delete both chains in both
 * families, forget the durable documents. Best-effort throughout: a chain that
 * is already gone is the desired state, not an error.
 */
export async function removeFirewall(
  options: FirewallApplyOptions = {},
): Promise<void> {
  const run = options.run ?? runFirewallHost;
  const layout = options.layout ?? resolveLayout(Deno.env.toObject());
  for (const family of [4, 6] as const) {
    const bin = binaryFor(family, "");
    await removeJumpBestEffort(
      family,
      INPUT_BUILTIN,
      FIREWALL_INPUT_CHAIN,
      run,
    );
    await removeJumpBestEffort(
      family,
      DOCKER_USER_CHAIN,
      FIREWALL_FORWARD_CHAIN,
      run,
    );
    for (const chain of [FIREWALL_INPUT_CHAIN, FIREWALL_FORWARD_CHAIN]) {
      for (const flag of ["-F", "-X"]) {
        const result = await run(bin, [flag, chain]);
        if (!result.success && !isMissingRuleText(result)) {
          logWarn(
            "firewall",
            `${bin} ${flag} ${chain} failed: ${
              sanitizeForLog(failureText(result))
            }`,
          );
        }
      }
    }
  }
  await removeIfPresent(join(layout.configDir, FIREWALL_V4_FILENAME));
  await removeIfPresent(join(layout.configDir, FIREWALL_V6_FILENAME));
  logInfo("firewall", "TurboPanel firewall chains removed (mode off)");
}

/**
 * The current TurboPanel chains as `iptables-save` prints them — only the
 * lines that declare or reference a `TP-` chain. The rollback snapshot
 * commit-confirm (`fw-invariants-commit-confirm`) restores from; exposed now
 * so that row is a caller, not a rewrite.
 */
export async function snapshotFirewallChains(
  family: FirewallFamily,
  run: FirewallRunFn = runFirewallHost,
): Promise<string | null> {
  const result = await run(binaryFor(family, "-save"), ["-t", "filter"]);
  if (!result.success) return null;
  const lines = result.stdout.split("\n").filter((line) =>
    line.startsWith(":TP-") || line.startsWith("-A TP-") ||
    line.includes("-j TP-")
  );
  return lines.join("\n");
}

/**
 * Re-hang `TP-FWD` off `DOCKER-USER` (and re-apply the durable v4 document)
 * when dockerd becomes reachable — the Docker monitor's hook, mirroring
 * `reinstallFabricForwardingIfEnabled`. No durable document means the
 * firewall is not managed here, and nothing happens. Never throws.
 */
export async function reinstallFirewallForwardingIfEnabled(
  options: FirewallApplyOptions = {},
): Promise<void> {
  const run = options.run ?? runFirewallHost;
  const layout = options.layout ?? resolveLayout(Deno.env.toObject());
  let v4: string;
  try {
    v4 = await Deno.readTextFile(join(layout.configDir, FIREWALL_V4_FILENAME));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    logWarn(
      "firewall",
      `firewall.v4 unreadable: ${sanitizeForLog(err)}`,
    );
    return;
  }
  if (!v4.includes(`:${FIREWALL_FORWARD_CHAIN} `)) return;
  try {
    if (!(await hasDockerUserChain(4, run))) return;
    await restoreDocument(4, v4, run);
    await ensureJump(4, DOCKER_USER_CHAIN, FIREWALL_FORWARD_CHAIN, run);
    logInfo(
      "firewall",
      "TP-FWD re-hung off DOCKER-USER after dockerd came back",
    );
  } catch (err) {
    logWarn(
      "firewall",
      `TP-FWD reinstall failed: ${sanitizeForLog(err)}`,
    );
  }
}
