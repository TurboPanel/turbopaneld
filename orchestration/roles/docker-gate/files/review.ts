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
  APPROVABLE_RULES,
  APPROVAL_LABEL,
  approvalBodyDigest,
  type ApprovalResult,
  ReplayCache,
  splitApproved,
  startApprovalFeatures,
  verifyApproval,
} from "./approval.ts";
import {
  type ContainerDoc,
  fetchContainerDoc,
  fetchLabels,
  type InspectKind,
} from "./inspect.ts";
import {
  evaluateDetailed,
  evaluateStartBinds,
  type RequestFacts,
  routePath,
  type Violation,
} from "./policy.ts";
import {
  LABEL_COMPOSE_PROJECT,
  labelsOf,
  ownedObject,
  ownedTarget,
  ownerOf,
  platformAccessRule,
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
    /** Accepted token ids (single use); a process-wide one when absent. */
    approvalReplay?: ReplayCache;
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
  facts: RequestFacts,
  labels: Record<string, string>,
  violations: Violation[],
  deps: ReviewDeps,
): Promise<Violation[]> {
  const token = labels[APPROVAL_LABEL];
  if (token === undefined) return violations;
  const nowSec = (deps.nowSec ?? defaultNowSec)();
  const verified = await verifyApproval(
    token,
    deps.approvalKeys ?? [],
    labels[LABEL_COMPOSE_PROJECT] ?? "",
    await approvalBodyDigest(facts.plainBody),
    facts.query.get("name") ?? "",
    nowSec,
  );
  const result = verified.ok &&
      !(deps.approvalReplay ?? SHARED_REPLAY).claim(
        verified.payload.jti,
        verified.payload.exp,
        nowSec,
      )
    ? { ok: false as const, reason: "replayed", ...whoFrom(verified.payload) }
    : verified;
  if (!result.ok) {
    logApproval(deps, result, []);
    return violations;
  }
  const { remaining, approved } = splitApproved(violations, result.payload);
  logApproval(deps, result, approved);
  for (const violation of approved) deps.stats.approvedRule(violation.rule);
  return remaining;
}

/** Used when the caller keeps no cache of its own (every gate does). */
const SHARED_REPLAY = new ReplayCache();

function whoFrom(payload: { deployId: string; project: string }) {
  return { deployId: payload.deployId, project: payload.project };
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
  return await applyApproval(facts, labels, withOwner, deps);
}

/** The object a request acts on, when it must be one the platform stamped. */
function ownedSubject(
  facts: RequestFacts,
): { kind: InspectKind; name: string } | undefined {
  const path = routePath(facts.path);
  const container = ownedTarget(facts.method, path);
  if (container !== undefined) return { kind: "container", name: container };
  return ownedObject(facts.method, path);
}

/** The container a `start` or `restart` acts on (binds are re-checked then). */
const START_PATH = /^\/containers\/([^/]+)\/(?:start|restart)$/;

function startTarget(facts: RequestFacts): string | undefined {
  if (facts.method !== "POST") return undefined;
  return START_PATH.exec(routePath(facts.path))?.[1];
}

/** Findings left once the container's own (earlier signed) approval is applied. */
async function applyStartApproval(
  doc: ContainerDoc,
  found: readonly Violation[],
  deps: ReviewDeps,
): Promise<Violation[]> {
  const token = doc.labels[APPROVAL_LABEL];
  if (found.length === 0 || token === undefined) return [...found];
  const features = await startApprovalFeatures(
    token,
    deps.approvalKeys ?? [],
    doc.labels[LABEL_COMPOSE_PROJECT] ?? "",
  );
  return found.filter((violation) => {
    const feature = APPROVABLE_RULES[violation.rule.replace(/^start-/, "")];
    return feature === undefined || !features.includes(feature);
  });
}

/**
 * Start / restart: one inspect gives both the ownership check and the bind
 * policy over the container's live HostConfig. The engine resolves a bind
 * source again at start, so a verdict from create time can be stale (the
 * source swapped for a symlink since, or the container made before the gate
 * enforced). Fails closed like the ownership check.
 */
async function startFindings(
  name: string,
  deps: ReviewDeps,
): Promise<Violation[]> {
  const doc = await fetchContainerDoc(deps.connectUpstream, name);
  if (doc === undefined) {
    return [{ rule: "owner-unknown", detail: name.slice(0, 64) }];
  }
  const owned = ownerOf(doc.labels) === "unlabeled"
    ? [{ rule: "unowned-container", detail: name.slice(0, 64) }]
    : [];
  const binds = await evaluateStartBinds(doc, deps.policy, deps.resolvePath);
  for (const allowance of binds.allowances) deps.stats.allowance(allowance);
  return [
    ...owned,
    ...await applyStartApproval(doc, binds.violations, deps),
  ];
}

async function unownedFinding(
  facts: RequestFacts,
  deps: ReviewDeps,
): Promise<Violation[]> {
  const starting = startTarget(facts);
  if (starting !== undefined) return await startFindings(starting, deps);
  const subject = ownedSubject(facts);
  if (subject === undefined) return [];
  const labels = await fetchLabels(
    deps.connectUpstream,
    subject.kind,
    subject.name,
  );
  // Fail closed: a target whose labels cannot be read (gone, engine error,
  // odd name) is a finding of its own, never assumed owned.
  if (labels === undefined) {
    return [{ rule: "owner-unknown", detail: subject.name.slice(0, 64) }];
  }
  const platformRule = subject.kind === "container"
    ? platformAccessRule(routePath(facts.path), labels, facts.body)
    : undefined;
  if (platformRule !== undefined) {
    return [{ rule: platformRule, detail: subject.name.slice(0, 64) }];
  }
  if (ownerOf(labels) !== "unlabeled") return [];
  return [{
    rule: `unowned-${subject.kind}`,
    detail: subject.name.slice(0, 64),
  }];
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
