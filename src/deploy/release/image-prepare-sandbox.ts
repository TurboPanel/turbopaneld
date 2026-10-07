/**
 * The image builder's prepare step, run in the build sandbox.
 *
 * Before an image build, the image builder reads the checked-out repository
 * and writes a build plan. That step interprets everything the repository
 * holds, so on a managed host it runs exactly where release builds run: in a
 * transient `turbopanel-build-<id>.service`, as a throwaway user systemd
 * creates for that one build, in the site owner's build slice, with the same
 * limits, network rules and hidden paths (`./build-sandbox.ts`). It never runs
 * as the daemon account.
 *
 * The build's user cannot reach the vendored tool under `/opt/turbopanel`, so
 * the daemon copies it into the work tree first (it is a public build tool;
 * the copy is the build's own, and the daemon never runs it). The plan is
 * written inside the work tree and, once `build-return` has given the tree
 * back, copied out as one regular file checked on its opened handle, so a
 * build that swapped it for a link cannot make the daemon read anything else.
 */

import { join } from "@std/path";
import type { CommandSummaryRedactor } from "../../logs/contracts.ts";
import type { RunFn } from "../ensure-principal.ts";
import {
  type BuildWork,
  renderBuildSpec,
  runSandboxedBuild,
} from "./build-sandbox.ts";
import type { ReleaseOutputHandler } from "./checkout.ts";
import { copyRegularFile, UnsafeTreeError } from "./safe-copy.ts";

/** Where the daemon puts the tool inside the work tree. */
const TOOLS_DIR = "tools";
/** The plan file the prepare step writes, inside the work tree. */
const PLAN_FILE = "image-plan.json";
/** A plan is a small JSON document; anything bigger is refused. */
export const IMAGE_PLAN_MAX_BYTES = 4 * 1024 * 1024;

/** The sandbox an image build's prepare step runs in. */
export type ImagePrepareSandbox = {
  work: BuildWork;
  /** The spec's cwd: `source`, or the declared subdirectory in it. */
  cwd: string;
  /** Privileged runner for `systemctl stop` and `build-return`. */
  runFn?: RunFn;
  /** Test seam — defaults to {@link runSandboxedBuild}. */
  run?: typeof runSandboxedBuild;
};

export type ImagePrepareParams = {
  sandbox: ImagePrepareSandbox;
  /** The vendored tool on the host. */
  tool: string;
  /** Its file name inside the work tree's `tools/`. */
  toolName: string;
  /** Arguments before the plan output flag, e.g. `["prepare", "."]`. */
  args: readonly string[];
  /** The flag that names the plan file, e.g. `--plan-out`. */
  planFlag: string;
  /** The build's variables: already filtered, shell names only. */
  env: Record<string, string>;
  /** Where the daemon's own copy of the plan goes (its scratch dir). */
  planDest: string;
  onOutput?: ReleaseOutputHandler;
  redactSummary?: CommandSummaryRedactor;
  signal?: AbortSignal;
};

/** A single quote inside a single-quoted shell word: close, escape, reopen. */
const QUOTED_QUOTE = String.raw`'\''`;

/** One shell word, single-quoted. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", QUOTED_QUOTE)}'`;
}

/**
 * The one command the spec runs: the tool copy in the work tree (`$HOME` is
 * the work tree), writing its plan next to it.
 */
export function imagePrepareCommand(
  toolName: string,
  args: readonly string[],
  planFlag: string,
): string {
  return [
    `"$HOME"/${TOOLS_DIR}/${shellQuote(toolName)}`,
    ...args.map(shellQuote),
    shellQuote(planFlag),
    `"$HOME"/${PLAN_FILE}`,
  ].join(" ");
}

/**
 * Run the prepare step in the build sandbox and leave the plan at
 * `params.planDest`. The work tree must be the daemon's, holding the checkout
 * (`createBuildWorkDir` then the clone); it is the daemon's again afterwards.
 */
export async function prepareImagePlanInSandbox(
  params: ImagePrepareParams,
): Promise<void> {
  const { sandbox } = params;
  const toolsDir = join(sandbox.work.workDir, TOOLS_DIR);
  await Deno.mkdir(toolsDir, { recursive: true, mode: 0o700 });
  const copy = join(toolsDir, params.toolName);
  await Deno.copyFile(params.tool, copy);
  // Owner-only: the unit hands the whole work tree to the build's user before
  // the spec runs, so that user is this copy's owner.
  await Deno.chmod(copy, 0o700);
  const spec = renderBuildSpec({
    cwd: sandbox.cwd,
    env: params.env,
    commands: [
      imagePrepareCommand(params.toolName, params.args, params.planFlag),
    ],
  });
  await (sandbox.run ?? runSandboxedBuild)({
    work: sandbox.work,
    spec,
    ...(params.onOutput === undefined ? {} : { onOutput: params.onOutput }),
    ...(params.redactSummary === undefined
      ? {}
      : { redactSummary: params.redactSummary }),
    ...(sandbox.runFn === undefined ? {} : { runFn: sandbox.runFn }),
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  });
  await takePlan(join(sandbox.work.workDir, PLAN_FILE), params.planDest);
}

/**
 * Copy the plan the build wrote out of the returned work tree: a regular
 * file (never a link or anything else), at most {@link IMAGE_PLAN_MAX_BYTES},
 * checked on the opened handle.
 */
export async function takePlan(source: string, dest: string): Promise<void> {
  const info = await Deno.lstat(source).catch((err) => {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  });
  if (info === null) {
    throw new Error("the image builder's prepare step wrote no build plan");
  }
  if (!info.isFile) {
    throw new UnsafeTreeError(
      "refusing the build plan: it is not a regular file",
    );
  }
  if (info.size > IMAGE_PLAN_MAX_BYTES) {
    throw new UnsafeTreeError(
      `refusing the build plan: larger than ${IMAGE_PLAN_MAX_BYTES} bytes`,
    );
  }
  await copyRegularFile(source, dest, info);
}
