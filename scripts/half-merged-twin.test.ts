import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  findHalfMergedTwin,
  isTwinBranch,
  main,
  type Side,
  type SideListing,
  type TwinPull,
} from "./half-merged-twin.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROOT = join(fromFileUrl(new URL(".", import.meta.url)), "..");

const SELF = "TurboPanel/turbopaneld";
const SIBLING = "TurboPanel/turbopanel";

function merged(branch: string, number: number, commit: string): TwinPull {
  return { branch, number, mergeCommit: commit };
}

function open(branch: string, number: number): TwinPull {
  return { branch, number, mergeCommit: null };
}

function side(repo: string, pulls: TwinPull[]): SideListing {
  return {
    repo,
    open: pulls.filter((p) => p.mergeCommit === null),
    merged: pulls.filter((p) => p.mergeCommit !== null),
  };
}

/** `contains` that knows which merge commits each checked tree holds. */
function holds(trees: Record<Side, string[]>) {
  return (s: Side, commit: string) =>
    Promise.resolve(trees[s].includes(commit));
}

test("control plane half merged first: check the daemon twin's merge ref", async () => {
  const twin = await findHalfMergedTwin(
    side(SELF, [open("feat/wire", 774), merged("fix/other", 770, "d1")]),
    side(SIBLING, [merged("feat/wire", 885, "p1")]),
    holds({ self: ["d1"], sibling: ["p1"] }),
  );
  assertEquals(twin?.branch, "feat/wire");
  assertEquals(twin?.leading, "sibling");
  assertEquals(twin?.lagging, "self");
  assertEquals(twin?.laggingRef, "refs/pull/774/merge");
});

test("the other half merged after this tree was checked out: use its merge commit", async () => {
  const twin = await findHalfMergedTwin(
    side(SELF, [merged("feat/wire", 753, "d2")]),
    side(SIBLING, [merged("feat/wire", 880, "p2")]),
    holds({ self: ["d2"], sibling: [] }),
  );
  assertEquals(twin?.lagging, "sibling");
  assertEquals(twin?.laggingRef, "p2");
  assertEquals(twin?.leadingPull.number, 753);
});

test("a twin both trees already hold, or neither holds, explains nothing", async () => {
  const both = await findHalfMergedTwin(
    side(SELF, [merged("feat/wire", 1, "d")]),
    side(SIBLING, [merged("feat/wire", 2, "p")]),
    holds({ self: ["d"], sibling: ["p"] }),
  );
  assertEquals(both, null);
  const neither = await findHalfMergedTwin(
    side(SELF, [open("feat/wire", 1)]),
    side(SIBLING, [merged("feat/wire", 2, "p")]),
    holds({ self: [], sibling: [] }),
  );
  assertEquals(neither, null);
});

test("only a branch name on both sides pairs, and version or promotion branches never do", async () => {
  assertEquals(
    await findHalfMergedTwin(
      side(SELF, [merged("version/0.1.19", 1, "d")]),
      side(SIBLING, [open("version/0.1.19", 2)]),
      holds({ self: ["d"], sibling: [] }),
    ),
    null,
  );
  assertEquals(
    await findHalfMergedTwin(
      side(SELF, [merged("feat/a", 1, "d")]),
      side(SIBLING, [open("feat/b", 2)]),
      holds({ self: ["d"], sibling: [] }),
    ),
    null,
  );
  for (
    const name of ["trunk", "staging", "live", "promote/v1", "dependabot/x"]
  ) {
    assert(!isTwinBranch(name), name);
  }
  assert(isTwinBranch("trust/rotation-key-signature"));
  assert(!isTwinBranch("bad..name"));
});

/** A fake GitHub API: path -> JSON body (a number is an HTTP error status). */
function fakeFetch(routes: Record<string, unknown>) {
  const fn = (url: string, init: RequestInit) => {
    const path = url.replace("https://api.github.com/", "");
    assertEquals(
      (init.headers as Record<string, string>).Authorization,
      "Bearer t0ken",
    );
    const body = routes[path];
    if (body === undefined) {
      return Promise.resolve(new Response("missing", { status: 404 }));
    }
    if (typeof body === "number") {
      return Promise.resolve(new Response("boom", { status: body }));
    }
    return Promise.resolve(Response.json(body));
  };
  return { fn };
}

