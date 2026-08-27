import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  parseGalaxyRequirementsYaml,
  parseOrchestrationPins,
} from "./generate-notices.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

test("parseGalaxyRequirementsYaml reads quoted and unquoted name/version pins", () => {
  const pins = parseGalaxyRequirementsYaml(`
# header
collections:
  - name: ansible.posix
    version: "2.2.1"
roles:
  - name: 'geerlingguy.docker'
    version: '8.0.0'
  - name: unversioned.role
`);
  assertEquals(pins, [
    {
      name: "ansible.posix",
      version: "2.2.1",
      license: "GPL-3.0-or-later",
    },
    {
      name: "geerlingguy.docker",
      version: "8.0.0",
      license: "MIT",
    },
    {
      name: "unversioned.role",
      version: "*",
      license: "",
    },
  ]);
});

test("parseGalaxyRequirementsYaml skips blank names and non-list keys", () => {
  const pins = parseGalaxyRequirementsYaml(`
name: not-a-list-item
  - name:
    version: "1.0.0"
  - name: kept.role
    source: galaxy
`);
  assertEquals(pins, [
    { name: "kept.role", version: "*", license: "" },
  ]);
});

test({
  name: "parseOrchestrationPins reads checkout Galaxy files and pip pins",
  permissions: { read: true },
  fn() {
    const pins = parseOrchestrationPins(ROOT);
    const names = pins.map((pin) => pin.name).sort((a, b) =>
      a.localeCompare(b)
    );
    assertEquals(names.includes("ansible-core"), true);
    assertEquals(names.includes("ansible.posix"), true);
    assertEquals(names.includes("geerlingguy.docker"), true);
    const posix = pins.find((pin) => pin.name === "ansible.posix");
    const docker = pins.find((pin) => pin.name === "geerlingguy.docker");
    if (!posix || !docker) {
      throw new TypeError("expected Galaxy pins");
    }
    assertEquals(posix.version, "2.2.1");
    assertEquals(posix.license, "GPL-3.0-or-later");
    assertEquals(docker.version, "8.0.0");
    assertEquals(docker.license, "MIT");
  },
});

test({
  name: "parseOrchestrationPins treats a missing Galaxy file as no pins",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "tp-galaxy-pins-" });
    try {
      await Deno.mkdir(join(root, "orchestration"));
      await Deno.writeTextFile(
        join(root, "orchestration", "requirements.txt"),
        "ansible-core==2.20.*\n",
      );
      await Deno.writeTextFile(
        join(root, "orchestration", "requirements.yml"),
        "- name: ansible.posix\n  version: 2.2.1\n",
      );
      const pins = parseOrchestrationPins(root);
      assertEquals(pins, [
        {
          name: "ansible-core",
          version: "==2.20.*",
          license: "GPL-3.0-or-later",
        },
        {
          name: "ansible.posix",
          version: "2.2.1",
          license: "GPL-3.0-or-later",
        },
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
