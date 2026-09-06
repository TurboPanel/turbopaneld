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

export type BuildToggleCliIo = {
  args?: string[];
  run?: (parsed: BuildToggleCliArgs) => Promise<void>;
  exit?: (code: number) => void;
  error?: (message: string) => void;
};

/** CLI wrapper around {@link runBuildToggle}. */
export async function runBuildToggleCli(
  io: BuildToggleCliIo = {},
): Promise<void> {
  const exitFn = io.exit ?? ((code: number) => {
    Deno.exit(code);
  });
  const error = io.error ?? ((message: string) => {
    console.error(message);
  });
  try {
    const parsed = parseBuildToggleArgs(io.args ?? Deno.args);
    await (io.run ?? runBuildToggle)(parsed);
  } catch (error_) {
    error(error_ instanceof Error ? error_.message : String(error_));
    exitFn(1);
  }
}

if (import.meta.main) {
  await runBuildToggleCli();
}
