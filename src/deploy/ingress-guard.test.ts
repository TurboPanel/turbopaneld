/**
 * The ingress guard: who on the host may open a connection to the shared
 * hosting-ingress Traefik's PROXY protocol entrypoints (127.0.0.1:7080/7443).
 *
 * The shared Traefik trusts a PROXY header only from its ingress network's
 * bridge gateway (see `traefikCompose`), and every connection through the
 * loopback publish arrives from that gateway. So the guard, not Traefik, is
 * what stops a local tenant process from forging client addresses: the
 * `hosting-caddy` role installs it as its own nftables table, loaded by
 * `turbopanel-ingress-guard.service`. These tests pin the rendered ruleset
 * (the role template, with the role defaults substituted the way Ansible
 * does) and the daemon's re-run trigger.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { PROD_LIB_DIR_DEFAULT, resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  ensureHostingCaddy,
  HOSTING_CADDY_USER,
  INGRESS_GUARD_MARKER,
  INGRESS_GUARD_RULES_PATH,
  INGRESS_GUARD_UNIT,
  INGRESS_GUARD_VERSION,
  ingressGuardInstalled,
} from "./ensure-hosting-caddy.ts";
import { caddyTraefikUpstream } from "./ingress.ts";

const test = Deno.test.bind(Deno);

const ROLE = fromFileUrl(
  new URL("../../orchestration/roles/hosting-caddy/", import.meta.url),
);

function readRole(path: string): string {
  return Deno.readTextFileSync(join(ROLE, path));
}

/** One scalar or flow-list default from the role's defaults/main.yml. */
function roleDefault(name: string): string {
  const match = new RegExp(`^${name}: (.+)$`, "m").exec(
    readRole("defaults/main.yml"),
  );
  assert(match, `${name} is a hosting-caddy role default`);
  return match[1].trim();
}

const GUARD_PORTS = JSON.parse(
  roleDefault("hosting_ingress_guard_ports"),
) as number[];
const CADDY_UID = roleDefault("hosting_caddy_uid");

/** The template with the role's defaults in place of its Jinja expressions. */
function renderGuard(): string {
  return readRole("templates/ingress-guard.nft.j2")
    .replaceAll(
      "{{ hosting_ingress_guard_version }}",
      roleDefault("hosting_ingress_guard_version"),
    )
    .replaceAll(
      "{{ hosting_ingress_guard_ports | join(', ') }}",
      GUARD_PORTS.join(", "),
    )
    .replaceAll(
      "{{ hosting_ingress_guard_ports | join('/') }}",
      GUARD_PORTS.join("/"),
    )
    .replaceAll("{{ hosting_caddy_uid }}", CADDY_UID)
    .replaceAll("{{ hosting_caddy_user }}", roleDefault("hosting_caddy_user"));
}

/** Rule lines (no comments, no blank lines), trimmed. */
function ruleLines(nft: string): string[] {
  return nft.split("\n").map((line) => line.trim()).filter((line) =>
    line !== "" && !line.startsWith("#")
  );
}

test("the guard ruleset carries the version marker the daemon looks for", () => {
  assertEquals(
    roleDefault("hosting_ingress_guard_version"),
    INGRESS_GUARD_VERSION,
  );
  const rendered = renderGuard();
  assertStringIncludes(rendered, INGRESS_GUARD_MARKER);
  assertEquals(rendered.includes("{{"), false, "every expression substituted");
});

test("the guard covers exactly the shared Traefik's PROXY protocol entrypoints", () => {
  // The ports Caddy proxies to (and Traefik publishes on loopback).
  const upstreamPorts = (["http", "https"] as const).map((hop) =>
    Number(/127\.0\.0\.1:(\d+)/.exec(caddyTraefikUpstream(hop))?.[1])
  );
  assertEquals(GUARD_PORTS, upstreamPorts);
  assertEquals(roleDefault("hosting_caddy_user"), HOSTING_CADDY_USER);
});

test("only root and the hosting Caddy may open a connection to the entrypoints", () => {
  const lines = ruleLines(renderGuard());
  assertEquals(lines, [
    "table inet turbopanel_ingress_guard",
    "delete table inet turbopanel_ingress_guard",
    "table inet turbopanel_ingress_guard {",
    "chain output {",
    "type filter hook output priority filter; policy accept;",
    // The original tuple: nat-output may already have DNAT'd the packet.
    `ct state new meta l4proto tcp ct original proto-dst { ${
      GUARD_PORTS.join(", ")
    } } jump traefik_entrypoints`,
    "}",
    "chain traefik_entrypoints {",
    `meta skuid { 0, ${CADDY_UID} } return`,
    // The loopback publish (docker-proxy relays it from the bridge gateway;
    // with userland-proxy false, nat-output DNATs it to the container).
    "ct original ip daddr 127.0.0.0/8 counter reject with tcp reset",
    "ct original ip6 daddr ::1 counter reject with tcp reset",
    // Straight to a container address: the host's source there is the
    // bridge gateway too, the very address Traefik trusts.
    'oifname "docker0" counter reject with tcp reset',
    'oifname "br-*" counter reject with tcp reset',
    "}",
    "}",
  ]);
});

