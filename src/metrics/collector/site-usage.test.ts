import { assertEquals } from "@std/assert";
import { parseSiteUsage, readSiteUsage } from "./site-usage.ts";
import { collectDirectoryUsage } from "./directory-usage.ts";
import type { DirectoryUsageIo } from "./directory-usage.ts";

const test = Deno.test.bind(Deno);

const OUTPUT = [
  "home 9000 alice",
  "site 5000 shop",
  "site 100 blog",
  "home 4000 bob",
  "site 3000 api",
  "site 700 a1",
  "site 600 a2",
  "site 500 a3",
  "site 400 a4",
  "not a row",
  "site 12 two words",
  "",
].join("\n");

test("parseSiteUsage sums the homes and keeps the five largest sites by id", () => {
  const reading = parseSiteUsage(OUTPUT);
  assertEquals(reading?.hostingBytes, 13_000);
  assertEquals(reading?.topSites, [
    { id: "shop", bytes: 5000 },
    { id: "api", bytes: 3000 },
    { id: "a1", bytes: 700 },
    { id: "a2", bytes: 600 },
    { id: "a3", bytes: 500 },
  ]);
});

test("parseSiteUsage answers null when no home is listed", () => {
  assertEquals(parseSiteUsage(""), null);
  assertEquals(parseSiteUsage("site 5 x"), null);
});

test("readSiteUsage asks the tp-host verb and is null when it fails", async () => {
  const calls: string[][] = [];
  const ok = await readSiteUsage((_cmd, args) => {
    calls.push(args);
    return Promise.resolve({ success: true, stdout: OUTPUT, stderr: "" });
  });
  assertEquals(ok?.topSites.length, 5);
  assertEquals(calls[0]!.at(-1), "site-usage");
  assertEquals(
    await readSiteUsage(() =>
      Promise.resolve({ success: false, stdout: "", stderr: "denied" })
    ),
    null,
  );
  assertEquals(
    await readSiteUsage(() => Promise.reject(new Error("no sudo"))),
    null,
  );
});

const unreadableIo: DirectoryUsageIo = {
  statfs: () => ({
    blocks: 100,
    bfree: 50,
    bavail: 50,
    bsize: 1000,
    files: 1,
    ffree: 1,
  }),
  stat: () =>
    Promise.resolve({
      isFile: false,
      isDirectory: true,
      isSymlink: false,
      size: 0,
      dev: 1,
    }),
  lstat: () =>
    Promise.resolve({
      isFile: false,
      isDirectory: true,
      isSymlink: false,
      size: 0,
    }),
  // A root-owned 0750 home root: the daemon cannot list it.
  readDir: () => {
    throw new Deno.errors.PermissionDenied("0750");
  },
};

test("hosting used falls back to the verb's home total and top sites are carried", async () => {
  const snapshot = await collectDirectoryUsage({
    resolveHostingPath: () => "/srv/users",
    resolveBackupPath: () => "/backup",
    resolveLogsPath: () => "/var/log/turbopanel",
    io: unreadableIo,
    readSiteUsage: () => Promise.resolve(parseSiteUsage(OUTPUT)),
    onError: () => {},
  });
  assertEquals(snapshot.hosting.usedBytes, 13_000);
  assertEquals(snapshot.topSites?.[0], { id: "shop", bytes: 5000 });
});

test("without the verb the unreadable hosting tree stays null, never zero", async () => {
  const snapshot = await collectDirectoryUsage({
    resolveHostingPath: () => "/srv/users",
    resolveBackupPath: () => "/backup",
    resolveLogsPath: () => "/var/log/turbopanel",
    io: unreadableIo,
    readSiteUsage: () => Promise.resolve(null),
    onError: () => {},
  });
  assertEquals(snapshot.hosting.usedBytes, null);
  assertEquals(snapshot.topSites, undefined);
});
