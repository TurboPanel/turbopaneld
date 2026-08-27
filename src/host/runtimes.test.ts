import { assertEquals } from "@std/assert";
import {
  parsePhpExtensionsFromModsAvailable,
  parsePhpSeriesFromBinaries,
  readHostRuntimes,
  RUNTIME_ENTITLEMENT_GID_BAND,
} from "./runtimes.ts";

const test = Deno.test.bind(Deno);

test("parsePhpSeriesFromBinaries caps series at 16", () => {
  const names = Array.from({ length: 18 }, (_, i) => `php-fpm8.${i}`);
  const parsed = parsePhpSeriesFromBinaries(names);
  assertEquals(parsed.length, 16);
  assertEquals(parsed[0], "8.0");
  assertEquals(parsed[15], "8.15");
});

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

test("readHostRuntimes defaults to TURBOPANEL_RUNTIMES_DIR via layout", async () => {
  const dir = await Deno.makeTempDir();
  const previous = Deno.env.get("TURBOPANEL_RUNTIMES_DIR");
  try {
    await Deno.mkdir(`${dir}/node-app/24/v24.1.0`, { recursive: true });
    await Deno.symlink(
      `${dir}/node-app/24/v24.1.0`,
      `${dir}/node-app/24/current`,
    );
    Deno.env.set("TURBOPANEL_RUNTIMES_DIR", dir);
    assertEquals(readHostRuntimes()?.node, { series: ["24"] });
  } finally {
    if (previous === undefined) {
      Deno.env.delete("TURBOPANEL_RUNTIMES_DIR");
    } else {
      Deno.env.set("TURBOPANEL_RUNTIMES_DIR", previous);
    }
    await Deno.remove(dir, { recursive: true });
  }
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

function dirEntry(name: string): Deno.DirEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    isSymlink: false,
  };
}

test("RUNTIME_ENTITLEMENT_GID_BAND re-exports the registry band", () => {
  assertEquals(typeof RUNTIME_ENTITLEMENT_GID_BAND.min, "number");
  assertEquals(typeof RUNTIME_ENTITLEMENT_GID_BAND.max, "number");
  assertEquals(
    RUNTIME_ENTITLEMENT_GID_BAND.min <= RUNTIME_ENTITLEMENT_GID_BAND.max,
    true,
  );
});

test("parsePhpExtensionsFromModsAvailable caps, dedupes, and ignores junk", () => {
  const overflow = Array.from({ length: 130 }, (_, i) => `e${i}.ini`);
  const parsed = parsePhpExtensionsFromModsAvailable(overflow);
  assertEquals(parsed.length, 128);
  assertEquals(
    parsePhpExtensionsFromModsAvailable(["redis.ini", "redis.ini", "not-ini"]),
    ["redis"],
  );
});

test("readHostRuntimes reports lsphp and sorted node series from vendor", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/node-app/22/v22.0.0`, { recursive: true });
    await Deno.mkdir(`${dir}/node-app/24/v24.1.0`, { recursive: true });
    await Deno.mkdir(`${dir}/node-app/latest`, { recursive: true });
    await Deno.symlink(
      `${dir}/node-app/22/v22.0.0`,
      `${dir}/node-app/22/current`,
    );
    await Deno.symlink(
      `${dir}/node-app/24/v24.1.0`,
      `${dir}/node-app/24/current`,
    );

    await Deno.mkdir(`${dir}/lsphp/8.2/v8.2.0`, { recursive: true });
    await Deno.mkdir(`${dir}/lsphp/8.4/v8.4.0`, { recursive: true });
    await Deno.symlink(`${dir}/lsphp/8.2/v8.2.0`, `${dir}/lsphp/8.2/current`);
    await Deno.symlink(`${dir}/lsphp/8.4/v8.4.0`, `${dir}/lsphp/8.4/current`);

    const meta = readHostRuntimes(dir);
    assertEquals(meta?.node, { series: ["22", "24"] });
    assertEquals(meta?.lsphp, { series: ["8.2", "8.4"] });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("readHostRuntimes caps vendored series at 16", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (let n = 1; n <= 18; n++) {
      const series = String(n);
      await Deno.mkdir(`${dir}/node-app/${series}/v1`, { recursive: true });
      await Deno.symlink(
        `${dir}/node-app/${series}/v1`,
        `${dir}/node-app/${series}/current`,
      );
    }
    const series = readHostRuntimes(dir)?.node?.series ?? [];
    assertEquals(series.length, 16);
    assertEquals(series[0], "1");
    assertEquals(series[15], "16");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("readHostRuntimes omits php extensions when mods-available is empty", () => {
  const originalReadDir = Deno.readDirSync.bind(Deno);
  Deno.readDirSync = function (
    path: string | URL,
  ): Iterable<Deno.DirEntry> {
    const p = String(path);
    if (p === "/usr/sbin") {
      return [dirEntry("php-fpm8.4")];
    }
    if (p === "/etc/php/8.4/mods-available") {
      return [dirEntry("README")];
    }
    return originalReadDir(path);
  } as typeof Deno.readDirSync;
  const dir = Deno.makeTempDirSync({ prefix: "tp-runtimes-php-empty-" });
  try {
    const meta = readHostRuntimes(dir);
    if (!meta?.php) {
      throw new TypeError("expected php series without extensions");
    }
    assertEquals(meta.php.series, ["8.4"]);
    assertEquals(meta.php.extensions, undefined);
  } finally {
    Deno.readDirSync = originalReadDir;
    Deno.removeSync(dir, { recursive: true });
  }
});

test("readHostRuntimes returns undefined when php and vendor trees are empty", () => {
  const originalReadDir = Deno.readDirSync.bind(Deno);
  Deno.readDirSync = function (
    path: string | URL,
  ): Iterable<Deno.DirEntry> {
    const p = String(path);
    if (p === "/usr/sbin") return [];
    return originalReadDir(path);
  } as typeof Deno.readDirSync;
  const dir = Deno.makeTempDirSync({ prefix: "tp-runtimes-empty-" });
  try {
    assertEquals(readHostRuntimes(dir), undefined);
  } finally {
    Deno.readDirSync = originalReadDir;
    Deno.removeSync(dir, { recursive: true });
  }
});

test("readHostRuntimes reports php-fpm series and mods-available extensions", () => {
  const originalReadDir = Deno.readDirSync.bind(Deno);
  Deno.readDirSync = function (
    path: string | URL,
  ): Iterable<Deno.DirEntry> {
    const p = String(path);
    if (p === "/usr/sbin") {
      return [
        dirEntry("php-fpm8.4"),
        dirEntry("php-fpm8.3"),
        dirEntry("nginx"),
      ];
    }
    if (p === "/etc/php/8.4/mods-available") {
      return [dirEntry("redis.ini"), dirEntry("intl.ini"), dirEntry("README")];
    }
    if (p === "/etc/php/8.3/mods-available") {
      throw new Error("missing mods");
    }
    return originalReadDir(path);
  } as typeof Deno.readDirSync;
  const dir = Deno.makeTempDirSync({ prefix: "tp-runtimes-php-" });
  try {
    const meta = readHostRuntimes(dir);
    if (!meta?.php) {
      throw new TypeError("expected php series from stubbed /usr/sbin");
    }
    assertEquals(meta.php.series, ["8.3", "8.4"]);
    assertEquals(meta.php.extensions, { "8.4": ["intl", "redis"] });
  } finally {
    Deno.readDirSync = originalReadDir;
    Deno.removeSync(dir, { recursive: true });
  }
});
