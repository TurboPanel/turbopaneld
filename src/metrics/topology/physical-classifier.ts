/**
 * Physical-vs-VM determination via DMI vendor strings and the `/sys/
 * hypervisor/type` marker. This is the sole enforcement point for
 * "GPU presence never activates physical classification" — this module has
 * no dependency on `gpu-topology.ts` (or anything GPU-related) and
 * `topology.ts` calls both as independent siblings.
 *
 * `hardwareSignals` in a `TopologySnapshot` is always `[]` unless
 * {@link isPhysicalMachine} returns `true` — a VM never reports fabricated
 * PSU/voltage/chassis-fan signals just because a passthrough GPU is present.
 */
import type { IdentityIo } from "./identity.ts";

/** Case-insensitive substrings of `/sys/class/dmi/id/sys_vendor` that mark a hypervisor guest. */
const VM_VENDOR_MARKERS: readonly string[] = [
  "qemu",
  "kvm",
  "vmware",
  "microsoft corporation",
  "xen",
  "digitalocean",
  "virtualbox",
  "innotek",
  "bochs",
  "parallels",
  "google",
  "amazon ec2",
  "openstack",
  "nutanix",
];

export type PhysicalClassifierDeps = {
  readFile: IdentityIo["readFile"];
  sysRoot?: string;
};

/**
 * `true` when this host looks like bare metal: no `/sys/hypervisor/type`
 * marker, and `sys_vendor` doesn't match a known hypervisor vendor string.
 * Defaults to physical when DMI is unreadable (containers/some ARM boards
 * lack `/sys/class/dmi` entirely and are not VMs in the sense this
 * classifier cares about).
 */
export async function isPhysicalMachine(
  deps: PhysicalClassifierDeps,
): Promise<boolean> {
  const root = deps.sysRoot ?? "/sys";
  const [hypervisorType, sysVendorRaw] = await Promise.all([
    deps.readFile(`${root}/hypervisor/type`),
    deps.readFile(`${root}/class/dmi/id/sys_vendor`),
  ]);
  if (hypervisorType !== undefined) return false;

  const sysVendor = sysVendorRaw?.trim().toLowerCase();
  if (!sysVendor) return true;
  return !VM_VENDOR_MARKERS.some((marker) => sysVendor.includes(marker));
}
