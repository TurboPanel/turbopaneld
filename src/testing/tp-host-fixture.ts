/**
 * A throwaway host for tp-host's test mode (TP_HOST_TEST_PREFIX): every
 * managed path lives under a temp prefix, account lookups read the prefix's
 * etc/passwd and etc/group, file mechanics run for real, and privileged
 * commands are printed as `EXEC [argv]…` instead of run.
 */
import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const repo = join(dirname(fromFileUrl(import.meta.url)), "../..");
export const TP_HOST_SCRIPT = join(repo, "orchestration/scripts/tp-host");
const SCRIPT = TP_HOST_SCRIPT;
const REGISTRY = join(repo, "orchestration/runtime-registry.json");

export type Host = {
  prefix: string;
  run: (
    args: string[],
    stdin?: string,
    env?: Record<string, string>,
    cwd?: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  path: (rel: string) => string;
  cleanup: () => Promise<void>;
};

/**
 * The prefix stands in for root's tree: tp-host's seal check refuses a parent
 * that is group- or world-writable, which is what a 0002 umask (a distro's
 * per-user-group default) makes of every directory a test or tp-host creates.
 * Pin 022 for this test process (and the children it spawns), so the suite
 * passes under any umask. Returns a function that puts the previous umask back;
 * call it from the host's cleanup so later tests see the caller's own umask,
 * and from the setup's error path (see {@link guardHostSetup}) so a setup that
 * throws does not leave 022 behind.
 */
export function useSealedUmask(): () => void {
  const previous = Deno.umask(0o022);
  return () => {
    Deno.umask(previous);
  };
}

/**
 * Make a temp prefix under the sealed umask and run `build` on it. If `build`
 * throws, the prefix is removed (when it exists), the previous umask is put
 * back and the error is rethrown; on success `build` owns both, and the host's
 * cleanup restores the umask with the function it is given.
 */
export async function guardHostSetup<T>(
  tempPrefix: string,
  build: (prefix: string, restoreUmask: () => void) => Promise<T>,
): Promise<T> {
  const restoreUmask = useSealedUmask();
  let prefix: string | undefined;
  try {
    prefix = await Deno.realPath(
      await Deno.makeTempDir({ prefix: tempPrefix }),
    );
    return await build(prefix, restoreUmask);
  } catch (err) {
    try {
      if (prefix !== undefined) await removeHostPrefix(prefix);
    } catch {
      // The setup error is the one worth seeing.
    }
    restoreUmask();
    throw err;
  }
}

export function makeHost(): Promise<Host> {
  return guardHostSetup("tp-host-", async (prefix, restoreUmask) => {
    const path = (rel: string) => join(prefix, rel);
    for (
      const dir of [
        "opt/turbopanel/lib",
        "opt/turbopanel/share/orchestration",
        "opt/turbopanel/vendor/caddy/2.11.4",
        "etc/turbopanel",
        "var/lib/turbopanel",
        "var/log/turbopanel",
        "run/turbopanel",
        "srv/users/alice/sites",
        "etc/systemd/system",
        "etc/ssh/sshd_config.d",
        "etc/ssh/turbopanel/authorized_keys",
        "etc/sysctl.d",
        "outside",
        "tmp",
      ]
    ) {
      await Deno.mkdir(path(dir), { recursive: true });
    }
    await Deno.copyFile(SCRIPT, path("opt/turbopanel/lib/tp-host"));
    await Deno.chmod(path("opt/turbopanel/lib/tp-host"), 0o755);
    await Deno.copyFile(
      join(repo, "orchestration/scripts/tp-php-loopback"),
      path("opt/turbopanel/lib/tp-php-loopback"),
    );
    await Deno.copyFile(
      REGISTRY,
      path("opt/turbopanel/share/orchestration/runtime-registry.json"),
    );
    await Deno.writeTextFile(
      path("etc/passwd"),
      [
        "root:x:0:0:root:/root:/bin/bash",
        "tp:x:9999:9999::/var/lib/turbopanel:/usr/sbin/nologin",
        "tpnginx:x:9990:9990::/nonexistent:/usr/sbin/nologin",
        `alice:x:15001:15001::${prefix}/srv/users/alice:/bin/bash`,
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      path("etc/group"),
      [
        "root:x:0:",
        "sudo:x:27:",
        "docker:x:998:tp",
        "tp:x:9999:",
        "tpnginx:x:9990:",
        "tpshell:x:9985:",
        "tpsftp:x:9986:",
        "alice:x:15001:",
        "carol:x:15003:",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(path("outside/secret"), "root-only secret\n");
    await Deno.writeTextFile(path("tmp/staged"), "staged content\n");
    const script = path("opt/turbopanel/lib/tp-host");
    return {
      prefix,
      path,
      run: async (args, stdin, extraEnv, cwd) => {
        const child = new Deno.Command("sh", {
          args: [script, ...args],
          cwd,
          clearEnv: true,
          env: {
            PATH: "/usr/bin:/bin",
            TP_HOST_TEST_PREFIX: prefix,
            // The host's core count, so the default build core limit is the
            // same on every machine running the suite.
            TP_TEST_CORES: "8",
            TP_TEST_MEM_KB: "8388608",
            ...extraEnv,
          },
          stdin: stdin === undefined ? "null" : "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        if (stdin !== undefined) {
          const writer = child.stdin.getWriter();
          await writer.write(new TextEncoder().encode(stdin));
          await writer.close();
        }
        const out = await child.output();
        return {
          code: out.code,
          stdout: new TextDecoder().decode(out.stdout),
          stderr: new TextDecoder().decode(out.stderr),
        };
      },
      cleanup: async () => {
        try {
          await removeHostPrefix(prefix);
        } finally {
          restoreUmask();
        }
      },
    };
  });
}

/**
 * Remove a test host's prefix, including a published release whose top is
 * 0550 (tp-host `publish`): the owner gets write back first.
 */
export async function removeHostPrefix(prefix: string): Promise<void> {
  await new Deno.Command("chmod", { args: ["-R", "u+rwX", prefix] }).output();
  await Deno.remove(prefix, { recursive: true });
}

export async function withHost(
  fn: (host: Host) => Promise<void>,
): Promise<void> {
  const host = await makeHost();
  try {
    await fn(host);
  } finally {
    await host.cleanup();
  }
}

export async function refused(
  host: Host,
  args: string[],
  stdin?: string,
): Promise<string> {
  const result = await host.run(args, stdin);
  assertEquals(result.code === 0, false, `accepted: ${args.join(" ")}`);
  assertEquals(result.stdout.includes("EXEC"), false, args.join(" "));
  return result.stderr;
}
