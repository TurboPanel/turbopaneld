import { assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { PHP_FPM_RUN_DIR } from "../../paths/layout.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { bareSudoArgs } from "../../testing/sudo-argv.ts";
import {
  checkPhpRunTree,
  type PhpRunTreeCheckIo,
} from "./php-run-tree-check.ts";

/** Sonar S2187 recognizes `test()`; see site-apply.test.ts. */
const test = Deno.test.bind(Deno);

const OLD_RUN = "/run/turbopanel";
const OLD_SOCKET = `listen = ${OLD_RUN}/php/8.4/tp-e1-shop.sock\n`;
const NEW_SOCKET = `listen = ${PHP_FPM_RUN_DIR}/8.4/tp-e1-shop.sock\n`;

type Host = {
  io: PhpRunTreeCheckIo;
  calls: string[];
  put: (rel: string, text: string) => Promise<void>;
  cleanup: () => Promise<void>;
};

async function makeHost(): Promise<Host> {
  const root = await Deno.makeTempDir({ prefix: "tp-run-tree-check-" });
  const calls: string[] = [];
  const run: PhpRunTreeCheckIo["run"] = async (command, args) => {
    const argv = bareSudoArgs(args).slice(1);
    calls.push([command, ...argv].join(" "));
    const last = argv.at(-1) as string;
    try {
      if (argv[0] === "cat") {
        return {
          success: true,
          stdout: await Deno.readTextFile(last),
          stderr: "",
        };
      }
      if (argv[0] === "ls") {
        const names: string[] = [];
        for await (const entry of Deno.readDir(last)) names.push(entry.name);
        return { success: true, stdout: names.join("\n"), stderr: "" };
      }
    } catch {
      return { success: false, stdout: "", stderr: `no such file ${last}` };
    }
    return { success: true, stdout: "", stderr: "" };
  };
  const layout = {
    configDir: join(root, "etc"),
    runDir: OLD_RUN,
  } as LayoutPaths;
  return {
    io: { run, unitDir: join(root, "units"), layout },
    calls,
    put: async (rel, text) => {
      await Deno.mkdir(dirname(join(root, rel)), { recursive: true });
      await Deno.writeTextFile(join(root, rel), text);
    },
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

const NEW_UNIT = `PIDFile=${PHP_FPM_RUN_DIR}/%i/php-fpm.pid\n`;
const OLD_UNIT = `PIDFile=${OLD_RUN}/php/%i/php-fpm.pid\n`;

test("a host with no php-fpm unit has nothing to report and nothing is run", async () => {
  const host = await makeHost();
  try {
    assertEquals(await checkPhpRunTree(host.io), []);
    assertEquals(host.calls, []);
  } finally {
    await host.cleanup();
  }
});

test("a moved host reports nothing", async () => {
  const host = await makeHost();
  try {
    await host.put("units/turbopanel-php-fpm@.service", NEW_UNIT);
    await host.put("etc/php/8.4/pools/tp-e1-shop.conf", NEW_SOCKET);
    await host.put("etc/nginx/sites/shop.conf", NEW_SOCKET);
    assertEquals(await checkPhpRunTree(host.io), []);
  } finally {
    await host.cleanup();
  }
});

test("the unit, pools and vhosts still on the old folder are reported", async () => {
  const host = await makeHost();
  try {
    await host.put("units/turbopanel-php-fpm@.service", OLD_UNIT);
    await host.put("etc/php/8.4/pools/tp-e1-shop.conf", OLD_SOCKET);
    await host.put("etc/php/8.4/pools/default.conf", NEW_SOCKET);
    await host.put("etc/nginx/sites/shop.conf", OLD_SOCKET);
    await host.put("etc/site-caddy/sites/shop.conf", OLD_SOCKET);
    await host.put("etc/apache/sites/shop.conf", OLD_SOCKET);
    assertEquals(await checkPhpRunTree(host.io), [
      "turbopanel-php-fpm@.service",
      "php 8.4 tp-e1-shop.conf",
      "caddy shop.conf",
      "nginx shop.conf",
      "apache shop.conf",
    ]);
  } finally {
    await host.cleanup();
  }
});

test("the check only reads: no command writes, and nothing is left behind", async () => {
  const host = await makeHost();
  try {
    await host.put("units/turbopanel-php-fpm@.service", OLD_UNIT);
    await host.put("etc/php/8.4/pools/tp-e1-shop.conf", OLD_SOCKET);
    await checkPhpRunTree(host.io);
    for (const call of host.calls) {
      assertEquals(/ (cat|ls) /.test(call), true, call);
    }
  } finally {
    await host.cleanup();
  }
});
