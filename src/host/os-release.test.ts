import { assertEquals } from "jsr:@std/assert@1";
import {
  hostOsFromFields,
  parseOsReleaseText,
  resetHostOsCacheForTests,
  resolveOsVersion,
} from "./os-release.ts";

Deno.test("parseOsReleaseText unquotes values and skips comments", () => {
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

Deno.test("resolveOsVersion prefers DEBIAN_VERSION_FULL then debian_version file", () => {
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

Deno.test("hostOsFromFields maps Debian os-release with point release", () => {
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

Deno.test("hostOsFromFields marks raspbian ID as raspberry-pi-os", () => {
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

Deno.test("hostOsFromFields marks debian+rpi-issue as raspberry-pi-os", () => {
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

Deno.test("hostOsFromFields falls back to Deno.build.os when fields empty", () => {
  const os = hostOsFromFields({}, { os: "linux", arch: "x86_64" });
  assertEquals(os, { family: "linux", arch: "x86_64" });
});

Deno.test("hostOsFromFields returns undefined for unknown non-linux build", () => {
  assertEquals(
    hostOsFromFields({}, { os: "sunos", arch: "x86_64" }),
    undefined,
  );
});
