import { assertEquals, assertThrows } from "@std/assert";
import { serviceTree } from "./layout.ts";

const test = Deno.test.bind(Deno);

const layout = { principalHomeRoot: "/srv/users" };
const folder = { owner: "alice", scope: "production", slug: "example.com" };

test("serviceTree builds every path from the folder", () => {
  const tree = serviceTree(layout, {
    serviceId: "svc-1",
    username: "alice",
    folder,
  });
  const root = "/srv/users/alice/production/services/example.com";
  assertEquals(tree, {
    root,
    publicDir: `${root}/public`,
    releasesDir: `${root}/releases`,
    currentLink: `${root}/current`,
    sharedDir: `${root}/shared`,
    logsDir: `${root}/logs`,
    hostingDir: `${root}/.turbopanel-hosting`,
  });
});

test("serviceTree refuses a folder that belongs to another owner or breaks the rules", () => {
  assertThrows(
    () => serviceTree(layout, { serviceId: "svc-1", username: "bob", folder }),
    TypeError,
    "does not match",
  );
  for (const bad of [{ ...folder, slug: ".." }, { ...folder, scope: "home" }]) {
    assertThrows(
      () =>
        serviceTree(layout, {
          serviceId: "svc-1",
          username: "alice",
          folder: bad,
        }),
      TypeError,
    );
  }
});
