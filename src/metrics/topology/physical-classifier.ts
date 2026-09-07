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
/**
 * `sys_vendor` values that only ever appear on a hypervisor, matched as a
 * substring. Every entry here must be unambiguous: a bare-metal machine
 * misclassified as virtual silently loses **every** hardware signal, because
 * `physicalHardwareSignalSlots` is 0 for a VM.
 */
const VM_VENDOR_MARKERS: readonly string[] = [
  "qemu",
  "kvm",
  "vmware",
  "xen",
  "digitalocean",
  "virtualbox",
  "innotek",
  "bochs",
  "parallels",
  "amazon ec2",
  "openstack",
  "nutanix",
];

/**
 * Vendors that ship *both* hypervisors and real hardware, so `sys_vendor`
 * alone cannot decide. v4 substring-matched `"google"` and
 * `"microsoft corporation"` here, which misclassified bare-metal Surface
 * and Google-branded boards as VMs and silently dropped all their sensors.
 * These require a corroborating `product_name` marker before demoting.
 */
const AMBIGUOUS_VM_VENDOR_MARKERS: readonly string[] = [
  "google",
  "microsoft corporation",
];

/** `product_name` values that confirm a virtual machine from an ambiguous vendor. */
const VM_PRODUCT_MARKERS: readonly string[] = [
  "google compute engine",
  "virtual machine",
  "hyper-v",
];

export type PhysicalClassifierDeps = {
  readFile: IdentityIo["readFile"];
  sysRoot?: string;
};

/**
 * `true` when this host looks like bare metal: no `/sys/hypervisor/type`
 * marker, and `sys_vendor` doesn't match a known hypervisor vendor string.
 * Vendors that sell both hypervisors and hardware additionally need a
 * matching `product_name` before the host is demoted to virtual — see
 * {@link AMBIGUOUS_VM_VENDOR_MARKERS}.
 * Defaults to physical when DMI is unreadable (containers/some ARM boards
 * lack `/sys/class/dmi` entirely and are not VMs in the sense this
 * classifier cares about).
 */
export async function isPhysicalMachine(
  deps: PhysicalClassifierDeps,
): Promise<boolean> {
  const root = deps.sysRoot ?? "/sys";
  const [hypervisorType, sysVendorRaw, productNameRaw] = await Promise.all([
    deps.readFile(`${root}/hypervisor/type`),
    deps.readFile(`${root}/class/dmi/id/sys_vendor`),
    deps.readFile(`${root}/class/dmi/id/product_name`),
  ]);
  if (hypervisorType !== undefined) return false;

  const sysVendor = sysVendorRaw?.trim().toLowerCase();
  if (!sysVendor) return true;
  if (VM_VENDOR_MARKERS.some((marker) => sysVendor.includes(marker))) {
    return false;
  }
  if (
    AMBIGUOUS_VM_VENDOR_MARKERS.some((marker) => sysVendor.includes(marker))
  ) {
    const productName = productNameRaw?.trim().toLowerCase() ?? "";
    return !VM_PRODUCT_MARKERS.some((marker) => productName.includes(marker));
  }
  return true;
}
