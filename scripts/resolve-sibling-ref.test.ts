import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  isSafeBranchName,
  main,
  parseSiblingBranch,
  resolveSiblingRef,
  summaryMarkdown,
} from "./resolve-sibling-ref.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROOT = join(fromFileUrl(new URL(".", import.meta.url)), "..");

/** The error text of a parse or resolve result ("" when it succeeded). */
function errorOf(result: object): string {
  return "error" in result && typeof result.error === "string"
    ? result.error
    : "";
}

test("resolveSiblingRef keeps the same-named default without an override", () => {
  assertEquals(
    resolveSiblingRef({ headRef: "feat/x", baseRef: "trunk", prBody: "Hi" }),
    { candidate: "feat/x", source: "same-name" },
  );
  assertEquals(resolveSiblingRef({ headRef: "", baseRef: "", prBody: "" }), {
    candidate: "trunk",
    source: "same-name",
  });
});

test("resolveSiblingRef uses the Sibling-Branch line when present", () => {
  assertEquals(
    resolveSiblingRef({
      headRef: "patch-1",
      baseRef: "trunk",
      prBody: "Summary\r\n\r\nSibling-Branch: feat/panel-side\r\n",
    }),
    { candidate: "feat/panel-side", source: "override" },
  );
  assertEquals(
    resolveSiblingRef({
      headRef: "patch-1",
      baseRef: "trunk",
      prBody: "sibling-branch:x.y",
    }),
    { candidate: "x.y", source: "override" },
  );
  // An indented line (a code block example) is not an override.
  assertEquals(
    resolveSiblingRef({
      headRef: "patch-1",
      baseRef: "trunk",
      prBody: "    Sibling-Branch: a b",
    }),
    { candidate: "patch-1", source: "same-name" },
  );
});

test("resolveSiblingRef always uses trunk for promotion pull requests", () => {
  for (
    const [headRef, baseRef] of [
      ["trunk", "staging"],
      ["staging", "live"],
      ["staging", "trunk"],
      ["live", ""],
    ]
  ) {
    assertEquals(
      resolveSiblingRef({ headRef, baseRef, prBody: "Sibling-Branch: feat/x" }),
      { candidate: "trunk", source: "promotion" },
    );
  }
});

test("resolveSiblingRef refuses an unsafe or repeated override without echoing it", () => {
  const result = resolveSiblingRef({
    headRef: "a",
    baseRef: "trunk",
    prBody: "Sibling-Branch: x$(curl evil)`id`",
  });
  assertStringIncludes(errorOf(result), "not a plain branch");
  assert(!errorOf(result).includes("curl"));
  assertStringIncludes(
    errorOf(parseSiblingBranch("Sibling-Branch: a\nSibling-Branch: b")),
    "more than one",
  );
  assertStringIncludes(
    errorOf(parseSiblingBranch("Sibling-Branch:")),
    "not a plain branch",
  );
});

test("isSafeBranchName accepts plain names and rejects the rest", () => {
  for (const name of ["trunk", "feat/x", "fix/a.b_c-d", "a".repeat(100)]) {
    assert(isSafeBranchName(name), name);
  }
  for (
    const name of [
      "",
      "a".repeat(101),
      "a b",
      "a;b",
      "a\nb",
      "$x",
      "-x",
      ".x",
      "/x",
      "x/",
      "x.",
      "x.lock",
      "a..b",
      "a//b",
      "a/.b",
      "refs:heads",
      undefined,
    ]
  ) {
    assert(!isSafeBranchName(name), JSON.stringify(name));
  }
});

test("summaryMarkdown names the ref, the override hint and the merge order", () => {
  const siblingRepo = "TurboPanel/turbopanel";
  const twin = summaryMarkdown({
    siblingRepo,
    ref: "feat/x",
    source: "override",
  });
  assertStringIncludes(twin, "`TurboPanel/turbopanel` at `feat/x`");
  assertStringIncludes(twin, "merge the turbopanel pull request first");
  const fallback = summaryMarkdown({
    siblingRepo,
    ref: "trunk",
    source: "trunk-fallback",
  });
  assertStringIncludes(fallback, "Sibling-Branch: <branch>");
  assert(!fallback.includes("merge the turbopanel pull request first"));
});

test("main prints the candidate, the summary, or an error line", () => {
  const run = (args: string[], vars: Record<string, string>) => {
    let out = "";
    const code = main(args, (name) => vars[name], (text) => (out += text));
    return { code, out };
  };
  assertEquals(
    run([], { HEAD_REF: "feat/x", BASE_REF: "trunk", PR_BODY: "" }),
    { code: 0, out: "candidate=feat/x\nsource=same-name\n" },
  );
  const bad = run([], { HEAD_REF: "a", PR_BODY: "Sibling-Branch: a b" });
  assertEquals(bad.code, 1);
  assert(bad.out.startsWith("::error title=Sibling-Branch::"));
  const summary = run(["summary"], {
    SIBLING_REPO: "TurboPanel/turbopanel",
    REF: "trunk",
    SOURCE: "same-name",
  });
  assertEquals(summary.code, 0);
  assertStringIncludes(summary.out, "### Contract sibling");
});

test("verify.yml reads the description through the environment only", () => {
  const verify = Deno.readTextFileSync(
    join(ROOT, ".github/workflows/verify.yml"),
  );
  assert(
    !/\$\{\{\s*github\.event\.pull_request\.body/.test(
      verify.replace(/EVENT_BODY: .*/, ""),
    ),
  );
  assertStringIncludes(
    verify,
    "EVENT_BODY: ${{ github.event.pull_request.body }}",
  );
  assertStringIncludes(verify, "scripts/resolve-sibling-ref.ts");
  assertStringIncludes(verify, "name: Note a skipped code scan");
  assertStringIncludes(verify, "::notice title=Code scan skipped::");
});
