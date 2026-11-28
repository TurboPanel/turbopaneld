import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { RUNTIME_COMPOSE_FILENAME } from "../deploy/compose-files.ts";
import type { CommandOutputSink } from "../logs/contracts.ts";
import { handleEnvironmentDeploy } from "./deploy-environment.ts";
import "../testing/stub-hosting-caddy-host.ts";
import { loginTokens } from "../deploy/network-share-logins.ts";
import { instantlyHealthy } from "../testing/instant-health-gate.ts";
import {
  resetShareDenySet,
  type ShareTargetDeps,
} from "../deploy/network-share-targets.ts";

const test = Deno.test.bind(Deno);

const SECRET = "hunter2-share-pw";

/** Names resolve through a table; nothing here touches DNS or Docker. */
function targets(
  names: Record<string, string> = { "files.example.net": "192.0.2.10" },
): ShareTargetDeps {
  return {
    hostAddresses: () => ["192.0.2.50"],
    listDockerNetworks: () => Promise.resolve([]),
    dockerPools: () => Promise.resolve([{ Base: "10.200.0.0/16" }]),
    resolveDns: (name, type) =>
      names[name] && type === "A"
        ? Promise.resolve([names[name]])
        : Promise.reject(new Deno.errors.NotFound("no record")),
  };
}

function shareVolume(extra: Record<string, unknown> = {}) {
  return {
    media: {
      driver: "local",
      driver_opts: {
        type: "cifs",
        device: "//192.0.2.10/media",
        o: "username=svc,vers=3.1.1,addr=192.0.2.10",
        ...extra,
      },
    },
  };
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const item of Deno.readDir(dir)) {
    const path = join(dir, item.name);
    if (item.isDirectory) out.push(...await listFiles(path));
    else out.push(path);
  }
  return out;
}

/** One real deploy whose resolved model carries an SMB share volume. */
async function deployWithShare(
  payloadExtra: Record<string, unknown>,
  volumes: Record<string, unknown>,
  smbFails = false,
  fromYaml = false,
  shareTargets: ShareTargetDeps = targets(),
) {
  resetShareDenySet();
  const root = await Deno.makeTempDir({ prefix: "tp-deploy-shares-" });
  const previous = {
    state: Deno.env.get("TURBOPANEL_STATE_DIR"),
    config: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    run: Deno.env.get("TURBOPANEL_RUN_DIR"),
  };
  Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
  Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
  Deno.env.set("TURBOPANEL_RUN_DIR", join(root, "run"));
  const lines: string[] = [];
  const secrets: string[] = [];
  const order: string[] = [];
  const sink: CommandOutputSink = {
    onLine: (_stream, message) => void lines.push(message),
    setPhase() {},
    addSecrets: (values) =>
      void secrets.push(...values.filter((v): v is string => !!v)),
    redactSummary: (text) => text,
    finalize: () => Promise.resolve(),
  };
  const ok = (stdout = "") =>
    Promise.resolve({ success: true, stdout, stderr: "", code: 0 });
  const upFiles: Array<{ text: string; mode: number | null }> = [];
  const resolvedYamls: string[] = [];
  const fakeRunDocker = async (args: string[]): Promise<DockerCliResult> => {
    if (args.includes("config") && args.includes("--format")) {
      let resolvedVolumes = volumes;
      if (fromYaml) {
        const text = await Deno.readTextFile(args[args.indexOf("-f") + 1]);
        resolvedYamls.push(text);
        resolvedVolumes = (parse(text) as { volumes: Record<string, unknown> })
          .volumes;
      }
      return ok(JSON.stringify({
        services: { web: { image: "nginx:alpine" } },
        volumes: resolvedVolumes,
      }));
    }
    if (args.includes("up")) {
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "-f") continue;
        const stat = await Deno.stat(args[i + 1]);
        upFiles.push({
          text: await Deno.readTextFile(args[i + 1]),
          mode: stat.mode === null ? null : stat.mode & 0o777,
        });
      }
    }
    if (args.includes("up")) order.push("up");
    return ok();
  };
  let error: Error | null = null;
  let smbCalls = 0;
  let leftovers: string[] = [];
  try {
    await handleEnvironmentDeploy(
      {
        environmentId: "envshares",
        projectId: "proj-shares",
        organizationId: "org-1",
        projectName: "tp-demo-shares",
        composeFiles: [{
          filename: RUNTIME_COMPOSE_FILENAME,
          role: "runtime",
          source: "inline",
          content: "services:\n  web:\n    image: nginx:alpine\n",
        }],
        hostings: [],
        ...payloadExtra,
      },
      new Date().toISOString(),
      {
        runDocker: fakeRunDocker,
        ensureDocker: () => Promise.resolve(),
        runPrivileged: () => ok(),
        decryptSecrets: (envelopes) =>
          Promise.resolve(envelopes.map((e) => e.replace(/^sealed:/, ""))),
        waitForHealth: instantlyHealthy,
        ensureExternalDockerNetworks: () => Promise.resolve(),
        ensureFabricDockerNetworks: () => Promise.resolve(),
        logSink: sink,
        shareTargets,
        ensureSmbTools: (log) => {
          smbCalls++;
          order.push("smb");
          log("Installing SMB tools (cifs-utils)");
          return smbFails
            ? Promise.reject(
              new Error("Installing SMB tools (cifs-utils) failed"),
            )
            : Promise.resolve();
        },
      },
    );
  } catch (err) {
    error = err as Error;
  } finally {
    if (previous.state === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
    else Deno.env.set("TURBOPANEL_STATE_DIR", previous.state);
    if (previous.config === undefined) Deno.env.delete("TURBOPANEL_CONFIG_DIR");
    else Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.config);
    if (previous.run === undefined) Deno.env.delete("TURBOPANEL_RUN_DIR");
    else Deno.env.set("TURBOPANEL_RUN_DIR", previous.run);
    leftovers = await listFiles(root);
    await Deno.remove(root, { recursive: true });
  }
  return {
    error,
    lines,
    secrets,
    order,
    smbCalls,
    upFiles,
    stateDir: join(root, "state"),
    leftovers,
    resolvedYamls,
  };
}

