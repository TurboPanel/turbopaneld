import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { PHP_FPM_RUN_DIR } from "../../paths/layout.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { bareSudoArgs } from "../../testing/sudo-argv.ts";
import {
  apacheSiteConfig,
  caddySiteConfig,
  nginxSiteConfig,
  phpFpmPoolConfig,
  phpFpmSocketPath,
  type SiteApplySpec,
} from "../site.ts";
import {
  movePhpSocketPaths,
  patchPhpFpmUnit,
  PHP_RUN_TREE_MARKER,
  type PhpRunTreeRepairIo,
  repairPhpRunTree,
} from "./php-run-tree-repair.ts";

/** Sonar S2187 recognizes `test()`; see site-apply.test.ts. */
const test = Deno.test.bind(Deno);

const OLD_RUN = "/run/turbopanel";
const OLD_UNIT = `[Service]
Type=forking
PIDFile=${OLD_RUN}/php/%i/php-fpm.pid
Environment=PHP_INI_SCAN_DIR=:/etc/turbopanel/php/%i/conf.d
ExecStartPre=/usr/bin/install -d -o tpapache -g tp -m 0750 ${OLD_RUN}/php/%i
ExecStart=/usr/sbin/php-fpm%i --fpm-config /etc/turbopanel/php/%i/php-fpm.conf --pid ${OLD_RUN}/php/%i/php-fpm.pid
`;
const ENVIRONMENT = "e1";
const ROOT = "/srv/users/alice/sites/shop/current/public";

function site(engine: "caddy" | "nginx" | "apache"): SiteApplySpec {
  return {
    composeServiceName: "shop",
    engine,
    root: "public",
    listenPort: 18080,
    principal: { principalId: "pr-1", username: "alice" },
    php: { version: "8.4", mode: "fpm" },
  };
}

const NEW_SOCKET = phpFpmSocketPath("8.4", ENVIRONMENT, "shop");
const OLD_SOCKET = `${OLD_RUN}/php/8.4/tp-e1-shop.sock`;

/** What a deploy writes today, per file, for the new socket path. */
function rendered(socket: string): Record<string, string> {
  return {
    pool: phpFpmPoolConfig(ENVIRONMENT, site("apache"), ROOT, socket),
    caddy: caddySiteConfig(site("caddy"), ROOT, null, { phpFpmSocket: socket }),
    nginx: nginxSiteConfig(site("nginx"), ROOT, null, {
      phpFpmSocket: socket,
    }),
    apache: apacheSiteConfig(site("apache"), ROOT, {
      phpFpmSocket: socket,
      phpSiteKey: "ab".repeat(32),
    }),
  };
}

type Host = {
  io: PhpRunTreeRepairIo;
  root: string;
  calls: string[];
  path: (...parts: string[]) => string;
  cleanup: () => Promise<void>;
};

