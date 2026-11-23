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
