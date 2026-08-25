#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-run
import { runBuildToggle } from "../src/orchestration/ansible.ts";

export function parseArg(
  name: string,
  args: string[] = Deno.args,
): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

export type BuildToggleCliArgs = {
  uiMode: "dev" | "static";
  instanceRunMode: "source" | "compiled";
  forceBuild: boolean;
};

export function parseBuildToggleArgs(
  args: string[] = Deno.args,
): BuildToggleCliArgs {
  const uiMode = parseArg("ui-mode", args);
  const instanceRunMode = parseArg("instance-run-mode", args);
  const forceBuild = parseArg("force-build", args) === "true";

  if (uiMode !== "dev" && uiMode !== "static") {
    throw new TypeError("Missing or invalid --ui-mode=dev|static");
  }

  if (instanceRunMode !== "source" && instanceRunMode !== "compiled") {
    throw new TypeError(
      "Missing or invalid --instance-run-mode=source|compiled",
    );
  }

  return { uiMode, instanceRunMode, forceBuild };
}

if (import.meta.main) {
  try {
    const parsed = parseBuildToggleArgs();
    await runBuildToggle(parsed);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error),
    );
    Deno.exit(1);
  }
}
