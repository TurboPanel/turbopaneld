import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const FILE = join(
  dirname(fromFileUrl(import.meta.url)),
  "../../orchestration/roles/os-security-updates/files/52turbopanel-security-updates",
);

/** The quoted origin patterns inside `Unattended-Upgrade::Origins-Pattern { ... };`. */
function origins(text: string): string[] {
  const block = /^Unattended-Upgrade::Origins-Pattern \{\n([\s\S]*?)^\};/m.exec(
    text,
  );
  return [...(block?.[1] ?? "").matchAll(/"([^"]+)";/g)].map((m) => m[1] ?? "");
}

test("automatic updates take the security archive and the PHP package archive, and nothing else", async () => {
  const text = await Deno.readTextFile(FILE);
  assertEquals(origins(text), [
    "origin=Debian,codename=${distro_codename}-security,label=Debian-Security",
    "origin=Debian,codename=${distro_codename},label=Debian-Security",
    "origin=deb.sury.org,codename=${distro_codename}",
  ]);
  // The package default is still dropped first, updates stay daily and the
  // server never restarts by itself.
  assert(text.includes("#clear Unattended-Upgrade::Origins-Pattern;"));
  assert(text.includes('APT::Periodic::Unattended-Upgrade "1";'));
  assert(text.includes('Unattended-Upgrade::Automatic-Reboot "false";'));
});
