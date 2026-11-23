import { assert } from "@std/assert";

const tasks = await Deno.readTextFile(
  new URL("../orchestration/roles/php-fpm/tasks/main.yml", import.meta.url),
);

Deno.test("php-fpm role installs the MariaDB client, never the server", () => {
  const at = tasks.indexOf("Install the database command-line client");
  assert(at !== -1, "missing the client install task");
  const block = tasks.slice(at, tasks.indexOf("\n\n", at));
  assert(block.includes("name: mariadb-client\n"));
  assert(block.includes("state: present"));
  assert(!block.includes("mariadb-server"), "must not pull in the server");
});

Deno.test("the client is installed before the PHP series loop", () => {
  assert(
    tasks.indexOf("Install the database command-line client") <
      tasks.indexOf("Install and configure each requested PHP series"),
  );
});
