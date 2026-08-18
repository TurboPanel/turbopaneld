import { join } from "@std/path";
import {
  devOwnershipPlaybookExtraArgs,
  runLocalPlaybook,
} from "../orchestration/ansible.ts";
import { INSTANCE_CERTS_APPLY_PLAYBOOK } from "../orchestration/paths.ts";
import { resolveDevRoot, resolveLayout } from "../paths/layout.ts";
import { upsertPublicUrlsInEnv } from "./public-urls-env.ts";

function stripTrailingSlashes(path: string): string {
  let out = path;
  while (out.length > 1 && out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out.length > 0 ? out : "/";
}

function isCoLocatedDev(
  env: Record<string, string | undefined>,
): boolean {
  if (env.TURBOPANEL_DEV_USER?.trim()) return true;
  if (env.TURBOPANEL_DEV_INSTANCE === "1") return true;
  const mode = env.TURBOPANEL_MODE?.trim().toLowerCase();
  return mode === "development";
}

/**
 * Instance source tree for cert generation (`scripts/` + `certs/`).
 *
 * Co-located development uses the checkout (`TURBOPANEL_INSTANCE_REPO` or
 * `<devRoot>/turbopanel`). {@link resolveLayout}.instanceDir stays on the FHS
 * stub (`/opt/turbopanel/lib/instance`) for mutable install layout — that path
 * has no generate script, so public-urls apply must not use it in dev.
 */
export function resolveInstanceDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const explicit = env.TURBOPANEL_INSTANCE_DIR?.trim();
  if (explicit) {
    return stripTrailingSlashes(explicit);
  }

  const repo = env.TURBOPANEL_INSTANCE_REPO?.trim();
  if (repo) {
    return stripTrailingSlashes(repo);
  }

  if (isCoLocatedDev(env)) {
    return join(resolveDevRoot(env), "turbopanel");
  }

  return resolveLayout(env).instanceDir;
}

export {
  resolveInstanceConfigDir,
  resolveInstanceRuntimeEnvPath,
  upsertPublicUrlsInEnv,
} from "./public-urls-env.ts";

export async function runInstanceCertsApply(
  instanceDir: string,
  urls: string[],
  deps: {
    runPlaybook?: typeof runLocalPlaybook;
  } = {},
): Promise<void> {
  const args = [
    "-e",
    `turbopanel_instance_dir=${instanceDir}`,
    "-e",
    `turbopanel_public_urls=${urls.join(",")}`,
    ...devOwnershipPlaybookExtraArgs(),
  ];
  const runPlaybook = deps.runPlaybook ?? runLocalPlaybook;
  await runPlaybook(INSTANCE_CERTS_APPLY_PLAYBOOK, args);
}

export async function applyPublicUrls(
  urls: string[],
  deps: {
    runCertsApply?: typeof runInstanceCertsApply;
  } = {},
): Promise<void> {
  const instanceDir = resolveInstanceDir();
  await upsertPublicUrlsInEnv(urls);
  const runCerts = deps.runCertsApply ?? runInstanceCertsApply;
  await runCerts(instanceDir, urls);
}