test("the guard matches the pre-DNAT destination, never the post-NAT one", () => {
  // At priority filter, nat-output (priority -100) has already rewritten
  // daddr/dport when Docker runs with userland-proxy false: a plain
  // `ip daddr 127.0.0.1` / `tcp dport` match would let a tenant through.
  const lines = ruleLines(renderGuard());
  for (const line of lines) {
    assertEquals(
      /(^|\s)(ip6? daddr|tcp dport)\s/.test(
        line.replace(/ct original ip6? daddr/g, ""),
      ),
      false,
      `post-NAT match: ${line}`,
    );
  }
  assert(lines.some((line) => line.includes("ct original proto-dst")));
  assert(
    lines.some((line) => line.startsWith("ct original ip daddr 127.0.0.0/8")),
  );
});

test("the guard is its own table, never the firewall's chains or a flush", () => {
  const rendered = ruleLines(renderGuard()).join("\n");
  assertEquals(
    /flush ruleset|TP-INPUT|TP-FWD|DOCKER-USER/.test(rendered),
    false,
  );
  const unit = readRole("templates/turbopanel-ingress-guard.service.j2");
  assertStringIncludes(
    unit,
    "ExecStart=/usr/sbin/nft -f {{ hosting_ingress_guard_rules }}",
  );
  assertStringIncludes(
    unit,
    "After=local-fs.target systemd-modules-load.service nftables.service",
  );
  assertStringIncludes(unit, "Before=network-pre.target docker.service");
  // `systemctl restart nftables` (flush ruleset) restarts the guard after it.
  assertStringIncludes(unit, "\nPartOf=nftables.service\n");
  // Starting Docker pulls the guard in; Requires= (RequiredBy) would restart
  // Docker, and every container, whenever the guard restarts.
  assertStringIncludes(unit, "\nWantedBy=multi-user.target docker.service\n");
  assertEquals(/^(RequiredBy|BindsTo|Requires)=/m.test(unit), false);
  // Docker refuses to start without the table: fails closed, no propagation.
  const dropin = readRole("templates/docker-ingress-guard.conf.j2");
  assertStringIncludes(
    dropin,
    "\n[Service]\nExecStartPre=/usr/sbin/nft list table inet turbopanel_ingress_guard\n",
  );
  // Root-owned under <install>/lib: the daemon (which can write
  // /etc/turbopanel) cannot rewrite its own guard.
  assertEquals(
    roleDefault("hosting_ingress_guard_rules"),
    '"{{ turbopanel_install_root }}/lib/ingress-guard.nft"',
  );
  // The daemon checks the path the playbook writes, in every layout.
  assertEquals(
    INGRESS_GUARD_RULES_PATH,
    join(PROD_LIB_DIR_DEFAULT, "ingress-guard.nft"),
  );
  assertEquals(
    roleDefault("turbopanel_install_root").split(" ")[0],
    "/opt/turbopanel",
  );
  assertEquals(INGRESS_GUARD_UNIT, "turbopanel-ingress-guard.service");
  const tasks = readRole("tasks/main.yml");
  assertStringIncludes(tasks, "validate: /usr/sbin/nft -c -f %s");
  assertStringIncludes(tasks, `name: ${INGRESS_GUARD_UNIT}`);
  assertStringIncludes(
    tasks,
    "dest: /etc/systemd/system/docker.service.d/turbopanel-ingress-guard.conf",
  );
  assertStringIncludes(
    tasks,
    "ansible.builtin.command: systemctl reenable turbopanel-ingress-guard.service",
  );
});

async function plantCaddy(runtimesDir: string): Promise<void> {
  const versionDir = join(runtimesDir, "caddy", "test");
  await Deno.mkdir(versionDir, { recursive: true });
  await Deno.writeTextFile(join(versionDir, "caddy"), "#!/bin/true\n");
  await Deno.chmod(join(versionDir, "caddy"), 0o755);
  await Deno.symlink(versionDir, join(runtimesDir, "caddy", "current"));
}

async function setupRunsWith(
  guard: string | undefined,
  active = true,
): Promise<number> {
  let setupCalls = 0;
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env, {
      skipDiscovery: true,
      forceMode: "production",
    });
    await plantCaddy(layout.runtimesDir);
    const rules = join(fixture.dirs.runtimesDir, "..", "ingress-guard.nft");
    if (guard !== undefined) await Deno.writeTextFile(rules, guard);
    await ensureHostingCaddy(layout, {
      accountExists: () => Promise.resolve(true),
      ingressGuardCurrent: () => ingressGuardInstalled(rules),
      ingressGuardActive: () => Promise.resolve(active),
      runCaddySetup: () => {
        setupCalls += 1;
        return Promise.resolve();
      },
      runCommand: () => {
        throw new TypeError("no download: the binary is present");
      },
    }).catch(() => {});
  });
  return setupCalls;
}

test({
  name:
    "a host without the current guard re-runs caddy-setup on its next deploy",
  permissions: { read: true, write: true },
  fn: async () => {
    assertEquals(await setupRunsWith(undefined), 1, "no guard installed");
    assertEquals(
      await setupRunsWith("# turbopanel-ingress-guard v1\ntable inet x {}\n"),
      1,
      "an older guard",
    );
    assertEquals(await setupRunsWith(renderGuard()), 0, "the current guard");
    assertEquals(
      await setupRunsWith(renderGuard(), false),
      1,
      "the current guard, unit inactive (e.g. nftables flushed it)",
    );
  },
});
