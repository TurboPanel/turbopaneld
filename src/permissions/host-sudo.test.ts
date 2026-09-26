import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import { hostSudoArgs, TP_HOST_VERBS } from "./host-sudo.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) yield* sourceFiles(path);
    else if (entry.isFile && entry.name.endsWith(".ts")) yield path;
  }
}

const MANAGED = { installMode: "production" as const, uid: 9999, env: {} };

test("a managed host routes every tp-host verb through /opt/turbopanel/lib/tp-host", () => {
  assertEquals(
    hostSudoArgs(["-n", "install", "-m", "0640", "a", "b"], MANAGED),
    [
      "-n",
      "--",
      "/opt/turbopanel/lib/tp-host",
      "install",
      "-m",
      "0640",
      "a",
      "b",
    ],
  );
  assertEquals(
    hostSudoArgs(["-n", "--", "systemctl", "daemon-reload"], MANAGED),
    ["-n", "--", "/opt/turbopanel/lib/tp-host", "systemctl", "daemon-reload"],
  );
});

test("self re-exec, docker, helpers and engine checks are left alone", () => {
  for (
    const args of [
      ["-n", "-u", "tp", "--", "docker", "ps"],
      ["-n", "--", "docker", "ps"],
      [
        "-n",
        "--",
        "/opt/turbopanel/share/orchestration/scripts/tp-orchestrate",
        "migrate",
      ],
      [
        "-n",
        "/usr/sbin/php-fpm8.4",
        "--fpm-config",
        "/etc/turbopanel/php/8.4/php-fpm.conf",
        "--test",
      ],
      ["-n", "modprobe", "drivetemp"],
      ["sh", "-s", "--"],
    ]
  ) {
    assertEquals(hostSudoArgs(args, MANAGED), args);
  }
});

test("development and root processes keep the direct sudo argv", () => {
  const args = ["-n", "rm", "-rf", "--", "/srv/users/alice/x"];
  assertEquals(
    hostSudoArgs(args, { installMode: "development", uid: 1000 }),
    args,
  );
  assertEquals(
    hostSudoArgs(args, { installMode: "production", uid: 0 }),
    args,
  );
});

test("every `sudo -n <tp-host verb>` literal in src goes through hostSudoArgs", async () => {
  // On a managed host sudoers grants tp-host, not the raw utility: an
  // unwrapped call site would be refused in production and nowhere else.
  const root = join(dirname(fromFileUrl(import.meta.url)), "..");
  const verbs = [...TP_HOST_VERBS].map((v) => v.replaceAll("-", "\\-")).join(
    "|",
  );
  const raw = new RegExp(
    String
      .raw`"sudo"\s*,\s*(?:\{\s*args\s*:\s*)?\[\s*"-n"\s*,\s*(?:"--"\s*,\s*)?"(${verbs})"`,
    "g",
  );
  const offenders: string[] = [];
  for await (const path of sourceFiles(root)) {
    if (path.endsWith(".test.ts") || path.includes("/testing/")) continue;
    const source = await Deno.readTextFile(path);
    for (const match of source.matchAll(raw)) {
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${relative(root, path)}:${line} (${match[1]})`);
    }
  }
  assertEquals(offenders, []);
});
