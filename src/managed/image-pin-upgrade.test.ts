import { assertEquals } from "@std/assert";
import type { ManagedApplyPayload } from "../contracts/commands-contracts.ts";
import { dockerProxyCompose, traefikCompose } from "../deploy/ingress.ts";
import {
  keepStoredImages,
  pinManagedEngineImage,
  pinnedImage,
  pinnedImageTag,
} from "../util/image-pins.ts";
import { chooseManagedCompose } from "./apply.ts";

const test = Deno.test.bind(Deno);

function payload(image: string): ManagedApplyPayload {
  return {
    managedId: "00000000-0000-4000-8000-000000000001",
    engine: "postgres",
    containerName: "c1",
    managedNetwork: "net",
    image,
    containerPort: 5432,
    composeYaml: ["services:", "  postgres:", "    environment: {}"].join("\n"),
    configFiles: [],
    volumes: [],
  } as unknown as ManagedApplyPayload;
}

function imageOf(composeYaml: string): string {
  return /image: (\S+)/.exec(composeYaml)?.[1] ?? "";
}

async function withStored<T>(
  stored: string | null,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/docker-compose.yml`;
    if (stored !== null) await Deno.writeTextFile(path, stored);
    return await run(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const TAG = "docker.io/library/postgres:18-alpine";

test("a running engine keeps its tag-only image when a pin appears", async () => {
  await withStored(`services:\n  postgres:\n    image: ${TAG}\n`, async (p) => {
    const next = await chooseManagedCompose(p, payload(TAG));
    assertEquals(imageOf(next.composeYaml), TAG);
  });
});

test("a new engine gets the digest on first create", async () => {
  await withStored(null, async (p) => {
    const next = await chooseManagedCompose(p, payload(TAG));
    assertEquals(imageOf(next.composeYaml), pinManagedEngineImage(TAG));
    assertEquals(imageOf(next.composeYaml).includes("@sha256:"), true);
  });
});

test("a deliberate version change gets the new tag with its digest", async () => {
  const other = "docker.io/library/postgres:18";
  await withStored(`services:\n  postgres:\n    image: ${TAG}\n`, async (p) => {
    const next = await chooseManagedCompose(p, payload(other));
    assertEquals(imageOf(next.composeYaml), pinManagedEngineImage(other));
  });
});

test("a stored digest is replaced when the table's digest changes", async () => {
  const old = `${TAG}@sha256:${"1".repeat(64)}`;
  await withStored(`services:\n  postgres:\n    image: ${old}\n`, async (p) => {
    const next = await chooseManagedCompose(p, payload(TAG));
    assertEquals(imageOf(next.composeYaml), pinManagedEngineImage(TAG));
  });
});

test("platform stacks keep a tag-only stored image and move on a stored digest", () => {
  const traefik = traefikCompose("net", ["172.18.0.1"]);
  const bare = traefik.replace(
    pinnedImage("traefik"),
    pinnedImageTag("traefik"),
  );
  assertEquals(keepStoredImages(traefik, bare), bare);
  assertEquals(keepStoredImages(traefik, null), traefik);
  const withOtherDigest = traefik.replace(
    /@sha256:[0-9a-f]{64}/,
    `@sha256:${"2".repeat(64)}`,
  );
  assertEquals(keepStoredImages(traefik, withOtherDigest), traefik);
  const proxy = dockerProxyCompose("net");
  const proxyBare = proxy.replace(/@sha256:[0-9a-f]{64}/, "");
  assertEquals(keepStoredImages(proxy, proxyBare), proxyBare);
});
