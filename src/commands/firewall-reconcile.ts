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
 *  3. **Default drop is still held.** `policy.inputDefault: "drop"` is refused
 *     outright. Commit-confirm now exists (an applied ruleset is pending until
 *     `server.firewall.confirm`, and a root timer undoes it otherwise), but the
 *     hold is only lifted once that safety net has been proven on a real host
 *     (`fw-proof`), and the control plane can confirm from outside. `accept`
 *     applies today: explicit `drop` / `reject` rows and published-port
 *     narrowing bite, the default does not.
 *
 * **Applied means pending.** An apply loads the rules and arms the rollback
 * guard but does not make them durable (`../firewall/pending.ts`); the result
 * carries `confirmation.deadlineAt`, and the rules become durable only when
 * `server.firewall.confirm` names the result's digest in time.
 *
 * `mode: "observe"` renders and reports (digest, warnings, rule count) and
 * applies nothing: it also asks the kernel to check the documents with
 * `--test` (nothing is loaded) and returns the verdict as `validation` plus
 * the rendered text as `rendered`, so it is a true preview. `mode: "off"`
 * removes TurboPanel's chains and jumps.
 */

import { logInfo, sanitizeForLog } from "../util/logger.ts";
import {
  autoConfirmFirewall,
  type FirewallAutoConfirmOptions,
} from "../firewall/auto-confirm.ts";
import { readPendingMarker, readRollbackRecord } from "../firewall/pending.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  applyRenderedFirewall,
  hasDockerUserChain,
  isControlPlaneColocated,
  probeXtables,
  removeFirewall,
  validateRenderedFirewall,
} from "../firewall/apply.ts";
import {
  type FirewallFamily,
  type RenderedFirewall,
  renderFirewall,
} from "../firewall/render.ts";
import { type FirewallRunFn, runFirewallHost } from "../firewall/run.ts";
import { readSshdEffectivePorts } from "../firewall/sshd-port.ts";
import {
  FIREWALL_RENDERED_MAX_BYTES,
  type FirewallReconcilePayload,
  type FirewallReconcileResult,
  type FirewallRendered,
} from "../contracts/commands-contracts.ts";

/** The exact sentence a refused default-drop carries, so a test can pin it. */
export const DEFAULT_DROP_HELD_WARNING =
  "policy.inputDefault drop is held until the commit-confirm rollback is proven on a real host (fw-proof); rendered, not applied";

export const CONTROL_PLANE_PORTS_MISSING_WARNING =
  "turbopanel-instance.service is active on this host but the payload names no controlPlane.tcpPorts; a default-drop apply would close the control plane and is refused";

export type FirewallReconcileDeps = {
  run?: FirewallRunFn;
  resolveLayout?: () => LayoutPaths;
  /** One authenticated round trip to the control plane; see `../firewall/auto-confirm.ts`. */
  verifyControlPlane?: () => Promise<void>;
  /** Test seams for the auto-confirm check. */
  autoConfirm?: Partial<FirewallAutoConfirmOptions>;
};

