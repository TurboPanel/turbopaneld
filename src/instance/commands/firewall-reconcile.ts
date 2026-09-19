/**
 * Reconcile the host firewall to the panel's desired state
 * (`server.firewall.reconcile`).
 *
 * Sits beside `server.principals.reconcile` and follows its shape: server-
 * scoped, carries the **complete** desired set, the daemon reconciles to it.
 * The panel derives the rules from what it deployed (the control-plane
 * entrypoint, hosting, ProxySQL, WireGuard, sshd, compose `ports:`) and adds
 * organization defaults and per-server rows; this handler renders that set
 * through `../../firewall/render.ts` and applies it through
 * `../../firewall/apply.ts`.
 *
 * **Lockout is the failure mode this handler guards, not exposure.** A
 * default-deny `INPUT` on a remote host you just removed ufw from is how a
 * server is lost, so three things are checked *before* anything is applied,
 * and each refusal is a result with `applied: false` and a warning that names
 * it — a state the console shows, not an error to retry:
 *
 *  1. sshd's effective ports are read from the host (`sshd -T`) and unioned
 *     with the payload's belief; the renderer guarantees an `ACCEPT` for each.
 *  2. If `turbopanel-instance.service` is active here — this is the co-located
 *     control-plane host — and the payload names no `controlPlane.tcpPorts`,
 *     a default-drop apply is refused. A panel that forgot its own port must
 *     not lock its wizard out a second time (the 2026-09-19 canary incident).
 *  3. **Held until commit-confirm lands** (`fw-invariants-commit-confirm`):
 *     `policy.inputDefault: "drop"` is refused outright. Until the daemon can
 *     roll a ruleset back on its own when its control-plane session dies,
 *     there is no safe way to apply a default drop to a host nobody is
 *     standing next to. `accept` applies today: explicit `drop` / `reject`
 *     rows and published-port narrowing bite, the default does not.
 *
 * `mode: "observe"` renders and reports (digest, warnings, rule count) and
 * applies nothing; `mode: "off"` removes TurboPanel's chains and jumps.
 */

import { logInfo, sanitizeForLog } from "../../logger.ts";
import { type LayoutPaths, resolveLayout } from "../../paths/layout.ts";
import {
  applyRenderedFirewall,
  hasDockerUserChain,
  isControlPlaneColocated,
  probeXtables,
  removeFirewall,
} from "../../firewall/apply.ts";
import { type FirewallFamily, renderFirewall } from "../../firewall/render.ts";
import { type FirewallRunFn, runFirewallHost } from "../../firewall/run.ts";
import { readSshdEffectivePorts } from "../../firewall/sshd-port.ts";
import type {
  FirewallReconcilePayload,
  FirewallReconcileResult,
} from "./contracts.ts";

/** The exact sentence a refused default-drop carries, so a test can pin it. */
export const DEFAULT_DROP_HELD_WARNING =
  "policy.inputDefault drop is held until commit-confirm rollback lands (fw-invariants-commit-confirm); rendered, not applied";

export const CONTROL_PLANE_PORTS_MISSING_WARNING =
  "turbopanel-instance.service is active on this host but the payload names no controlPlane.tcpPorts; a default-drop apply would close the control plane and is refused";

export type FirewallReconcileDeps = {
  run?: FirewallRunFn;
  resolveLayout?: () => LayoutPaths;
};

function union(a: number[], b: number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

export async function handleFirewallReconcile(
  payload: FirewallReconcilePayload,
  _daemonReceivedAt: string,
  deps: FirewallReconcileDeps = {},
): Promise<FirewallReconcileResult> {
  const run = deps.run ?? runFirewallHost;
  const layout = (deps.resolveLayout ??
    (() => resolveLayout(Deno.env.toObject())))();
  const warnings: string[] = [];

  if (payload.mode === "off") {
    await removeFirewall({ run, layout });
    return {
      generation: payload.generation,
      mode: "off",
      applied: true,
      digest: "",
      ruleCount: 0,
      ipv6Applied: false,
      forwardApplied: false,
      sshPorts: [],
      warnings,
      summary:
        `firewall generation ${payload.generation}: TurboPanel chains removed`,
    };
  }

  const probe = await probeXtables(run);
  if (!probe.ok) {
    // Nothing can be rendered against a host with no iptables; that is a
    // failed command, not a refusal state.
    throw new Error(probe.warning ?? "iptables is not available");
  }
  if (probe.warning) warnings.push(probe.warning);

  const sshd = await readSshdEffectivePorts(run);
  if (sshd.warning) warnings.push(sshd.warning);
  const sshPorts = union(sshd.ports, payload.sshPorts ?? []);

  const includeForward: Record<FirewallFamily, boolean> = {
    4: await hasDockerUserChain(4, run),
    6: payload.policy.ipv6 === "mirror" && probe.ipv6 &&
      await hasDockerUserChain(6, run),
  };

  const rendered = renderFirewall({ payload, sshPorts, includeForward });
  warnings.push(...rendered.warnings);

  const base = {
    generation: payload.generation,
    mode: payload.mode,
    digest: rendered.digest,
    ruleCount: rendered.ruleCount,
    sshPorts: rendered.sshPorts,
  };

  const refusals: string[] = [];
  if (payload.policy.inputDefault === "drop") {
    const colocated = await isControlPlaneColocated(run);
    if (colocated && (payload.controlPlane?.tcpPorts.length ?? 0) === 0) {
      refusals.push(CONTROL_PLANE_PORTS_MISSING_WARNING);
    }
    refusals.push(DEFAULT_DROP_HELD_WARNING);
  }

  if (payload.mode === "observe" || refusals.length > 0) {
    warnings.push(...refusals);
    logInfo(
      "command",
      `firewall generation ${payload.generation} rendered, not applied (${
        payload.mode === "observe" ? "observe" : "refused"
      }): ${rendered.ruleCount} rules, digest ${rendered.digest.slice(0, 12)}`,
    );
    return {
      ...base,
      applied: false,
      ipv6Applied: false,
      forwardApplied: false,
      warnings,
      summary: payload.mode === "observe"
        ? `firewall generation ${payload.generation} observed: ${rendered.ruleCount} rules would render`
        : `firewall generation ${payload.generation} refused: ${refusals.length} condition(s) block a default-drop apply`,
    };
  }

  const outcome = await applyRenderedFirewall(rendered, includeForward, probe, {
    run,
    layout,
  });
  warnings.push(...outcome.warnings);

  logInfo(
    "command",
    `firewall generation ${payload.generation} applied: ${rendered.ruleCount} rules, v6=${outcome.ipv6Applied}, forward=${outcome.forwardApplied}, digest ${
      rendered.digest.slice(0, 12)
    }${
      warnings.length > 0
        ? `, warnings: ${sanitizeForLog(warnings.join(" | "))}`
        : ""
    }`,
  );

  return {
    ...base,
    applied: true,
    ipv6Applied: outcome.ipv6Applied,
    forwardApplied: outcome.forwardApplied,
    warnings,
    summary:
      `firewall generation ${payload.generation} applied: ${rendered.ruleCount} rules, ${probe.version}`,
  };
}
