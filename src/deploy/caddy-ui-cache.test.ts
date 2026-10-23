import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";

/**
 * After a control-plane update the exported UI has new bundle names. A browser
 * that kept the old page asks for the old names; if Caddy answered those with
 * the app page (text/html, 200), `nosniff` refuses to run it and the page hangs
 * on its spinner. So the panel's Caddy:
 * - sends `Cache-Control: no-cache` on the page and everything that falls back
 *   to it, so a browser always checks for a newer page;
 * - caches the hashed bundles (/_expo/static/*, /assets/*) for a year;
 * - answers a missing hashed bundle with 404, never with the app page.
 */

const ROLES = new URL("../../orchestration/roles/", import.meta.url);
const TEMPLATE = "instance-launch/templates/Caddyfile.j2";
const TASKS = "instance-launch/tasks/caddyfile-ui-cache.yml";

const IMMUTABLE = 'Cache-Control "public, max-age=31536000, immutable"';
const NO_CACHE = 'Cache-Control "no-cache"';
const HASHED_MATCHER = "@ui_hashed path /_expo/static/* /assets/*";

async function readRole(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, ROLES));
}

/** The block that opens on `line` (exact text) and its closing brace. */
function block(text: string, line: string): string {
  const start = text.indexOf(`${line}\n`);
  assert(start >= 0, `missing block: ${line.trim()}`);
  const indent = /^ */.exec(line)?.[0] ?? "";
  const end = text.indexOf(`\n${indent}}\n`, start);
  assert(end > start, `unclosed block: ${line.trim()}`);
  return text.slice(start, end + indent.length + 3);
}

/** The UI catch-all `handle` in the shared site snippet. */
function uiHandle(text: string): string {
  const marker = text.indexOf("# Serve the exported UI");
  assert(marker >= 0, "UI handle comment present");
  return block(text.slice(marker), "        handle {");
}

const stripComments = (text: string) =>
  text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

Deno.test("the panel UI caches hashed bundles, revalidates pages and 404s missing bundles", async () => {
  const ui = uiHandle(await readRole(TEMPLATE));
  // The security headers stay on every UI response.
  assertStringIncludes(ui, 'Content-Security-Policy "frame-ancestors');
  assertStringIncludes(ui, "Content-Security-Policy-Report-Only");
  assertStringIncludes(ui, HASHED_MATCHER);

  const hashed = block(ui, "                handle @ui_hashed {");
  const found = block(
    hashed,
    "                        handle @ui_hashed_file {",
  );
  assertStringIncludes(hashed, "@ui_hashed_file file");
  assertStringIncludes(found, IMMUTABLE);
  assertStringIncludes(found, "file_server");
  // A missing bundle is a plain 404, never the app page.
  assertEquals(hashed.includes("try_files"), false);
  assertStringIncludes(hashed, 'respond "Not Found" 404');
  assertStringIncludes(hashed, 'Cache-Control "no-store"');

  // Everything else (the page, routes, unhashed files such as /theme-boot.js)
  // falls back to index.html and is revalidated on every load.
  const rest = ui.slice(ui.indexOf(hashed) + hashed.length);
  const fallback = block(rest, "                handle {");
  assertStringIncludes(fallback, NO_CACHE);
  assertStringIncludes(fallback, "try_files {path} /index.html");
  assertStringIncludes(fallback, "file_server");
  assertEquals(ui.split("try_files").length - 1, 1);
});

Deno.test("existing hosts get the UI cache headers in place, safely", async () => {
  const tasks = await readRole(TASKS);
  // Only when missing, backed up, and refused unless the vendored Caddy still
  // adapts the result.
  assertStringIncludes(tasks, "ansible.builtin.replace:");
  assertStringIncludes(tasks, "is not search('ui_hashed')");
  assertStringIncludes(tasks, "backup: true");
  assertStringIncludes(tasks, "caddy adapt --config %s");
  assertStringIncludes(tasks, "Reload turbopanel caddy");
  const main = await readRole("instance-launch/tasks/main.yml");
  assertStringIncludes(main, "caddyfile-ui-cache.yml");
  assert(
    main.indexOf("caddyfile-ui-cache.yml") > main.indexOf("caddyfile.yml"),
    "the in-place edit runs after the guarded render",
  );
});

// ---- Optional checks: need ansible-playbook and/or the pinned Caddy. ----

