import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { parse } from "yaml";
import type { EnvironmentDeployVariableMaterial } from "../contracts/commands-contracts.ts";
import {
  applyShareLoginsToCompose,
  fingerprint,
  loginTokens,
  pruneStaleShareVolumes,
  removeProjectShareVolumes,
  resolveShareLogins,
} from "./network-share-logins.ts";

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

const ENTRY = {
  volume: "media",
  passwordKey: "SHARE_SECRET_A",
  usernameKey: "SHARE_SECRET_B",
};

test("a sealed login is decrypted by volume, with an optional plain user and domain", async () => {
  const logins = await resolveShareLogins(
    [ENTRY, {
      volume: "docs",
      passwordKey: "SHARE_SECRET_A",
      username: "svc",
      domain: "CORP",
    }],
    [material("SHARE_SECRET_A", "w d"), material("SHARE_SECRET_B", "svc2")],
    decrypt,
  );
  assertEquals(logins.get("media"), { username: "svc2", password: "w d" });
  assertEquals(logins.get("docs"), {
    username: "svc",
    password: "w d",
    domain: "CORP",
  });
  assertEquals(
    (await resolveShareLogins([], [], undefined)).size,
    0,
  );
});

test("a missing value, a comma, a line break or a bad volume refuses", async () => {
  const mat = (v: string) => [
    material("SHARE_SECRET_A", v),
    material("SHARE_SECRET_B", "svc"),
  ];
  await assertRejects(
    () =>
      resolveShareLogins([ENTRY], [material("SHARE_SECRET_B", "u")], decrypt),
    Error,
    "no sealed login",
  );
  await assertRejects(
    () => resolveShareLogins([ENTRY], mat("a,b"), decrypt),
    Error,
    "comma",
  );
  await assertRejects(
    () => resolveShareLogins([ENTRY], mat("a\nusername=root"), decrypt),
    Error,
    "control character",
  );
  await assertRejects(
    () => resolveShareLogins([ENTRY], mat(""), decrypt),
    Error,
    "empty",
  );
  await assertRejects(
    () => resolveShareLogins([ENTRY], mat("x"), undefined),
    Error,
    "unavailable",
  );
  await assertRejects(
    () => resolveShareLogins([{ ...ENTRY, volume: "../x" }], mat("x"), decrypt),
    Error,
    "volume name",
  );
  await assertRejects(
    () => resolveShareLogins([ENTRY, ENTRY], mat("x"), decrypt),
    Error,
    "twice",
  );
});

test("the secret never reaches an error message", async () => {
  const err = await assertRejects(() =>
    resolveShareLogins(
      [ENTRY],
      [
        material("SHARE_SECRET_A", "hunter2,x"),
        material("SHARE_SECRET_B", "u"),
      ],
      decrypt,
    )
  );
  assertEquals(String(err).includes("hunter2"), false);
});

const SECRET = new Uint8Array(32).fill(7);
const COMPOSE = `services:
  web:
    image: alpine
volumes:
  media:
    driver: local
    driver_opts:
      type: cifs
      device: //files.example.net/media
      o: ro,vers=3.1.1,domain=OLD,credentials=/x
  plain:
    driver: local
`;

test("logins land in o, replace authored ones, and rename the Docker volume", async () => {
  const login = { username: "svc", password: "p$w", domain: "CORP" };
  const out = await applyShareLoginsToCompose(
    COMPOSE,
    "proj",
    new Map([["media", login]]),
    SECRET,
  );
  const doc = parse(out.yaml) as {
    volumes: Record<string, { name?: string; driver_opts?: { o: string } }>;
  };
  // `$` is escaped for Compose, and authored login options are gone.
  assertEquals(
    doc.volumes.media.driver_opts?.o,
    "ro,vers=3.1.1," +
      loginTokens(login).map((t) => t.replaceAll("$", "$$$$")).join(","),
  );
  assertEquals(out.injected.get("media"), loginTokens(login));
  const name = out.volumeNames.get("media") ?? "";
  assertEquals(doc.volumes.media.name, name);
  assertEquals(/^proj_media_[0-9a-f]{12}$/.test(name), true);
  assertEquals(doc.volumes.plain.name, undefined);
  assertEquals(out.yaml.includes("credentials"), false);
});

test("a changed login or device gives a new volume name, the same login the same name", async () => {
  const name = async (login: { username: string; password: string }) =>
    (await applyShareLoginsToCompose(
      COMPOSE,
      "proj",
      new Map([["media", login]]),
      SECRET,
    ))
      .volumeNames.get("media");
  const a = await name({ username: "svc", password: "one" });
  assertEquals(a, await name({ username: "svc", password: "one" }));
  assertNotEquals(a, await name({ username: "svc", password: "two" }));
  const moved = await applyShareLoginsToCompose(
    COMPOSE.replace("files.example.net", "other.example.net"),
    "proj",
    new Map([["media", { username: "svc", password: "one" }]]),
    SECRET,
  );
  assertNotEquals(a, moved.volumeNames.get("media"));
});

