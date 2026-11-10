/**
 * Explain a contract-drift failure on trunk by a wire twin that is merged on
 * one side only.
 *
 * Wire twins (a daemon and a control plane pull request with the same branch
 * name) are merged one after the other, control plane first. Between the two
 * merges one trunk has the twin and the other does not, so the trunk build of
 * any commit in that window fails contract drift although nothing is wrong.
 * The contract-drift job in verify.yml runs the strict check first; only when
 * it fails on trunk (a push, a manual run, or the Release Candidate pull
 * request, whose head is trunk) does it run this script, which looks for that
 * window and nothing else:
 *
 *   a branch name with a pull request merged into trunk on one side whose
 *   merge commit the checked tree contains, and on the other side a pull
 *   request that is still open or was merged after the checked tree.
 *
 * It prints the ref to check the lagging side out at (the open pull
 * request's `refs/pull/<n>/merge`, or the later merge commit) and the job
 * runs the same strict check again with it. That second check must pass, or
 * the job stays red: a drift that the twin does not explain is still a
 * failure. No twin found, or an API error, is a failure too (fail closed).
 *
 *   deno run --allow-env=... --allow-net=api.github.com scripts/half-merged-twin.ts
 *
 * Environment: SELF_REPO and SIBLING_REPO (owner/name), SELF_SHA and
 * SIBLING_SHA (the checked commits), GH_TOKEN. Prints `twin=`, `self-ref=`,
 * `sibling-ref=` and `note=` lines for GITHUB_OUTPUT. The control plane
 * repository keeps a twin of this logic in scripts/half-merged-twin.mjs;
 * change both together.
 */
import { isSafeBranchName } from "./resolve-sibling-ref.ts";

/** One pull request into trunk; `mergeCommit` is null while it is open. */
export interface TwinPull {
  branch: string;
  number: number;
  mergeCommit: string | null;
}

/** The open and recently merged pull requests into one repository's trunk, newest first. */
export interface SideListing {
  repo: string;
  open: TwinPull[];
  merged: TwinPull[];
}

export type Side = "self" | "sibling";

/** A twin merged on `leading` (inside the checked tree) and not yet on `lagging`. */
export interface HalfMergedTwin {
  branch: string;
  leading: Side;
  lagging: Side;
  leadingPull: TwinPull;
  laggingPull: TwinPull;
  /** Where to check the lagging side out so it holds the twin. */
  laggingRef: string;
}

/** Branches that pair by name in both repositories but are never wire twins. */
const NOT_TWINS = /^(trunk|staging|live)$|^(version|promote|dependabot)\//;

/** True when a branch name can name a wire twin. */
export function isTwinBranch(branch: string): boolean {
  return isSafeBranchName(branch) && !NOT_TWINS.test(branch);
}

/** Where a side stands on one twin branch. */
type SideState =
  | { kind: "in"; pull: TwinPull }
  | { kind: "lagging"; pull: TwinPull; ref: string }
  | { kind: "none" };

async function sideState(
  listing: SideListing,
  side: Side,
  branch: string,
  contains: (side: Side, commit: string) => Promise<boolean>,
): Promise<SideState> {
  const merged = listing.merged.find((p) => p.branch === branch);
  if (merged?.mergeCommit) {
    if (await contains(side, merged.mergeCommit)) {
      return { kind: "in", pull: merged };
    }
    return { kind: "lagging", pull: merged, ref: merged.mergeCommit };
  }
  const open = listing.open.find((p) => p.branch === branch);
  if (open) {
    return {
      kind: "lagging",
      pull: open,
      ref: `refs/pull/${open.number}/merge`,
    };
  }
  return { kind: "none" };
}

/** Branch names that appear on both sides, newest merge first. */
function pairedBranches(self: SideListing, sibling: SideListing): string[] {
  const names = (l: SideListing) =>
    new Set([...l.merged, ...l.open].map((p) => p.branch));
  const selfNames = names(self);
  const siblingNames = names(sibling);
  const ordered = [...self.merged, ...sibling.merged].map((p) => p.branch);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const branch of ordered) {
    if (seen.has(branch)) continue;
    seen.add(branch);
    if (
      isTwinBranch(branch) && selfNames.has(branch) && siblingNames.has(branch)
    ) out.push(branch);
  }
  return out;
}

/**
 * The newest twin that is inside one checked tree and missing from the other,
 * or null. `contains(side, commit)` says whether that side's checked tree
 * holds the commit.
 */
