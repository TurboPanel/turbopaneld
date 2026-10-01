/**
 * Counters for the gate's periodic summary line: which routes were seen, with
 * which status, how many upgrades, and how many times each strict-profile rule
 * would have fired. Together with the per-finding log lines this is the
 * observe-mode corpus the strict profile is tuned against.
 *
 * Dependency-free on purpose (see http.ts).
 */

export type StatsSnapshot = {
  requests: Array<
    { route: string; method: string; status: number; count: number }
  >;
  upgrades: Record<string, number>;
  wouldDeny: Record<string, number>;
  refusals: Record<string, number>;
  /** Platform allowances that removed a finding, by name. */
  allowances: Record<string, number>;
  /** Signed approvals by outcome (`accepted`, `rejected:<reason>`). */
  approvals: Record<string, number>;
  /** Findings an accepted approval covered, by rule. */
  approvedRules: Record<string, number>;
  /** Container creates by owner class (`platform` / `tenant` / `unlabeled`). */
  owners: Record<string, number>;
};

function byKey(a: [string, number], b: [string, number]): number {
  return a[0].localeCompare(b[0]);
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function toRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].toSorted(byKey));
}

export class GateStats {
  private readonly requests = new Map<string, number>();
  private readonly upgrades = new Map<string, number>();
  private readonly wouldDeny = new Map<string, number>();
  private readonly refusals = new Map<string, number>();
  private readonly allowances = new Map<string, number>();
  private readonly approvals = new Map<string, number>();
  private readonly approvedRules = new Map<string, number>();
  private readonly owners = new Map<string, number>();

  request(route: string, method: string, status: number): void {
    bump(this.requests, `${route}\t${method}\t${status}`);
  }

  upgrade(route: string): void {
    bump(this.upgrades, route);
  }

  violation(rule: string): void {
    bump(this.wouldDeny, rule);
  }

  refusal(status: number): void {
    bump(this.refusals, String(status));
  }

  allowance(name: string): void {
    bump(this.allowances, name);
  }

  approval(outcome: string): void {
    bump(this.approvals, outcome);
  }

  approvedRule(rule: string): void {
    bump(this.approvedRules, rule);
  }

  owner(owner: string): void {
    bump(this.owners, owner);
  }

  snapshot(): StatsSnapshot {
    const requests = [...this.requests.entries()].toSorted(byKey).map(
      ([key, count]) => {
        const [route, method, status] = key.split("\t");
        return { route, method, status: Number(status), count };
      },
    );
    return {
      requests,
      upgrades: toRecord(this.upgrades),
      wouldDeny: toRecord(this.wouldDeny),
      refusals: toRecord(this.refusals),
      allowances: toRecord(this.allowances),
      approvals: toRecord(this.approvals),
      approvedRules: toRecord(this.approvedRules),
      owners: toRecord(this.owners),
    };
  }
}
