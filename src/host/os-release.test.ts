import { assertEquals } from "jsr:@std/assert@1";
import {
  hostOsFromFields,
  parseOsReleaseText,
  resetHostOsCacheForTests,
} from "./os-release.ts";

Deno.test("parseOsReleaseText unquotes values and skips comments", () => {
  const fields = parseOsReleaseText(String.raw`
# comment
PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
NAME="Debian GNU/Linux"
VERSION_ID="13"
VERSION_CODENAME=trixie
ID=debian
ID_LIKE=debian
HOME_URL='https://www.debian.org/'
`);
  assertEquals(fields.PRETTY_NAME, "Debian GNU/Linux 13 (trixie)");
  assertEquals(fields.NAME, "Debian GNU/Linux");
  assertEquals(fields.VERSION_ID, "13");
  assertEquals(fields.VERSION_CODENAME, "trixie");
  assertEquals(fields.ID, "debian");
  assertEquals(fields.HOME_URL, "https://www.debian.org/");
});

Deno.test("hostOsFromFields maps Debian os-release to HostOsMetadata", () => {
  resetHostOsCacheForTests();
  const os = hostOsFromFields(
    {
      PRETTY_NAME: "Debian GNU/Linux 13 (trixie)",
      NAME: "Debian GNU/Linux",
      VERSION_ID: "13",
      VERSION_CODENAME: "trixie",
      ID: "debian",
    },
    { os: "linux", arch: "aarch64" },
  );
  assertEquals(os, {
    family: "linux",
    id: "debian",
    version: "13",
    versionCodename: "trixie",
    prettyName: "Debian GNU/Linux 13 (trixie)",
    arch: "aarch64",
  });
});

Deno.test("hostOsFromFields falls back to Deno.build.os when fields empty", () => {
  const os = hostOsFromFields({}, { os: "linux", arch: "x86_64" });
  assertEquals(os, { family: "linux", arch: "x86_64" });
});

Deno.test("hostOsFromFields returns undefined for unknown non-linux build", () => {
  assertEquals(hostOsFromFields({}, { os: "sunos", arch: "x86_64" }), undefined);
});
