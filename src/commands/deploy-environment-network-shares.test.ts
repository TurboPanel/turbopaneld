import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { RUNTIME_COMPOSE_FILENAME } from "../deploy/compose-files.ts";
import type { CommandOutputSink } from "../logs/contracts.ts";
import { handleEnvironmentDeploy } from "./deploy-environment.ts";
import "../testing/stub-hosting-caddy-host.ts";
import { instantlyHealthy } from "../testing/instant-health-gate.ts";

const test = Deno.test.bind(Deno);

const SECRET = "hunter2-share-pw";

function shareVolume(extra: Record<string, unknown> = {}) {
  return {
    media: {
      driver: "local",
      driver_opts: {
        type: "cifs",
        device: "//files.example.net/media",
        o: "username=svc,vers=3.1.1",
        ...extra,
      },
    },
  };
}

/** One real deploy whose resolved model carries an SMB share volume. */
async function deployWithShare(
  payloadExtra: Record<string, unknown>,
  volumes: Record<string, unknown>,
  smbFails = false,
  fromYaml = false,
) {
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
  const credentialFiles: string[] = [];
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
      const dir = join(
        root,
        "run",
        "deployments",
        "proj-shares",
        "envshares",
        "smb",
      );
      try {
        for await (const item of Deno.readDir(dir)) {
          credentialFiles.push(await Deno.readTextFile(join(dir, item.name)));
        }
      } catch { /* no folder */ }
    }
    if (args.includes("up")) order.push("up");
    return ok();
  };
  let error: Error | null = null;
  let smbCalls = 0;
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
    await Deno.remove(root, { recursive: true });
  }
  return {
    error,
    lines,
    secrets,
    order,
    smbCalls,
    credentialFiles,
    resolvedYamls,
  };
}

test("an allowed share installs the helper before compose up and never logs the password", async () => {
  const r = await deployWithShare({ allowNetworkShares: true }, shareVolume());
  assertEquals(r.error, null);
  assertEquals(r.order, ["smb", "up"]);
  const text = r.lines.join("\n");
  assertStringIncludes(text, "//files.example.net/media");
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

test("a sealed login becomes a credentials file the volume points at, never compose text", async () => {
  const r = await deployWithShare(
    {
      ...LOGIN,
      networkShareCredentials: [{
        ...LOGIN.networkShareCredentials[0],
        username: "svc",
      }],
    },
    {},
    false,
    true,
  );
  assertEquals(r.error, null);
  assertEquals(r.order, ["smb", "up"]);
  assertEquals(r.credentialFiles, [`username=svc\npassword=${SECRET}\n`]);
  for (const text of r.resolvedYamls) {
    assertEquals(text.includes(SECRET), false);
    assertStringIncludes(text, "credentials=");
  }
  assertEquals(r.lines.join("\n").includes(SECRET), false);
  assertEquals(r.secrets.includes(SECRET), true);
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
  assertEquals(r.credentialFiles, []);
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