test("an allowed share installs the helper before compose up and never logs the password", async () => {
  const r = await deployWithShare({ allowNetworkShares: true }, shareVolume());
  assertEquals(r.error, null);
  assertEquals(r.order, ["smb", "up"]);
  const text = r.lines.join("\n");
  assertStringIncludes(text, "//192.0.2.10/media");
  assertEquals(text.includes(SECRET), false);
});

test("a share without the flag is refused before the helper or compose up", async () => {
  const r = await deployWithShare({}, shareVolume());
  assertStringIncludes(
    r.error?.message ?? "",
    "network shares must be allowed for this server",
  );
  assertEquals(r.smbCalls, 0);
  assertEquals(r.order, []);
  assertEquals((r.error?.message ?? "").includes(SECRET), false);
});

test("an unsafe share option is refused even with the flag", async () => {
  const r = await deployWithShare(
    { allowNetworkShares: true },
    shareVolume({ o: "username=svc,suid" }),
  );
  assertStringIncludes(r.error?.message ?? "", "suid");
  assertEquals((r.error?.message ?? "").includes(SECRET), false);
  assertEquals(r.order, []);
});

test("a failed helper install fails the deploy before compose up", async () => {
  const r = await deployWithShare(
    { allowNetworkShares: true },
    shareVolume(),
    true,
  );
  assertStringIncludes(r.error?.message ?? "", "Installing SMB tools");
  assertEquals(r.order, ["smb"]);
});

test("a deploy with no share volume never touches the helper", async () => {
  const r = await deployWithShare({ allowNetworkShares: true }, {});
  assertEquals(r.error, null);
  assertEquals(r.smbCalls, 0);
});

const COMPOSE_WITH_SHARE = `services:
  web:
    image: nginx:alpine
volumes:
  media:
    driver: local
    driver_opts:
      type: cifs
      device: //files.example.net/media
      o: username=svc,vers=3.1.1
`;

const LOGIN = {
  allowNetworkShares: true,
  networkShareCredentials: [{
    volume: "media",
    passwordKey: "SHARE_SECRET_A",
    username: "svc",
  }],
  variableMaterial: [{
    key: "SHARE_SECRET_A",
    composeServiceName: null,
    forBuild: false,
    forRuntime: true,
    isLiteral: false,
    valueEnvelope: `sealed:${SECRET}`,
  }],
  composeFiles: [{
    filename: RUNTIME_COMPOSE_FILENAME,
    role: "runtime",
    source: "inline",
    content: COMPOSE_WITH_SHARE,
  }],
};

