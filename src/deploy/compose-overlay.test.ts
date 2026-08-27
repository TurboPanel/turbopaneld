import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import { DAEMON_COMPOSE_FILENAME } from "./compose-files.ts";
import {
  applyRailpackImagesToComposeYaml,
  isEmptyFragment,
  mergeComposeOverlayFragments,
  mergeOverlayIntoComposeYaml,
  renderComposeOverlay,
  writeDaemonComposeLayer,
} from "./compose-overlay.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("mergeComposeOverlayFragments merges service fields and dedups arrays", () => {
  const merged = mergeComposeOverlayFragments([
    {
      services: {
        web: {
          environment: { A: "1" },
          volumes: [{ type: "bind", source: "/a", target: "/a" }],
          extra_hosts: ["host.docker.internal:host-gateway"],
        },
      },
    },
    {
      services: {
        web: {
          environment: { B: "2" },
          volumes: [
            { type: "bind", source: "/a", target: "/a" },
            { type: "volume", source: "v", target: "/v" },
          ],
          labels: { "traefik.enable": "true" },
        },
      },
      networks: { "turbopanel-ingress": { external: true } },
    },
  ]);

  assertEquals(merged.services?.web?.environment, { A: "1", B: "2" });
  assertEquals(merged.services?.web?.volumes, [
    { type: "bind", source: "/a", target: "/a" },
    { type: "volume", source: "v", target: "/v" },
  ]);
  assertEquals(merged.services?.web?.extra_hosts, [
    "host.docker.internal:host-gateway",
  ]);
  assertEquals(merged.services?.web?.labels, { "traefik.enable": "true" });
  assertEquals(merged.networks?.["turbopanel-ingress"], { external: true });
});

test("isEmptyFragment detects empty overlay", () => {
  assertEquals(isEmptyFragment({}), true);
  assertEquals(isEmptyFragment({ services: {} }), true);
  assertEquals(
    isEmptyFragment({ services: { web: { image: "nginx" } } }),
    false,
  );
});

test("mergeOverlayIntoComposeYaml merges overlay and preserves other keys", () => {
  const merged = mergeOverlayIntoComposeYaml(
    "name: demo\nservices:\n  web:\n    image: nginx:alpine\n",
    {
      services: {
        web: { environment: { K: "v" } },
      },
      networks: { "turbopanel-managed": { external: true } },
    },
  );
  assertEquals(merged.includes("name: demo"), true);
  assertEquals(merged.includes("image: nginx:alpine"), true);
  assertEquals(merged.includes("K: v"), true);
  assertEquals(merged.includes("turbopanel-managed"), true);
  assertEquals(
    mergeOverlayIntoComposeYaml("services:\n  web: {}\n", {}),
    "services:\n  web: {}\n",
  );
});

