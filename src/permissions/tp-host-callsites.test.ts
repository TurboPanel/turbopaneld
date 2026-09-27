/**
 * The seam between the daemon's root requests and what root accepts.
 *
 * `tp-host-callsites.ts` lists what each hostSudoArgs call site really
 * sends. This suite proves three things about it:
 *
 * 1. Every call site in the source is listed (a static scan), and nothing
 *    listed is gone — a new root request cannot land without a sample.
 * 2. Every sample routed through tp-host is accepted by the real
 *    orchestration/scripts/tp-host, run in its unprivileged test mode against
 *    a throwaway prefix with the accounts a managed host has.
 * 3. Every sample that bypasses tp-host matches a rule in the rendered
 *    `/etc/sudoers.d/tp` (orchestration/roles/turbopanel-user/templates/sudoers.j2).
 */
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import { hostSudoArgs } from "./host-sudo.ts";
import {
  CALL_SITES,
  type CallSiteSetup,
  STAGED_CONTENT,
  STALE_KNOWN_BUGS,
  type SudoSample,
  type TpHostSample,
} from "./tp-host-callsites.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const repo = join(dirname(fromFileUrl(import.meta.url)), "../..");
const SCRIPT = join(repo, "orchestration/scripts/tp-host");
const REGISTRY = join(repo, "orchestration/runtime-registry.json");
const SUDOERS = join(
  repo,
  "orchestration/roles/turbopanel-user/templates/sudoers.j2",
);
const MANAGED = { installMode: "production" as const, uid: 9999 };

// --- 1. every call site is listed -------------------------------------------

/** The argument text of a `hostSudoArgs(…)` call, normalised into a key part. */
function normaliseCallArgument(text: string): string {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/[^\n]*/g, "")
    .replaceAll(/\s+/g, "")
    .replaceAll(",]", "]")
    .replace(/,$/, "");
}

/** `<file>|<normalised argument>` for every `hostSudoArgs(` call in `source`. */
function callSiteKeys(file: string, source: string): string[] {
  const keys: string[] = [];
  const needle = "hostSudoArgs(";
  let at = source.indexOf(needle);
  while (at >= 0) {
    const isDefinition = source.slice(Math.max(0, at - 9), at) === "function ";
    const start = at + needle.length;
    let depth = 1;
    let i = start;
    while (depth > 0 && i < source.length) {
      const ch = source[i];
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
      i += 1;
    }
    if (!isDefinition) {
      keys.push(`${file}|${normaliseCallArgument(source.slice(start, i - 1))}`);
    }
    at = source.indexOf(needle, i);
  }
  return keys;
}

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) yield* sourceFiles(path);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      yield path;
    }
  }
}

async function scannedKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  for await (const path of sourceFiles(join(repo, "src"))) {
    const file = relative(repo, path);
    for (const key of callSiteKeys(file, await Deno.readTextFile(path))) {
      keys.add(key);
    }
  }
  return keys;
}

test("the scanner reads a call site's argument text, comments and layout aside", () => {
  const source = [
    "export function hostSudoArgs(args) {}",
    "run('sudo', hostSudoArgs([",
    '  "-n", // why',
    '  "rm", "-f", path,',
    "]));",
    'run("sudo", hostSudoArgs(["-n", "systemctl", `${unit}.service`]));',
  ].join("\n");
  assertEquals(callSiteKeys("src/x.ts", source), [
    'src/x.ts|["-n","rm","-f",path]',
    'src/x.ts|["-n","systemctl",`${unit}.service`]',
  ]);
});

test("every hostSudoArgs call site has samples, and every listed call site still exists", async () => {
  const scanned = await scannedKeys();
  const listed = new Set(CALL_SITES.map((site) => site.key));
  const unlisted = [...scanned].filter((key) => !listed.has(key)).sort();
  const stale = [...listed].filter((key) => !scanned.has(key)).sort();
  assertEquals(
    unlisted,
    [],
    "add these to src/permissions/tp-host-callsites.ts with what they send",
  );
  assertEquals(stale, [], "these listed call sites no longer exist");
  assertEquals(STALE_KNOWN_BUGS, [], "these known bugs name no call site");
  assertEquals(listed.size, CALL_SITES.length, "a call site is listed twice");
  for (const site of CALL_SITES) {
    assert(site.samples.length > 0, `${site.key} has no sample`);
  }
});

