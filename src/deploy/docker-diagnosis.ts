/**
 * Why the Docker Engine API is still unreachable after docker-setup.
 *
 * The generic "is the daemon user in the docker group?" hint sent operators
 * after the wrong cause: on a real host the daemon user *was* in the group and
 * Docker itself was down (systemd `start-limit-hit` after a burst of
 * restarts). This names the actual cause, in the order that matters:
 *
 *   1. docker.service is not active — report its ActiveState/Result.
 *   2. The daemon user is not in the `docker` group at all.
 *   3. The user is in the group but this process started before it was added,
 *      so its supplementary groups are stale (a running process never gains
 *      new groups). `runDocker` normally side-steps this with a self-sudo, so
 *      reaching here means that rung was refused too — restart the daemon.
 *   4. Otherwise, Docker's own error.
 *
 * Pure parsers are exported for tests; host reads go through `DockerDiagnosisIo`.
 */

export type DockerServiceState = {
  activeState: string;
  result: string;
};

export type DockerDiagnosisIo = {
  /** `systemctl show docker.service -p ActiveState -p Result` output. */
  systemctlShow: () => Promise<string>;
  /** `/proc/self/status` text. */
  readProcStatus: () => Promise<string>;
  /** `/etc/group` text. */
  readGroupFile: () => Promise<string>;
  /** The daemon's login name. */
  username: () => Promise<string>;
};

/** `KEY=value` lines → the two properties we ask systemctl for. */
export function parseSystemctlShow(text: string): DockerServiceState {
  const props = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return {
    activeState: props.get("ActiveState") ?? "",
    result: props.get("Result") ?? "",
  };
}

/** Supplementary group ids from the `Groups:` line of `/proc/<pid>/status`. */
export function parseProcessGroups(statusText: string): number[] {
  const line = statusText.split("\n").find((l) => l.startsWith("Groups:"));
  if (!line) return [];
  return line
    .slice("Groups:".length)
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => Number.isInteger(n));
}

/** The `docker` group's gid and members from `/etc/group`, or null when absent. */
export function parseDockerGroup(
  groupText: string,
): { gid: number; members: string[] } | null {
  for (const line of groupText.split("\n")) {
    const [name, , gid, members] = line.split(":");
    if (name !== "docker" || gid === undefined) continue;
    const parsed = Number(gid);
    if (!Number.isInteger(parsed)) return null;
    const list = (members ?? "").split(",").map((m) => m.trim()).filter((m) =>
      m
    );
    return { gid: parsed, members: list };
  }
  return null;
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/** The operator-facing explanation; never throws. */
export function explainDockerUnreachable(input: {
  service: DockerServiceState | null;
  processGroups: number[];
  dockerGroup: { gid: number; members: string[] } | null;
  username: string;
  probeStderr: string;
}): string {
  const { service, processGroups, dockerGroup, username, probeStderr } = input;
  if (service && service.activeState && service.activeState !== "active") {
    const result = service.result && service.result !== "success"
      ? `, Result=${service.result}`
      : "";
    const lockout = service.result === "start-limit-hit"
      ? " — systemd stopped retrying after repeated restarts"
      : "";
    return `Docker service is not running (ActiveState=${service.activeState}${result})${lockout}; check \`journalctl -u docker\``;
  }
  if (dockerGroup && username && !dockerGroup.members.includes(username)) {
    return `Docker Engine API unreachable: ${username} is not in the docker group`;
  }
  if (dockerGroup && !processGroups.includes(dockerGroup.gid)) {
    return `Docker Engine API unreachable: turbopaneld is running without the docker group (gid ${dockerGroup.gid}) that ${username} was added to — restart the daemon (systemctl restart turbopaneld) to pick it up`;
  }
  const detail = firstLine(probeStderr);
  return `Docker Engine API still unreachable after docker-setup${
    detail ? `: ${detail}` : ""
  }`;
}

async function readText(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

async function systemctlShowDefault(): Promise<string> {
  try {
    const out = await new Deno.Command("systemctl", {
      args: ["show", "docker.service", "-p", "ActiveState", "-p", "Result"],
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(out.stdout);
  } catch {
    return "";
  }
}

async function usernameDefault(): Promise<string> {
  const fromEnv = Deno.env.get("USER")?.trim() ||
    Deno.env.get("LOGNAME")?.trim();
  if (fromEnv) return fromEnv;
  try {
    const out = await new Deno.Command("/usr/bin/id", {
      args: ["-un"],
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(out.stdout).trim();
  } catch {
    return "";
  }
}

const defaultIo: DockerDiagnosisIo = {
  systemctlShow: systemctlShowDefault,
  readProcStatus: () => readText("/proc/self/status"),
  readGroupFile: () => readText("/etc/group"),
  username: usernameDefault,
};

/** Read the host and explain why Docker is unreachable. */
export async function diagnoseDockerUnreachable(
  probeStderr: string,
  io: DockerDiagnosisIo = defaultIo,
): Promise<string> {
  const [showText, statusText, groupText, username] = await Promise.all([
    io.systemctlShow(),
    io.readProcStatus(),
    io.readGroupFile(),
    io.username(),
  ]);
  return explainDockerUnreachable({
    service: showText ? parseSystemctlShow(showText) : null,
    processGroups: parseProcessGroups(statusText),
    dockerGroup: parseDockerGroup(groupText),
    username,
    probeStderr,
  });
}