function findOnPath(name: string): string | undefined {
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

/** The pinned Caddy, when one is available (env or PATH); else skip. */
function pinnedCaddy(): string | undefined {
  const defaults = Deno.readTextFileSync(
    new URL("caddy/defaults/main.yml", ROLES),
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

const caddy = pinnedCaddy();
const ansiblePlaybook = findOnPath("ansible-playbook");

/** The template's variables, for a render without Jinja. */
function substitute(text: string, root: string): string {
  return text
    .replaceAll("{{ turbopanel_caddy_admin_socket }}", join(root, "admin.sock"))
    .replaceAll("{{ turbopanel_run_dir }}", join(root, "run"))
    .replaceAll("{{ turbopanel_ui_dist_dir }}", join(root, "ui"))
    .replaceAll("{{ turbopanel_caddyfile | dirname }}", root);
}

/** Global options and the shared snippet, served over plain HTTP on `port`. */
function testSite(template: string, root: string, port: number): string {
  const start = template.search(/^\{$/m);
  const end = template.indexOf("# Always-on recovery listener");
  assert(start >= 0 && end > start, "template layout");
  return substitute(template.slice(start, end), root) +
    `\nhttp://127.0.0.1:${port} {\n\timport turbopanel_app\n}\n`;
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

Deno.test({
  name: "the pinned Caddy serves the UI cache rules as intended",
  ignore: caddy === undefined,
  permissions: { read: true, write: true, run: true, env: true, net: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-ui-cache-" });
    const port = freePort();
    const js = "_expo/static/js/web/entry-0123456789abcdef0123456789abcdef.js";
    await Deno.mkdir(join(root, "ui", dirname(js)), { recursive: true });
    await Deno.writeTextFile(join(root, "ui", "index.html"), "<html></html>");
    await Deno.writeTextFile(join(root, "ui", "theme-boot.js"), "void 0;");
    await Deno.writeTextFile(join(root, "ui", js), "void 0;");
    const config = join(root, "Caddyfile");
    await Deno.writeTextFile(
      config,
      testSite(await readRole(TEMPLATE), root, port),
    );
    const child = new Deno.Command(caddy!, {
      args: ["run", "--config", config, "--adapter", "caddyfile"],
      env: { XDG_DATA_HOME: root, XDG_CONFIG_HOME: root, HOME: root },
      stdout: "null",
      stderr: "piped",
    }).spawn();
    const base = `http://127.0.0.1:${port}`;
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        try {
          await (await fetch(`${base}/`)).body?.cancel();
          up = true;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      assert(up, "caddy came up");
      const get = async (path: string) => {
        const res = await fetch(base + path);
        await res.body?.cancel();
        return res;
      };
      for (const path of ["/", "/settings/updates", "/theme-boot.js"]) {
        const res = await get(path);
        assertEquals(res.status, 200, path);
        assertEquals(res.headers.get("cache-control"), "no-cache", path);
        assertEquals(res.headers.get("x-content-type-options"), "nosniff");
      }
      const bundle = await get(`/${js}`);
      assertEquals(bundle.status, 200);
      assertEquals(
        bundle.headers.get("cache-control"),
        "public, max-age=31536000, immutable",
      );
      for (
        const path of [
          "/_expo/static/js/web/entry-ffffffffffffffffffffffffffffffff.js",
          "/assets/missing.ffffffffffffffffffffffffffffffff.ttf",
        ]
      ) {
        const res = await get(path);
        assertEquals(res.status, 404, path);
        assertEquals(res.headers.get("cache-control"), "no-store", path);
        assertEquals(
          res.headers.get("content-type")?.startsWith("text/html") ?? false,
          false,
          path,
        );
      }
    } finally {
      child.kill("SIGTERM");
      await child.stderr.cancel();
      await child.status;
      await Deno.remove(root, { recursive: true });
    }
  },
});

/** The UI handle tail every Caddyfile rendered before this change carries. */
const OLD_TAIL = [
  "                try_files {path} /index.html",
  "                file_server",
  "",
].join("\n");

async function runInPlaceEdit(root: string, caddyBin: string): Promise<string> {
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
      "  tasks:",
      `    - ansible.builtin.import_tasks: ${new URL(TASKS, ROLES).pathname}`,
      "  handlers:",
      "    - name: Reload turbopanel caddy",
      "      ansible.builtin.debug:",
      "        msg: reload",
      "",
    ].join("\n"),
  );
  const home = join(root, "home");
  await Deno.mkdir(home, { recursive: true });
  const out = await new Deno.Command(ansiblePlaybook!, {
    args: [play, "-i", "localhost,", "-c", "local"],
    env: {
      HOME: home,
      ANSIBLE_HOME: home,
      ANSIBLE_LOCAL_TEMP: home,
      ANSIBLE_REMOTE_TMP: home,
      ANSIBLE_NOCOWS: "1",
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

Deno.test({
  name: "the in-place edit turns an older Caddyfile into the current template",
  ignore: ansiblePlaybook === undefined || caddy === undefined,
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-ui-cache-edit-" });
    try {
      const template = await readRole(TEMPLATE);
      const current = testSite(template, root, 18443);
      const ui = uiHandle(current);
      // Everything after the `root` line, up to the handle's closing brace.
      const newTail = ui.slice(
        ui.indexOf("\n", ui.indexOf("root * ")) + 1,
        -"        }\n".length,
      );
      assert(newTail.endsWith("file_server\n                }\n"), newTail);
      const older = current.replace(newTail, OLD_TAIL);
      assert(older !== current && !older.includes("ui_hashed"));
      const file = join(root, "Caddyfile");
      await Deno.writeTextFile(file, older);

      const first = await runInPlaceEdit(root, caddy!);
      assertStringIncludes(first, "changed=1");
      const edited = await Deno.readTextFile(file);
      assertEquals(stripComments(edited), stripComments(current));

      const again = await runInPlaceEdit(root, caddy!);
      assertStringIncludes(again, "changed=0");
      assertEquals(await Deno.readTextFile(file), edited);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
