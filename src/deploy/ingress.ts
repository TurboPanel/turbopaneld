import { join } from "@std/path";
import { logWarn } from "../logger.ts";
import type { EnvironmentDeployPayload } from "../instance/commands/contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { runDocker } from "./docker-cli.ts";
import { ensureHostingCaddy } from "./ensure-hosting-caddy.ts";

const INGRESS_NETWORK = "turbopanel-ingress";
const CADDY_SERVICE = "turbopanel-hosting-caddy.service";
const TRAEFIK_IMAGE = "traefik:v3.6.6";
const TRAEFIK_LOOPBACK = "127.0.0.1";
const TRAEFIK_HTTP_PORT = 7080;
const TRAEFIK_HTTPS_PORT = 7443;
const SAFE_FILE_ID_RE = /^[A-Za-z0-9_-]+$/;
const decoder = new TextDecoder();

export function caddyTraefikUpstream(hop: "http" | "https"): string {
  if (hop === "http") {
    return `reverse_proxy ${TRAEFIK_LOOPBACK}:${TRAEFIK_HTTP_PORT} {
  transport http {
    proxy_protocol v2
    keepalive off
    versions h2c
  }
}`;
  }
  return `reverse_proxy ${TRAEFIK_LOOPBACK}:${TRAEFIK_HTTPS_PORT} {
  transport http {
    proxy_protocol v2
    keepalive off
    versions 2
    tls
    tls_insecure_skip_verify
  }
}`;
}

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

export function traefikCompose(): string {
  return `services:
  traefik:
    image: ${TRAEFIK_IMAGE}
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=${INGRESS_NETWORK}
      - --entrypoints.web.address=:${TRAEFIK_HTTP_PORT}
      - --entrypoints.web.proxyProtocol.insecure=true
      - --entrypoints.websecure.address=:${TRAEFIK_HTTPS_PORT}
      - --entrypoints.websecure.proxyProtocol.insecure=true
      - --entrypoints.websecure.http.tls=true
    ports:
      - ${TRAEFIK_LOOPBACK}:${TRAEFIK_HTTP_PORT}:${TRAEFIK_HTTP_PORT}
      - ${TRAEFIK_LOOPBACK}:${TRAEFIK_HTTPS_PORT}:${TRAEFIK_HTTPS_PORT}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - ${INGRESS_NETWORK}

networks:
  ${INGRESS_NETWORK}:
    external: true
`;
}

export function caddyfile(configDir: string): string {
  return `{
  auto_https off
  servers {
    protocols h1 h2 h3
  }
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
  await Deno.writeTextFile(composePath, traefikCompose(), {
    mode: 0o640,
  });
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
  forceHttps = true,
): string {
  const httpUpstream = caddyTraefikUpstream("http");
  const httpsUpstream = caddyTraefikUpstream("https");
  const tlsLine = tlsId
    ? `  tls ${join(tlsDir, tlsId, "fullchain.pem")} ${
      join(tlsDir, tlsId, "privkey.pem")
    }`
    : "  tls internal";

  const httpBlock = forceHttps
    ? `http://${hostname} {
  redir https://{host}{uri} permanent
}

`
    : `http://${hostname} {
  ${httpUpstream}
}

`;

  const httpsBlock = forceHttps
    ? `${hostname} {
${tlsLine}
  ${httpsUpstream}
}
`
    : "";

  return httpBlock + httpsBlock;
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

  const hostnameForceHttps = new Map<string, boolean>();
  for (const hosting of payload.hostings) {
    const forceHttps = hosting.proxy?.forceHttps ?? true;
    for (const hostname of hosting.hostnames) {
      hostnameForceHttps.set(hostname, forceHttps);
    }
  }

  const hostnames = [...hostnameForceHttps.keys()].sort((a, b) =>
    a.localeCompare(b)
  );
  const siteContent = hostnames
    .map((hostname) =>
      siteSnippet(
        hostname,
        hostnameTls?.get(hostname),
        layout.tlsDir,
        hostnameForceHttps.get(hostname) ?? true,
      )
    )
    .join("\n");
  await Deno.writeTextFile(
    join(sitesDir, `${payload.environmentId}.caddy`),
    siteContent,
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

/** Remove the per-environment hosting site snippet and best-effort reload Caddy. */
export async function removeHostingCaddySite(
  layout: LayoutPaths,
  environmentId: string,
): Promise<void> {
  if (!SAFE_FILE_ID_RE.test(environmentId)) {
    throw new Error("environmentId contains unsupported characters");
  }

  const sitePath = join(
    layout.configDir,
    "hosting",
    "sites",
    `${environmentId}.caddy`,
  );
  try {
    await Deno.remove(sitePath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }

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
