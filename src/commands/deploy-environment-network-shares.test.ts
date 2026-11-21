import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
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
        o: `username=svc,password=${SECRET},vers=3.1.1`,
        ...extra,
      },
    },
  };
}

/** One real deploy whose resolved model carries an SMB share volume. */
async function deployWithShare(
  payloadExtra: { allowNetworkShares?: boolean },
  volumes: Record<string, unknown>,
  smbFails = false,
) {
  const root = await Deno.makeTempDir({ prefix: "tp-deploy-shares-" });
  const previous = {
    state: Deno.env.get("TURBOPANEL_STATE_DIR"),
    config: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
  };
  Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
  Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
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
  const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
    if (args.includes("config") && args.includes("--format")) {
      return ok(JSON.stringify({
        services: { web: { image: "nginx:alpine" } },
        volumes,
      }));
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
    await Deno.remove(root, { recursive: true });
  }
  return { error, lines, secrets, order, smbCalls };
}

test("an allowed share installs the helper before compose up and never logs the password", async () => {
  const r = await deployWithShare({ allowNetworkShares: true }, shareVolume());
  assertEquals(r.error, null);
  assertEquals(r.order, ["smb", "up"]);
  assertEquals(r.secrets, [SECRET]);
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
    shareVolume({ o: `password=${SECRET},suid` }),
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
