import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import type { LayoutPaths } from "../../paths/layout.ts";
import { bareSudoArgs } from "../../testing/sudo-argv.ts";
import {
  apacheSiteConfig,
  apacheWallLines,
  type SiteApplySpec,
} from "../site.ts";
import {
  APACHE_WALLS_MARKER,
  type ApacheWallsRepairIo,
  patchApacheVhost,
  patchSitePhpFpmConf,
  patchSitePhpIni,
  repairApacheWalls,
} from "./apache-walls-repair.ts";
import {
  sitePhpFpmConf,
  sitePhpGuardPath,
  sitePhpGuardPhp,
  sitePhpIni,
  type SitePhpRuntimeSpec,
  sitePhpServiceName,
  sitePhpSocketPath,
} from "./php-runtime.ts";
import { phpSiteKey } from "./php-site-key.ts";

/** Sonar S2187 recognizes `test()`; see site-apply.test.ts. */
const test = Deno.test.bind(Deno);

const ID = "shop-0a1b2c3d4e5f-fcgi84";
const FPM_ID = "shop-0a1b2c3d4e5f-fpm84";
const HOME = "/srv/users/alice";
const SECRET = new Uint8Array(32).fill(7);
const SITE: SiteApplySpec = {
  composeServiceName: "shop",
  engine: "apache",
  root: "public",
  listenPort: 18080,
  principal: { principalId: "pr-1", username: "alice" },
  php: { version: "8.4", mode: "fastcgi" },
};
const VALUES = [
  { key: "memory_limit", value: "256M" },
  { key: "open_basedir", value: `${HOME}:/tmp` },
];

const isWall = (line: string) => line.includes('ProxyFCGISetEnvIf "true"');

function vhost(id: string, key: string): string {
  return apacheSiteConfig(SITE, `${HOME}/sites/shop/current/public`, {
    phpFpmSocket: sitePhpSocketPath(id),
    phpSiteKey: key,
  });
}

const without = (text: string, drop: (line: string) => boolean) =>
  text.split("\n").filter((line) => !drop(line)).join("\n");

test("an old vhost gets exactly the wall lines and key a deploy writes", async () => {
  const key = await phpSiteKey(SECRET, ID);
  const current = vhost(ID, key);
  assert(current.includes(`TP_SITE_KEY "${key}"`));
  // Before the walls: no wall lines at all.
  assertEquals(patchApacheVhost(without(current, isWall), key), current);
  // Strip lines only: the key line is missing.
  assertEquals(
    patchApacheVhost(without(current, (l) => l.includes('TP_SITE_KEY "')), key),
    current,
  );
  // Already complete: left as it is.
  assertEquals(patchApacheVhost(current, key), current);
  assertEquals(apacheWallLines(key).length, 6);
});

test("a static vhost gets the unset lines a deploy writes, and no key", () => {
  const site: SiteApplySpec = { ...SITE, php: undefined };
  const current = apacheSiteConfig(site, `${HOME}/sites/shop/current/public`, {
    phpSiteKey: null,
  });
  assert(current.includes('ProxyFCGISetEnvIf "true" !PHP_VALUE'));
  assert(!current.includes('TP_SITE_KEY "'));
  const old = without(current, isWall);
  assertEquals(patchApacheVhost(old, null), current);
  assertEquals(patchApacheVhost(current, null), current);
});

test("php.ini patched equals the ini a deploy renders with the guard", async () => {
  const key = await phpSiteKey(SECRET, ID);
  const path = sitePhpGuardPath("/etc/turbopanel", ID);
  for (const values of [VALUES, [{ key: "memory_limit", value: "64M" }], []]) {
    const old = sitePhpIni(values, HOME);
    const next = sitePhpIni(values, HOME, undefined, { key, path });
    assertEquals(patchSitePhpIni(old, key, path), next);
    assertEquals(patchSitePhpIni(next, key, path), next);
  }
});

