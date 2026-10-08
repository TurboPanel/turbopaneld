/**
 * Typed registry for named kernel/boot features. The shell helper
 * `orchestration/scripts/tp-kernel-features` is the host-side source of truth;
 * this module mirrors its `pi-4k-pagesize` transforms and state machine so
 * daemon messages and tests stay in lockstep. The daemon never invokes the
 * helper.
 */

export type KernelFeatureState =
  | "not-applicable"
  | "switchable"
  | "restart-needed"
  | "ready"
  | "blocked";

export const KERNEL_FEATURE_IDS = ["pi-4k-pagesize"] as const;

export type KernelFeatureId = (typeof KERNEL_FEATURE_IDS)[number];

export const KERNEL_FEATURE_BOOT_LINE = "kernel=kernel8.img";

export type BootConfigKernelScan =
  | "none"
  | "kernel8-top"
  | "kernel8-later"
  | "other";

export type PiFourKPagesizeFacts = {
  pageSizeBytes?: number;
  model?: string;
  codename?: string;
  configText?: string;
  hasKernel8Img: boolean;
  hasConfigTxt: boolean;
  hasV8Modules: boolean;
  hasInitramfs8: boolean;
};

export type KernelFeatureStatus = {
  state: KernelFeatureState;
  reason: string;
};

/** True for features whose apply only takes effect after a restart. */
export function needsReboot(id: KernelFeatureId): boolean {
  return id === "pi-4k-pagesize";
}

/** Trim spaces and tabs only (not other whitespace), like the shell helper. */
function trimBlanks(text: string, side: "start" | "both"): string {
  let from = 0;
  while (from < text.length && (text[from] === " " || text[from] === "\t")) {
    from++;
  }
  let to = text.length;
  if (side === "both") {
    while (to > from && (text[to - 1] === " " || text[to - 1] === "\t")) to--;
  }
  return text.slice(from, to);
}

function stripTrailingCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** The value of an active `kernel=` line, or `undefined` for any other line. */
function kernelLineValue(head: string): string | undefined {
  if (!head.startsWith("kernel")) return undefined;
  const afterName = trimBlanks(head.slice("kernel".length), "start");
  if (!afterName.startsWith("=")) return undefined;
  return trimBlanks(afterName.slice(1), "both");
}

/**
 * Same rules as `kf_bootcfg_scan`: CRLF is tolerated, a `[section]` header
 * ends the top area, and any `kernel=` that is not `kernel8.img` wins as
 * `"other"`.
 */
export function scanBootConfigKernelLines(text: string): BootConfigKernelScan {
  let section = false;
  let top = false;
  let later = false;
  let other = false;
  for (const raw of text.split("\n")) {
    const head = trimBlanks(stripTrailingCr(raw), "start");
    if (head.startsWith("[")) {
      section = true;
      continue;
    }
    const value = kernelLineValue(head);
    if (value === undefined) continue;
    if (value !== "kernel8.img") other = true;
    else if (section) later = true;
    else top = true;
  }
  if (other) return "other";
  if (top) return "kernel8-top";
  if (later) return "kernel8-later";
  return "none";
}

/** Same match as `grep -qi '^[[:space:]]*auto_initramfs[[:space:]]*=[[:space:]]*1'`. */
function configTurnsOnAutoInitramfs(configText: string | undefined): boolean {
  if (configText === undefined) return false;
  for (const raw of configText.split("\n")) {
    const head = trimBlanks(stripTrailingCr(raw), "start").toLowerCase();
    if (!head.startsWith("auto_initramfs")) continue;
    const afterName = trimBlanks(head.slice("auto_initramfs".length), "start");
    if (
      afterName.startsWith("=") &&
      trimBlanks(afterName.slice(1), "start").startsWith("1")
    ) return true;
  }
  return false;
}

function firstLineEndsCrlf(text: string): boolean {
  const newline = text.indexOf("\n");
  return newline > 0 && text[newline - 1] === "\r";
}

