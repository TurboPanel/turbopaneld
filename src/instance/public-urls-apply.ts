import {
  devOwnershipPlaybookExtraArgs,
  runLocalPlaybook,
} from "../orchestration/ansible.ts";
import { INSTANCE_CERTS_APPLY_PLAYBOOK } from "../orchestration/paths.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  resolveInstanceRuntimeEnvPath,
  upsertPublicUrlsInEnv,
} from "./public-urls-env.ts";

export function resolveInstanceDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
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
): Promise<void> {
  const args = [
    "-e",
    `turbopanel_instance_dir=${instanceDir}`,
    "-e",
    `turbopanel_public_urls=${urls.join(",")}`,
    ...devOwnershipPlaybookExtraArgs(),
  ];
  await runLocalPlaybook(INSTANCE_CERTS_APPLY_PLAYBOOK, args);
}

export async function applyPublicUrls(urls: string[]): Promise<void> {
  const instanceDir = resolveInstanceDir();
  await upsertPublicUrlsInEnv(urls);
  await runInstanceCertsApply(instanceDir, urls);
}
