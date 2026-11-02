/**
 * Pick the turbopanel branch the contract-drift job in verify.yml checks out.
 *
 * Default (unchanged): the branch with this pull request's name in
 * TurboPanel/turbopanel, else trunk. Promotion pull requests (head or base
 * staging/live) always use trunk.
 *
 * Override: a pull request from a fork, or one whose control plane twin has
 * another name, can name the sibling branch with one line in its
 * description:
 *
 *   Sibling-Branch: feat/my-panel-change
 *
 * The branch must exist in TurboPanel/turbopanel (a maintainer pushes it
 * there for a fork). The description is untrusted text: it only ever comes
 * in through the environment, and the value must match SAFE_BRANCH or the
 * job fails without echoing it.
 *
 *   deno run --allow-env scripts/resolve-sibling-ref.ts           # candidate= and source=
 *   deno run --allow-env scripts/resolve-sibling-ref.ts summary   # the job summary
 *
 * Environment: HEAD_REF, BASE_REF, PR_BODY (resolve); SIBLING_REPO, REF,
 * SOURCE (summary). The control plane repository keeps a twin of this logic
 * in scripts/resolve-sibling-ref.mjs; change both together.
 */

export const SIBLING_BRANCH_KEY = "Sibling-Branch";

const SAFE_BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
// Column 0 only, so an indented example in a code block never counts.
const KEY_LINE = /^sibling-branch[ \t]*:(.*)$/i;
const PROMOTION_BRANCHES = new Set(["staging", "live"]);

/** Where the sibling ref came from. */
export type SiblingSource =
  | "promotion"
  | "override"
  | "same-name"
  | "trunk-fallback";

/** A resolved candidate, or the reason the description was refused. */
export type SiblingResolution =
  | { candidate: string; source: SiblingSource }
  | { error: string };

/** True when `name` is a plain branch name that is safe to put in a URL and an output line. */
export function isSafeBranchName(name: unknown): boolean {
  if (typeof name !== "string" || !SAFE_BRANCH.test(name)) return false;
  if (name.startsWith("-") || name.startsWith(".") || name.startsWith("/")) {
    return false;
  }
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) {
    return false;
  }
  return !name.includes("..") && !name.includes("//") && !name.includes("/.");
}

/**
 * Read the optional `Sibling-Branch:` line from a pull request description.
 * Returns `{ branch: null }` when there is none, `{ error }` when the line is
 * repeated or its value is not a safe branch name.
 */
export function parseSiblingBranch(
  body: string | undefined,
): { branch: string | null } | { error: string } {
  const values: string[] = [];
  for (const line of (body ?? "").split(/\r?\n/)) {
    const match = KEY_LINE.exec(line);
    if (match) values.push(match[1].trim());
  }
  if (values.length === 0) return { branch: null };
  if (values.length > 1) {
    return {
      error: `the description has more than one ${SIBLING_BRANCH_KEY} line`,
    };
  }
  if (!isSafeBranchName(values[0])) {
    return {
      error: `the ${SIBLING_BRANCH_KEY} value is not a plain branch name ` +
        '(letters, digits, ".", "_", "-" and "/", at most 100 characters)',
    };
  }
  return { branch: values[0] };
}

/**
 * The branch to try first and why. `source` is `promotion` (always trunk),
 * `override` (named in the description) or `same-name` (this pull request's
 * own branch name, which falls back to trunk when the sibling lacks it).
 */
export function resolveSiblingRef(
  opts: { headRef: string; baseRef: string; prBody: string },
): SiblingResolution {
  if (
    PROMOTION_BRANCHES.has(opts.headRef) || PROMOTION_BRANCHES.has(opts.baseRef)
  ) {
    return { candidate: "trunk", source: "promotion" };
  }
  const parsed = parseSiblingBranch(opts.prBody);
  if ("error" in parsed) return parsed;
  if (parsed.branch) return { candidate: parsed.branch, source: "override" };
  return { candidate: opts.headRef || "trunk", source: "same-name" };
}

const HOW: Record<SiblingSource, string> = {
  promotion: "promotion pull requests always compare against trunk",
  override:
    `named by the ${SIBLING_BRANCH_KEY} line in the pull request description`,
  "same-name": "the branch with the same name as this one",
  "trunk-fallback": "trunk, because no branch with the same name exists there",
};

/** Markdown for the job summary: which sibling ref was used, and the twin merge order. */
export function summaryMarkdown(
  opts: { siblingRepo: string; ref: string; source: string },
): string {
  const how = HOW[opts.source as SiblingSource] ?? opts.source;
  const lines = [
    "### Contract sibling",
    "",
    `Checked against \`${opts.siblingRepo}\` at \`${opts.ref}\` (${how}).`,
  ];
  if (opts.source === "trunk-fallback") {
    lines.push(
      "",
      `To compare against another branch of \`${opts.siblingRepo}\`, add a line ` +
        `\`${SIBLING_BRANCH_KEY}: <branch>\` to the pull request description and re-run this job. ` +
        "For a pull request from a fork, a maintainer first pushes the matching branch to the " +
        "TurboPanel repository.",
    );
  }
  if (opts.ref !== "trunk") {
    lines.push(
      "",
      "Twin pull requests: when a change touches the messages between the control plane and " +
        "the daemon, merge the turbopanel pull request first, then the turbopaneld one.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** CLI entry: resolve (default) or `summary`. Returns the exit code. */
export function main(
  args: string[],
  env: (name: string) => string | undefined,
  write: (text: string) => void,
): number {
  if (args[0] === "summary") {
    write(summaryMarkdown({
      siblingRepo: env("SIBLING_REPO") ?? "",
      ref: env("REF") ?? "",
      source: env("SOURCE") ?? "",
    }));
    return 0;
  }
  const result = resolveSiblingRef({
    headRef: env("HEAD_REF") ?? "",
    baseRef: env("BASE_REF") ?? "",
    prBody: env("PR_BODY") ?? "",
  });
  if ("error" in result) {
    write(`::error title=${SIBLING_BRANCH_KEY}::${result.error}\n`);
    return 1;
  }
  write(`candidate=${result.candidate}\nsource=${result.source}\n`);
  return 0;
}

if (import.meta.main) {
  const encoder = new TextEncoder();
  Deno.exitCode = main(
    Deno.args,
    (name) => Deno.env.get(name),
    (text) => Deno.stdout.writeSync(encoder.encode(text)),
  );
}
