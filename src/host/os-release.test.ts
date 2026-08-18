import { assertEquals } from "@std/assert";
import {
  hostOsFromFields,
  parseOsReleaseText,
  readOsRelease,
  resetHostOsCacheForTests,
  resolveOsVersion,
} from "./os-release.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseOsReleaseText unquotes values and skips comments", () => {
  const fields = parseOsReleaseText(String.raw`
# comment
PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
NAME="Debian GNU/Linux"
VERSION_ID="13"
VERSION_CODENAME=trixie
DEBIAN_VERSION_FULL=13.5
ID=debian
ID_LIKE=debian
HOME_URL='https://www.debian.org/'
`);
  assertEquals(fields.PRETTY_NAME, "Debian GNU/Linux 13 (trixie)");
  assertEquals(fields.NAME, "Debian GNU/Linux");
  assertEquals(fields.VERSION_ID, "13");
  assertEquals(fields.VERSION_CODENAME, "trixie");
  assertEquals(fields.DEBIAN_VERSION_FULL, "13.5");
  assertEquals(fields.ID, "debian");
  assertEquals(fields.HOME_URL, "https://www.debian.org/");
});

test("resolveOsVersion prefers DEBIAN_VERSION_FULL then debian_version file", () => {
  assertEquals(
    resolveOsVersion({ VERSION_ID: "13", DEBIAN_VERSION_FULL: "13.5" }),
    "13.5",
  );
  assertEquals(
    resolveOsVersion({ VERSION_ID: "13" }, "13.5\n"),
    "13.5",
  );
  assertEquals(
    resolveOsVersion({ VERSION_ID: "13" }, "trixie/sid\n"),
    "13",
  );
});

test("hostOsFromFields maps Debian os-release with point release", () => {
  resetHostOsCacheForTests();
  const os = hostOsFromFields(
    {
      PRETTY_NAME: "Debian GNU/Linux 13 (trixie)",
      NAME: "Debian GNU/Linux",
      VERSION_ID: "13",
      VERSION_CODENAME: "trixie",
      DEBIAN_VERSION_FULL: "13.5",
      ID: "debian",
    },
    { os: "linux", arch: "aarch64" },
  );
  assertEquals(os, {
    family: "linux",
    id: "debian",
    version: "13.5",
    codename: "trixie",
    prettyName: "Debian GNU/Linux 13 (trixie)",
    architecture: "aarch64",
  });
});

test("hostOsFromFields marks raspbian ID as raspberry-pi-os", () => {
  const os = hostOsFromFields(
    {
      PRETTY_NAME: "Raspbian GNU/Linux 12 (bookworm)",
      NAME: "Raspbian GNU/Linux",
      VERSION_ID: "12",
      VERSION_CODENAME: "bookworm",
      ID: "raspbian",
      ID_LIKE: "debian",
    },
    { os: "linux", arch: "arm" },
  );
  assertEquals(os?.id, "raspbian");
  assertEquals(os?.variant, "raspberry-pi-os");
  assertEquals(os?.version, "12");
});

test("hostOsFromFields marks debian+rpi-issue as raspberry-pi-os", () => {
  const os = hostOsFromFields(
    {
      PRETTY_NAME: "Debian GNU/Linux 12 (bookworm)",
      NAME: "Debian GNU/Linux",
      VERSION_ID: "12",
      VERSION_CODENAME: "bookworm",
      ID: "debian",
    },
    { os: "linux", arch: "aarch64" },
    { rpiIssuePresent: true, debianVersionFile: "12.11" },
  );
  assertEquals(os, {
    family: "linux",
    id: "debian",
    variant: "raspberry-pi-os",
    version: "12.11",
    codename: "bookworm",
    prettyName: "Debian GNU/Linux 12 (bookworm)",
    architecture: "aarch64",
  });
});

test("hostOsFromFields falls back to Deno.build.os when fields empty", () => {
  const os = hostOsFromFields({}, { os: "linux", arch: "x86_64" });
  assertEquals(os, { family: "linux", architecture: "x86_64" });
});

test("hostOsFromFields returns undefined for unknown non-linux build", () => {
  assertEquals(
    hostOsFromFields({}, { os: "sunos", arch: "x86_64" }),
    undefined,
  );
});

test("hostOsFromFields maps darwin / freebsd / windows families from ID", () => {
  assertEquals(
    hostOsFromFields({ ID: "darwin" }, { os: "linux", arch: "arm64" })?.family,
    "darwin",
  );
  assertEquals(
    hostOsFromFields({ ID_LIKE: "freebsd" }, { os: "linux", arch: "x86_64" })
      ?.family,
    "freebsd",
  );
  assertEquals(
    hostOsFromFields({ ID: "msys" }, { os: "linux", arch: "x86_64" })?.family,
    "windows",
  );
});

test("hostOsFromFields maps Deno build families when os-release is empty", () => {
  assertEquals(
    hostOsFromFields({}, { os: "darwin", arch: "arm64" }),
    { family: "darwin", architecture: "arm64" },
  );
  assertEquals(
    hostOsFromFields({}, { os: "freebsd", arch: "x86_64" }),
    { family: "freebsd", architecture: "x86_64" },
  );
  assertEquals(
    hostOsFromFields({}, { os: "windows", arch: "x86_64" }),
    { family: "windows", architecture: "x86_64" },
  );
});

test("parseOsReleaseText skips lines without a key=value pair", () => {
  assertEquals(
    parseOsReleaseText("NOEQUALS\n=novalue\nID=debian\n").ID,
    "debian",
  );
});

test("resolveOsVersion keeps VERSION_ID when debian_version is a suite name only", () => {
  assertEquals(resolveOsVersion({}, "trixie/sid\n"), undefined);
  assertEquals(resolveOsVersion({ VERSION_ID: "13" }, undefined), "13");
});

test({
  name: "readOsRelease parses a fixture path without caching the default path",
  permissions: { read: true, write: true },
  fn() {
    resetHostOsCacheForTests();
    const dir = Deno.makeTempDirSync({ prefix: "tp-os-release-" });
    try {
      const path = `${dir}/os-release`;
      Deno.writeTextFileSync(
        path,
        [
          'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"',
          "ID=debian",
          "VERSION_ID=13",
          "VERSION_CODENAME=trixie",
          "DEBIAN_VERSION_FULL=13.5",
        ].join("\n"),
      );
      const os = readOsRelease(path);
      assertEquals(os?.id, "debian");
      assertEquals(os?.version, "13.5");
      assertEquals(os?.codename, "trixie");
      assertEquals(os?.prettyName, "Debian GNU/Linux 13 (trixie)");
      assertEquals(os?.family, "linux");
    } finally {
      Deno.removeSync(dir, { recursive: true });
      resetHostOsCacheForTests();
    }
  },
});

test({
  name:
    "readOsRelease falls back to Deno.build when the fixture path is missing",
  permissions: { read: true },
  fn() {
    resetHostOsCacheForTests();
    const os = readOsRelease("/no/such/turbopanel-os-release");
    if (Deno.build.os === "linux") {
      assertEquals(os?.family, "linux");
    } else if (os) {
      assertEquals(typeof os.family, "string");
    }
    resetHostOsCacheForTests();
  },
});
