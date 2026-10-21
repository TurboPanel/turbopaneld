import { assert, assertEquals } from "@std/assert";

const roleFile = (path: string) =>
  Deno.readTextFile(
    new URL(`../orchestration/roles/nginx/${path}`, import.meta.url),
  );

const unit = await roleFile("templates/turbopanel-nginx.service.j2");
const conf = await roleFile("templates/nginx.conf.j2");
const tasks = await roleFile("tasks/main.yml");
const defaults = await roleFile("defaults/main.yml");

Deno.test("nginx unit gets its pidfile directory from systemd, not from the role", () => {
  assert(
    unit.includes("RuntimeDirectory={{ nginx_runtime_directory }}\n"),
    "the unit must own its runtime directory so /run (tmpfs) is rebuilt on boot",
  );
  assert(unit.includes("RuntimeDirectoryMode=0750"));
  assert(
    unit.includes("PIDFile=/run/{{ nginx_runtime_directory }}/nginx.pid"),
    "PIDFile must sit inside the RuntimeDirectory",
  );
});

Deno.test("nginx.conf writes its pidfile where the unit expects it", () => {
  assert(conf.includes("pid /run/{{ nginx_runtime_directory }}/nginx.pid;"));
});

Deno.test("nginx runtime directory is a top-level /run name, outside the tp-owned tree", () => {
  const line = defaults.split("\n").find((l) =>
    l.startsWith("nginx_runtime_directory:")
  );
  assert(line, "nginx_runtime_directory must have a default");
  const value = line.slice(line.indexOf(":") + 1).trim();
  assert(/^[a-z0-9-]+$/.test(value), `must be one path component: ${value}`);
  assertEquals(value, "turbopanel-nginx");
});

Deno.test("nginx role no longer creates the pidfile directory itself", () => {
  assert(
    !tasks.includes("Ensure nginx runtime directory (pidfile)"),
    "a one-off ansible-created /run directory is lost at reboot",
  );
  const removal = tasks.indexOf("Remove the old nginx pidfile directory");
  assert(removal !== -1, "the old /run/turbopanel/nginx directory must go");
  const body = tasks.slice(removal, tasks.indexOf("\n- name:", removal + 1));
  assert(body.includes('path: "{{ turbopanel_run_dir }}/nginx"'));
  assert(body.includes("state: absent"));
});

Deno.test("nginx role restarts a running master after the unit changed", () => {
  const at = tasks.indexOf("Restart a running nginx after its unit changed");
  assert(at !== -1, "the old master holds the old pidfile path");
  const body = tasks.slice(at, tasks.indexOf("\n- name:", at + 1));
  assert(body.includes("systemctl try-restart turbopanel-nginx.service"));
  assert(body.includes("_nginx_unit.changed"));
});

Deno.test("nginx role starts the unit so the first site deploy's config test finds its pidfile directory", () => {
  const at = tasks.indexOf("Ensure turbopanel-nginx is enabled and running");
  assert(at !== -1, "the role must start turbopanel-nginx, not only enable it");
  const body = tasks.slice(at, tasks.indexOf("\n- name:", at + 1));
  assert(body.includes("enabled: true"));
  assert(body.includes("state: started"));
  assert(
    unit.includes("RuntimeDirectoryPreserve=yes"),
    "a stopped or crashed unit must not take its pidfile directory with it",
  );
});