/**
 * Put `line` first. Keeps the file's own line endings: CRLF only when the
 * first line of `text` ends in CRLF. Returning `text` unchanged when the scan
 * is already `"kernel8-top"` matches the apply verb skipping a write.
 */
export function addBootConfigLineTop(text: string, line: string): string {
  if (scanBootConfigKernelLines(text) === "kernel8-top") return text;
  const ending = firstLineEndsCrlf(text) ? "\r\n" : "\n";
  return `${line}${ending}${text}`;
}

/**
 * Remove every exact `line` that comes before the first `[section]` header.
 * Later-section copies and raw endings stay.
 */
export function removeBootConfigLineTop(text: string, line: string): string {
  let section = false;
  const kept: string[] = [];
  const parts = text.split("\n");
  if (parts.at(-1) === "") {
    parts.pop();
  }
  for (const raw of parts) {
    const stripped = stripTrailingCr(raw);
    if (trimBlanks(stripped, "start").startsWith("[")) section = true;
    if (!section && stripped === line) continue;
    kept.push(raw);
  }
  if (kept.length === 0) return "";
  return `${kept.join("\n")}\n`;
}

/** Checks about the platform; `undefined` means the boot files come next. */
function platformStatus(
  facts: PiFourKPagesizeFacts,
): KernelFeatureStatus | undefined {
  const pageSizeBytes = facts.pageSizeBytes;
  if (
    pageSizeBytes === undefined ||
    !Number.isInteger(pageSizeBytes) ||
    pageSizeBytes < 0
  ) {
    return {
      state: "not-applicable",
      reason: "the memory page size could not be read",
    };
  }
  if (pageSizeBytes <= 4096) {
    return {
      state: "ready",
      reason: "this server already uses 4 KiB memory pages",
    };
  }
  if (!facts.model?.includes("Raspberry Pi")) {
    return {
      state: "not-applicable",
      reason: "this server is not a Raspberry Pi",
    };
  }
  if (facts.codename !== "trixie") {
    return {
      state: "not-applicable",
      reason: "only Raspberry Pi OS based on Debian 13 (trixie) is supported",
    };
  }
  if (pageSizeBytes !== 16384) {
    return {
      state: "not-applicable",
      reason:
        `this server uses ${pageSizeBytes}-byte memory pages, not the 16 KiB Raspberry Pi kernel`,
    };
  }
  return undefined;
}

/** Checks that something the switch needs is missing; `undefined` means none is. */
function bootFilesBlocked(
  facts: PiFourKPagesizeFacts,
): KernelFeatureStatus | undefined {
  if (!facts.hasConfigTxt) {
    return {
      state: "blocked",
      reason: "/boot/firmware/config.txt is missing",
    };
  }
  if (!facts.hasKernel8Img) {
    return {
      state: "blocked",
      reason: "the 4 KiB kernel (kernel8.img) is not on the boot partition",
    };
  }
  if (!facts.hasV8Modules) {
    return {
      state: "blocked",
      reason: "the modules for the 4 KiB kernel (*-rpi-v8) are not installed",
    };
  }
  if (
    configTurnsOnAutoInitramfs(facts.configText) && !facts.hasInitramfs8
  ) {
    return {
      state: "blocked",
      reason:
        "config.txt turns on auto_initramfs but initramfs8 is missing from the boot partition",
    };
  }
  return undefined;
}

/**
 * Same reasons and check order as `kf_pi_4k_pagesize_state`.
 */
export function piFourKPagesizeState(
  facts: PiFourKPagesizeFacts,
): KernelFeatureStatus {
  const early = platformStatus(facts) ?? bootFilesBlocked(facts);
  if (early !== undefined) return early;
  const scan = scanBootConfigKernelLines(facts.configText ?? "");
  if (scan === "other") {
    return {
      state: "blocked",
      reason:
        "config.txt already chooses a different kernel, so it is left as it is",
    };
  }
  if (scan === "kernel8-top") {
    return {
      state: "restart-needed",
      reason: "the switch is saved in config.txt; the server needs a restart",
    };
  }
  return {
    state: "switchable",
    reason: "this server can switch to the 4 KiB kernel (a restart is needed)",
  };
}