test("the fingerprint is a keyed HMAC, not the plain hash, and depends on the key", async () => {
  const parts = ["proj", "media", "//files.example.net/media", "password=x"];
  const plain = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(["tp-smb-login-v1", ...parts])),
  );
  const plainHex = Array.from(
    new Uint8Array(plain),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("").slice(0, 12);
  const keyed = await fingerprint(SECRET, parts);
  assertNotEquals(keyed, plainHex);
  assertEquals(keyed, await fingerprint(SECRET, parts));
  assertNotEquals(keyed, await fingerprint(new Uint8Array(32).fill(8), parts));
});

test("a login for a volume that is not a share volume is an error", async () => {
  await assertRejects(
    () =>
      applyShareLoginsToCompose(
        COMPOSE,
        "proj",
        new Map([["plain", { username: "u", password: "p" }]]),
        SECRET,
      ),
    Error,
    "not a share volume",
  );
  await assertRejects(
    () =>
      applyShareLoginsToCompose(
        "services: {}\n",
        "proj",
        new Map([["media", { username: "u", password: "p" }]]),
        SECRET,
      ),
    Error,
    "lacks",
  );
  const none = await applyShareLoginsToCompose(
    COMPOSE,
    "proj",
    new Map(),
    SECRET,
  );
  assertEquals(none.yaml, COMPOSE);
});

test("the unsuffixed data volume and look-alikes survive a prune", async () => {
  const removedNames: string[] = [];
  const run = (args: string[]) => {
    if (args[1] === "rm") removedNames.push(args[2]);
    return Promise.resolve({
      success: true,
      stdout: args[1] === "ls"
        ? [
          "proj_media",
          "proj_media_abcdef012345",
          "proj_media_abcdef0123456",
          "proj_media_ABCDEF012345",
          "xproj_media_abcdef012345",
          "proj_media_1b1b1b1b1b1b000000000",
        ].join("\n")
        : "",
      stderr: "",
    });
  };
  const removed = await pruneStaleShareVolumes(
    "proj",
    new Map([["media", "proj_media_0123456789ab"]]),
    run,
  );
  assertEquals(removed, ["proj_media_abcdef012345"]);
  assertEquals(removedNames, ["proj_media_abcdef012345"]);
});

test("a delete removes only cifs volumes of the share shape in the project", async () => {
  const removedNames: string[] = [];
  const types: Record<string, string> = {
    proj_media_abcdef012345: "cifs",
    proj_notes_abcdef012345: "none",
  };
  const run = (args: string[]) => {
    if (args[1] === "rm") removedNames.push(args[2]);
    const stdout = args[1] === "ls"
      ? [
        "proj_media_abcdef012345\tmedia",
        "proj_notes_abcdef012345\tnotes",
        "proj_media\tmedia",
        "proj_db_abcdef012345\tother",
      ].join("\n")
      : args[1] === "inspect"
      ? `${types[args[4]] ?? ""}\n`
      : "";
    return Promise.resolve({ success: true, stdout, stderr: "" });
  };
  assertEquals(await removeProjectShareVolumes("proj", run), [
    "proj_media_abcdef012345",
  ]);
  assertEquals(removedNames, ["proj_media_abcdef012345"]);
  assertEquals(
    await removeProjectShareVolumes(
      "proj",
      () => Promise.reject(new Error("x")),
    ),
    [],
  );
});

test("volumes of an earlier login are removed, the current one kept", async () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return Promise.resolve({
      success: true,
      stdout: args[1] === "ls"
        ? "proj_media_0a0a0a0a0a0a\nproj_media_1b1b1b1b1b1b\n\n"
        : "",
      stderr: "",
    });
  };
  const removed = await pruneStaleShareVolumes(
    "proj",
    new Map([["media", "proj_media_1b1b1b1b1b1b"]]),
    run,
  );
  assertEquals(removed, ["proj_media_0a0a0a0a0a0a"]);
  assertStringIncludes(
    calls[0].join(" "),
    "label=com.docker.compose.project=proj",
  );
  assertEquals(calls.at(-1), ["volume", "rm", "proj_media_0a0a0a0a0a0a"]);
  // A volume still in use stays; nothing throws.
  const kept = await pruneStaleShareVolumes(
    "proj",
    new Map([["media", "proj_media_1b1b1b1b1b1b"]]),
    (args) =>
      Promise.resolve({
        success: args[1] === "ls",
        stdout: "proj_media_0a0a0a0a0a0a\n",
        stderr: "in use",
      }),
  );
  assertEquals(kept, []);
});
