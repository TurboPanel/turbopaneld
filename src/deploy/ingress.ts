import { join } from "@std/path";
import { logWarn } from "../logger.ts";
import type { EnvironmentDeployPayload } from "../instance/commands/contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { runDocker } from "./docker-cli.ts";
import { ensureHostingCaddy } from "./ensure-hosting-caddy.ts";

const INGRESS_NETWORK = "turbopanel-ingress";
const CADDY_SERVICE = "turbopanel-hosting-caddy.service";
const SAFE_FILE_ID_RE = /^[A-Za-z0-9_-]+$/;
const decoder = new TextDecoder();

type CommandResult = {
  success: boolean;
  stderr: string;
};

async function run(
  command: string,
  args: string[],
): Promise<CommandResult> {
  const result = await new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stderr: decoder.decode(result.stderr).trim(),
  };
}

function commandError(action: string, result: CommandResult): Error {
  return new Error(result.stderr || `${action} failed`);
}

async function ensureIngressNetwork(): Promise<void> {
  const inspect = await runDocker(["network", "inspect", INGRESS_NETWORK]);
  if (inspect.success) return;

  const create = await runDocker(["network", "create", INGRESS_NETWORK]);
  if (!create.success) {
    throw commandError("Creating ingress Docker network", create);
  }
}

function traefikCompose(): string {
  return `services:
  traefik:
    image: traefik:v3.3
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=${INGRESS_NETWORK}
      - --entrypoints.web.address=:80
    ports:
      - 127.0.0.1:8080:80
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - ${INGRESS_NETWORK}
networks:
  ${INGRESS_NETWORK}:
    external: true
`;
}

function caddyfile(configDir: string): string {
  return `{
  auto_https off
}
import ${join(configDir, "hosting", "sites", "*.caddy")}
`;
}

function caddyUnit(layout: LayoutPaths): string {
  const caddy = join(layout.runtimesDir, "caddy", "current", "caddy");
  const configDir = join(layout.configDir, "hosting");
  return `[Unit]
Description=TurboPanel hosting Caddy ingress
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${configDir}
ExecStart=${caddy} run --config ${
    join(configDir, "Caddyfile")
  } --adapter caddyfile
ExecReload=${caddy} reload --config ${
    join(configDir, "Caddyfile")
  } --adapter caddyfile
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}

async function installAndStartCaddy(
  unitSource: string,
): Promise<boolean> {
  const install = await run("sudo", [
    "-n",
    "install",
    "-m",
    "0640",
    unitSource,
    join("/etc/systemd/system", CADDY_SERVICE),
  ]);
  if (!install.success) {
    logWarn("deploy", `hosting Caddy unit not installed: ${install.stderr}`);
    return false;
  }

  const daemonReload = await run("sudo", ["-n", "systemctl", "daemon-reload"]);
  if (!daemonReload.success) {
    logWarn(
      "deploy",
      `hosting Caddy daemon-reload failed: ${daemonReload.stderr}`,
    );
    return false;
  }
  const enable = await run("sudo", [
    "-n",
    "systemctl",
    "enable",
    "--now",
    CADDY_SERVICE,
  ]);
  if (!enable.success) {
    logWarn("deploy", `hosting Caddy start failed: ${enable.stderr}`);
    return false;
  }
  return true;
}

export async function ensureHostingIngress(layout: LayoutPaths): Promise<void> {
  await ensureIngressNetwork();

  const ingressDir = join(layout.stateDir, "ingress", "traefik");
  await Deno.mkdir(ingressDir, { recursive: true, mode: 0o750 });
  const composePath = join(ingressDir, "docker-compose.yml");
  await Deno.writeTextFile(composePath, traefikCompose(), { mode: 0o640 });
  const composeUp = await runDocker([
    "compose",
    "-p",
    "turbopanel-ingress",
    "-f",
    composePath,
    "up",
    "-d",
    "--remove-orphans",
  ]);
  if (!composeUp.success) {
    throw commandError("Starting Traefik ingress", composeUp);
  }

  await ensureHostingCaddy(layout);
  const hostingDir = join(layout.configDir, "hosting");
  const sitesDir = join(hostingDir, "sites");
  await Deno.mkdir(sitesDir, { recursive: true, mode: 0o750 });
  await Deno.writeTextFile(
    join(sitesDir, "00-empty.caddy"),
    "# Hosting routes are written per environment.\n",
    { mode: 0o640 },
  );
  await Deno.writeTextFile(
    join(hostingDir, "Caddyfile"),
    caddyfile(layout.configDir),
    {
      mode: 0o640,
    },
  );
  const unitSource = join(hostingDir, CADDY_SERVICE);
  await Deno.writeTextFile(unitSource, caddyUnit(layout), { mode: 0o640 });

  // A non-root daemon cannot install a system unit. Keep the generated config
  // so test and dev environments can grant sudo later without redeploying.
  await installAndStartCaddy(unitSource);
}

function siteSnippet(
  hostname: string,
  tlsId: string | undefined,
  tlsDir: string,
): string {
  const tlsLine = tlsId
    ? `  tls ${join(tlsDir, tlsId, "fullchain.pem")} ${
      join(tlsDir, tlsId, "privkey.pem")
    }`
    : "  tls internal";

  return `http://${hostname} {
  reverse_proxy 127.0.0.1:8080
}

${hostname} {
${tlsLine}
  reverse_proxy 127.0.0.1:8080
}
`;
}

export async function rewriteHostingCaddySites(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
  hostnameTls?: Map<string, string>,
): Promise<void> {
  if (!SAFE_FILE_ID_RE.test(payload.environmentId)) {
    throw new Error("environmentId contains unsupported characters");
  }

  const sitesDir = join(layout.configDir, "hosting", "sites");
  await Deno.mkdir(sitesDir, { recursive: true, mode: 0o750 });
  const hostnames = [
    ...new Set(payload.hostings.flatMap((hosting) => hosting.hostnames)),
  ]
    .sort((a, b) => a.localeCompare(b));
  await Deno.writeTextFile(
    join(sitesDir, `${payload.environmentId}.caddy`),
    hostnames
      .map((hostname) =>
        siteSnippet(hostname, hostnameTls?.get(hostname), layout.tlsDir)
      )
      .join("\n"),
    { mode: 0o640 },
  );

  const reload = await run("sudo", [
    "-n",
    "systemctl",
    "reload",
    CADDY_SERVICE,
  ]);
  if (!reload.success) {
    logWarn("deploy", `hosting Caddy reload skipped: ${reload.stderr}`);
  }
}
