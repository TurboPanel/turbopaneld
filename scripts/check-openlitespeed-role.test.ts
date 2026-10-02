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
