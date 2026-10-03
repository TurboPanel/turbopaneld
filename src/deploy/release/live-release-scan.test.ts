import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { RunFn } from "../ensure-principal.ts";
import {
  RELEASE_LINK_SCAN_FILENAME,
  reportLiveReleaseLinks,
  scanLiveReleaseLinks,
} from "./live-release-scan.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** No root on the test host: everything here is readable as the daemon. */
const noRoot: RunFn = () =>
  Promise.resolve({ success: false, stdout: "", stderr: "unexpected sudo" });

async function site(
  homes: string,
  user: string,
  service: string,
  links: Readonly<Record<string, string>>,
  current: string | null = "releases/r1",
): Promise<void> {
  const siteDir = join(homes, user, "sites", service);
  const release = join(siteDir, "releases", "r1");
  await Deno.mkdir(join(release, "public"), { recursive: true });
  await Deno.mkdir(join(siteDir, "shared"), { recursive: true });
  await Deno.symlink("../../shared", join(release, "shared"));
  await Promise.all(
    Object.entries(links).map(([path, text]) =>
      Deno.symlink(text, join(release, path))
    ),
  );
  if (current !== null) await Deno.symlink(current, join(siteDir, "current"));
}

async function withLayout(
  fn: (
    layout: { principalHomeRoot: string; daemonStateDir: string },
  ) => Promise<
    void
  >,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-live-scan-" });
  const layout = {
    principalHomeRoot: join(root, "homes"),
    daemonStateDir: join(root, "state"),
  };
  await Deno.mkdir(layout.principalHomeRoot);
  await Deno.mkdir(layout.daemonStateDir);
  try {
    await fn(layout);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("scanLiveReleaseLinks reports only live releases with escaping links", async () => {
  await withLayout(async (layout) => {
    const homes = layout.principalHomeRoot;
    await site(homes, "alice", "wp", { "public/uploads": "../shared/uploads" });
    await site(homes, "bob", "app", { "public/build": "../dist" });
    // Unpublished (a Railpack service, a daemon-owned web root): skipped.
    await site(homes, "carol", "rp", { "public/x": "../shared/x" }, null);
    await Deno.mkdir(join(homes, "dave"));

    assertEquals(await scanLiveReleaseLinks(layout, noRoot), [{
      username: "alice",
      serviceId: "wp",
      releaseId: "r1",
      links: ["public/uploads -> ../shared/uploads (reaches into shared/)"],
    }]);
  });
});

test("scanLiveReleaseLinks reports a site it cannot check instead of failing", async () => {
  await withLayout(async (layout) => {
    await site(layout.principalHomeRoot, "alice", "web", {}, "releases/..");
    const [finding] = await scanLiveReleaseLinks(layout, noRoot);
    assertEquals(finding.serviceId, "web");
    assertEquals(finding.links, []);
    assertStringIncludes(finding.error ?? "", "..");
  });
});

test("scanLiveReleaseLinks lists what the daemon cannot read as root", async () => {
  await withLayout(async (layout) => {
    const calls: string[][] = [];
    const runFn: RunFn = (_command, args) => {
      calls.push([...args]);
      const listing: Record<string, string> = {
        [layout.principalHomeRoot]: "alice\n",
        [join(layout.principalHomeRoot, "alice", "sites")]: "web\n",
      };
      const dir = args.at(-1) ?? "";
      if (args.includes("readlink")) {
        return Promise.resolve({
          success: true,
          stdout: "releases/r1\n",
          stderr: "",
        });
      }
      if (args.includes("-printf")) {
        return Promise.resolve({
          success: true,
          stdout: "shared\0../../shared\0public/x\0../shared/evil\0",
          stderr: "",
        });
      }
      return Promise.resolve({
        success: true,
        stdout: listing[dir] ?? "",
        stderr: "",
      });
    };
    const readDir = Deno.readDir;
    const readLink = Deno.readLink;
    Deno.readDir = () => {
      throw new Deno.errors.PermissionDenied("denied");
    };
    Deno.readLink = () => Promise.reject(new Deno.errors.PermissionDenied("x"));
    try {
      const findings = await scanLiveReleaseLinks(layout, runFn);
      assertEquals(findings.map((f) => f.links), [[
        "public/x -> ../shared/evil (reaches into shared/)",
      ]]);
    } finally {
      Deno.readDir = readDir;
      Deno.readLink = readLink;
    }
    assertEquals(calls[0], ["-n", "ls", "-A", "--", layout.principalHomeRoot]);
  });
});

test("reportLiveReleaseLinks warns per finding and records the scan", async () => {
  await withLayout(async (layout) => {
    await site(layout.principalHomeRoot, "alice", "wp", {
      "public/x": "../shared/evil",
    });
    const warnings: string[] = [];
    await reportLiveReleaseLinks(layout, {
      runFn: noRoot,
      warn: (message) => warnings.push(message),
      now: () => "2026-10-03T00:00:00.000Z",
    });
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "alice/sites/wp");
    assertStringIncludes(warnings[0], "public/x -> ../shared/evil");
    const path = join(layout.daemonStateDir, RELEASE_LINK_SCAN_FILENAME);
    const record = JSON.parse(await Deno.readTextFile(path));
    assertEquals(record.scannedAt, "2026-10-03T00:00:00.000Z");
    assertEquals(record.findings.length, 1);
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
  });
});
