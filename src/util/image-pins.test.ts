import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { MANAGED_ALLOWED_IMAGES_BY_ENGINE } from "../contracts/commands-contracts.ts";
import { dockerProxyCompose, traefikCompose } from "../deploy/ingress.ts";
import { ORCHESTRATOR_IMAGE } from "../managed/orchestrator.ts";
import { PROXYSQL_IMAGE } from "../managed/proxysql.ts";
import {
  allPinnedDigests,
  isImageDigest,
  pinManagedEngineImage,
  pinnedImage,
  pinnedImageDigest,
  pinnedImageTag,
} from "./image-pins.ts";

const test = Deno.test.bind(Deno);
const ORCHESTRATION = new URL("../../orchestration", import.meta.url).pathname;

test("every pinned digest is a sha256 digest", () => {
  const digests = allPinnedDigests();
  assert(digests.length > 0);
  for (const digest of digests) assert(isImageDigest(digest), digest);
});

test("no pinned image uses a floating latest tag", () => {
  for (
    const name of [
      "traefik",
      "socketProxy",
      "proxysql",
      "orchestrator",
      "postgres",
      "rabbitmq",
      "railpackFrontend",
      "redisInsight",
      "mailpit",
      "socat",
    ] as const
  ) {
    assert(!pinnedImageTag(name).endsWith(":latest"), name);
    assert(pinnedImageTag(name).includes(":"), `${name} needs a tag`);
  }
});

test("the daemon's platform images carry the table's digest", () => {
  assertEquals(PROXYSQL_IMAGE, pinnedImage("proxysql"));
  assertEquals(ORCHESTRATOR_IMAGE, pinnedImage("orchestrator"));
  const traefik = /image: (\S+)/.exec(traefikCompose("net", ["172.18.0.1"]))
    ?.[1];
  const proxy = /image: (\S+)/.exec(dockerProxyCompose("net"))?.[1];
  assertEquals(traefik, pinnedImage("traefik"));
  assertEquals(proxy, pinnedImage("socketProxy"));
  assert(PROXYSQL_IMAGE.endsWith(pinnedImageDigest("proxysql")));
});

test("every allowed managed engine image has a digest, and none is extra", () => {
  const allowed = Object.values(MANAGED_ALLOWED_IMAGES_BY_ENGINE).flat()
    .sort();
  for (const image of allowed) {
    const pinned = pinManagedEngineImage(image);
    assert(pinned.startsWith(`${image}@sha256:`), `${image} has no digest`);
  }
  const table = JSON.parse(
    Deno.readTextFileSync(join(ORCHESTRATION, "image-pins.json")),
  ).managedEngines as Record<string, string>;
  assertEquals(Object.keys(table).sort(), allowed);
});

test("digest-pinned and unknown references are left alone", () => {
  const pinned = `docker.io/library/postgres:18@sha256:${"a".repeat(64)}`;
  assertEquals(pinManagedEngineImage(pinned), pinned);
  assertEquals(
    pinManagedEngineImage("docker.io/library/other:1"),
    "docker.io/library/other:1",
  );
});

test("role image variables come from the table, never a literal tag", () => {
  const offenders: string[] = [];
  for (const role of Deno.readDirSync(join(ORCHESTRATION, "roles"))) {
    if (!role.isDirectory) continue;
    let text: string;
    try {
      text = Deno.readTextFileSync(
        join(ORCHESTRATION, "roles", role.name, "defaults", "main.yml"),
      );
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = /^([a-z_]*image[a-z_]*):\s*(\S.*)$/.exec(line);
      if (m === null || m[1].endsWith("_tag")) continue;
      if (!m[2].includes("image-pins.json") && !m[2].includes("@sha256:")) {
        if (m[2].replaceAll('"', "") === "") continue;
        offenders.push(`${role.name}: ${line}`);
      }
    }
  }
  // railpack_frontend_image is the repository name; its digest is pinned.
  assertEquals(
    offenders.filter((o) => !o.includes("railpack_frontend_image")),
    [],
  );
});
