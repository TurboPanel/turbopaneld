import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import type { EnvironmentDeployVariableMaterial } from "../contracts/commands-contracts.ts";
import {
  applyShareCredentialsToCompose,
  materializeShareCredentials,
  removeShareCredentialsTree,
  renderShareCredentials,
  shareCredentialsDirectory,
} from "./network-share-credentials.ts";

const test = Deno.test.bind(Deno);

function material(
  key: string,
  value: string,
): EnvironmentDeployVariableMaterial {
  return {
    key,
    composeServiceName: null,
    forBuild: false,
    forRuntime: true,
    isLiteral: false,
    valueEnvelope: `sealed:${value}`,
  };
}

const decrypt = (envelopes: readonly string[]) =>
  Promise.resolve(envelopes.map((e) => e.replace(/^sealed:/, "")));

async function withStateDir(
  fn: (layout: { stateDir: string }) => Promise<void>,
) {
  const stateDir = await Deno.makeTempDir({ prefix: "tp-share-cred-" });
  try {
    await fn({ stateDir });
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
}

test("the credentials file has the cifs lines and is private", async () => {
  await withStateDir(async (layout) => {
    const paths = await materializeShareCredentials(
      layout,
      "p1",
      "e1",
      [{
        volume: "media",
        passwordKey: "SHARE_SECRET_A",
        usernameKey: "SHARE_SECRET_B",
        domain: "CORP",
      }],
      [material("SHARE_SECRET_A", "p,w d"), material("SHARE_SECRET_B", "svc")],
      decrypt,
    );
    const path = paths.get("media")!;
    assertEquals(
      path,
      join(shareCredentialsDirectory(layout, "p1", "e1"), "media.cred"),
    );
    assertEquals(
      await Deno.readTextFile(path),
      "username=svc\npassword=p,w d\ndomain=CORP\n",
    );
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    assertEquals(
      (await Deno.stat(shareCredentialsDirectory(layout, "p1", "e1"))).mode! &
        0o777,
      0o700,
    );
  });
});

test("a plain username needs no sealed key, and stale files are removed", async () => {
  await withStateDir(async (layout) => {
    const entry = { passwordKey: "PW", username: "svc" };
    await materializeShareCredentials(
      layout,
      "p1",
      "e1",
      [{ volume: "a", ...entry }, { volume: "b", ...entry }],
      [material("PW", "x")],
      decrypt,
    );
    await materializeShareCredentials(
      layout,
      "p1",
      "e1",
      [{ volume: "a", ...entry }],
      [material("PW", "y")],
      decrypt,
    );
    const dir = shareCredentialsDirectory(layout, "p1", "e1");
    const names = [];
    for await (const item of Deno.readDir(dir)) names.push(item.name);
    assertEquals(names, ["a.cred"]);
    await materializeShareCredentials(layout, "p1", "e1", [], [], decrypt);
    await assertRejects(() => Deno.stat(dir), Deno.errors.NotFound);
  });
});

test("a missing value, a line break or a bad volume name refuses before writing", async () => {
  await withStateDir(async (layout) => {
    const dir = shareCredentialsDirectory(layout, "p1", "e1");
    await assertRejects(
      () =>
        materializeShareCredentials(
          layout,
          "p1",
          "e1",
          [{ volume: "media", passwordKey: "PW", username: "svc" }],
          [],
          decrypt,
        ),
      Error,
      "no sealed login",
    );
    await assertRejects(
      () =>
        materializeShareCredentials(
          layout,
          "p1",
          "e1",
          [{ volume: "media", passwordKey: "PW", username: "svc" }],
          [material("PW", "a\npassword=b")],
          decrypt,
        ),
      Error,
      "control character",
    );
    await assertRejects(
      () =>
        materializeShareCredentials(
          layout,
          "p1",
          "e1",
          [{ volume: "../x", passwordKey: "PW", username: "svc" }],
          [material("PW", "a")],
          decrypt,
        ),
      Error,
      "volume name",
    );
    await assertRejects(
      () =>
        materializeShareCredentials(
          layout,
          "p1",
          "e1",
          [{ volume: "media", passwordKey: "PW", username: "svc" }],
          [material("PW", "a")],
          undefined,
        ),
      Error,
      "decrypt is unavailable",
    );
    await assertRejects(() => Deno.stat(dir), Deno.errors.NotFound);
  });
});

test("the secret never reaches an error message", async () => {
  await withStateDir(async (layout) => {
    const err = await assertRejects(() =>
      materializeShareCredentials(
        layout,
        "p1",
        "e1",
        [{ volume: "media", passwordKey: "PW", username: "svc" }],
        [material("PW", "top\nsecret-value")],
        decrypt,
      )
    );
    assertEquals((err as Error).message.includes("secret-value"), false);
  });
});

test("removing the tree takes the files and tolerates an absent folder", async () => {
  await withStateDir(async (layout) => {
    await removeShareCredentialsTree(layout, "p1", "e1");
    await materializeShareCredentials(
      layout,
      "p1",
      "e1",
      [{ volume: "media", passwordKey: "PW", username: "svc" }],
      [material("PW", "x")],
      decrypt,
    );
    await removeShareCredentialsTree(layout, "p1", "e1");
    await assertRejects(
      () => Deno.stat(shareCredentialsDirectory(layout, "p1", "e1")),
      Deno.errors.NotFound,
    );
  });
});

test("render refuses empty and multi-line values", () => {
  assertThrows(() => renderShareCredentials({ username: "", password: "x" }));
  assertThrows(() =>
    renderShareCredentials({ username: "a", password: "x", domain: "d\n" })
  );
});

const YAML = `services:
  web:
    image: alpine
volumes:
  media:
    driver: local
    driver_opts:
      type: cifs
      device: //files.example.net/media
      o: ro,credentials=/etc/shadow,vers=3.1.1
`;

test("credentials= is set on the share volume and replaces an authored one", () => {
  const out = parse(
    applyShareCredentialsToCompose(
      YAML,
      new Map([["media", "/run/x/media.cred"]]),
    ),
  ) as { volumes: { media: { driver_opts: { o: string } } } };
  assertEquals(
    out.volumes.media.driver_opts.o,
    "ro,vers=3.1.1,credentials=/run/x/media.cred",
  );
  assertEquals(applyShareCredentialsToCompose(YAML, new Map()), YAML);
});

test("a login for a volume that is not a share volume is an error", () => {
  assertThrows(
    () => applyShareCredentialsToCompose(YAML, new Map([["nope", "/x"]])),
    Error,
    "not a share volume",
  );
  assertThrows(
    () =>
      applyShareCredentialsToCompose("services: {}\n", new Map([["a", "/x"]])),
    Error,
    "compose lacks",
  );
  assertStringIncludes("ok", "ok");
});
