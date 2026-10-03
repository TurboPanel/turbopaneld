/**
 * What the gate concludes about one request, beyond the strict-profile rules
 * themselves: which platform allowance removed a finding, whether a signed
 * approval covers the rest, and whether a container the request acts on
 * carries anything the platform stamped. Observe mode: every outcome is a log
 * line and a counter; nothing here refuses a request.
 *
 * Never logged: the approval token, labels, environment, commands.
 *
 * Dependency-free on purpose (see http.ts).
 */

import {
  APPROVAL_LABEL,
  type ApprovalResult,
  splitApproved,
  verifyApproval,
} from "./approval.ts";
import { fetchContainerLabels } from "./inspect.ts";
import {
  evaluateDetailed,
  type RequestFacts,
  routePath,
  type Violation,
} from "./policy.ts";
import {
  LABEL_COMPOSE_PROJECT,
  labelsOf,
  ownedTarget,
  ownerOf,
} from "./platform.ts";
import type { ProxyDeps } from "./proxy.ts";

/** What the gate needs from the connection layer to review a request. */
export type ReviewDeps =
  & Pick<
    ProxyDeps,
    "policy" | "resolvePath" | "log" | "stats" | "connectUpstream"
  >
  & {
    /** Trusted approval keys; `undefined` or empty = approvals are off. */
    approvalKeys?: readonly CryptoKey[];
    /** Seconds since the epoch (injected so tests control the clock). */
    nowSec?: () => number;
  };

function logViolations(
  deps: ReviewDeps,
  facts: RequestFacts,
  route: string,
  violations: readonly Violation[],
): void {
  for (const violation of violations) {
    deps.stats.violation(violation.rule);
    deps.log({
      level: "warn",
      event: "docker-gate.would-deny",
      rule: violation.rule,
      ...(violation.detail === undefined ? {} : { detail: violation.detail }),
      method: facts.method,
      route,
      path: routePath(facts.path),
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function logApproval(
  deps: ReviewDeps,
  result: ApprovalResult,
  covered: readonly Violation[],
): void {
  if (result.ok) {
    deps.stats.approval("accepted");
    deps.log({
      level: "info",
      event: "docker-gate.approval",
      result: "accepted",
      deployId: result.payload.deployId,
      project: result.payload.project,
      composeDigest: result.payload.composeDigest,
      features: result.payload.features,
      covered: covered.map((violation) => violation.rule),
    });
    return;
  }
  deps.stats.approval(`rejected:${result.reason}`);
  deps.log({
    level: "warn",
    event: "docker-gate.approval",
    result: "rejected",
    reason: result.reason,
    ...(result.deployId === undefined ? {} : { deployId: result.deployId }),
    ...(result.project === undefined ? {} : { project: result.project }),
  });
}

/** Findings left after the create's signed approval (if it carries one). */
async function applyApproval(
  labels: Record<string, string>,
  violations: Violation[],
  deps: ReviewDeps,
): Promise<Violation[]> {
  const token = labels[APPROVAL_LABEL];
  if (token === undefined) return violations;
  const result = await verifyApproval(
    token,
    deps.approvalKeys ?? [],
    labels[LABEL_COMPOSE_PROJECT] ?? "",
    (deps.nowSec ?? defaultNowSec)(),
  );
  if (!result.ok) {
    logApproval(deps, result, []);
    return violations;
  }
  const { remaining, approved } = splitApproved(violations, result.payload);
  logApproval(deps, result, approved);
  for (const violation of approved) deps.stats.approvedRule(violation.rule);
  return remaining;
}

function defaultNowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function createFindings(
  facts: RequestFacts,
  found: Violation[],
  deps: ReviewDeps,
): Promise<Violation[]> {
  const labels = labelsOf(asRecord(facts.body).Labels);
  const owner = ownerOf(labels);
  deps.stats.owner(owner);
  const withOwner = owner === "unlabeled"
    ? [...found, { rule: "unlabeled-create" }]
    : found;
  return await applyApproval(labels, withOwner, deps);
}

async function unownedFinding(
  facts: RequestFacts,
  deps: ReviewDeps,
): Promise<Violation[]> {
  const target = ownedTarget(facts.method, routePath(facts.path));
  if (target === undefined) return [];
  const labels = await fetchContainerLabels(deps.connectUpstream, target);
  if (labels === undefined || ownerOf(labels) !== "unlabeled") return [];
  return [{ rule: "unowned-container", detail: target.slice(0, 64) }];
}

/**
 * Judge one request: findings, allowances, approval, ownership; log and count.
 * `extra` holds findings judged outside the policy (the build credential).
 * Returns every finding left, for the caller to refuse on in enforce mode.
 */
export async function review(
  facts: RequestFacts,
  route: string,
  deps: ReviewDeps,
  extra: readonly Violation[] = [],
): Promise<Violation[]> {
  const detail = await evaluateDetailed(
    facts,
    deps.policy,
    deps.resolvePath,
  );
  for (const allowance of detail.allowances) {
    deps.stats.allowance(allowance);
    deps.log({
      level: "info",
      event: "docker-gate.allowed",
      allowance,
      route,
    });
  }
  const findings = route === "containers.create"
    ? await createFindings(facts, detail.violations, deps)
    : detail.violations;
  const unowned = await unownedFinding(facts, deps);
  const all = [...findings, ...unowned, ...extra];
  logViolations(deps, facts, route, all);
  return all;
}
