import { assertEquals } from "@std/assert";
import {
  hostOsFromFields,
  parseOsReleaseText,
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
    versionCodename: "trixie",
    prettyName: "Debian GNU/Linux 13 (trixie)",
    arch: "aarch64",
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
    versionCodename: "bookworm",
    prettyName: "Debian GNU/Linux 12 (bookworm)",
    arch: "aarch64",
  });
});

test("hostOsFromFields falls back to Deno.build.os when fields empty", () => {
  const os = hostOsFromFields({}, { os: "linux", arch: "x86_64" });
  assertEquals(os, { family: "linux", arch: "x86_64" });
});

test("hostOsFromFields returns undefined for unknown non-linux build", () => {
  assertEquals(
    hostOsFromFields({}, { os: "sunos", arch: "x86_64" }),
    undefined,
  );
});