test("a sealed login rides in o of the compose docker reads, never in a login file or log", async () => {
  const r = await deployWithShare(LOGIN, {}, false, true);
  assertEquals(r.error, null);
  assertEquals(r.order, ["smb", "up"]);
  // Every compose resolved before `up` was judged without the login.
  for (const text of r.resolvedYamls.slice(0, -1)) {
    assertEquals(text.includes(SECRET), false);
  }
  // `up` reads one group-private (0640) file whose share volume holds the login and a
  // fingerprinted Docker volume name.
  assertEquals(r.upFiles.length, 1);
  assertEquals(r.upFiles[0].mode, 0o640);
  const doc = parse(r.upFiles[0].text) as {
    volumes: Record<string, { name: string; driver_opts: { o: string } }>;
  };
  assertEquals(
    doc.volumes.media.driver_opts.o,
    `vers=3.1.1,addr=192.0.2.10,${
      loginTokens({ username: "svc", password: SECRET }).join(",")
    }`,
  );
  assertEquals(
    /^tp-demo-shares_media_[0-9a-f]{12}$/.test(doc.volumes.media.name),
    true,
  );
  // No separate login file, and no credentials= anywhere.
  assertEquals(r.leftovers.filter((f) => f.endsWith(".cred")), []);
  assertEquals(r.upFiles[0].text.includes("credentials"), false);
  assertEquals(r.lines.join("\n").includes(SECRET), false);
  assertEquals(r.secrets.includes(SECRET), true);
});

test("host-level approval alone never allows a share", async () => {
  const r = await deployWithShare(
    { hostLevelApproved: true },
    shareVolume(),
  );
  assertStringIncludes(
    r.error?.message ?? "",
    "network shares must be allowed for this server",
  );
  assertEquals(r.smbCalls, 0);
  assertEquals(r.order, []);
});

test("a login with a comma is refused before anything starts", async () => {
  const r = await deployWithShare(
    {
      ...LOGIN,
      variableMaterial: [{
        ...LOGIN.variableMaterial[0],
        valueEnvelope: "sealed:a,b",
      }],
    },
    {},
    false,
    true,
  );
  assertStringIncludes(r.error?.message ?? "", "comma");
  assertEquals(r.order, []);
});

test("sealed logins without the allow flag are refused before anything is written", async () => {
  const r = await deployWithShare(
    { ...LOGIN, allowNetworkShares: false },
    {},
    false,
    true,
  );
  assertStringIncludes(
    r.error?.message ?? "",
    "network shares must be allowed",
  );
  assertEquals(r.order, []);
  assertEquals(r.upFiles, []);
});

test("a password written in compose text is refused even with a login supplied", async () => {
  const r = await deployWithShare(
    {
      ...LOGIN,
      composeFiles: [{
        ...LOGIN.composeFiles[0],
        content: COMPOSE_WITH_SHARE.replace(
          "username=svc",
          `username=svc,password=${SECRET}`,
        ),
      }],
    },
    {},
    false,
    true,
  );
  assertStringIncludes(r.error?.message ?? "", "password");
  assertEquals((r.error?.message ?? "").includes(SECRET), false);
  assertEquals(r.order, []);
});

test("a share name that resolves to this server is refused before anything starts", async () => {
  const r = await deployWithShare(
    { allowNetworkShares: true, ...{ composeFiles: LOGIN.composeFiles } },
    {},
    false,
    true,
    targets({ "files.example.net": "127.0.0.1" }),
  );
  assertStringIncludes(r.error?.message ?? "", "resolves to 127.0.0.1");
  assertEquals(r.order, []);
});

test("a share name that does not resolve is refused before anything starts", async () => {
  const r = await deployWithShare(
    { allowNetworkShares: true, ...{ composeFiles: LOGIN.composeFiles } },
    {},
    false,
    true,
    targets({}),
  );
  assertStringIncludes(r.error?.message ?? "", "could not be resolved");
  assertEquals(r.order, []);
});

test("an allowed share is published pinned to the address that was checked", async () => {
  const r = await deployWithShare(
    { allowNetworkShares: true, ...{ composeFiles: LOGIN.composeFiles } },
    {},
    false,
    true,
  );
  assertEquals(r.error, null);
  const doc = parse(r.upFiles[0].text) as {
    volumes: Record<string, { driver_opts: { o: string; device: string } }>;
  };
  assertEquals(
    doc.volumes.media.driver_opts.o,
    "username=svc,vers=3.1.1,addr=192.0.2.10",
  );
  assertEquals(
    doc.volumes.media.driver_opts.device,
    "//192.0.2.10/media",
  );
});
