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
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  path: (rel: string) => string;
  cleanup: () => Promise<void>;
};

export async function makeHost(): Promise<Host> {
  const prefix = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "tp-host-" }),
  );
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
      "tpphp84:x:9902:",
      "tpsftp:x:9986:",
      "alice-grp:x:15001:",
      "carol-grp:x:15003:",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(path("outside/secret"), "root-only secret\n");
  await Deno.writeTextFile(path("tmp/staged"), "staged content\n");
  const script = path("opt/turbopanel/lib/tp-host");
  return {
    prefix,
    path,
    run: async (args, stdin, extraEnv) => {
      const child = new Deno.Command("sh", {
        args: [script, ...args],
        clearEnv: true,
        env: {
          PATH: "/usr/bin:/bin",
          TP_HOST_TEST_PREFIX: prefix,
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
    cleanup: () => removeHostPrefix(prefix),
  };
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
