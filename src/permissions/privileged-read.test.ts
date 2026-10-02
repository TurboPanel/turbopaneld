import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  instanceAcmeSettingsPath,
  readInstanceAcmeSettings,
} from "../deploy/instance-acme-issuer.ts";
import {
  instanceHostnameSidecarPath,
  readInstanceEdgeHostnames,
} from "../instance/instance-acme-observe.ts";
import {
  directoryExists,
  type PrivilegedReadRun,
  readTextFileOrNull,
} from "./privileged-read.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const layout = { configDir: "/etc/turbopanel" } as LayoutPaths;

/**
 * Deny the daemon's own `readTextFile`/`stat` under `prefix`, the way a
 * `root:tpcaddysite` `0750` dir or a principal home does on a host.
 */
async function withDeniedFs(
  prefix: string,
  fn: () => Promise<void>,
): Promise<void> {
  const readTextFile = Deno.readTextFile;
  const stat = Deno.stat;
  const deny = (path: string | URL) => {
    if (String(path).startsWith(prefix)) {
      throw new Deno.errors.PermissionDenied(String(path));
    }
  };
  Deno.readTextFile = ((path: string | URL, options?: Deno.ReadFileOptions) => {
    deny(path);
    return readTextFile(path, options);
  }) as typeof Deno.readTextFile;
  Deno.stat = ((path: string | URL) => {
    deny(path);
    return stat(path);
  }) as typeof Deno.stat;
  try {
    await fn();
  } finally {
    Deno.readTextFile = readTextFile;
    Deno.stat = stat;
  }
}

/** tp-host as root sees it: `cat` and `test -e` over a fake file table. */
function fakeHost(files: Record<string, string>): {
  run: PrivilegedReadRun;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: PrivilegedReadRun = (_command, args) => {
    calls.push(args);
    const path = args.at(-1) ?? "";
    const present = path in files ||
      Object.keys(files).some((name) => name.startsWith(`${path}/`));
    if (args.includes("cat")) {
      return Promise.resolve(
        path in files
          ? { success: true, stdout: files[path], stderr: "" }
          : { success: false, stdout: "", stderr: `no such file ${path}` },
      );
    }
    return Promise.resolve({ success: present, stdout: "", stderr: "" });
  };
  return { run, calls };
}

test("instance ACME settings are read through tp-host when the caddy dir is closed", async () => {
  const settings = {
    contactEmail: "ops@example.com",
    tosAccepted: true,
    directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
    useStaging: false,
  };
  const { run, calls } = fakeHost({
    [instanceAcmeSettingsPath(layout)]: JSON.stringify(settings),
  });
  await withDeniedFs("/etc/turbopanel/caddy", async () => {
    assertEquals(await readInstanceAcmeSettings(layout, run), settings);
  });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].slice(-3), [
    "cat",
    "--",
    instanceAcmeSettingsPath(layout),
  ]);
});

test("instance edge hostnames are read through tp-host when the caddy dir is closed", async () => {
  const sidecar = [{ host: "panel.example.com", source: "lets-encrypt" }];
  const { run } = fakeHost({
    [instanceHostnameSidecarPath(layout)]: JSON.stringify(sidecar),
  });
  await withDeniedFs("/etc/turbopanel/caddy", async () => {
    const hosts = await readInstanceEdgeHostnames(layout, run);
    assertEquals(hosts.map((entry) => entry.host), ["panel.example.com"]);
  });
});

test("a closed caddy dir without the files reads as unset, not as an error", async () => {
  const { run } = fakeHost({});
  await withDeniedFs("/etc/turbopanel/caddy", async () => {
    assertEquals(await readInstanceAcmeSettings(layout, run), null);
    assertEquals(await readInstanceEdgeHostnames(layout, run), []);
  });
});

test("readTextFileOrNull surfaces a tp-host refusal", async () => {
  const run: PrivilegedReadRun = () =>
    Promise.resolve({
      success: false,
      stdout: "",
      stderr: "refusing /etc/turbopanel/x: a component is a symlink",
    });
  await withDeniedFs("/etc/turbopanel", async () => {
    await assertRejects(
      () => readTextFileOrNull("/etc/turbopanel/x", run),
      Error,
      "a component is a symlink",
    );
  });
});

test("readTextFileOrNull reads directly and answers null for a missing file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "a.json");
    await Deno.writeTextFile(path, "{}");
    const { run, calls } = fakeHost({});
    assertEquals(await readTextFileOrNull(path, run), "{}");
    assertEquals(await readTextFileOrNull(join(dir, "missing"), run), null);
    assertEquals(calls.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("directoryExists asks tp-host for presence behind a home it cannot enter", async () => {
  const home = "/srv/users/alice/volumes/stor-1";
  const { run, calls } = fakeHost({ [`${home}/data.db`]: "" });
  await withDeniedFs("/srv/users/alice", async () => {
    assertEquals(await directoryExists(home, run), true);
    assertEquals(await directoryExists(`${home}-gone`, run), false);
  });
  assertEquals(calls[0].slice(-3), ["test", "-e", home]);
});

test("directoryExists stats a reachable path itself", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { run, calls } = fakeHost({});
    assertEquals(await directoryExists(dir, run), true);
    assertEquals(await directoryExists(join(dir, "missing"), run), false);
    await Deno.writeTextFile(join(dir, "f"), "");
    assertEquals(await directoryExists(join(dir, "f"), run), false);
    assertEquals(calls.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