function union(a: number[], b: number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

/**
 * The rendered documents for a result that did not apply, or `null` (with a
 * warning) when either exceeds {@link FIREWALL_RENDERED_MAX_BYTES}: the
 * digest and rule count still describe the ruleset, only the text is left out.
 */
function renderedForResult(
  rendered: RenderedFirewall,
  warnings: string[],
): FirewallRendered | null {
  const v6 = rendered.v6 ?? undefined;
  if (
    rendered.v4.length > FIREWALL_RENDERED_MAX_BYTES ||
    (v6 !== undefined && v6.length > FIREWALL_RENDERED_MAX_BYTES)
  ) {
    warnings.push(
      `the rendered ruleset is larger than ${FIREWALL_RENDERED_MAX_BYTES} characters and is not included; the digest and rule count still describe it`,
    );
    return null;
  }
  return v6 === undefined ? { v4: rendered.v4 } : { v4: rendered.v4, v6 };
}

type RenderOnlyArgs = {
  payload: FirewallReconcilePayload;
  rendered: RenderedFirewall;
  probe: Parameters<typeof validateRenderedFirewall>[1];
  run: FirewallRunFn;
  base: Pick<
    FirewallReconcileResult,
    "generation" | "mode" | "digest" | "ruleCount" | "sshPorts"
  >;
  warnings: string[];
  refusals: string[];
};

/**
 * Observe (preview) and refused applies: render, ask the kernel to check the
 * text (`--test`, nothing is loaded) and report. Never applies anything.
 */
async function renderOnlyResult(
  args: RenderOnlyArgs,
): Promise<FirewallReconcileResult> {
  const { payload, rendered, probe, run, base, warnings, refusals } = args;
  warnings.push(...refusals);
  const validation = await validateRenderedFirewall(rendered, probe, run);
  if (!validation.ok) {
    warnings.push(
      "the kernel would refuse this ruleset (iptables-restore --test failed); see validation",
    );
  }
  const renderedText = renderedForResult(rendered, warnings);
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
    validation,
    ...(renderedText === null ? {} : { rendered: renderedText }),
    summary: payload.mode === "observe"
      ? `firewall generation ${payload.generation} observed: ${rendered.ruleCount} rules would render`
      : `firewall generation ${payload.generation} refused: ${refusals.length} condition(s) block a default-drop apply`,
  };
}

/**
 * The guard's rollback record, but only while no ruleset is pending: that is
 * how the control plane learns "rolled back" without asking. Cleared by the
 * next confirm.
 */
async function lastRollbackField(
  layout: LayoutPaths,
): Promise<Pick<FirewallReconcileResult, "lastRollback">> {
  if (await readPendingMarker(layout) !== null) return {};
  const record = await readRollbackRecord(layout);
  return record === null ? {} : { lastRollback: record };
}

/** Run the daemon's own confirm and fold the answer into the pending confirmation. */
async function selfConfirm(
  digest: string,
  confirmation: NonNullable<FirewallReconcileResult["confirmation"]>,
  deps: FirewallReconcileDeps,
  run: FirewallRunFn,
  layout: LayoutPaths,
): Promise<NonNullable<FirewallReconcileResult["confirmation"]>> {
  const outcome = await autoConfirmFirewall(digest, {
    ...deps.autoConfirm,
    verifyControlPlane: deps.verifyControlPlane,
    run,
    layout,
  });
  return {
    ...confirmation,
    state: outcome.confirmed ? "confirmed" : "pending",
    autoConfirm: { ok: outcome.confirmed, reason: outcome.reason },
  };
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
    const preview = await renderOnlyResult({
      payload,
      rendered,
      probe,
      run,
      base,
      warnings,
      refusals,
    });
    return { ...preview, ...await lastRollbackField(layout) };
  }

  const outcome = await applyRenderedFirewall(rendered, includeForward, probe, {
    run,
    layout,
    generation: payload.generation,
  });
  warnings.push(...outcome.warnings);

  const confirmation = await selfConfirm(
    rendered.digest,
    {
      state: "pending",
      deadlineAt: outcome.confirmation.deadlineAt,
      windowSeconds: outcome.confirmation.windowSeconds,
    },
    deps,
    run,
    layout,
  );

  logInfo(
    "command",
    `firewall generation ${payload.generation} applied (${
      confirmation.state === "confirmed"
        ? "auto-confirmed"
        : "pending confirmation"
    }): ${rendered.ruleCount} rules, v6=${outcome.ipv6Status}, forward=${outcome.forwardApplied}, digest ${
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
    ipv6Status: outcome.ipv6Status,
    forwardApplied: outcome.forwardApplied,
    warnings,
    confirmation,
    summary: confirmation.state === "confirmed"
      ? `firewall generation ${payload.generation} applied and confirmed by the daemon: ${rendered.ruleCount} rules, ${probe.version}`
      : `firewall generation ${payload.generation} applied, pending confirmation until ${outcome.confirmation.deadlineAt} (${confirmation.autoConfirm?.reason}): ${rendered.ruleCount} rules, ${probe.version}`,
  };
}
