/**
 * Test-only helpers for the control plane's Caddyfile
 * (`orchestration/roles/instance-launch/templates/Caddyfile.j2`): find the
 * pinned Caddy and `ansible-playbook`, build a plain-HTTP test site from the
 * template's shared snippet, run Caddy on it, and run an in-place edit task
 * file against an installed copy. Do not import from production code.
 */

import { assert } from "@std/assert";
import { dirname, join } from "@std/path";

export const INSTANCE_LAUNCH_ROLES = new URL(
  "../../orchestration/roles/",
  import.meta.url,
);

/** Absolute path of `name` on PATH, or undefined. */
export function findOnPath(name: string): string | undefined {
  for (const dir of (Deno.env.get("PATH") ?? "").split(":")) {
    if (!dir) continue;
    try {
      if (Deno.statSync(join(dir, name)).isFile) return join(dir, name);
    } catch {
      // not here
    }
  }
  return undefined;
}

/** The pinned Caddy, when one is available (env or PATH); else undefined. */
export function pinnedCaddy(): string | undefined {
  const defaults = Deno.readTextFileSync(
    new URL("caddy/defaults/main.yml", INSTANCE_LAUNCH_ROLES),
  );
  const wanted = /caddy_version:\s*"([^"]+)"/.exec(defaults)?.[1];
  const candidate = Deno.env.get("TURBOPANEL_TEST_CADDY") ?? "caddy";
  try {
    const out = new Deno.Command(candidate, {
      args: ["version"],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    const version = new TextDecoder().decode(out.stdout);
    return wanted && version.startsWith(`v${wanted}`) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** `value`, or a TypeError naming the missing tool. */
export function required(value: string | undefined, name: string): string {
  if (value === undefined) throw new TypeError(`${name} missing`);
  return value;
}

/** A free loopback TCP port. */
export function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

/**
 * The template's variables, for a render without Jinja. Jinja statement and
 * comment lines (the edge port redirect include) drop out: a raw template
 * then renders as if no hostname were listed.
 */
export function substitutePanelCaddyfile(text: string, root: string): string {
  return text
    .replaceAll(/^\{[%#][^\n]*\n/gm, "")
    .replaceAll("{{ turbopanel_caddy_admin_socket }}", join(root, "admin.sock"))
    .replaceAll("{{ turbopanel_run_dir }}", join(root, "run"))
    .replaceAll("{{ turbopanel_ui_dist_dir }}", join(root, "ui"))
    .replaceAll("{{ turbopanel_caddyfile | dirname }}", root);
}

/**
 * Global options and the shared snippet of a template (raw or rendered),
 * served over plain HTTP on `port`.
 */
export function panelCaddyTestSite(
  template: string,
  root: string,
  port: number,
): string {
  const start = template.search(/^\{$/m);
  const end = template.indexOf("# Always-on recovery listener");
  assert(start >= 0 && end > start, "template layout");
  return substitutePanelCaddyfile(template.slice(start, end), root) +
    `\nhttp://:${port} {\n\tbind 127.0.0.1\n\timport turbopanel_app\n}\n`;
}

/** A running test Caddy; `stop` kills it and removes nothing. */
export interface RunningCaddy {
  base: string;
  stop: () => Promise<void>;
}

/** Run `caddy` on `config` and wait until `base` answers. */
export async function startPanelCaddy(
  caddy: string,
  config: string,
  root: string,
  port: number,
): Promise<RunningCaddy> {
  const child = new Deno.Command(caddy, {
    args: ["run", "--config", config, "--adapter", "caddyfile"],
    env: { XDG_DATA_HOME: root, XDG_CONFIG_HOME: root, HOME: root },
    stdout: "null",
    stderr: "piped",
  }).spawn();
  const stop = async () => {
    child.kill("SIGTERM");
    await child.stderr.cancel();
    await child.status;
  };
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      await (await fetch(`${base}/`, { redirect: "manual" })).body?.cancel();
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!up) await stop();
  assert(up, "caddy came up");
  return { base, stop };
}

/**
 * Run one role task file (`<role>/tasks/<file>.yml`) against
 * `<root>/Caddyfile` through the role, with the given Caddy linked as the
 * vendored one. Returns the play output.
 */
export async function runCaddyfileTasks(
  root: string,
  caddyBin: string,
  ansiblePlaybook: string,
  tasks: string,
): Promise<string> {
  const vendor = join(root, "vendor");
  const link = join(vendor, "caddy", "current", "caddy");
  await Deno.mkdir(dirname(link), { recursive: true });
  try {
    await Deno.lstat(link);
  } catch {
    const target = caddyBin.includes("/")
      ? caddyBin
      : findOnPath(caddyBin) ?? caddyBin;
    await Deno.symlink(target, link);
  }
  const play = join(root, "play.yml");
  await Deno.writeTextFile(
    play,
    [
      "- hosts: localhost",
      "  connection: local",
      "  gather_facts: false",
      "  vars:",
      `    turbopanel_caddyfile: ${join(root, "Caddyfile")}`,
      `    turbopanel_vendor_dir: ${vendor}`,
      "    turbopanel_dev_user: ''",
      // The role's reload handler is skipped, as in the unit refresh.
      "    instance_start: false",
      "  tasks:",
      "    - ansible.builtin.include_role:",
      `        name: ${tasks.split("/")[0]}`,
      `        tasks_from: ${tasks.split("/").at(-1)}`,
      "",
    ].join("\n"),
  );
  return await runLocalPlaybook(ansiblePlaybook, root, play);
}

/**
 * Run a localhost playbook with Ansible state kept under `root`; fails the
 * test when the play fails. Returns the play output.
 */
export async function runLocalPlaybook(
  ansiblePlaybook: string,
  root: string,
  play: string,
  extraArgs: string[] = [],
): Promise<string> {
  const home = join(root, "home");
  await Deno.mkdir(home, { recursive: true });
  const out = await new Deno.Command(ansiblePlaybook, {
    args: [play, "-i", "localhost,", "-c", "local", ...extraArgs],
    env: {
      HOME: home,
      ANSIBLE_HOME: home,
      ANSIBLE_LOCAL_TEMP: home,
      ANSIBLE_REMOTE_TMP: home,
      ANSIBLE_NOCOWS: "1",
      ANSIBLE_ROLES_PATH: INSTANCE_LAUNCH_ROLES.pathname,
      XDG_DATA_HOME: root,
      XDG_CONFIG_HOME: root,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const output = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  assert(out.success, output);
  return output;
}
