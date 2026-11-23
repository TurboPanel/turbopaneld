import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "yaml";
import { copyMountArg } from "../backups/copy-backup.ts";
import { dockerProxyCompose } from "../deploy/ingress.ts";
import {
  ORCHESTRATOR_COMPOSE_SERVICE_NAME,
  SYSTEM_MANAGED_HA_COMPONENT,
  type SystemComponentDescriptor,
} from "../deploy/system-component.ts";
import { volumeMountArgs } from "./engines/standby-probe.ts";
import { orchestratorCompose } from "./orchestrator.ts";
import { proxysqlCompose } from "./proxysql.ts";

const test = Deno.test.bind(Deno);

const NETWORK = "00000000-0000-4000-8000-0000000000ee";
const HA: SystemComponentDescriptor = {
  component: SYSTEM_MANAGED_HA_COMPONENT,
  serviceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  composeServiceName: ORCHESTRATOR_COMPOSE_SERVICE_NAME,
  containerName: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-ha",
  role: "turbopanel",
};

/** Every short-form `volumes:` entry of every service in a compose document. */
function serviceMounts(yaml: string): string[] {
  const document = parseYaml(yaml) as {
    services: Record<string, { volumes?: unknown[] }>;
  };
  return Object.values(document.services).flatMap((service) =>
    (service.volumes ?? []).map((entry) => String(entry))
  );
}

function assertModeStated(mounts: readonly string[]): void {
  assert(mounts.length > 0, "the compose file mounts something");
  for (const mount of mounts) {
    assert(/:(ro|rw)$/.test(mount), `mount states rw or ro: ${mount}`);
  }
}

test("generated system compose files state a mode on every mount", () => {
  assertModeStated(serviceMounts(proxysqlCompose(null, [], [], null, NETWORK)));
  assertModeStated(serviceMounts(dockerProxyCompose(NETWORK)));
  assertModeStated(serviceMounts(orchestratorCompose(HA, {
    nodeId: "00000000-0000-4000-8000-0000000000ab",
    advertiseAddress: "203.0.113.10",
    httpPort: 33001,
    raftPort: 33002,
    peers: [],
  }, NETWORK)));
});

test("helper container mount arguments state a mode", () => {
  const args = volumeMountArgs([{ name: "data", target: "/var/lib/data" }]);
  assertEquals(args, ["-v", "data:/var/lib/data:rw"]);
  assertEquals(
    copyMountArg({ type: "volume", name: "v" }, "/dst", false),
    "type=volume,src=v,dst=/dst,readonly=false",
  );
  assertEquals(
    copyMountArg({ type: "volume", name: "v" }, "/src", true),
    "type=volume,src=v,dst=/src,readonly=true",
  );
});

const MODE_END = /:(ro|rw)(`|"|'|\}\})?,?$/;

async function sourceFiles(
  dir: string,
  extensions: readonly string[],
  skipTests: boolean,
): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (entry.name === "testdata" || entry.name === "node_modules") continue;
      found.push(...await sourceFiles(path, extensions, skipTests));
    } else if (
      extensions.some((ext) => entry.name.endsWith(ext)) &&
      !(skipTests && /\.test\.ts$/.test(entry.name))
    ) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Docker `-v` argument sites: a line that is only the `-v` flag (TS argv
 * array or Ansible list item), whose next line is the mount spec. psql's own
 * `-v ON_ERROR_STOP=1` variable flag is not a mount.
 */
function findUnmodedVolumeArgs(path: string, text: string): string[] {
  const lines = text.split("\n");
  const bad: string[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\s*(- )?["']?-v["']?,?$/.test(lines[i])) continue;
    const spec = lines[i + 1].trim();
    if (/ON_ERROR_STOP/.test(spec)) continue;
    if (!MODE_END.test(spec)) bad.push(`${path}:${i + 2}: ${spec}`);
  }
  return bad;
}

test("every docker -v argument in the daemon source and Ansible roles states a mode", async () => {
  const files = [
    ...await sourceFiles("src", [".ts"], true),
    ...await sourceFiles(
      "orchestration",
      [".yml", ".yaml", ".j2", ".sh"],
      true,
    ),
  ];
  assert(files.length > 50, "the scan sees the source tree");
  const bad: string[] = [];
  for (const path of files) {
    bad.push(...findUnmodedVolumeArgs(path, await Deno.readTextFile(path)));
  }
  assertEquals(bad, []);
});

test("every compose volumes list in the Ansible roles states a mode", async () => {
  const files = await sourceFiles(
    "orchestration",
    [".yml", ".yaml", ".j2"],
    true,
  );
  const bad: string[] = [];
  let scanned = 0;
  for (const path of files) {
    const lines = (await Deno.readTextFile(path)).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const header = /^(\s*)volumes:\s*$/.exec(lines[i]);
      if (!header) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const entry = /^(\s*)- (.*)$/.exec(lines[j]);
        if (!entry || entry[1].length <= header[1].length) break;
        // Only short-form mount strings carry a mode; `pgdata:` style top-level
        // volume declarations are maps, not list items.
        if (!entry[2].includes(":")) continue;
        scanned++;
        if (!MODE_END.test(entry[2].trim())) bad.push(`${path}:${j + 1}`);
      }
    }
  }
  assert(scanned > 0, "the scan sees at least one compose volumes list");
  assertEquals(bad, []);
});

test("the scan flags a -v argument without a mode", () => {
  const sample = ['    "-v",', "    `${dir}:/data`,"].join("\n");
  assertEquals(findUnmodedVolumeArgs("x.ts", sample).length, 1);
  assertEquals(
    findUnmodedVolumeArgs(
      "x.ts",
      ['    "-v",', "    `${dir}:/data:ro`,"].join("\n"),
    ),
    [],
  );
});
