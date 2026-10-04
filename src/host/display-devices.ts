/**
 * Display devices that are not GPUs worth monitoring: emulated/paravirtual
 * adapters (QEMU bochs/std-vga, virtio-gpu, QXL, VMware SVGA, VirtualBox,
 * Hyper-V), firmware framebuffers, and server BMC VGA cores (ASPEED `ast`,
 * Matrox `mgag200`). None of them expose utilization, VRAM, temperature or
 * power, so they are left out of the host GPU inventory and the metrics GPU
 * topology — an entity that can only ever report `null` still costs an
 * Analytics Engine row and three `hardware.physical` signal slots per sample.
 *
 * Matched on PCI vendor id as well as driver: driver names drift between
 * kernels (`bochs-drm` became `bochs`), vendor ids do not.
 */
const VIRTUAL_DISPLAY_VENDOR_IDS: ReadonlySet<string> = new Set([
  "1234", // QEMU std-vga / bochs
  "1af4", // virtio (virtio-gpu)
  "1b36", // Red Hat QXL
  "15ad", // VMware SVGA
  "80ee", // VirtualBox VGA
  "1414", // Microsoft Hyper-V synthetic video
]);

const NO_TELEMETRY_DISPLAY_DRIVERS: ReadonlySet<string> = new Set([
  "bochs",
  "bochs-drm",
  "virtio_gpu",
  "virtio-gpu",
  "qxl",
  "cirrus",
  "cirrus-qemu",
  "vmwgfx",
  "vboxvideo",
  "hyperv_drm",
  "hyperv_fb",
  "simpledrm",
  "simple-framebuffer",
  "efifb",
  "ast",
  "mgag200",
]);

function normalizeVendorId(vendorId: string): string {
  const trimmed = vendorId.trim().toLowerCase();
  return trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
}

/**
 * Whether a DRM/PCI display device is a virtual or no-op display rather than
 * a GPU with telemetry. `vendorId` is the sysfs `vendor` text (`0x1234` or
 * `1234`); `driver` is the bound kernel driver (`DRIVER=` in `uevent`).
 */
export function isNoTelemetryDisplay(
  vendorId: string | undefined,
  driver: string | undefined,
): boolean {
  if (vendorId && VIRTUAL_DISPLAY_VENDOR_IDS.has(normalizeVendorId(vendorId))) {
    return true;
  }
  return driver !== undefined &&
    NO_TELEMETRY_DISPLAY_DRIVERS.has(driver.trim().toLowerCase());
}