test("php-fpm.conf patched equals the conf a deploy renders with the guard", async () => {
  const key = await phpSiteKey(SECRET, FPM_ID);
  const path = sitePhpGuardPath("/etc/turbopanel", FPM_ID);
  const spec: SitePhpRuntimeSpec = {
    id: FPM_ID,
    mode: "fpm",
    series: "8.4",
    user: "alice",
    group: "alice",
    home: HOME,
    configDir: "/etc/turbopanel",
    libDir: "/opt/turbopanel/lib",
    runtimesDir: "/opt/turbopanel/vendor",
    webAccount: "tpapache",
  };
  const admin = [{ key: "memory_limit", value: "256M" }];
  const old = sitePhpFpmConf(spec, { pool: [], admin });
  const next = sitePhpFpmConf(spec, { pool: [], admin, guard: { key, path } });
  assertEquals(patchSitePhpFpmConf(old, path), next);
  assertEquals(patchSitePhpFpmConf(next, path), next);
  assertEquals(patchSitePhpFpmConf("[global]\n", path), null);
});

type Host = {
  io: ApacheWallsRepairIo;
  root: string;
  calls: string[];
  failOn: { tool?: string };
  read: (path: string) => Promise<string>;
  cleanup: () => Promise<void>;
};

async function makeHost(): Promise<Host> {
  const root = await Deno.makeTempDir({ prefix: "tp-walls-repair-" });
  const calls: string[] = [];
  const failOn: { tool?: string } = {};
  const ok = (stdout = "") => ({ success: true, stdout, stderr: "" });
  const fail = (stderr: string) => ({ success: false, stdout: "", stderr });
  const run: ApacheWallsRepairIo["run"] = async (command, args) => {
    if (command === "curl") return ok("200");
    const argv = bareSudoArgs(args).slice(1);
    const tool = argv[0];
    calls.push(argv.join(" "));
    if (tool === failOn.tool) return fail(`${tool} failed`);
    const last = argv.at(-1) as string;
    switch (tool) {
      case "cat":
        try {
          return ok(await Deno.readTextFile(last));
        } catch {
          return fail(`no such file ${last}`);
        }
      case "ls": {
        try {
          const names: string[] = [];
          for await (const entry of Deno.readDir(last)) names.push(entry.name);
          return ok(names.join("\n"));
        } catch {
          return fail(`no such directory ${last}`);
        }
      }
      case "cmp": {
        try {
          const [a, b] = await Promise.all([
            Deno.readTextFile(argv.at(-2) as string),
            Deno.readTextFile(last),
          ]);
          return a === b ? ok() : fail("differ");
        } catch {
          return fail("missing");
        }
      }
      case "install":
        if (argv.includes("-d")) {
          await Deno.mkdir(last, { recursive: true });
          return ok();
        }
        await Deno.mkdir(dirname(last), { recursive: true });
        await Deno.copyFile(argv.at(-2) as string, last);
        return ok();
      case "cp":
        try {
          await Deno.copyFile(argv.at(-2) as string, last);
          return ok();
        } catch {
          return fail("no such file");
        }
      case "mv":
        await Deno.rename(argv.at(-2) as string, last);
        return ok();
      case "rm":
        await Deno.remove(last).catch(() => undefined);
        return ok();
      default:
        return ok();
    }
  };
  const layout = {
    configDir: join(root, "etc"),
    stateDir: join(root, "state"),
    daemonStateDir: join(root, "daemon-state"),
  } as LayoutPaths;
  return {
    io: {
      run,
      unitDir: join(root, "units"),
      layout,
      secret: () => Promise.resolve(SECRET),
      version: "9.9.9",
      sleep: () => Promise.resolve(),
    },
    root,
    calls,
    failOn,
    read: (path) => Deno.readTextFile(path),
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

async function writeAt(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/** An Apache site and runtime as an update leaves them: no walls, no guard. */
async function seedOldSite(host: Host, id = ID): Promise<{
  vhostPath: string;
  oldVhost: string;
  newVhost: string;
  iniPath: string;
  oldIni: string;
  newIni: string;
}> {
  const { configDir } = host.io.layout;
  const key = await phpSiteKey(SECRET, id);
  const guardPath = sitePhpGuardPath(configDir, id);
  const newVhost = vhost(id, key);
  const oldVhost = without(newVhost, isWall);
  const vhostPath = join(configDir, "apache", "sites", "tp-e1-shop.conf");
  const iniPath = join(configDir, "php", "sites", id, "php.ini");
  const oldIni = sitePhpIni(VALUES, HOME);
  await writeAt(vhostPath, oldVhost);
  await writeAt(iniPath, oldIni);
  await writeAt(
    join(host.io.unitDir, sitePhpServiceName(id)),
    "[Service]\nUser=alice\n",
  );
  return {
    vhostPath,
    oldVhost,
    newVhost,
    iniPath,
    oldIni,
    newIni: sitePhpIni(VALUES, HOME, undefined, { key, path: guardPath }),
  };
}

test("the repair writes the vhost, the guard and the ini, once per version", async () => {
  const host = await makeHost();
  try {
    const site = await seedOldSite(host);
    const result = await repairApacheWalls(host.io);
    assertEquals(result.failed, []);
    assertEquals(result.repaired, ["tp-e1-shop.conf"]);
    assertEquals(await host.read(site.vhostPath), site.newVhost);
    assertEquals(await host.read(site.iniPath), site.newIni);
    assertEquals(
      await host.read(sitePhpGuardPath(host.io.layout.configDir, ID)),
      sitePhpGuardPhp(),
    );
    // The vhost is reloaded before the runtime restarts.
    const reload = host.calls.indexOf(
      "systemctl reload turbopanel-apache",
    );
    const restart = host.calls.findIndex((c) =>
      c.startsWith(`systemctl restart ${sitePhpServiceName(ID)}`)
    );
    assert(reload >= 0 && restart > reload, host.calls.join("\n"));
    const marker = JSON.parse(
      await host.read(
        join(host.io.layout.stateDir, "sites", APACHE_WALLS_MARKER),
      ),
    );
    assertEquals(marker.version, "9.9.9");

    host.calls.length = 0;
    const again = await repairApacheWalls(host.io);
    assertEquals(again.skipped, true);
    assertEquals(host.calls, []);
  } finally {
    await host.cleanup();
  }
});

test("a new daemon version repairs again but finds nothing left to change", async () => {
  const host = await makeHost();
  try {
    await seedOldSite(host);
    await repairApacheWalls(host.io);
    host.calls.length = 0;
    const next = await repairApacheWalls({ ...host.io, version: "9.9.10" });
    assertEquals(next.repaired, []);
    assertEquals(next.failed, []);
    assertEquals(
      host.calls.some((c) => c.startsWith("systemctl restart")),
      false,
    );
  } finally {
    await host.cleanup();
  }
});

test("a runtime that fails its test puts the vhost and ini back and is not recorded", async () => {
  const host = await makeHost();
  try {
    const site = await seedOldSite(host);
    host.failOn.tool = "php-test";
    const result = await repairApacheWalls(host.io);
    assertEquals(result.failed, ["tp-e1-shop.conf"]);
    assertEquals(await host.read(site.vhostPath), site.oldVhost);
    assertEquals(await host.read(site.iniPath), site.oldIni);
    const marker = await Deno.stat(
      join(host.io.layout.stateDir, "sites", APACHE_WALLS_MARKER),
    ).catch(() => null);
    assertEquals(marker, null);
  } finally {
    await host.cleanup();
  }
});

test("a runtime that cannot be read leaves its vhost alone", async () => {
  const host = await makeHost();
  try {
    const site = await seedOldSite(host);
    await Deno.remove(site.iniPath);
    const result = await repairApacheWalls(host.io);
    assertEquals(result.failed, ["tp-e1-shop.conf"]);
    assertEquals(await host.read(site.vhostPath), site.oldVhost);
  } finally {
    await host.cleanup();
  }
});

test("a host without Apache, or with a shared-pool site, is recorded; the shared site gets the unset lines", async () => {
  const host = await makeHost();
  try {
    assertEquals((await repairApacheWalls(host.io)).failed, []);
    const shared =
      '<VirtualHost *:80>\n  <FilesMatch \\.php$>\n    SetHandler "proxy:unix:/run/php/shared.sock|fcgi://localhost/"\n  </FilesMatch>\n</VirtualHost>\n';
    const path = join(host.io.layout.configDir, "apache", "sites", "tp-s.conf");
    await writeAt(path, shared);
    const result = await repairApacheWalls({ ...host.io, version: "9.9.10" });
    assertEquals(result.needsRedeploy, ["tp-s.conf"]);
    assertEquals(result.failed, []);
    assertEquals(
      await host.read(path),
      patchApacheVhost(shared, null),
    );
    assert((await host.read(path)).includes("!TP_SITE_KEY"));
  } finally {
    await host.cleanup();
  }
});

test("a vhost a deploy rewrote after the listing is patched from its new text", async () => {
  const host = await makeHost();
  try {
    const site = await seedOldSite(host);
    const rewritten = `${site.oldVhost}# written by a deploy\n`;
    let reads = 0;
    const run = host.io.run;
    const io: ApacheWallsRepairIo = {
      ...host.io,
      run: async (command, args) => {
        const result = await run(command, args);
        const argv = bareSudoArgs(args).slice(1);
        if (
          argv[0] === "cat" && argv.at(-1) === site.vhostPath && ++reads === 1
        ) {
          await Deno.writeTextFile(site.vhostPath, rewritten);
        }
        return result;
      },
    };
    const result = await repairApacheWalls(io);
    assertEquals(result.failed, []);
    const final = await host.read(site.vhostPath);
    assert(final.includes("# written by a deploy"), final);
    assertEquals(
      final,
      patchApacheVhost(rewritten, await phpSiteKey(SECRET, ID)),
    );
  } finally {
    await host.cleanup();
  }
});

test("an fpm runtime gets its pool config patched and the unit's own group", async () => {
  const host = await makeHost();
  try {
    const { configDir } = host.io.layout;
    const key = await phpSiteKey(SECRET, FPM_ID);
    const guardPath = sitePhpGuardPath(configDir, FPM_ID);
    const spec: SitePhpRuntimeSpec = {
      id: FPM_ID,
      mode: "fpm",
      series: "8.4",
      user: "alice",
      group: "websites",
      home: HOME,
      configDir,
      libDir: "/opt/turbopanel/lib",
      runtimesDir: "/opt/turbopanel/vendor",
      webAccount: "tpapache",
    };
    const site = { ...SITE, php: { version: "8.4", mode: "fpm" as const } };
    const newVhost = apacheSiteConfig(
      site,
      `${HOME}/sites/shop/current/public`,
      {
        phpFpmSocket: sitePhpSocketPath(FPM_ID),
        phpSiteKey: key,
      },
    );
    const vhostPath = join(configDir, "apache", "sites", "tp-e1-shop.conf");
    const dir = join(configDir, "php", "sites", FPM_ID);
    const admin = [{ key: "memory_limit", value: "256M" }];
    await writeAt(vhostPath, without(newVhost, isWall));
    await writeAt(join(dir, "php.ini"), sitePhpIni(VALUES, HOME));
    await writeAt(
      join(dir, "php-fpm.conf"),
      sitePhpFpmConf(spec, { pool: [], admin }),
    );
    await writeAt(
      join(host.io.unitDir, sitePhpServiceName(FPM_ID)),
      "[Service]\nUser=alice\nGroup=websites\n",
    );
    const result = await repairApacheWalls(host.io);
    assertEquals(result.failed, []);
    assertEquals(result.repaired, ["tp-e1-shop.conf"]);
    assertEquals(
      await host.read(join(dir, "php-fpm.conf")),
      sitePhpFpmConf(spec, {
        pool: [],
        admin,
        guard: { key, path: guardPath },
      }),
    );
    assertEquals(await host.read(vhostPath), newVhost);
    assert(
      host.calls.some((c) => c.includes("-g websites")),
      host.calls.join("\n"),
    );
  } finally {
    await host.cleanup();
  }
});
