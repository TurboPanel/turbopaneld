#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-run --allow-env
import { runBootstrapOrchestration } from "../src/orchestration/bootstrap-once.ts";
import { InstallerPresentedFailure } from "../src/orchestration/install-presenter-context.ts";
import { sanitizeForLog } from "../src/logger.ts";

export type BootstrapOrchestrationCliIo = {
  run?: () => Promise<void>;
  exit?: (code: number) => void;
  error?: (message: string) => void;
};

/** CLI wrapper around {@link runBootstrapOrchestration}. */
export async function runBootstrapOrchestrationCli(
  io: BootstrapOrchestrationCliIo = {},
): Promise<void> {
  const exitFn = io.exit ?? ((code: number) => {
    Deno.exit(code);
  });
  const error = io.error ?? ((message: string) => {
    console.error(message);
  });
  try {
    await (io.run ?? runBootstrapOrchestration)();
  } catch (err) {
    if (err instanceof InstallerPresentedFailure) {
      exitFn(1);
      return;
    }
    error(`[bootstrap] ${sanitizeForLog(err)}`);
    exitFn(1);
  }
}

if (import.meta.main) {
  await runBootstrapOrchestrationCli();
}
