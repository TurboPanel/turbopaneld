import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import { DAEMON_ROOT } from "./assets.ts";
import { ensureSitePhpRuntimes, type SiteApplySpec } from "../deploy/site.ts";

const test = Deno.test.bind(Deno);

type Task = Record<string, unknown> & { name?: string };

const tasksOf = async (role: string): Promise<Task[]> =>
  parse(
    await Deno.readTextFile(
      join(DAEMON_ROOT, `orchestration/roles/${role}/tasks/main.yml`),
    ),
  ) as Task[];

test("deploy vendors PHP runtimes (creating tpphp groups) before joining principals", async () => {
  const src = await Deno.readTextFile(
    join(DAEMON_ROOT, "src/commands/deploy-environment.ts"),
  );
  const php = src.search(/await\s+ensureSitePhpRuntimes\(/);
  const principals = src.search(/await\s+ensureDeployPrincipals\(\s*layout,/);
  assert(php > 0 && principals > 0);
  assertEquals(php < principals, true);
});

test("ensureSitePhpRuntimes runs the engine playbook for PHP sites only", async () => {
  const phpSite: SiteApplySpec = {
    composeServiceName: "phpsite",
    engine: "nginx",
    root: "public",
    listenPort: 18083,
    php: { version: "8.4", settings: {} },
  };
  const staticSite: SiteApplySpec = {
    composeServiceName: "static",
    engine: "caddy",
    root: "public",
    listenPort: 18085,
  };
  const labels: string[] = [];
  const runPlaybook = (_p: string, label: string, args?: string[]) => {
    labels.push(`${label} ${(args ?? []).join(" ")}`);
    return Promise.resolve();
  };
  await ensureSitePhpRuntimes([staticSite], { runPlaybook });
  assertEquals(labels, []);
  await ensureSitePhpRuntimes([staticSite, phpSite], { runPlaybook });
  assertEquals(labels.length, 1);
  assert(labels[0].includes("nginx"));
  assert(labels[0].includes('"php_fpm_versions":["8.4"]'));
});

test("apache creates its log directory before the main config is installed", async () => {
  const names = (await tasksOf("apache")).map((t) => t.name ?? "");
  const logDir = names.indexOf("Ensure the Apache log directory");
  const config = names.indexOf("Install TurboPanel Apache main config");
  assert(logDir >= 0 && logDir < config);
  const task = (await tasksOf("apache"))[logDir];
  const file = task["ansible.builtin.file"] as Record<string, string>;
  assertEquals(file.path, "/var/log/{{ apache_logs_directory }}");
  assertEquals(file.owner, "{{ apache_service_user }}");
  assertEquals(file.mode, "0750");
});

test("nginx and OpenLiteSpeed create their log directories in the role", async () => {
  for (
    const [role, name] of [
      ["nginx", "Ensure nginx log directory"],
      ["openlitespeed", "Ensure OpenLiteSpeed log directory"],
    ]
  ) {
    const names = (await tasksOf(role)).map((t) => t.name ?? "");
    assert(names.includes(name), `${role}: ${name}`);
  }
});
