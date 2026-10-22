import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  GALAXY_POSIX_SHA256,
  GALAXY_POSIX_TARBALL,
  GALAXY_POSIX_TARBALL_NAME,
  GALAXY_POSIX_VERSION,
  ORCHESTRATION_DIR,
} from "./assets.ts";
import { fileSha256Hex, verifyGalaxyPosixTarball } from "./galaxy-bundle.ts";

const test = Deno.test.bind(Deno);

test("bundled ansible.posix tarball is present and matches its pinned digest", async () => {
  assertEquals(await fileSha256Hex(GALAXY_POSIX_TARBALL), GALAXY_POSIX_SHA256);
  await verifyGalaxyPosixTarball();
});

test("bundled ansible.posix tarball sits where the release package copies it", () => {
  assertEquals(
    GALAXY_POSIX_TARBALL,
    join(ORCHESTRATION_DIR, "vendor", "galaxy", GALAXY_POSIX_TARBALL_NAME),
  );
  assertEquals(GALAXY_POSIX_TARBALL_NAME.includes(GALAXY_POSIX_VERSION), true);
});

test("requirements.yml version matches the bundled tarball version", async () => {
  const text = await Deno.readTextFile(
    join(ORCHESTRATION_DIR, "requirements.yml"),
  );
  const match = /name:\s*ansible\.posix\s+version:\s*"([^"]+)"/.exec(text);
  assertEquals(match?.[1], GALAXY_POSIX_VERSION);
});

test("a tampered or missing ansible.posix tarball is refused with a clear error", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, GALAXY_POSIX_TARBALL_NAME);
    await Deno.writeTextFile(file, "not the collection");
    await assertRejects(
      () => verifyGalaxyPosixTarball(file),
      Error,
      "digest mismatch",
    );
    await assertRejects(
      () => verifyGalaxyPosixTarball(join(dir, "absent.tar.gz")),
      Error,
      "missing or unreadable",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("release packaging keeps the bundled ansible.posix tarball", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const lib = join(
      ORCHESTRATION_DIR,
      "..",
      "scripts",
      "lib",
      "release-artifacts.sh",
    );
    const staged = join(dir, "orchestration");
    const script = [
      `. "$1"`,
      `cp -a "$2/." "$3/"`,
      `tp_prune_release_orchestration_tree "$3"`,
      `ls "$3"/vendor/galaxy/ansible-posix-*.tar.gz`,
    ].join("\n");
    await Deno.mkdir(staged);
    const out = await new Deno.Command("bash", {
      args: ["-c", script, "bash", lib, ORCHESTRATION_DIR, staged],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    assertEquals(
      new TextDecoder().decode(out.stdout).includes(GALAXY_POSIX_TARBALL_NAME),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
