import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  findOnPath,
  freePort,
  panelCaddyTestSite,
  pinnedCaddy,
  required,
  runCaddyfileTasks,
  startPanelCaddy,
} from "../testing/panel-caddy.ts";

/**
 * The self-hosted control plane's proxy does not name itself. Caddy sends
 * `Server: Caddy` on every response and `Via: 1.1 Caddy` on proxied ones; the
 * template deletes both in the shared header block, and handle_errors (which
 * that block does not reach) deletes Server again. Existing hosts get the same
 * lines in place.
 */

const test = Deno.test.bind(Deno);

const ROLES = new URL("../../orchestration/roles/", import.meta.url);
const TEMPLATE = "instance-launch/templates/Caddyfile.j2";
const TASKS = "instance-launch/tasks/caddyfile-server-headers.yml";

const HEADER_DELETIONS = "                -Server\n                -Via\n";
const ERRORS_DELETION = "                header -Server\n";

async function readRole(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, ROLES));
}

const stripComments = (text: string) =>
  text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

/** The template as an older build rendered it: no deletions at all. */
function withoutDeletions(text: string): string {
  const older = text
    .replace(HEADER_DELETIONS, "")
    .replace(ERRORS_DELETION, "");
  assert(!older.includes("-Via") && !older.includes("-Server"), older);
  return older;
}

test("the panel Caddyfile deletes Server and Via, error responses included", async () => {
  const template = stripComments(await readRole(TEMPLATE));
  assertStringIncludes(
    template,
    `                X-Frame-Options "DENY"\n${HEADER_DELETIONS}        }\n`,
  );
  assertStringIncludes(
    template,
    `        handle_errors {\n${ERRORS_DELETION}`,
  );
});

test("existing hosts get the deletions in place, safely", async () => {
  const tasks = await readRole(TASKS);
  assertStringIncludes(tasks, "ansible.builtin.replace:");
  assertStringIncludes(tasks, "is not search('(?m)^\\s*-Via\\s*$')");
  assertStringIncludes(tasks, "is not search('(?m)^\\s*header -Server\\s*$')");
  assertEquals(tasks.split("backup: true").length - 1, 2);
  assertEquals(tasks.split("caddy adapt --config %s").length - 1, 2);
  assertStringIncludes(tasks, "Reload turbopanel caddy");
  const main = await readRole("instance-launch/tasks/main.yml");
  assertStringIncludes(main, "caddyfile-server-headers.yml");
  assert(
    main.indexOf("caddyfile-server-headers.yml") >
      main.indexOf("caddyfile.yml"),
    "the in-place edit runs after the guarded render",
  );
});

// ---- Optional checks: need ansible-playbook and/or the pinned Caddy. ----

const caddy = pinnedCaddy();
const ansiblePlaybook = findOnPath("ansible-playbook");

test({
  name: "the pinned Caddy sends no Server or Via header from the panel",
  ignore: caddy === undefined,
  permissions: { read: true, write: true, run: true, env: true, net: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-server-headers-" });
    const port = freePort();
    await Deno.mkdir(join(root, "ui"), { recursive: true });
    await Deno.mkdir(join(root, "run"), { recursive: true });
    await Deno.writeTextFile(join(root, "ui", "index.html"), "<html></html>");
    await Deno.writeTextFile(join(root, "updating.html"), "<html></html>");
    // A stand-in instance on the Unix socket the API is proxied to.
    const instance = Deno.serve(
      {
        path: join(root, "run", "instance.sock"),
        transport: "unix",
        onListen: () => {},
      },
      () => new Response("{}", { headers: { server: "instance" } }),
    );
    const config = join(root, "Caddyfile");
    await Deno.writeTextFile(
      config,
      panelCaddyTestSite(await readRole(TEMPLATE), root, port),
    );
    const { base, stop } = await startPanelCaddy(
      required(caddy, "caddy"),
      config,
      root,
      port,
    );
    try {
      const get = async (path: string) => {
        const res = await fetch(base + path, { redirect: "manual" });
        await res.body?.cancel();
        return res;
      };
      // Proxied, static page, missing hashed bundle.
      for (
        const [path, status] of [
          ["/api/health", 200],
          ["/", 200],
          ["/assets/missing.ffffffffffffffffffffffffffffffff.ttf", 404],
        ] as const
      ) {
        const res = await get(path);
        assertEquals(res.status, status, path);
        assertEquals(res.headers.get("via"), null, path);
        assertEquals(
          res.headers.get("server")?.toLowerCase().includes("caddy") ?? false,
          false,
          path,
        );
        assertEquals(res.headers.get("x-content-type-options"), "nosniff");
      }
      // The instance is down: handle_errors answers.
      await instance.shutdown();
      for (const path of ["/api/health", "/webhook/github"]) {
        const res = await get(path);
        assertEquals(res.status, 503, path);
        assertEquals(res.headers.get("server"), null, path);
        assertEquals(res.headers.get("via"), null, path);
      }
    } finally {
      await stop();
      await instance.shutdown();
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "the in-place edit turns an older Caddyfile into the current template",
  ignore: ansiblePlaybook === undefined || caddy === undefined,
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-server-headers-edit-" });
    try {
      const current = panelCaddyTestSite(await readRole(TEMPLATE), root, 18443);
      const file = join(root, "Caddyfile");
      await Deno.writeTextFile(file, withoutDeletions(current));

      const run = () =>
        runCaddyfileTasks(
          root,
          caddy!,
          required(ansiblePlaybook, "ansible-playbook"),
          TASKS,
        );
      const first = await run();
      assertStringIncludes(first, "changed=2");
      const edited = await Deno.readTextFile(file);
      assertEquals(stripComments(edited), stripComments(current));

      const again = await run();
      assertStringIncludes(again, "changed=0");
      assertEquals(await Deno.readTextFile(file), edited);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
