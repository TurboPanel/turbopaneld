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
};

export type KernelFeatureStatus = {
  state: KernelFeatureState;
  reason: string;
};

/** True for features whose apply only takes effect after a restart. */
export function needsReboot(id: KernelFeatureId): boolean {
  return id === "pi-4k-pagesize";
}

function stripTrailingCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
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
    const line = stripTrailingCr(raw);
    if (/^[ \t]*\[/.test(line)) {
      section = true;
      continue;
    }
    if (!/^[ \t]*kernel[ \t]*=/.test(line)) continue;
    const value = line.replace(/^[ \t]*kernel[ \t]*=[ \t]*/, "").replace(
      /[ \t]+$/,
      "",
    );
    if (value === "kernel8.img") {
      if (section) later = true;
      else top = true;
    } else {
      other = true;
    }
  }
  if (other) return "other";
  if (top) return "kernel8-top";
  if (later) return "kernel8-later";
  return "none";
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
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  for (const raw of parts) {
    const stripped = stripTrailingCr(raw);
    if (/^[ \t]*\[/.test(stripped)) section = true;
    if (!section && stripped === line) continue;
    kept.push(raw);
  }
  if (kept.length === 0) return "";
  return `${kept.join("\n")}\n`;
}

/**
 * Same reasons and check order as `kf_pi_4k_pagesize_state`.
 */
export function piFourKPagesizeState(
  facts: PiFourKPagesizeFacts,
): KernelFeatureStatus {
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
