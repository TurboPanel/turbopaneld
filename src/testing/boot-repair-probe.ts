import { repairProxySqlFrontendAtBoot } from "../managed/proxysql-boot-repair.ts";
import type { LayoutPaths } from "../paths/layout.ts";

/**
 * Runs the ProxySQL boot repair against a stopped container and an on-disk
 * compose that publishes nothing, reporting whether it ran `compose up`.
 */
export async function probeBootRepair(
  layout: LayoutPaths,
): Promise<{ result: string; upCalls: number }> {
  let upCalls = 0;
  const result = await repairProxySqlFrontendAtBoot(layout, {
    runDocker: (args) => {
      if (args.includes("up")) upCalls += 1;
      return Promise.resolve(
        { success: true, stdout: "", stderr: "", code: 0 },
      );
    },
    readCompose: () => Promise.resolve("services:\n  proxysql: {}\n"),
    localAddresses: () => [],
    sleep: () => Promise.resolve(),
    info: () => {},
    warn: () => {},
    budgetMs: 10_000,
  });
  return { result, upCalls };
}
