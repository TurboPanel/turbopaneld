import { assertRejects } from "@std/assert";
import { assertNoSymlinkBelow } from "./copy-source-guard.ts";

const test = Deno.test.bind(Deno);

test("a real tree below the owner's home passes; a link anywhere in it does not", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-guard-" });
  try {
    const home = `${root}/alice`;
    await Deno.mkdir(`${home}/volumes/data`, { recursive: true });
    await assertNoSymlinkBelow(home, `${home}/volumes/data`);

    await Deno.mkdir(`${root}/elsewhere`);
    await Deno.symlink(`${root}/elsewhere`, `${home}/volumes/linked`);
    await assertRejects(
      () => assertNoSymlinkBelow(home, `${home}/volumes/linked`),
      Error,
      "symbolic link",
    );
    await Deno.symlink(`${root}/elsewhere`, `${home}/escape`);
    await assertRejects(
      () => assertNoSymlinkBelow(home, `${home}/escape/anything`),
      Error,
      "symbolic link",
    );
    await assertRejects(
      () => assertNoSymlinkBelow(home, `${root}/elsewhere`),
      Error,
      "outside",
    );
    await assertRejects(
      () => assertNoSymlinkBelow(home, `${home}/volumes/missing`),
      Error,
      "not found",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("a directory the daemon cannot traverse is confirmed through tp-host or refused", async () => {
  const denied = () => Promise.reject(new Deno.errors.PermissionDenied("no"));
  await assertNoSymlinkBelow("/srv/users/a", "/srv/users/a/volumes/x", {
    lstat: denied,
    privilegedDirectoryExists: () => Promise.resolve(true),
  });
  await assertRejects(
    () =>
      assertNoSymlinkBelow("/srv/users/a", "/srv/users/a/volumes/x", {
        lstat: denied,
        privilegedDirectoryExists: () => Promise.resolve(false),
      }),
    Error,
    "could not be confirmed",
  );
});
