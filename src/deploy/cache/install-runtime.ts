/**
 * Vendor the cache engine (Valkey) on first use, the same way the tenant Node
 * and Deno runtimes are: the `cache-runtime-apply.yml` playbook runs only when
 * the pinned binary is missing. A missing playbook is a failure here (unlike
 * the tenant runtimes there is no other way the binary gets onto the host).
 */

import {
  devOwnershipPlaybookExtraArgs,
  runLocalPlaybook,
} from "../../orchestration/ansible.ts";
import type { AnsibleEventHandler } from "../../orchestration/ansible-events.ts";
import { CACHE_RUNTIME_APPLY_PLAYBOOK } from "../../orchestration/assets.ts";
import { logInfo } from "../../util/logger.ts";

export type CacheRuntimePlaybookFn = (
  playbookPath: string,
  extraArgs: string[],
  onEvent?: AnsibleEventHandler,
) => Promise<void>;

/** Run the playbook that vendors the pinned Valkey release. */
export async function installCacheRuntime(
  patch: string,
  opts: {
    runPlaybook?: CacheRuntimePlaybookFn;
    onEvent?: AnsibleEventHandler;
  } = {},
): Promise<void> {
  logInfo("deploy", `vendoring the cache engine ${patch}`);
  const run: CacheRuntimePlaybookFn = opts.runPlaybook ??
    ((playbook, extraArgs, onEvent) =>
      runLocalPlaybook(playbook, extraArgs, onEvent));
  try {
    await run(
      CACHE_RUNTIME_APPLY_PLAYBOOK,
      [...devOwnershipPlaybookExtraArgs()],
      opts.onEvent,
    );
  } catch (err) {
    throw new Error(
      `could not install the cache engine ${patch}: ${
        err instanceof Error && err.message
          ? err.message
          : "the playbook failed"
      }`,
    );
  }
}