const ENV: Record<string, string> = {
  GH_TOKEN: "t0ken",
  SELF_REPO: SELF,
  SIBLING_REPO: SIBLING,
  SELF_SHA: "a".repeat(40),
  SIBLING_SHA: "b".repeat(40),
};

const OPEN = "pulls?state=open&base=trunk&per_page=100";
const CLOSED =
  "pulls?state=closed&base=trunk&sort=updated&direction=desc&per_page=50";

function apiPull(ref: string, number: number, mergeSha: string | null) {
  return {
    number,
    head: { ref },
    merged_at: mergeSha ? "2026-11-10T01:36:17Z" : null,
    merge_commit_sha: mergeSha,
  };
}

async function run(routes: Record<string, unknown>, env = ENV) {
  const out: string[] = [];
  const err: string[] = [];
  const { fn } = fakeFetch(routes);
  const code = await main(
    (n) => env[n],
    fn,
    (l) => out.push(l),
    (l) => err.push(l),
  );
  return { code, out, err };
}

test("main prints the lagging side's ref and a note for GITHUB_OUTPUT", async () => {
  const { code, out, err } = await run({
    [`repos/${SELF}/${OPEN}`]: [apiPull("feat/wire", 774, null)],
    [`repos/${SELF}/${CLOSED}`]: [apiPull("closed/unmerged", 9, null)],
    [`repos/${SIBLING}/${OPEN}`]: [],
    [`repos/${SIBLING}/${CLOSED}`]: [apiPull("feat/wire", 885, "p1")],
    [`repos/${SIBLING}/compare/p1...${"b".repeat(40)}`]: { status: "ahead" },
  });
  assertEquals(err, []);
  assertEquals(code, 0);
  assertEquals(out.slice(0, 3), [
    "twin=feat/wire",
    "self-ref=refs/pull/774/merge",
    "sibling-ref=",
  ]);
  assertStringIncludes(out[3], "note=contract drift at aaaaaaa");
  assertStringIncludes(out[3], `${SIBLING}#885 is merged`);
  assertStringIncludes(out[3], `${SELF}#774 is still open`);
});

test("main fails closed: no twin, an API error or a missing setting is exit 1", async () => {
  const none = await run({
    [`repos/${SELF}/${OPEN}`]: [],
    [`repos/${SELF}/${CLOSED}`]: [],
    [`repos/${SIBLING}/${OPEN}`]: [],
    [`repos/${SIBLING}/${CLOSED}`]: [],
  });
  assertEquals(none.code, 1);
  assertStringIncludes(none.err[0], "this drift is real");

  const broken = await run({
    [`repos/${SELF}/${OPEN}`]: 502,
    [`repos/${SELF}/${CLOSED}`]: [],
    [`repos/${SIBLING}/${OPEN}`]: [],
    [`repos/${SIBLING}/${CLOSED}`]: [],
  });
  assertEquals(broken.code, 1);
  assertStringIncludes(broken.err[0], "HTTP 502");

  const unset = await run({}, { ...ENV, SIBLING_SHA: "" });
  assertEquals(unset.code, 1);
  assertStringIncludes(unset.err[0], "SIBLING_SHA is not set");
  assertEquals(unset.out, []);
});

test("verify.yml: strict on feature pull requests, the twin look only on trunk", () => {
  const verify = Deno.readTextFileSync(
    join(ROOT, ".github/workflows/verify.yml"),
  );
  assertStringIncludes(
    verify,
    "continue-on-error: ${{ github.event_name != 'pull_request' || (github.head_ref == 'trunk' && github.base_ref == 'staging' && github.event.pull_request.head.repo.full_name == github.repository) }}",
  );
  assertStringIncludes(verify, "if: steps.drift.outcome == 'failure'");
  assertStringIncludes(verify, "scripts/half-merged-twin.ts");
  assertStringIncludes(
    verify,
    "if: steps.twin.outputs.self-ref != ''",
  );
  assertStringIncludes(
    verify,
    "if: steps.twin.outputs.sibling-ref != ''",
  );
  // The second check runs only after the twin look succeeded and has no
  // continue-on-error, so a drift the twin does not explain stays red.
  const at = verify.indexOf(
    "- name: Check contract drift with both halves of the twin",
  );
  assert(at >= 0, "the second check step is missing");
  const recheck = verify.slice(at);
  const step = recheck.slice(0, recheck.indexOf("\n\n"));
  assert(!step.includes("continue-on-error"), step);
  assertStringIncludes(step, "deno task check:contract-drift");
});