async function makeHost(): Promise<Host> {
  const root = await Deno.makeTempDir({ prefix: "tp-run-tree-repair-" });
  const calls: string[] = [];
  const ok = (stdout = "") => ({ success: true, stdout, stderr: "" });
  const fail = (stderr: string) => ({ success: false, stdout: "", stderr });
  const run: PhpRunTreeRepairIo["run"] = async (command, args) => {
    if (command === "curl") return ok("200");
    const argv = bareSudoArgs(args).slice(1);
    calls.push(argv.join(" "));
    const last = argv.at(-1) as string;
    switch (argv[0]) {
      case "cat":
        try {
          return ok(await Deno.readTextFile(last));
        } catch {
          return fail(`no such file ${last}`);
        }
      case "ls":
        try {
          const names: string[] = [];
          for await (const entry of Deno.readDir(last)) names.push(entry.name);
          return ok(names.join("\n"));
        } catch {
          return fail(`no such directory ${last}`);
        }
      case "cmp":
        try {
          const [a, b] = await Promise.all([
            Deno.readTextFile(argv.at(-2) as string),
            Deno.readTextFile(last),
          ]);
          return a === b ? ok() : fail("differ");
        } catch {
          return fail("missing");
        }
      case "install":
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
    runDir: OLD_RUN,
    stateDir: join(root, "state"),
    daemonStateDir: join(root, "daemon-state"),
  } as LayoutPaths;
  return {
    io: { run, unitDir: join(root, "units"), layout, version: "9.9.9" },
    root,
    calls,
    path: (...parts) => join(root, ...parts),
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

async function writeAt(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/** Where each file lives on a host, keyed like {@link rendered}. */
function locations(host: Host): Record<string, string> {
  return {
    pool: host.path("etc/php/8.4/pools/tp-e1-shop.conf"),
    caddy: host.path("etc/site-caddy/sites/tp-e1-shop.conf"),
    nginx: host.path("etc/nginx/sites/tp-e1-shop.conf"),
    apache: host.path("etc/apache/sites/tp-e1-shop.conf"),
  };
}

const DEFAULT_POOL = (dir: string) =>
  `[default]\nlisten = ${dir}/8.4/default.sock\nlisten.mode = 0660\n`;

/** A host an update left as it was: every file names the old folder. */
async function seedOldHost(host: Host): Promise<void> {
  const old = rendered(OLD_SOCKET);
  const where = locations(host);
  for (const key of Object.keys(where)) await writeAt(where[key], old[key]);
  await writeAt(
    host.path("etc/php/8.4/pools/default.conf"),
    DEFAULT_POOL(`${OLD_RUN}/php`),
  );
  await writeAt(host.path("units/turbopanel-php-fpm@.service"), OLD_UNIT);
}

test("the old pool and vhosts end up on the new path and name no old path", async () => {
  const host = await makeHost();
  try {
    await seedOldHost(host);
    const result = await repairPhpRunTree(host.io);
    assertEquals(result.failed, []);
    const want = rendered(NEW_SOCKET);
    const where = locations(host);
    for (const key of Object.keys(where)) {
      assertEquals(await Deno.readTextFile(where[key]), want[key], key);
    }
    assertEquals(
      await Deno.readTextFile(host.path("etc/php/8.4/pools/default.conf")),
      DEFAULT_POOL(PHP_FPM_RUN_DIR),
    );
    const unit = await Deno.readTextFile(
      host.path("units/turbopanel-php-fpm@.service"),
    );
    for (
      const text of [
        unit,
        ...Object.values(where),
        host.path("etc/php/8.4/pools/default.conf"),
      ]
    ) {
      const body = text.startsWith("/") ? await Deno.readTextFile(text) : text;
      assert(!body.includes(`${OLD_RUN}/php`), body);
    }
    assert(unit.includes(`--pid ${PHP_FPM_RUN_DIR}/%i/php-fpm.pid`));
    assert(host.calls.includes("systemctl daemon-reload"));
    // The master is restarted (new unit and pidfile), then the engines reload.
    const restart = host.calls.indexOf(
      "systemctl restart turbopanel-php-fpm@8.4",
    );
    const nginx = host.calls.indexOf("systemctl reload turbopanel-nginx");
    assert(restart >= 0 && nginx > restart, host.calls.join("\n"));
    assert(
      (await Deno.readTextFile(host.path("state/sites", PHP_RUN_TREE_MARKER)))
        .includes("9.9.9"),
    );
  } finally {
    await host.cleanup();
  }
});

test("the repair is recorded per version and a current host is left alone", async () => {
  const host = await makeHost();
  try {
    await seedOldHost(host);
    await repairPhpRunTree(host.io);
    host.calls.length = 0;
    const again = await repairPhpRunTree(host.io);
    assert(again.skipped);
    assertEquals(host.calls, []);
    // A newer version looks again and finds nothing to write.
    const next = await repairPhpRunTree({ ...host.io, version: "9.9.10" });
    assertEquals(next.repaired, []);
    assert(!host.calls.some((call) => call.startsWith("systemctl restart")));
  } finally {
    await host.cleanup();
  }
});

test("a pool that fails its test is put back and the pass is retried", async () => {
  const host = await makeHost();
  try {
    await seedOldHost(host);
    const inner = host.io.run;
    const io: PhpRunTreeRepairIo = {
      ...host.io,
      run: (command, args) =>
        bareSudoArgs(args).includes("--test")
          ? Promise.resolve({ success: false, stdout: "", stderr: "bad" })
          : inner(command, args),
    };
    const result = await repairPhpRunTree(io);
    assertEquals(result.failed, ["php 8.4"]);
    assertEquals(
      await Deno.readTextFile(locations(host).pool),
      rendered(OLD_SOCKET).pool,
    );
    // The vhosts stay on the old path too, and nothing is recorded.
    assertEquals(
      await Deno.readTextFile(locations(host).nginx),
      rendered(OLD_SOCKET).nginx,
    );
    await assertRejectsNoMarker(host);
  } finally {
    await host.cleanup();
  }
});

async function assertRejectsNoMarker(host: Host): Promise<void> {
  try {
    await Deno.stat(host.path("state/sites", PHP_RUN_TREE_MARKER));
  } catch (err) {
    assert(err instanceof Deno.errors.NotFound);
    return;
  }
  throw new Error("the pass was recorded after a failure");
}

test("movePhpSocketPaths and patchPhpFpmUnit move only the run folder", () => {
  assertEquals(
    movePhpSocketPaths(`listen = ${OLD_SOCKET}\nuser = a`, OLD_RUN),
    `listen = ${NEW_SOCKET}\nuser = a`,
  );
  const unit = patchPhpFpmUnit(OLD_UNIT, OLD_RUN);
  assert(
    unit.includes(
      `ExecStartPre=/usr/bin/install -d -o root -g tp -m 0750 ${PHP_FPM_RUN_DIR}\n` +
        `ExecStartPre=/usr/bin/install -d -o root -g tp -m 0750 ${PHP_FPM_RUN_DIR}/%i\n`,
    ),
  );
  assertEquals(patchPhpFpmUnit(unit, OLD_RUN), unit);
});
