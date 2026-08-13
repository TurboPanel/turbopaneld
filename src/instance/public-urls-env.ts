import { dirname, join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
const RUNTIME_ENV_FILENAME = "runtime.env";
const PUBLIC_URLS_KEY = "TURBOPANEL_PUBLIC_URLS=";
const DEFAULT_ENV_MODE = 0o640;

type EnvFileMeta = {
  mode: number;
  uid?: number;
  gid?: number;
};

export function resolveInstanceConfigDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return resolveLayout(env).instanceConfigDir;
}

export function resolveInstanceRuntimeEnvPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return join(resolveInstanceConfigDir(env), RUNTIME_ENV_FILENAME);
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

async function runSudo(args: string[]): Promise<void> {
  const result = await new Deno.Command("sudo", {
    args: ["-n", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      new TextDecoder().decode(result.stderr).trim() ||
        `sudo ${args.join(" ")} failed`,
    );
  }
}

async function chownFileOwner(
  path: string,
  uid: number,
  gid: number,
): Promise<void> {
  try {
    await Deno.chown(path, uid, gid);
    return;
  } catch (err) {
    if (!(err instanceof Deno.errors.PermissionDenied)) throw err;
  }
  await runSudo(["chown", `${uid}:${gid}`, path]);
}

async function ensureWriteTmpDir(configDir: string): Promise<string> {
  const tmpDir = join(configDir, ".write-tmp");
  await Deno.mkdir(tmpDir, { recursive: true, mode: 0o700 });
  return tmpDir;
}

async function removeTempFile(path: string | null): Promise<void> {
  if (!path) return;
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

function modeOctal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

/**
 * Instance config (`/etc/turbopanel/instance`) is intentionally root:group
 * mode 0750 so secret files stay non-group-writable. The daemon therefore
 * cannot create `.write-tmp` there — stage in /tmp and `sudo install`.
 */
async function writeEnvFilePrivileged(
  envPath: string,
  content: string,
  meta: EnvFileMeta | null,
): Promise<void> {
  const configDir = dirname(envPath);
  const mode = meta?.mode ?? DEFAULT_ENV_MODE;
  await runSudo(["install", "-d", "-m", "0750", configDir]);

  const staging = await Deno.makeTempFile({ prefix: "tp-runtime-env-" });
  try {
    await Deno.writeTextFile(staging, content);
    const installArgs = ["install", "-m", modeOctal(mode)];
    if (meta?.uid !== undefined && meta?.gid !== undefined) {
      installArgs.push("-o", String(meta.uid), "-g", String(meta.gid));
    } else {
      try {
        const parent = await Deno.stat(configDir);
        if (parent.gid !== undefined) {
          installArgs.push("-o", "0", "-g", String(parent.gid));
        }
      } catch {
        // install as root (sudo) with default group
      }
    }
    installArgs.push(staging, envPath);
    await runSudo(installArgs);
  } finally {
    await removeTempFile(staging);
  }
}

async function writeEnvFileUnprivileged(
  envPath: string,
  content: string,
  meta: EnvFileMeta | null,
): Promise<void> {
  const configDir = dirname(envPath);
  await Deno.mkdir(configDir, { recursive: true, mode: 0o750 });
  const tmpDir = await ensureWriteTmpDir(configDir);
  const tmpPath = join(tmpDir, `write-${crypto.randomUUID()}`);
  const mode = meta?.mode ?? DEFAULT_ENV_MODE;
  let tmpCreated: string | null = tmpPath;
  try {
    await Deno.writeTextFile(tmpPath, content, { mode });
    if (meta?.uid !== undefined && meta?.gid !== undefined) {
      await chownFileOwner(tmpPath, meta.uid, meta.gid);
    }
    await Deno.rename(tmpPath, envPath);
    tmpCreated = null;
  } finally {
    await removeTempFile(tmpCreated);
  }
}

async function writeEnvFileAtomic(
  envPath: string,
  content: string,
  meta: EnvFileMeta | null,
): Promise<void> {
  try {
    await writeEnvFileUnprivileged(envPath, content, meta);
  } catch (err) {
    if (!(err instanceof Deno.errors.PermissionDenied)) throw err;
    await writeEnvFilePrivileged(envPath, content, meta);
  }
}

export async function upsertPublicUrlsInEnv(
  urls: string[],
  options: {
    runtimeEnvPath?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<void> {
  const envPath = options.runtimeEnvPath ??
    resolveInstanceRuntimeEnvPath(options.env);
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