export async function findHalfMergedTwin(
  self: SideListing,
  sibling: SideListing,
  contains: (side: Side, commit: string) => Promise<boolean>,
): Promise<HalfMergedTwin | null> {
  for (const branch of pairedBranches(self, sibling)) {
    const mine = await sideState(self, "self", branch, contains);
    const theirs = await sideState(sibling, "sibling", branch, contains);
    if (mine.kind === "in" && theirs.kind === "lagging") {
      return {
        branch,
        leading: "self",
        lagging: "sibling",
        leadingPull: mine.pull,
        laggingPull: theirs.pull,
        laggingRef: theirs.ref,
      };
    }
    if (theirs.kind === "in" && mine.kind === "lagging") {
      return {
        branch,
        leading: "sibling",
        lagging: "self",
        leadingPull: theirs.pull,
        laggingPull: mine.pull,
        laggingRef: mine.ref,
      };
    }
  }
  return null;
}

/** The GITHUB_OUTPUT lines for a found twin. */
export function outputLines(
  twin: HalfMergedTwin,
  repos: Record<Side, string>,
  checkedSha: string,
): string[] {
  const lagState = twin.laggingPull.mergeCommit
    ? "was merged after this tree was checked out"
    : "is still open";
  const lead = `${repos[twin.leading]}#${twin.leadingPull.number}`;
  const lag = `${repos[twin.lagging]}#${twin.laggingPull.number}`;
  const note = [
    `contract drift at ${checkedSha.slice(0, 7)} is the half-merged wire twin`,
    `${twin.branch}: ${lead} is merged, ${lag} ${lagState}.`,
    "The contracts match with both halves in, so this check passed with a warning.",
  ].join(" ");
  return [
    `twin=${twin.branch}`,
    `self-ref=${twin.lagging === "self" ? twin.laggingRef : ""}`,
    `sibling-ref=${twin.lagging === "sibling" ? twin.laggingRef : ""}`,
    `note=${note}`,
  ];
}

interface ApiPull {
  number: number;
  head: { ref: string };
  merged_at: string | null;
  merge_commit_sha: string | null;
}

/** The GitHub REST calls this script makes, as one injectable function. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function client(token: string, fetchFn: FetchLike) {
  return async <T>(path: string): Promise<T> => {
    const res = await fetchFn(`https://api.github.com/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`GitHub API ${path}: HTTP ${res.status}`);
    }
    return await res.json() as T;
  };
}

type Api = ReturnType<typeof client>;

async function listing(api: Api, repo: string): Promise<SideListing> {
  const [open, closed] = await Promise.all([
    api<ApiPull[]>(`repos/${repo}/pulls?state=open&base=trunk&per_page=100`),
    api<ApiPull[]>(
      `repos/${repo}/pulls?state=closed&base=trunk&sort=updated&direction=desc&per_page=50`,
    ),
  ]);
  return {
    repo,
    open: open.map((p) => ({
      branch: p.head.ref,
      number: p.number,
      mergeCommit: null,
    })),
    merged: closed.filter((p) => p.merged_at && p.merge_commit_sha).map((
      p,
    ) => ({
      branch: p.head.ref,
      number: p.number,
      mergeCommit: p.merge_commit_sha,
    })),
  };
}

/**
 * Look once and print the outputs. Returns the exit code: 0 with a twin,
 * 1 without one or on any error (the drift then stays a failure).
 */
export async function main(
  getEnv: (name: string) => string | undefined,
  fetchFn: FetchLike,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  try {
    const need = (name: string): string => {
      const value = getEnv(name) ?? "";
      if (!value) throw new Error(`${name} is not set`);
      return value;
    };
    const api = client(need("GH_TOKEN"), fetchFn);
    const repos: Record<Side, string> = {
      self: need("SELF_REPO"),
      sibling: need("SIBLING_REPO"),
    };
    const checked: Record<Side, string> = {
      self: need("SELF_SHA"),
      sibling: need("SIBLING_SHA"),
    };
    const [self, sibling] = await Promise.all([
      listing(api, repos.self),
      listing(api, repos.sibling),
    ]);
    const contains = async (side: Side, commit: string): Promise<boolean> => {
      const { status } = await api<{ status: string }>(
        `repos/${repos[side]}/compare/${commit}...${checked[side]}`,
      );
      return status === "ahead" || status === "identical";
    };
    const twin = await findHalfMergedTwin(self, sibling, contains);
    if (!twin) {
      err(
        "::error title=Contract drift::no wire twin is merged on one side only, " +
          "so this drift is real: fix the contract on trunk",
      );
      return 1;
    }
    for (const line of outputLines(twin, repos, checked.self)) out(line);
    return 0;
  } catch (e) {
    err(
      `::error title=Contract drift::could not look for a half-merged wire twin: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(
    await main(
      (name) => Deno.env.get(name),
      fetch,
      (line) => console.log(line),
      (line) => console.error(line),
    ),
  );
}
