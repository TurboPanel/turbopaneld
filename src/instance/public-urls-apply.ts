import { dirname, join } from "@std/path";
import { devOwnershipPlaybookExtraArgs, runLocalPlaybook } from "../orchestration/ansible.ts";
import { INSTANCE_CERTS_APPLY_PLAYBOOK } from "../orchestration/paths.ts";

const DEFAULT_INSTANCE_DIR = "/opt/turbopanel/platform/instance";
const PUBLIC_URLS_KEY = "TURBOPANEL_PUBLIC_URLS=";
const DEFAULT_ENV_MODE = 0o640;

type EnvFileMeta = {
  mode: number;
  uid?: number;
  gid?: number;
};

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

export function resolveInstanceDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const override = env.TURBOPANEL_INSTANCE_DIR?.trim();
  if (override) return stripTrailingSlash(override);
  return DEFAULT_INSTANCE_DIR;
}

async function readEnvFileMeta(envPath: string): Promise<EnvFileMeta | null> {
  try {
    const stat = await Deno.stat(envPath);
    return {
      mode: stat.mode ?? DEFAULT_ENV_MODE,
      uid: stat.uid ?? undefined,
      gid: stat.gid ?? undefined,
    };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function writeEnvFileAtomic(
  envPath: string,
  content: string,
  meta: EnvFileMeta | null,
): Promise<void> {
  const mode = meta?.mode ?? DEFAULT_ENV_MODE;
  const tmpPath = join(dirname(envPath), `.env.tmp-${crypto.randomUUID()}`);
  await Deno.writeTextFile(tmpPath, content, { mode });
  if (meta?.uid !== undefined && meta?.gid !== undefined) {
    await Deno.chown(tmpPath, meta.uid, meta.gid);
  }
  await Deno.rename(tmpPath, envPath);
}

export async function upsertPublicUrlsInEnv(
  instanceDir: string,
  urls: string[],
): Promise<void> {
  const envPath = join(instanceDir, ".env");
  const meta = await readEnvFileMeta(envPath);
  let content = "";
  try {
    content = await Deno.readTextFile(envPath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  const newLine = `${PUBLIC_URLS_KEY}${urls.join(",")}`;
  const lines = content.length > 0 ? content.split("\n") : [];
  let found = false;
  const updated = lines.map((line) => {
    if (line.startsWith(PUBLIC_URLS_KEY)) {
      found = true;
      return newLine;
    }
    return line;
  });

  if (!found) {
    updated.push(newLine);
  }

  let result = updated.join("\n");
  if (!result.endsWith("\n")) result += "\n";

  await writeEnvFileAtomic(envPath, result, meta);
}

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
  await upsertPublicUrlsInEnv(instanceDir, urls);
  await runInstanceCertsApply(instanceDir, urls);
}
