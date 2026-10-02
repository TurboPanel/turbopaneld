import { assert } from "@std/assert";

const tasks = await Deno.readTextFile(
  new URL(
    "../orchestration/roles/openlitespeed/tasks/main.yml",
    import.meta.url,
  ),
);

Deno.test("openlitespeed role creates fcgi-bin before copying lsperld.fpl", () => {
  const mkdir = tasks.indexOf(
    "Create fcgi-bin directory in the versioned tree",
  );
  const copy = tasks.indexOf("Install lsperld.fpl only");
  assert(mkdir !== -1, "missing fcgi-bin directory task");
  assert(copy !== -1, "missing lsperld.fpl copy task");
  assert(mkdir < copy, "fcgi-bin must exist before lsperld.fpl is copied");
});

Deno.test("openlitespeed role links bin/litespeed outside the first-install block", () => {
  const head = "- name: Create litespeed exec name expected by lswsctrl";
  const link = tasks.indexOf(`\n${head}\n`);
  assert(link !== -1, "litespeed link must be a top-level task, not inside the install block");
  const assertTask = tasks.indexOf("Assert vendored OpenLiteSpeed binary is a regular file");
  assert(assertTask !== -1 && assertTask < link, "target must be validated before linking");
  const body = tasks.slice(link + 1, tasks.indexOf("\n- name:", link + 1));
  assert(body.includes('src: "openlitespeed"'), "link must be relative to bin/");
  assert(body.includes("state: link"), "must be a symlink");
  assert(body.includes("follow: false"), "must not follow an existing dest");
  assert(body.includes("force: true"), "must replace a stale link");
});
