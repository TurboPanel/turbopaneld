import { assertEquals, assertNotEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { defaultSensorIo } from "../collector/sensors/discovery.ts";
import {
  deriveBlockDeviceIdentity,
  deriveFilesystemId,
  deriveNetworkDeviceId,
  deriveNetworkDeviceIdentity,
} from "./identity.ts";

const test = Deno.test.bind(Deno);

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`./testdata/${name}`, import.meta.url));
}

test("deriveNetworkDeviceIdentity: same MAC under a different interface name resolves to the same deviceId", async () => {
  const io = defaultSensorIo();
  const root = fixtureRoot("net-topology");
  const eth0 = await deriveNetworkDeviceIdentity("eth0", io, root);
  const eth1 = await deriveNetworkDeviceIdentity("eth1", io, root);
  assertEquals(eth0.deviceId, eth1.deviceId);
  assertEquals(eth0.identity.mac, "aa:bb:cc:dd:ee:01");
});

test("deriveNetworkDeviceIdentity: loopback (all-zero MAC, no PCI) falls back to a stable virtual-key hash", async () => {
  const io = defaultSensorIo();
  const root = fixtureRoot("net-topology");
  const first = await deriveNetworkDeviceId("lo", io, root);
  const second = await deriveNetworkDeviceId("lo", io, root);
  assertEquals(first, second);
  assertEquals(first.startsWith("virtual:"), true);
});

test("deriveNetworkDeviceIdentity: distinct devices with distinct MACs get distinct ids", async () => {
  const io = defaultSensorIo();
  const root = fixtureRoot("net-topology-hotplug");
  const eth0 = await deriveNetworkDeviceId("eth0", io, root);
  const eth2 = await deriveNetworkDeviceId("eth2", io, root);
  assertNotEquals(eth0, eth2);
});

test("deriveBlockDeviceIdentity: prefers model+serial when no WWN is present", async () => {
  const io = defaultSensorIo();
  const root = fixtureRoot("block-graph-nvme");
  const identity = await deriveBlockDeviceIdentity("nvme0n1", io, root);
  assertEquals(identity.deviceId, "disk:NVMe SSD Model A:NVME-SERIAL-1");
});

test("deriveBlockDeviceIdentity: falls back to a major:minor hash when no model/serial/WWN resolves", async () => {
  const io = defaultSensorIo();
  const root = fixtureRoot("block-graph-nvme");
  const identity = await deriveBlockDeviceIdentity("nvme0n1p1", io, root);
  assertEquals(identity.deviceId.startsWith("blk:"), true);
});

test("deriveFilesystemId: same source device, different mountpoints, resolves to the same id", async () => {
  const io = defaultSensorIo();
  const root = fixtureRoot("net-topology");
  const rootFs = await deriveFilesystemId(
    { sourceDevice: "/dev/sda1", deviceName: "sda1", mountpoint: "/" },
    io,
    root,
  );
  const dockerFs = await deriveFilesystemId(
    {
      sourceDevice: "/dev/sda1",
      deviceName: "sda1",
      mountpoint: "/var/lib/docker",
    },
    io,
    root,
  );
  assertEquals(rootFs, dockerFs);
});

test("deriveFilesystemId: falls back to the normalized mountpoint when no backing device resolves", async () => {
  const io = defaultSensorIo();
  const root = fixtureRoot("net-topology");
  const id = await deriveFilesystemId(
    { sourceDevice: null, deviceName: null, mountpoint: "/tmp" },
    io,
    root,
  );
  assertEquals(id, "fs:path:/tmp");
});

test("deriveNetworkDeviceIdentity: an enslaved port identifies by its permanent hardware MAC, not the bond MAC it currently advertises", async () => {
  const io = defaultSensorIo();
  const root = fixtureRoot("net-topology-bond");
  const eth0 = await deriveNetworkDeviceIdentity("eth0", io, root);
  const eth1 = await deriveNetworkDeviceIdentity("eth1", io, root);
  assertEquals(eth0.deviceId, "mac:aa:bb:cc:00:00:01");
  assertEquals(eth1.deviceId, "mac:aa:bb:cc:00:00:02");
  assertEquals(eth1.identity.pciPath, "0000:01:00.1");
});

test("deriveNetworkDeviceIdentity: software devices never identify by MAC even when they carry one", async () => {
  const io = defaultSensorIo();
  const root = fixtureRoot("net-topology-bridge-over-bond");
  const ids = await Promise.all(
    ["eth0", "bond0", "bond0.5", "vmbr0"].map((name) =>
      deriveNetworkDeviceId(name, io, root)
    ),
  );
  assertEquals(ids[0], "mac:aa:bb:cc:11:00:01");
  for (const id of ids.slice(1)) assertEquals(id.startsWith("virtual:"), true);
  assertEquals(new Set(ids).size, ids.length);
});

test("deriveNetworkDeviceIdentity: a bare Ethernet device (container veth peer) keeps its mac: id only when the caller asks for MAC identity", async () => {
  const io = defaultSensorIo();
  const root = fixtureRoot("net-topology-container");
  const asUplink = await deriveNetworkDeviceIdentity("eth0", io, root, {
    macIdentity: true,
  });
  const asSoftware = await deriveNetworkDeviceIdentity("eth0", io, root);
  assertEquals(asUplink.deviceId, "mac:0a:1b:2c:3d:4e:5f");
  assertEquals(asUplink.identity.pciPath, undefined);
  assertEquals(asSoftware.deviceId.startsWith("virtual:"), true);
});