test({
  name:
    "writeDaemonComposeLayer writes or removes the daemon layer file and forces 0640 on rewrite",
  permissions: { read: true, write: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-compose-overlay-" });
    try {
      const path = join(dir, DAEMON_COMPOSE_FILENAME);
      // Pre-create a world-readable file — creation mode alone would keep 0644
      // on open/truncate; the secure writer must chmod to 0640.
      await Deno.writeTextFile(path, "services: {}\n", { mode: 0o644 });
      assertEquals((await Deno.stat(path)).mode! & 0o777, 0o644);

      const written = await writeDaemonComposeLayer(dir, {
        services: { web: { environment: { K: "v" } } },
      });
      assertEquals(written, path);
      const stat = await Deno.stat(path);
      assertEquals(stat.mode! & 0o777, 0o640);
      const text = await Deno.readTextFile(path);
      assertEquals(text.includes("web:"), true);

      const cleared = await writeDaemonComposeLayer(dir, {});
      assertEquals(cleared, null);
      try {
        await Deno.stat(join(dir, DAEMON_COMPOSE_FILENAME));
        throw new Error("expected daemon layer removed");
      } catch (err) {
        assertEquals(err instanceof Deno.errors.NotFound, true);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test("mergeOverlayIntoComposeYaml keeps service network aliases under a mapping overlay", () => {
  const base = [
    "services:",
    "  adminer:",
    "    image: adminer:latest",
    "    container_name: 01a025f1-850c-705d-a7c2-1833d01cda9f",
    "    networks:",
    "      default:",
    "        aliases:",
    "          - adminer",
    "",
  ].join("\n");

  const merged = mergeOverlayIntoComposeYaml(base, {
    services: {
      adminer: {
        labels: { "traefik.enable": "true" },
        networks: { default: {}, "turbopanel-ingress": {} },
      },
    },
  });

  const parsed = parse(merged) as {
    services: Record<string, { networks: Record<string, unknown> }>;
  };
  assertEquals(parsed.services.adminer.networks, {
    default: { aliases: ["adminer"] },
    "turbopanel-ingress": {},
  });
});

test("mergeOverlayIntoComposeYaml drops aliases when the overlay uses list form", () => {
  // Documents why `unionServiceNetworks` emits mapping form: list over mapping
  // is a type mismatch and the later fragment wins outright.
  const base = [
    "services:",
    "  adminer:",
    "    image: adminer:latest",
    "    networks:",
    "      default:",
    "        aliases:",
    "          - adminer",
    "",
  ].join("\n");

  const merged = mergeOverlayIntoComposeYaml(base, {
    services: { adminer: { networks: ["default", "turbopanel-ingress"] } },
  });

  const parsed = parse(merged) as {
    services: Record<string, { networks: unknown }>;
  };
  assertEquals(parsed.services.adminer.networks, [
    "default",
    "turbopanel-ingress",
  ]);
});

test("applyRailpackImagesToComposeYaml sets the built image and drops build", () => {
  const yaml = `services:
  api:
    build:
      context: .
    ports:
      - "3000:3000"
  cache:
    image: redis:7
`;
  const out = parse(
    applyRailpackImagesToComposeYaml(
      yaml,
      new Map([["api", "turbopanel-app/api:rel-1"]]),
    ),
  ) as {
    services: Record<string, Record<string, unknown>>;
  };
  assertEquals(out.services.api.image, "turbopanel-app/api:rel-1");
  assertEquals("build" in out.services.api, false);
  // Untouched services keep everything, including their own authored image.
  assertEquals(out.services.api.ports, ["3000:3000"]);
  assertEquals(out.services.cache.image, "redis:7");
});

test("applyRailpackImagesToComposeYaml is a no-op without railpack services", () => {
  const yaml = "services:\n  cache:\n    image: redis:7\n";
  assertEquals(applyRailpackImagesToComposeYaml(yaml, new Map()), yaml);
  // A named service the compile step already stripped is ignored, not an error.
  assertEquals(
    applyRailpackImagesToComposeYaml(
      yaml,
      new Map([["gone", "turbopanel-app/gone:rel-1"]]),
    ),
    yaml,
  );
});

test("mergeComposeOverlayFragments merges volumes and skips unequal nested arrays", () => {
  const merged = mergeComposeOverlayFragments([
    {
      volumes: { data: { name: "data", external: true } },
      services: {
        web: {
          volumes: [{ type: "bind", source: "/a", extra: true }],
        },
      },
    },
    {
      volumes: { cache: { name: "cache", external: true } },
      services: {
        web: {
          volumes: [
            { type: "bind", source: "/a" },
            { type: "bind", source: "/b" },
          ],
        },
      },
    },
  ]);
  assertEquals(merged.volumes, {
    data: { name: "data", external: true },
    cache: { name: "cache", external: true },
  });
  assertEquals(merged.services?.web?.volumes, [
    { type: "bind", source: "/a", extra: true },
    { type: "bind", source: "/a" },
    { type: "bind", source: "/b" },
  ]);
});

test("renderComposeOverlay emits networks and volumes and omits empty maps", () => {
  assertEquals(renderComposeOverlay({}), "{}\n");
  const yaml = renderComposeOverlay({
    networks: { "turbopanel-ingress": { external: true } },
    volumes: { data: { external: true } },
  });
  assertEquals(yaml.includes("turbopanel-ingress"), true);
  assertEquals(yaml.includes("data:"), true);
  assertEquals(yaml.includes("services:"), false);
});

test("isEmptyFragment treats empty networks and volumes as empty", () => {
  assertEquals(isEmptyFragment({ networks: {}, volumes: {} }), true);
  assertEquals(
    isEmptyFragment({ volumes: { data: { external: true } } }),
    false,
  );
});

test("mergeOverlayIntoComposeYaml folds volumes and ignores a non-object document", () => {
  const withVolumes = mergeOverlayIntoComposeYaml(
    "volumes:\n  data:\n    external: true\nservices:\n  web:\n    image: nginx\n",
    { volumes: { cache: { external: true } } },
  );
  assertEquals(withVolumes.includes("cache:"), true);
  assertEquals(withVolumes.includes("data:"), true);

  const scalar = mergeOverlayIntoComposeYaml("just-a-string\n", {
    services: { web: { image: "nginx" } },
  });
  assertEquals(scalar.includes("web:"), true);
});

test("applyRailpackImagesToComposeYaml ignores non-object documents and services", () => {
  const images = new Map([["api", "turbopanel-app/api:rel-1"]]);
  assertEquals(applyRailpackImagesToComposeYaml("[]\n", images), "[]\n");
  assertEquals(
    applyRailpackImagesToComposeYaml("services: []\n", images),
    "services: []\n",
  );
  assertEquals(
    applyRailpackImagesToComposeYaml("services:\n  api: nginx\n", images),
    "services:\n  api: nginx\n",
  );
});

test({
  name: "writeDaemonComposeLayer returns null when an empty fragment has no file",
  permissions: { read: true, write: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-overlay-missing-" });
    try {
      assertEquals(await writeDaemonComposeLayer(dir, {}), null);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
