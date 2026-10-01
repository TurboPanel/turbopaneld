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
    };
  }
}
