/**
 * Typed registry for named kernel/boot features. The shell helper
 * `orchestration/scripts/tp-kernel-features` is the host-side source of truth;
 * this module mirrors its `pi-4k-pagesize` and `pi-memory-cgroup` transforms
 * and state machines so daemon messages and tests stay in lockstep. The daemon
 * never invokes the helper.
 */

export type KernelFeatureState =
  | "not-applicable"
  | "switchable"
  | "restart-needed"
  | "ready"
  | "blocked";

export const KERNEL_FEATURE_IDS = [
  "pi-4k-pagesize",
  "pi-memory-cgroup",
] as const;

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
  return id === "pi-4k-pagesize" || id === "pi-memory-cgroup";
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
 * Remove every `kernel=` line with the same value as `line` that comes before
 * the first `[section]` header (spaces and tabs around the name, the `=` and
 * the value are tolerated). Later-section copies and raw endings stay.
 */
export function removeBootConfigLineTop(text: string, line: string): string {
  let section = false;
  const want = kernelLineValue(trimBlanks(line, "start"));
  const kept: string[] = [];
  const parts = text.split("\n");
  if (parts.at(-1) === "") {
    parts.pop();
  }
  for (const raw of parts) {
    const stripped = stripTrailingCr(raw);
    const head = trimBlanks(stripped, "start");
    if (head.startsWith("[")) section = true;
    if (!section && want !== undefined && kernelLineValue(head) === want) {
      continue;
    }
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

/** The word `pi-memory-cgroup` adds to the Raspberry Pi kernel command line. */
export const MEMORY_CGROUP_ON_WORD = "cgroup_enable=memory";
/** The word the Raspberry Pi firmware adds, which turns the controller off. */
export const MEMORY_CGROUP_OFF_WORD = "cgroup_disable=memory";

export type CmdlineMemoryScan = "list" | "enable" | "disable" | "none";

export type PiMemoryCgroupFacts = {
  /** `/sys/fs/cgroup/cgroup.controllers`; `undefined` when it is missing. */
  controllers?: string;
  model?: string;
  /** `/proc/cmdline` (NUL bytes allowed); `undefined` when unreadable. */
  procCmdline?: string;
  /** `/boot/firmware/cmdline.txt`; `undefined` when it is missing. */
  cmdlineText?: string;
  /** `/boot/firmware/config.txt`; `undefined` when it is missing. */
  configText?: string;
};

/** Words split the way awk splits fields: on spaces, tabs and newlines. */
function words(line: string): string[] {
  return line.split(/[ \t\n]+/).filter((word) => word !== "");
}

/** The first line as it is on disk, without its newline. */
function rawFirstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

/**
 * Same as `kf_cmdline_line`: the first line without its newline and without
 * one CR at its end. Any other CR stays (the state check refuses it).
 */
export function cmdlineFirstLine(text: string): string {
  const first = rawFirstLine(text);
  return first.endsWith("\r") ? first.slice(0, -1) : first;
}

/**
 * Same as `kf_cmdline_bad_bytes`: a control byte in the first line other than
 * a tab and one trailing CR.
 */
export function cmdlineHasControlBytes(text: string): boolean {
  for (const char of cmdlineFirstLine(text)) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

/** Same as `kf_bootcfg_moves_cmdline`: an active `cmdline=` or `os_prefix=`. */
export function bootConfigMovesCmdline(
  configText: string | undefined,
): boolean {
  if (configText === undefined) return false;
  return configText.split("\n").some((raw) =>
    /^\s*(cmdline|os_prefix)\s*=/i.test(raw)
  );
}

/** Same as `kf_cmdline_extra_lines`: anything but blank lines after line one. */
export function cmdlineHasExtraLines(text: string): boolean {
  const newline = text.indexOf("\n");
  if (newline === -1) return false;
  return /[^ \t\r\n]/.test(text.slice(newline + 1));
}

/** Same rules as `kf_cmdline_mem_scan`. */
export function scanCmdlineMemoryWords(line: string): CmdlineMemoryScan {
  let last: "enable" | "disable" | undefined;
  let list = false;
  for (const word of words(line)) {
    if (word === MEMORY_CGROUP_ON_WORD) last = "enable";
    else if (word === MEMORY_CGROUP_OFF_WORD) last = "disable";
    else if (word.startsWith("cgroup_disable=")) {
      const names = word.slice("cgroup_disable=".length).split(",");
      if (names.includes("memory")) list = true;
    }
  }
  if (list) return "list";
  return last ?? "none";
}

function trimTrailingBlanks(text: string): string {
  let to = text.length;
  while (to > 0 && (text[to - 1] === " " || text[to - 1] === "\t")) to--;
  return text.slice(0, to);
}

/** Same as `kf_cmdline_enable_line`. */
export function enableMemoryCgroupLine(line: string): string {
  let result = line;
  if (words(line).includes(MEMORY_CGROUP_OFF_WORD)) {
    result = words(line).filter((word) => word !== MEMORY_CGROUP_OFF_WORD)
      .join(" ");
  }
  if (result.split(/[ \t]+/).includes(MEMORY_CGROUP_ON_WORD)) return result;
  const base = trimTrailingBlanks(result);
  return base === ""
    ? MEMORY_CGROUP_ON_WORD
    : `${base} ${MEMORY_CGROUP_ON_WORD}`;
}

/** Same as `kf_cmdline_undo_line`. */
export function undoMemoryCgroupLine(
  current: string,
  before: string,
  after: string,
): string {
  if (current === after) return before;
  if (!words(current).includes(MEMORY_CGROUP_ON_WORD)) return current;
  return words(current).filter((word) => word !== MEMORY_CGROUP_ON_WORD).join(
    " ",
  );
}

/**
 * Same as `kf_cmdline_write`: replace the first line and keep the rest byte
 * for byte, including the first line's own CR and newline (or none).
 */
export function replaceCmdlineFirstLine(text: string, line: string): string {
  const cr = rawFirstLine(text).endsWith("\r") ? "\r" : "";
  const newline = text.indexOf("\n");
  if (newline === -1) return `${line}${cr}`;
  return `${line}${cr}\n${text.slice(newline + 1)}`;
}

/** The checks on the boot files that leave cmdline.txt alone, in order. */
function cmdlineFileBlocked(
  cmdlineText: string,
  configText: string | undefined,
): string | undefined {
  if (cmdlineHasControlBytes(cmdlineText)) {
    return "/boot/firmware/cmdline.txt holds control characters, so it is left as it is";
  }
  const lineWords = words(cmdlineFirstLine(cmdlineText));
  if (lineWords.length === 0) {
    return "/boot/firmware/cmdline.txt is empty, so it is left as it is";
  }
  if (!lineWords.some((word) => word.startsWith("root="))) {
    return "/boot/firmware/cmdline.txt has no root= setting, so it is left as it is";
  }
  if (bootConfigMovesCmdline(configText)) {
    return "config.txt points the firmware at another command line (cmdline= or os_prefix=), so cmdline.txt is left as it is";
  }
  return undefined;
}

/** Same reasons and check order as `kf_pi_memory_cgroup_state`. */
export function piMemoryCgroupState(
  facts: PiMemoryCgroupFacts,
): KernelFeatureStatus {
  if (facts.controllers === undefined) {
    return {
      state: "not-applicable",
      reason:
        "this server does not use the unified control group hierarchy (cgroup v2)",
    };
  }
  if (words(facts.controllers.replaceAll("\t", " ")).includes("memory")) {
    return {
      state: "ready",
      reason: "the memory controller is on, so memory limits are enforced",
    };
  }
  if (!facts.model?.includes("Raspberry Pi")) {
    return {
      state: "not-applicable",
      reason: "this server is not a Raspberry Pi",
    };
  }
  if (facts.cmdlineText === undefined) {
    return {
      state: "blocked",
      reason: "/boot/firmware/cmdline.txt is missing",
    };
  }
  if (cmdlineHasExtraLines(facts.cmdlineText)) {
    return {
      state: "blocked",
      reason:
        "/boot/firmware/cmdline.txt has more than one line, so it is left as it is",
    };
  }
  const blocked = cmdlineFileBlocked(facts.cmdlineText, facts.configText);
  if (blocked !== undefined) return { state: "blocked", reason: blocked };
  const running = (facts.procCmdline ?? "").replaceAll(/[\0\r\n]/g, " ");
  const runningScan = scanCmdlineMemoryWords(running);
  if (runningScan === "enable") {
    return {
      state: "blocked",
      reason:
        "this kernel was started with cgroup_enable=memory but the memory controller is still missing, so a restart would not turn it on",
    };
  }
  if (runningScan === "none") {
    return {
      state: "not-applicable",
      reason:
        "the memory controller is missing, but not because of the Raspberry Pi boot setting (cgroup_disable=memory is not on the kernel command line)",
    };
  }
  const saved = scanCmdlineMemoryWords(cmdlineFirstLine(facts.cmdlineText));
  if (saved === "list") {
    return {
      state: "blocked",
      reason:
        "cmdline.txt turns off control groups itself, so it is left as it is",
    };
  }
  if (saved === "enable") {
    return {
      state: "restart-needed",
      reason:
        "memory limits are saved in cmdline.txt; the server needs a restart",
    };
  }
  return {
    state: "switchable",
    reason: "this server can turn on memory limits (a restart is needed)",
  };
}