// --- 2. tp-host accepts what the daemon sends --------------------------------

type Host = {
  prefix: string;
  run: (
    args: string[],
    stdin?: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  cleanup: () => Promise<void>;
};

async function makeHost(): Promise<Host> {
  const prefix = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "tp-host-callsites-" }),
  );
  const path = (rel: string) => join(prefix, rel);
  for (
    const d of [
      "opt/turbopanel/lib",
      "opt/turbopanel/share/orchestration",
      "etc/turbopanel",
      "var/lib/turbopanel",
      "var/log/turbopanel",
      "run/turbopanel",
      "srv/users/alice/sites",
      "etc/systemd/system",
      "etc/ssh/sshd_config.d",
      "etc/ssh/turbopanel/authorized_keys",
      "etc/sysctl.d",
      "etc/wireguard",
      "tmp",
    ]
  ) {
    await Deno.mkdir(path(d), { recursive: true });
  }
  await Deno.copyFile(SCRIPT, path("opt/turbopanel/lib/tp-host"));
  await Deno.chmod(path("opt/turbopanel/lib/tp-host"), 0o755);
  await Deno.copyFile(
    REGISTRY,
    path("opt/turbopanel/share/orchestration/runtime-registry.json"),
  );
  // The accounts a managed host with web engines has (turbopanel-user,
  // runtime-entitlement and the engine roles create them), plus one
  // principal and the group a new principal's useradd follows.
  await Deno.writeTextFile(
    path("etc/passwd"),
    [
      "root:x:0:0:root:/root:/bin/bash",
      "tp:x:9999:9999::/var/lib/turbopanel:/usr/sbin/nologin",
      "tpnginx:x:9990:9990::/nonexistent:/usr/sbin/nologin",
      "tpapache:x:9991:9991::/nonexistent:/usr/sbin/nologin",
      "tpols:x:9992:9992::/nonexistent:/usr/sbin/nologin",
      "tpcaddysite:x:9993:9993::/nonexistent:/usr/sbin/nologin",
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
      "tpapache:x:9991:",
      "tpols:x:9992:",
      "tpcaddysite:x:9993:",
      "tpphp84:x:9902:",
      "tpsftp:x:9986:alice",
      "alice-grp:x:15001:",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(path("tmp/staged"), STAGED_CONTENT);
  const script = path("opt/turbopanel/lib/tp-host");
  return {
    prefix,
    run: async (args, stdin) => {
      const child = new Deno.Command("sh", {
        args: [script, ...args],
        clearEnv: true,
        env: { PATH: "/usr/bin:/bin", TP_HOST_TEST_PREFIX: prefix },
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
    cleanup: () => Deno.remove(prefix, { recursive: true }),
  };
}

const at = (prefix: string, value: string) => value.replaceAll("{P}", prefix);

async function prepare(prefix: string, setup: CallSiteSetup | undefined) {
  for (const d of setup?.dirs ?? []) {
    await Deno.mkdir(at(prefix, d), { recursive: true });
  }
  for (const [file, contents] of Object.entries(setup?.files ?? {})) {
    await Deno.mkdir(dirname(at(prefix, file)), { recursive: true });
    await Deno.writeTextFile(at(prefix, file), at(prefix, contents));
  }
  if (setup?.groups !== undefined) {
    const groupFile = join(prefix, "etc/group");
    await Deno.writeTextFile(groupFile, `${setup.groups.join("\n")}\n`, {
      append: true,
    });
  }
  for (const [target, link] of setup?.links ?? []) {
    await Deno.mkdir(dirname(at(prefix, link)), { recursive: true });
    await Deno.symlink(target, at(prefix, link));
  }
}

/** The argv a managed host really sends: `{P}` is the host's `/`. */
function onHost(argv: readonly string[]): string[] {
  return argv.map((a) => a.replaceAll("{P}", ""));
}

async function runSample(sample: TpHostSample): Promise<string | undefined> {
  const host = await makeHost();
  try {
    await prepare(host.prefix, sample.setup);
    const argv = sample.argv.map((a) => at(host.prefix, a));
    const stdin = sample.stdin === undefined
      ? undefined
      : at(host.prefix, sample.stdin);
    const result = await host.run(argv, stdin);
    const refusal = result.stderr.split("\n").find((l) =>
      l.startsWith("tp-host:")
    );
    if (result.code !== 0 || refusal !== undefined) {
      return `exit ${result.code}: ${refusal ?? result.stderr.trim()}`;
    }
    return undefined;
  } finally {
    await host.cleanup();
  }
}

for (const site of CALL_SITES) {
  if (site.via !== "tp-host") continue;
  test({
    name: `tp-host accepts ${site.key}${knownBugSuffix(site.knownBug)}`,
    ignore: site.knownBug !== undefined,
  }, async () => {
    for (const sample of site.samples) {
      const routed = hostSudoArgs(["-n", ...onHost(sample.argv)], MANAGED);
      assert(
        routed[2]?.endsWith("/tp-host"),
        `not routed through tp-host: ${sample.argv.join(" ")}`,
      );
      const failure = await runSample(sample);
      assertEquals(
        failure,
        undefined,
        `tp-host refused: ${onHost(sample.argv).join(" ")}`,
      );
    }
  });
}

// Shapes one step off from a call site's: tp-host must refuse each, so the
// accepting samples above prove a boundary rather than an open door.
const NEAR_MISSES: Array<{ why: string; sample: TpHostSample }> = [
  {
    why: "rm outside the managed trees",
    sample: { argv: ["rm", "-rf", "--", "{P}/etc/ssh"] },
  },
  {
    why: "a managed root itself",
    sample: { argv: ["rm", "-rf", "--", "{P}/srv/users"] },
  },
  {
    why: "a unit name TurboPanel does not own",
    sample: { argv: ["systemctl", "restart", "nginx.service"] },
  },
  {
    why: "a unit that runs as root",
    sample: {
      argv: [
        "install",
        "-m",
        "0644",
        "{P}/tmp/staged",
        "{P}/etc/systemd/system/turbopanel-app-x.service",
      ],
      setup: {
        files: {
          "{P}/tmp/staged": "[Service]\nUser=root\nExecStart=/bin/sh\n",
        },
      },
    },
  },
  {
    why: "an owner group no host has",
    sample: {
      argv: ["chown", "root:wheel", "{P}/etc/turbopanel/x"],
      setup: { files: { "{P}/etc/turbopanel/x": "x\n" } },
    },
  },
  {
    why: "mv across directories",
    sample: {
      argv: [
        "mv",
        "-f",
        "--",
        "{P}/etc/turbopanel/a/x",
        "{P}/etc/turbopanel/b/x",
      ],
      setup: { files: { "{P}/etc/turbopanel/a/x": "x\n" } },
    },
  },
  {
    why: "find running a program",
    sample: {
      argv: ["find", "{P}/var/lib/turbopanel", "-exec", "sh", ";"],
    },
  },
  {
    why: "group- or world-writable config",
    sample: {
      argv: ["chmod", "0666", "{P}/etc/turbopanel/x"],
      setup: { files: { "{P}/etc/turbopanel/x": "x\n" } },
    },
  },
  {
    why: "a verb tp-host does not implement",
    sample: { argv: ["sh", "-c", "id"] },
  },
];

for (const { why, sample } of NEAR_MISSES) {
  test(`tp-host refuses ${why}`, async () => {
    const failure = await runSample(sample);
    assert(failure !== undefined, `accepted: ${sample.argv.join(" ")}`);
    assert(failure.includes("tp-host:"), `not a refusal: ${failure}`);
  });
}

function knownBugSuffix(reason: string | undefined): string {
  return reason === undefined ? "" : ` (KNOWN BUG: ${reason})`;
}

// --- 3. direct sudo matches the sudoers rules --------------------------------

type SudoRule = { runas: Set<string>; commands: string[] };

/** The sudoers file for a production install, `{{ … }}` filled in. */
async function renderSudoers(): Promise<string> {
  const vars: Record<string, string> = {
    turbopanel_user: "tp",
    turbopanel_install_root: "/opt/turbopanel",
    turbopanel_orchestration_dir: "/opt/turbopanel/share/orchestration",
    turbopanel_vendor_dir: "/opt/turbopanel/vendor",
  };
  const template = await Deno.readTextFile(SUDOERS);
  assert(
    !template.includes("{%"),
    "sudoers.j2 grew a block tag; render it with Jinja",
  );
  return template.replaceAll(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new TypeError(`unknown sudoers var ${name}`);
    return value;
  });
}

function parseSudoers(text: string, user: string): SudoRule[] {
  const aliases = new Map<string, string[]>();
  const rules: SudoRule[] = [];
  const split = (list: string) =>
    list.split(",").map((s) => s.trim()).filter(Boolean);
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("Defaults")) {
      continue;
    }
    const alias = /^Cmnd_Alias\s+(\w+)\s*=\s*(.+)$/.exec(line);
    if (alias) {
      aliases.set(alias[1], split(alias[2]));
      continue;
    }
    const rule = new RegExp(
      `^${user}\\s+ALL\\s*=\\s*\\(([^)]*)\\)\\s*NOPASSWD:\\s*(.+)$`,
    )
      .exec(line);
    if (!rule) continue;
    const commands = split(rule[2]).flatMap((c) => aliases.get(c) ?? [c]);
    rules.push({ runas: new Set(split(rule[1])), commands });
  }
  return rules;
}

/** sudoers glob: `*` never crosses `/` in the command path; anything in arguments. */
function globToRegExp(pattern: string, pathPart: boolean): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") out += pathPart ? "[^/]*" : ".*";
    else if (ch === "?") out += pathPart ? "[^/]" : ".";
    else if (ch === "[") {
      const end = pattern.indexOf("]", i);
      out += pattern.slice(i, end + 1);
      i = end;
    } else out += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function sudoersAllows(rules: SudoRule[], sample: SudoSample): boolean {
  const runas = sample.runas ?? "root";
  const [command, ...args] = sample.argv;
  return rules.some((rule) =>
    rule.runas.has(runas) &&
    rule.commands.some((spec) => {
      if (spec === "ALL") return true;
      const [specPath, ...specArgs] = spec.split(/\s+/);
      if (!globToRegExp(specPath, true).test(command)) return false;
      if (specArgs.length === 0) return true;
      return globToRegExp(specArgs.join(" "), false).test(args.join(" "));
    })
  );
}

test("the sudoers parser follows aliases, run-as lists and argument globs", async () => {
  const rules = parseSudoers(await renderSudoers(), "tp");
  assert(
    sudoersAllows(rules, {
      argv: ["/opt/turbopanel/lib/tp-host", "systemctl"],
    }),
  );
  assert(
    !sudoersAllows(rules, {
      argv: ["/usr/sbin/php-fpm8.4", "--fpm-config", "/etc/passwd", "--test"],
    }),
  );
  assert(!sudoersAllows(rules, { runas: "tpnginx", argv: ["/bin/sh"] }));
  assert(sudoersAllows(rules, { runas: "tp", argv: ["/bin/sh"] }));
});

for (const site of CALL_SITES) {
  if (site.via !== "sudo") continue;
  test({
    name: `sudoers allows ${site.key}${knownBugSuffix(site.knownBug)}`,
    ignore: site.knownBug !== undefined,
  }, async () => {
    const rules = parseSudoers(await renderSudoers(), "tp");
    for (const sample of site.samples) {
      const argv = sample.runas === undefined
        ? ["-n", ...sample.argv]
        : ["-n", "-u", sample.runas, "--", ...sample.argv];
      assertEquals(
        hostSudoArgs(argv, MANAGED),
        argv,
        `unexpectedly routed through tp-host: ${sample.argv.join(" ")}`,
      );
      assert(
        sudoersAllows(rules, sample),
        `sudoers denies ${sample.runas ?? "root"}: ${sample.argv.join(" ")}`,
      );
    }
  });
}
