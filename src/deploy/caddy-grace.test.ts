import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { caddyfile, caddyUnit, HOSTING_CADDY_GRACE_PERIOD } from "./ingress.ts";

/**
 * Caddy waits forever for open connections after SIGTERM unless `grace_period`
 * is set ("servers shutting down with eternal grace period"). systemd then
 * kills it, and an explicit stop leaves the unit inactive: the panel is down
 * after an update. Every TurboPanel Caddy bounds its shutdown, and its unit
 * waits longer than that.
 */

const GRACE_SECONDS = 5;
/** The stop timeout must exceed the grace period by at least this much. */
const MARGIN_SECONDS = 10;

const ROLES = new URL("../../orchestration/roles/", import.meta.url);

async function readRole(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, ROLES));
}

function timeoutStopSeconds(unit: string): number {
  const match = /^TimeoutStopSec=(\d+)$/m.exec(unit);
  assert(match, "unit sets TimeoutStopSec");
  return Number(match[1]);
}

/** The first top-level `{ ... }` block: Caddy's global options. */
function globalOptions(caddyfileText: string): string {
  const start = caddyfileText.search(/^\{$/m);
  const end = caddyfileText.indexOf("\n}\n", start);
  assert(start >= 0 && end > start, "Caddyfile has a global options block");
  return caddyfileText.slice(start, end + 3);
}

const MINIMAL_SITE = ':18443 {\n\trespond "ok"\n}\n';

/** The pinned Caddy, when one is available (env or PATH); else tests skip. */
async function pinnedCaddy(): Promise<string | null> {
  const wanted = /caddy_version:\s*"([^"]+)"/.exec(
    await readRole("caddy/defaults/main.yml"),
  )?.[1];
  const candidate = Deno.env.get("TURBOPANEL_TEST_CADDY") ?? "caddy";
  try {
    const out = await new Deno.Command(candidate, {
      args: ["version"],
      stdout: "piped",
      stderr: "null",
    }).output();
    const version = new TextDecoder().decode(out.stdout);
    return wanted && version.startsWith(`v${wanted}`) ? candidate : null;
  } catch {
    return null;
  }
}

async function validate(
  caddy: string,
  text: string,
): Promise<{ ok: boolean; output: string }> {
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "Caddyfile");
    await Deno.writeTextFile(file, text);
    const result = await new Deno.Command(caddy, {
      args: ["validate", "--config", file, "--adapter", "caddyfile"],
      stdout: "piped",
      stderr: "piped",
      env: { XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, HOME: dir },
    }).output();
    const output = new TextDecoder().decode(result.stderr);
    return { ok: result.success, output };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("control-plane Caddy sets a grace period and its unit waits longer", async () => {
  const caddyfileText = await readRole(
    "instance-launch/templates/Caddyfile.j2",
  );
  assertStringIncludes(
    globalOptions(caddyfileText),
    `grace_period ${GRACE_SECONDS}s`,
  );
  const unit = await readRole(
    "instance-launch/templates/turbopanel-caddy.service.j2",
  );
  assert(timeoutStopSeconds(unit) >= GRACE_SECONDS + MARGIN_SECONDS);
  // The reload path is untouched and a stopped unit is brought back.
  assertStringIncludes(unit, "ExecReload=");
  assertStringIncludes(unit, "Restart=always");
});

Deno.test("site Caddy sets a grace period and its unit waits longer", async () => {
  const caddyfileText = await readRole("site-caddy/templates/Caddyfile.j2");
  assertStringIncludes(
    globalOptions(caddyfileText),
    `grace_period ${GRACE_SECONDS}s`,
  );
  const unit = await readRole(
    "site-caddy/templates/turbopanel-site-caddy.service.j2",
  );
  assert(timeoutStopSeconds(unit) >= GRACE_SECONDS + MARGIN_SECONDS);
});

Deno.test("hosting Caddy sets a grace period and its unit waits longer", () => {
  assertEquals(HOSTING_CADDY_GRACE_PERIOD, `${GRACE_SECONDS}s`);
  const config = caddyfile("/etc/turbopanel");
  assertStringIncludes(globalOptions(config), `grace_period ${GRACE_SECONDS}s`);
  const unit = caddyUnit(
    {
      runtimesDir: "/opt/turbopanel/vendor",
      configDir: "/etc/turbopanel",
      stateDir: "/var/lib/turbopanel",
    } as Parameters<typeof caddyUnit>[0],
  );
  assert(timeoutStopSeconds(unit) >= GRACE_SECONDS + MARGIN_SECONDS);
});

Deno.test("the pinned Caddy accepts the grace period in every global block", async (t) => {
  const caddy = await pinnedCaddy();
  if (!caddy) {
    console.warn(
      "pinned Caddy not found: set TURBOPANEL_TEST_CADDY to run this check",
    );
    return;
  }
  await t.step("control plane", async () => {
    const text = globalOptions(
      (await readRole("instance-launch/templates/Caddyfile.j2")).replaceAll(
        "{{ turbopanel_caddy_admin_socket }}",
        "/tmp/tp-grace-test-admin.sock",
      ),
    );
    const result = await validate(caddy, text + MINIMAL_SITE);
    assert(result.ok, result.output);
  });
  await t.step("site", async () => {
    const text = globalOptions(
      (await readRole("site-caddy/templates/Caddyfile.j2")).replaceAll(
        "{{ site_caddy_admin_addr }}",
        "127.0.0.1:2039",
      ),
    );
    const result = await validate(caddy, text + MINIMAL_SITE);
    assert(result.ok, result.output);
  });
  await t.step("hosting", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(dir, "hosting", "sites"), { recursive: true });
      await Deno.writeTextFile(join(dir, "hosting", "sites", "a.caddy"), "");
      const result = await validate(caddy, caddyfile(dir));
      assert(result.ok, result.output);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
  await t.step("a grace_period inside servers is refused (guard)", async () => {
    const result = await validate(
      caddy,
      "{\n\tservers {\n\t\tgrace_period 5s\n\t}\n}\n" + MINIMAL_SITE,
    );
    assertEquals(result.ok, false);
  });
});
