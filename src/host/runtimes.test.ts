import { assertEquals } from "@std/assert";
import {
  parsePhpExtensionsFromModsAvailable,
  parsePhpSeriesFromBinaries,
  readHostRuntimes,
} from "./runtimes.ts";

const test = Deno.test.bind(Deno);

test("parsePhpSeriesFromBinaries reads co-installed series from /usr/sbin", () => {
  assertEquals(
    parsePhpSeriesFromBinaries([
      "php-fpm8.4",
      "php-fpm8.3",
      "nginx",
      "php-fpm", // unversioned distro leftover — not a series
      "php-fpm8", // major only — not the exec boundary we key on
    ]),
    ["8.3", "8.4"],
  );
  assertEquals(parsePhpSeriesFromBinaries([]), []);
});

test("parsePhpExtensionsFromModsAvailable takes installed, not loaded", () => {
  // mods-available is a readdir; `php -m` is a fork per series and answers a
  // different question (loaded for a SAPI). Installed is what the control
  // plane can offer.
  assertEquals(
    parsePhpExtensionsFromModsAvailable([
      "intl.ini",
      "redis.ini",
      "opcache.ini",
      "README",
      "..ini",
      "UPPER.ini",
    ]),
    ["intl", "opcache", "redis", "upper"],
  );
});

test("readHostRuntimes omits an area entirely when nothing is found", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // No vendor/node-app and no vendor/lsphp: those keys must be absent
    // rather than present-and-empty, matching how docker.ts reports.
    const meta = readHostRuntimes(dir);
    assertEquals(meta?.node, undefined);
    assertEquals(meta?.lsphp, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("readHostRuntimes reports a vendored series only once current resolves", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // A half-vendored series (directory exists, `current` does not) must not be
    // advertised — the control plane would offer a runtime nothing can exec.
    await Deno.mkdir(`${dir}/node-app/24`, { recursive: true });
    assertEquals(readHostRuntimes(dir)?.node, undefined);

    await Deno.mkdir(`${dir}/node-app/24/v24.1.0`, { recursive: true });
    await Deno.symlink(
      `${dir}/node-app/24/v24.1.0`,
      `${dir}/node-app/24/current`,
    );
    assertEquals(readHostRuntimes(dir)?.node, { series: ["24"] });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
