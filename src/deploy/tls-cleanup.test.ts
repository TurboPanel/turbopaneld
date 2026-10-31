import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import { removeUnreferencedTlsFolders } from "./tls-cleanup.ts";

const test = Deno.test.bind(Deno);

const KEPT = "11111111-1111-4111-8111-111111111111";
const GONE = "22222222-2222-4222-8222-222222222222";
const FRESH = "33333333-3333-4333-8333-333333333333";
const QUARANTINED = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2029-01-01T01:00:00Z");
const OLD = new Date("2029-01-01T00:00:00Z");
const RECENT = new Date("2029-01-01T00:55:00Z");

async function withTls(
  fn: (layout: LayoutPaths, root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-tls-cleanup-" });
  const layout = {
    configDir: join(root, "config"),
    tlsDir: join(root, "config", "tls"),
  } as LayoutPaths;
  await Deno.mkdir(join(layout.configDir, "hosting", "sites"), {
    recursive: true,
  });
  try {
    await fn(layout, root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function folder(layout: LayoutPaths, name: string, when: Date) {
  const dir = join(layout.tlsDir, name);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "fullchain.pem"), "chain");
  await Deno.writeTextFile(join(dir, "privkey.pem"), "key");
  await Deno.utime(join(dir, "fullchain.pem"), when, when);
  await Deno.utime(join(dir, "privkey.pem"), when, when);
  await Deno.utime(dir, when, when);
}

async function site(layout: LayoutPaths, name: string, text: string) {
  await Deno.writeTextFile(
    join(layout.configDir, "hosting", "sites", name),
    text,
  );
}

async function names(layout: LayoutPaths): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(layout.tlsDir)) out.push(entry.name);
  return out.sort();
}

test("only an old folder no site file mentions is removed", async () => {
  await withTls(async (layout) => {
    for (const id of [KEPT, GONE, QUARANTINED]) await folder(layout, id, OLD);
    await folder(layout, FRESH, RECENT);
    await folder(layout, "instance-acme", OLD);
    await site(
      layout,
      "env1.caddy",
      `a.example.com {\n  tls ${layout.tlsDir}/${KEPT}/fullchain.pem ${layout.tlsDir}/${KEPT}/privkey.pem\n}\n`,
    );
    // A set-aside file still counts: it may be put back.
    await site(
      layout,
      "env2.caddy.quarantined",
      `tls ${layout.tlsDir}/${QUARANTINED}/fullchain.pem`,
    );
    const removed = await removeUnreferencedTlsFolders(layout, {
      now: () => NOW,
    });
    assertEquals(removed, [GONE]);
    assertEquals(
      await names(layout),
      [
        FRESH,
        KEPT,
        QUARANTINED,
        "instance-acme",
      ].sort(),
    );
  });
});

test("another environment's certificate survives this environment's cleanup", async () => {
  await withTls(async (layout) => {
    await folder(layout, KEPT, OLD);
    await site(layout, "00-fallback.caddy", "# reserved\n");
    await site(layout, "other-env.caddy", `tls /x/${KEPT}/privkey.pem`);
    assertEquals(
      await removeUnreferencedTlsFolders(layout, { now: () => NOW }),
      [],
    );
  });
});

test("nothing is removed when the sites folder cannot be read", async () => {
  await withTls(async (layout) => {
    await folder(layout, GONE, OLD);
    await Deno.remove(join(layout.configDir, "hosting"), { recursive: true });
    assertEquals(
      await removeUnreferencedTlsFolders(layout, { now: () => NOW }),
      [],
    );
    assertEquals(await names(layout), [GONE]);
  });
});

test("a missing TLS folder is not an error", async () => {
  await withTls(async (layout) => {
    assertEquals(
      await removeUnreferencedTlsFolders(layout, { now: () => NOW }),
      [],
    );
  });
});
