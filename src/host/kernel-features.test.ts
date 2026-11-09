import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  addBootConfigLineTop,
  cmdlineFirstLine,
  enableMemoryCgroupLine,
  KERNEL_FEATURE_BOOT_LINE,
  KERNEL_FEATURE_IDS,
  needsReboot,
  type PiFourKPagesizeFacts,
  piFourKPagesizeState,
  type PiMemoryCgroupFacts,
  piMemoryCgroupState,
  removeBootConfigLineTop,
  replaceCmdlineFirstLine,
  scanBootConfigKernelLines,
  scanCmdlineMemoryWords,
  undoMemoryCgroupLine,
} from "./kernel-features.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SCRIPT = join(
  dirname(fromFileUrl(import.meta.url)),
  "../../orchestration/scripts/tp-kernel-features",
);

const LINE = KERNEL_FEATURE_BOOT_LINE;

type Golden = {
  name: string;
  input: string;
  scan: ReturnType<typeof scanBootConfigKernelLines>;
  added: string;
  removed: string;
};

const GOLDENS: Golden[] = [
  {
    name: "empty file",
    input: "",
    scan: "none",
    added: `${LINE}\n`,
    removed: "",
  },
  {
    name: "CRLF file",
    input: "dtparam=audio=on\r\narm_64bit=1\r\n",
    scan: "none",
    added: `${LINE}\r\ndtparam=audio=on\r\narm_64bit=1\r\n`,
    removed: "dtparam=audio=on\r\narm_64bit=1\r\n",
  },
  {
    name: "LF file",
    input: "dtparam=audio=on\narm_64bit=1\n",
    scan: "none",
    added: `${LINE}\ndtparam=audio=on\narm_64bit=1\n`,
    removed: "dtparam=audio=on\narm_64bit=1\n",
  },
  {
    name: "section-only kernel8",
    input: "[all]\nkernel=kernel8.img\n",
    scan: "kernel8-later",
    added: `${LINE}\n[all]\nkernel=kernel8.img\n`,
    removed: "[all]\nkernel=kernel8.img\n",
  },
  {
    name: "other kernel",
    input: "kernel=kernel_2712.img\n",
    scan: "other",
    added: `${LINE}\nkernel=kernel_2712.img\n`,
    removed: "kernel=kernel_2712.img\n",
  },
  {
    name: "line already on top",
    input: `${LINE}\narm_64bit=1\n`,
    scan: "kernel8-top",
    added: `${LINE}\narm_64bit=1\n`,
    removed: "arm_64bit=1\n",
  },
  {
    name: "trailing blanks on our line",
    input: `${LINE}  \t\narm_64bit=1\n`,
    scan: "kernel8-top",
    added: `${LINE}  \t\narm_64bit=1\n`,
    removed: "arm_64bit=1\n",
  },
  {
    name: "spaces around the equals sign",
    input: "kernel = kernel8.img\narm_64bit=1\n",
    scan: "kernel8-top",
    added: "kernel = kernel8.img\narm_64bit=1\n",
    removed: "arm_64bit=1\n",
  },
  {
    name: "removal keeps later-section line",
    input: `${LINE}\n[all]\n${LINE}\n`,
    scan: "kernel8-top",
    added: `${LINE}\n[all]\n${LINE}\n`,
    removed: `[all]\n${LINE}\n`,
  },
];

const SWITCHABLE_HOST: PiFourKPagesizeFacts = {
  pageSizeBytes: 16384,
  model: "Raspberry Pi 5 Model B Rev 1.0",
  codename: "trixie",
  configText: "arm_64bit=1\n",
  hasKernel8Img: true,
  hasConfigTxt: true,
  hasV8Modules: true,
  hasInitramfs8: true,
};

type StateCase = {
  name: string;
  facts: PiFourKPagesizeFacts;
  state: ReturnType<typeof piFourKPagesizeState>["state"];
  reason: string;
};

const STATE_CASES: StateCase[] = [
  {
    name: "unreadable page size",
    facts: {
      ...SWITCHABLE_HOST,
      pageSizeBytes: undefined,
    },
    state: "not-applicable",
    reason: "the memory page size could not be read",
  },
  {
    name: "already 4 KiB",
    facts: { ...SWITCHABLE_HOST, pageSizeBytes: 4096 },
    state: "ready",
    reason: "this server already uses 4 KiB memory pages",
  },
  {
    name: "not a Raspberry Pi",
    facts: { ...SWITCHABLE_HOST, model: "Generic ARM board" },
    state: "not-applicable",
    reason: "this server is not a Raspberry Pi",
  },
  {
    name: "not trixie",
    facts: { ...SWITCHABLE_HOST, codename: "bookworm" },
    state: "not-applicable",
    reason: "only Raspberry Pi OS based on Debian 13 (trixie) is supported",
  },
  {
    name: "unexpected page size on a Pi",
    facts: { ...SWITCHABLE_HOST, pageSizeBytes: 65536 },
    state: "not-applicable",
    reason:
      "this server uses 65536-byte memory pages, not the 16 KiB Raspberry Pi kernel",
  },
  {
    name: "missing config.txt",
    facts: { ...SWITCHABLE_HOST, hasConfigTxt: false, configText: undefined },
    state: "blocked",
    reason: "/boot/firmware/config.txt is missing",
  },
  {
    name: "missing kernel8.img",
    facts: { ...SWITCHABLE_HOST, hasKernel8Img: false },
    state: "blocked",
    reason: "the 4 KiB kernel (kernel8.img) is not on the boot partition",
  },
  {
    name: "missing v8 modules",
    facts: { ...SWITCHABLE_HOST, hasV8Modules: false },
    state: "blocked",
    reason: "the modules for the 4 KiB kernel (*-rpi-v8) are not installed",
  },
  {
    name: "auto_initramfs without initramfs8",
    facts: {
      ...SWITCHABLE_HOST,
      configText: "auto_initramfs=1\narm_64bit=1\n",
      hasInitramfs8: false,
    },
    state: "blocked",
    reason:
      "config.txt turns on auto_initramfs but initramfs8 is missing from the boot partition",
  },
  {
    name: "other kernel chosen",
    facts: {
      ...SWITCHABLE_HOST,
      configText: "kernel=kernel_2712.img\n",
    },
    state: "blocked",
    reason:
      "config.txt already chooses a different kernel, so it is left as it is",
  },
  {
    name: "switch saved, restart needed",
    facts: {
      ...SWITCHABLE_HOST,
      configText: `${LINE}\narm_64bit=1\n`,
    },
    state: "restart-needed",
    reason: "the switch is saved in config.txt; the server needs a restart",
  },
  {
    name: "can switch",
    facts: SWITCHABLE_HOST,
    state: "switchable",
    reason: "this server can switch to the 4 KiB kernel (a restart is needed)",
  },
];

test("KERNEL_FEATURE_IDS lists both Raspberry Pi features and both need a reboot", () => {
  assertEquals(KERNEL_FEATURE_IDS, ["pi-4k-pagesize", "pi-memory-cgroup"]);
  assertEquals(needsReboot("pi-4k-pagesize"), true);
  assertEquals(needsReboot("pi-memory-cgroup"), true);
});

test("scan/add/remove boot config goldens", () => {
  for (const golden of GOLDENS) {
    assertEquals(
      scanBootConfigKernelLines(golden.input),
      golden.scan,
      golden.name,
    );
    assertEquals(
      addBootConfigLineTop(golden.input, LINE),
      golden.added,
      `${golden.name} add`,
    );
    assertEquals(
      removeBootConfigLineTop(golden.input, LINE),
      golden.removed,
      `${golden.name} remove`,
    );
  }
});

for (const stateCase of STATE_CASES) {
  test(`piFourKPagesizeState: ${stateCase.name}`, () => {
    assertEquals(piFourKPagesizeState(stateCase.facts), {
      state: stateCase.state,
      reason: stateCase.reason,
    });
  });
}

async function shExists(): Promise<boolean> {
  try {
    const out = await new Deno.Command("sh", {
      args: ["-c", "exit 0"],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } catch {
    return false;
  }
}

async function mvSupportsDashT(): Promise<boolean> {
  const dir = await Deno.makeTempDir({ prefix: "tp-kf-mv-" });
  const src = join(dir, "src");
  const dest = join(dir, "dest");
  await Deno.writeTextFile(src, "a");
  await Deno.writeTextFile(dest, "b");
  try {
    const out = await new Deno.Command("mv", {
      args: ["-T", "-f", "--", src, dest],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } catch {
    return false;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function runKernelFeatures(
  prefix: string,
  verb: string[],
  pageSize: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("sh", {
    args: [SCRIPT, ...verb],
    clearEnv: true,
    env: {
      PATH: "/usr/bin:/bin",
      TP_KERNEL_TEST_PREFIX: prefix,
      TP_KERNEL_TEST_PAGESIZE: pageSize,
      TP_KERNEL_TEST_ENROL_WAIT: "0",
      ...extraEnv,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function writePrefix(
  facts: PiFourKPagesizeFacts,
  configText?: string,
): Promise<string> {
  const prefix = await Deno.makeTempDir({ prefix: "tp-kf-parity-" });
  await Deno.mkdir(join(prefix, "boot/firmware"), { recursive: true });
  await Deno.mkdir(join(prefix, "proc/device-tree"), { recursive: true });
  await Deno.mkdir(join(prefix, "etc"), { recursive: true });
  if (facts.hasConfigTxt) {
    await Deno.writeTextFile(
      join(prefix, "boot/firmware/config.txt"),
      configText ?? facts.configText ?? "",
    );
  }
  if (facts.hasKernel8Img) {
    await Deno.writeFile(
      join(prefix, "boot/firmware/kernel8.img"),
      new Uint8Array([0]),
    );
  }
  if (facts.hasV8Modules) {
    await Deno.mkdir(
      join(prefix, "lib/modules/6.12.0+rpt-rpi-v8"),
      { recursive: true },
    );
  }
  if (facts.hasInitramfs8) {
    await Deno.writeTextFile(
      join(prefix, "boot/firmware/initramfs8"),
      "",
    );
  }
  if (facts.model !== undefined) {
    await Deno.writeTextFile(
      join(prefix, "proc/device-tree/model"),
      facts.model,
    );
  }
  const codename = facts.codename ?? "";
  await Deno.writeTextFile(
    join(prefix, "etc/os-release"),
    `ID=debian\nVERSION_CODENAME=${codename}\n`,
  );
  return prefix;
}

function pageSizeEnv(facts: PiFourKPagesizeFacts): string {
  if (
    facts.pageSizeBytes === undefined ||
    !Number.isInteger(facts.pageSizeBytes) ||
    facts.pageSizeBytes < 0
  ) {
    return "x";
  }
  return String(facts.pageSizeBytes);
}

test({
  name:
    "parity with orchestration/scripts/tp-kernel-features status, apply, undo",
  ignore: Deno.build.os !== "linux" || Deno.uid() === 0,
  fn: async () => {
    if (!await shExists() || !await mvSupportsDashT()) return;

    for (const golden of GOLDENS) {
      const facts: PiFourKPagesizeFacts = {
        ...SWITCHABLE_HOST,
        configText: golden.input,
      };
      const prefix = await writePrefix(facts, golden.input);
      try {
        const expected = piFourKPagesizeState(facts);
        const status = await runKernelFeatures(prefix, [
          "status",
          "pi-4k-pagesize",
        ], pageSizeEnv(facts));
        assertEquals(
          status.stdout,
          `pi-4k-pagesize\t${expected.state}\t${expected.reason}\n`,
          `${golden.name} status: ${status.stderr}`,
        );

        const before = await Deno.readTextFile(
          join(prefix, "boot/firmware/config.txt"),
        );
        const applied = await runKernelFeatures(prefix, [
          "apply",
          "pi-4k-pagesize",
        ], pageSizeEnv(facts));
        let afterApply = before;
        if (applied.code === 0) {
          afterApply = await Deno.readTextFile(
            join(prefix, "boot/firmware/config.txt"),
          );
          assertEquals(
            afterApply,
            addBootConfigLineTop(before, LINE),
            `${golden.name} apply`,
          );
        }

        if (applied.code === 0 && expected.state === "switchable") {
          const undoneAfterApply = await runKernelFeatures(prefix, [
            "undo",
            "pi-4k-pagesize",
          ], pageSizeEnv(facts));
          assertEquals(
            undoneAfterApply.code,
            0,
            `${golden.name} undo after apply: ${undoneAfterApply.stderr}`,
          );
          const afterUndoApply = await Deno.readTextFile(
            join(prefix, "boot/firmware/config.txt"),
          );
          assertEquals(
            afterUndoApply,
            removeBootConfigLineTop(afterApply, LINE),
            `${golden.name} undo after apply`,
          );
        }

        const prefixUndo = await writePrefix(facts, golden.input);
        try {
          const undone = await runKernelFeatures(prefixUndo, [
            "undo",
            "pi-4k-pagesize",
          ], pageSizeEnv(facts));
          assertEquals(undone.code, 0, `${golden.name} undo: ${undone.stderr}`);
          assertEquals(
            undone.stdout.includes("Nothing to undo"),
            true,
            `${golden.name} undo message: ${undone.stdout}`,
          );
          const afterUndo = await Deno.readTextFile(
            join(prefixUndo, "boot/firmware/config.txt"),
          );
          assertEquals(
            afterUndo,
            golden.input,
            `${golden.name} undo leaves user-written config`,
          );
        } finally {
          await Deno.remove(prefixUndo, { recursive: true });
        }
      } finally {
        await Deno.remove(prefix, { recursive: true });
      }
    }

    for (const stateCase of STATE_CASES) {
      const prefix = await writePrefix(stateCase.facts);
      try {
        const expected = piFourKPagesizeState(stateCase.facts);
        const status = await runKernelFeatures(prefix, [
          "status",
          "pi-4k-pagesize",
        ], pageSizeEnv(stateCase.facts));
        assertEquals(
          status.stdout,
          `pi-4k-pagesize\t${expected.state}\t${expected.reason}\n`,
          `${stateCase.name}: ${status.stderr}`,
        );
      } finally {
        await Deno.remove(prefix, { recursive: true });
      }
    }
  },
});

// The real line from a Raspberry Pi 5 on Raspberry Pi OS (Debian 13): one
// line, no line ending at all.
const PI_CMDLINE =
  "console=serial0,115200 console=tty1 root=PARTUUID=c5feafe0-02 rootfstype=ext4 fsck.repair=yes rootwait cfg80211.ieee80211_regdom=US ds=nocloud;i=rpi-imager-1794257616899";
// What the firmware hands the kernel: its own words first, cmdline.txt last.
const PI_PROC_CMDLINE =
  `reboot=w coherent_pool=1M 8250.nr_uarts=1 pci=pcie_bus_safe cgroup_disable=memory numa_policy=interleave ${PI_CMDLINE}\n`;
const ON = "cgroup_enable=memory";

type CmdlineGolden = {
  name: string;
  input: string;
  scan: ReturnType<typeof scanCmdlineMemoryWords>;
  enabled: string;
};

const CMDLINE_GOLDENS: CmdlineGolden[] = [
  {
    name: "Pi line without a line ending",
    input: PI_CMDLINE,
    scan: "none",
    enabled: `${PI_CMDLINE} ${ON}`,
  },
  {
    name: "Pi line with a newline",
    input: `${PI_CMDLINE}\n`,
    scan: "none",
    enabled: `${PI_CMDLINE} ${ON}\n`,
  },
  {
    name: "CRLF line",
    input: "console=tty1 rootwait\r\n",
    scan: "none",
    enabled: `console=tty1 rootwait ${ON}\r\n`,
  },
  {
    name: "trailing blanks",
    input: "console=tty1 rootwait  \n",
    scan: "none",
    enabled: `console=tty1 rootwait ${ON}\n`,
  },
  {
    name: "own disable word is removed",
    input: "console=tty1  cgroup_disable=memory rootwait\n",
    scan: "disable",
    enabled: `console=tty1 rootwait ${ON}\n`,
  },
  {
    name: "disable after enable",
    input: `console=tty1 ${ON} cgroup_disable=memory\n`,
    scan: "disable",
    enabled: `console=tty1 ${ON}\n`,
  },
  {
    name: "already on",
    input: `console=tty1 ${ON} rootwait\n`,
    scan: "enable",
    enabled: `console=tty1 ${ON} rootwait\n`,
  },
  {
    name: "a list that names memory",
    input: "console=tty1 cgroup_disable=cpu,memory\n",
    scan: "list",
    enabled: `console=tty1 cgroup_disable=cpu,memory ${ON}\n`,
  },
  {
    name: "empty file",
    input: "",
    scan: "none",
    enabled: ON,
  },
];

test("cmdline.txt memory word goldens: scan, enable, undo", () => {
  for (const golden of CMDLINE_GOLDENS) {
    const line = cmdlineFirstLine(golden.input);
    assertEquals(scanCmdlineMemoryWords(line), golden.scan, golden.name);
    const after = enableMemoryCgroupLine(line);
    assertEquals(
      replaceCmdlineFirstLine(golden.input, after),
      golden.enabled,
      `${golden.name} enable`,
    );
    assertEquals(
      scanCmdlineMemoryWords(after) === "enable" || golden.scan === "list",
      true,
      `${golden.name} reads back as on`,
    );
    assertEquals(
      undoMemoryCgroupLine(after, line, after),
      line,
      `${golden.name} undo restores the line`,
    );
  }
  // Changed by hand since: only the word is taken out.
  assertEquals(
    undoMemoryCgroupLine(`a ${ON} b quiet`, "a b", `a b ${ON}`),
    "a b quiet",
  );
  // Gone already: nothing changes.
  assertEquals(undoMemoryCgroupLine("a b", "a b", `a b ${ON}`), "a b");
});

const MEMORY_SWITCHABLE: PiMemoryCgroupFacts = {
  controllers: "cpuset cpu io pids\n",
  model: "Raspberry Pi 5 Model B Rev 1.0",
  procCmdline: PI_PROC_CMDLINE,
  cmdlineText: PI_CMDLINE,
};

type MemoryStateCase = {
  name: string;
  facts: PiMemoryCgroupFacts;
  state: ReturnType<typeof piMemoryCgroupState>["state"];
  reason: string;
};

const MEMORY_STATE_CASES: MemoryStateCase[] = [
  {
    name: "no cgroup v2",
    facts: { ...MEMORY_SWITCHABLE, controllers: undefined },
    state: "not-applicable",
    reason:
      "this server does not use the unified control group hierarchy (cgroup v2)",
  },
  {
    name: "memory controller on",
    facts: { ...MEMORY_SWITCHABLE, controllers: "cpuset cpu io memory pids\n" },
    state: "ready",
    reason: "the memory controller is on, so memory limits are enforced",
  },
  {
    name: "not a Raspberry Pi",
    facts: { ...MEMORY_SWITCHABLE, model: "Generic ARM board" },
    state: "not-applicable",
    reason: "this server is not a Raspberry Pi",
  },
  {
    name: "missing cmdline.txt",
    facts: { ...MEMORY_SWITCHABLE, cmdlineText: undefined },
    state: "blocked",
    reason: "/boot/firmware/cmdline.txt is missing",
  },
  {
    name: "more than one line",
    facts: { ...MEMORY_SWITCHABLE, cmdlineText: "console=tty1\nquiet\n" },
    state: "blocked",
    reason:
      "/boot/firmware/cmdline.txt has more than one line, so it is left as it is",
  },
  {
    name: "started with the word and still missing",
    facts: {
      ...MEMORY_SWITCHABLE,
      procCmdline: `cgroup_disable=memory ${PI_CMDLINE} ${ON}\n`,
      cmdlineText: `${PI_CMDLINE} ${ON}`,
    },
    state: "blocked",
    reason:
      "this kernel was started with cgroup_enable=memory but the memory controller is still missing, so a restart would not turn it on",
  },
  {
    name: "missing for another reason",
    facts: { ...MEMORY_SWITCHABLE, procCmdline: `${PI_CMDLINE}\n` },
    state: "not-applicable",
    reason:
      "the memory controller is missing, but not because of the Raspberry Pi boot setting (cgroup_disable=memory is not on the kernel command line)",
  },
  {
    name: "a list in cmdline.txt",
    facts: {
      ...MEMORY_SWITCHABLE,
      cmdlineText: `${PI_CMDLINE} cgroup_disable=cpu,memory`,
    },
    state: "blocked",
    reason:
      "cmdline.txt turns off control groups itself, so it is left as it is",
  },
  {
    name: "saved, restart needed",
    facts: { ...MEMORY_SWITCHABLE, cmdlineText: `${PI_CMDLINE} ${ON}` },
    state: "restart-needed",
    reason:
      "memory limits are saved in cmdline.txt; the server needs a restart",
  },
  {
    name: "can switch",
    facts: MEMORY_SWITCHABLE,
    state: "switchable",
    reason: "this server can turn on memory limits (a restart is needed)",
  },
];

for (const stateCase of MEMORY_STATE_CASES) {
  test(`piMemoryCgroupState: ${stateCase.name}`, () => {
    assertEquals(piMemoryCgroupState(stateCase.facts), {
      state: stateCase.state,
      reason: stateCase.reason,
    });
  });
}

async function writeMemoryPrefix(facts: PiMemoryCgroupFacts): Promise<string> {
  const prefix = await Deno.makeTempDir({ prefix: "tp-kf-mem-" });
  await Deno.mkdir(join(prefix, "boot/firmware"), { recursive: true });
  await Deno.mkdir(join(prefix, "proc/device-tree"), { recursive: true });
  await Deno.mkdir(join(prefix, "sys/fs/cgroup"), { recursive: true });
  await Deno.mkdir(join(prefix, "etc"), { recursive: true });
  await Deno.writeTextFile(
    join(prefix, "etc/os-release"),
    "ID=debian\nVERSION_CODENAME=trixie\n",
  );
  if (facts.cmdlineText !== undefined) {
    await Deno.writeTextFile(
      join(prefix, "boot/firmware/cmdline.txt"),
      facts.cmdlineText,
    );
  }
  if (facts.controllers !== undefined) {
    await Deno.writeTextFile(
      join(prefix, "sys/fs/cgroup/cgroup.controllers"),
      facts.controllers,
    );
  }
  if (facts.procCmdline !== undefined) {
    await Deno.writeTextFile(join(prefix, "proc/cmdline"), facts.procCmdline);
  }
  if (facts.model !== undefined) {
    await Deno.writeTextFile(
      join(prefix, "proc/device-tree/model"),
      `${facts.model}\0`,
    );
  }
  return prefix;
}

const linuxUnprivileged = Deno.build.os !== "linux" || Deno.uid() === 0;

test({
  name:
    "parity with orchestration/scripts/tp-kernel-features for pi-memory-cgroup",
  ignore: linuxUnprivileged,
  fn: async () => {
    if (!await shExists() || !await mvSupportsDashT()) return;
    for (const stateCase of MEMORY_STATE_CASES) {
      const prefix = await writeMemoryPrefix(stateCase.facts);
      try {
        const status = await runKernelFeatures(prefix, [
          "status",
          "pi-memory-cgroup",
        ], "4096");
        assertEquals(
          status.stdout,
          `pi-memory-cgroup\t${stateCase.state}\t${stateCase.reason}\n`,
          `${stateCase.name}: ${status.stderr}`,
        );
      } finally {
        await Deno.remove(prefix, { recursive: true });
      }
    }
    for (const golden of CMDLINE_GOLDENS) {
      if (golden.scan === "enable" || golden.scan === "list") continue;
      const prefix = await writeMemoryPrefix({
        ...MEMORY_SWITCHABLE,
        cmdlineText: golden.input,
      });
      const file = join(prefix, "boot/firmware/cmdline.txt");
      try {
        const applied = await runKernelFeatures(prefix, [
          "apply",
          "pi-memory-cgroup",
        ], "4096");
        assertEquals(applied.code, 0, `${golden.name}: ${applied.stderr}`);
        assertEquals(
          applied.stdout.split("\n")[0].startsWith(
            "kernel-feature pi-memory-cgroup state=restart-needed changed=yes backup=",
          ),
          true,
          applied.stdout,
        );
        assertEquals(
          await Deno.readTextFile(file),
          golden.enabled,
          golden.name,
        );
        const again = await runKernelFeatures(prefix, [
          "apply",
          "pi-memory-cgroup",
        ], "4096");
        assertEquals(
          again.stdout.split("\n")[0],
          "kernel-feature pi-memory-cgroup state=restart-needed changed=no",
        );
        const undone = await runKernelFeatures(prefix, [
          "undo",
          "pi-memory-cgroup",
        ], "4096");
        assertEquals(undone.code, 0, undone.stderr);
        assertEquals(
          await Deno.readTextFile(file),
          golden.input,
          `${golden.name} undo restores the file byte for byte`,
        );
        const twice = await runKernelFeatures(prefix, [
          "undo",
          "pi-memory-cgroup",
        ], "4096");
        assertEquals(twice.stdout.includes("Nothing to undo"), true);
      } finally {
        await Deno.remove(prefix, { recursive: true });
      }
    }
    // After the restart the controller is on: a second apply is a no-op.
    const ready = await writeMemoryPrefix({
      ...MEMORY_SWITCHABLE,
      controllers: "cpuset cpu io memory pids\n",
    });
    try {
      const out = await runKernelFeatures(ready, [
        "apply",
        "pi-memory-cgroup",
      ], "4096");
      assertEquals(out.code, 0);
      assertEquals(
        out.stdout.split("\n")[0],
        "kernel-feature pi-memory-cgroup state=ready changed=no",
      );
    } finally {
      await Deno.remove(ready, { recursive: true });
    }
  },
});

/** A first-install host where both Raspberry Pi features apply. */
async function writeBothPrefix(): Promise<string> {
  const prefix = await writeMemoryPrefix(MEMORY_SWITCHABLE);
  await Deno.writeTextFile(
    join(prefix, "boot/firmware/config.txt"),
    "arm_64bit=1\n",
  );
  await Deno.writeFile(
    join(prefix, "boot/firmware/kernel8.img"),
    new Uint8Array([0]),
  );
  await Deno.mkdir(join(prefix, "lib/modules/6.12.0+rpt-rpi-v8"), {
    recursive: true,
  });
  const state = join(prefix, "var/lib/turbopanel");
  await Deno.mkdir(state, { recursive: true });
  const ref = join(prefix, "install-start");
  await Deno.writeTextFile(ref, "");
  const old = new Date(Date.now() - 60_000);
  await Deno.utime(ref, old, old);
  // The saved server key is matched by the glob server-key.j*.
  for (const name of ["server.id", "server-key-id", "server-key.jwk"]) {
    await Deno.writeTextFile(join(state, name), "x");
  }
  return prefix;
}

async function installerStep(
  prefix: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string; calls: string }> {
  const log = join(prefix, "systemctl.log");
  await Deno.writeTextFile(log, "");
  const out = await runKernelFeatures(prefix, ["installer-step"], "16384", {
    TP_KF_FIRST_INSTALL: "1",
    TP_KF_ENROL_REF: join(prefix, "install-start"),
    TP_KERNEL_TEST_REBOOT_CMD: "echo REBOOTED",
    TP_KERNEL_TEST_DAEMON_ACTIVE: "1",
    TP_KERNEL_TEST_SYSTEMCTL_LOG: log,
    ...env,
  });
  return { ...out, calls: await Deno.readTextFile(log) };
}

async function markConvergeDone(prefix: string): Promise<void> {
  await Deno.mkdir(join(prefix, "run/turbopanel"), { recursive: true });
  await Deno.writeTextFile(
    join(prefix, "run/turbopanel/boot-converge-done"),
    "{}\n",
  );
}

test({
  name:
    "installer-step saves both Raspberry Pi changes and restarts once, after the first setup run",
  ignore: linuxUnprivileged,
  fn: async () => {
    if (!await shExists() || !await mvSupportsDashT()) return;
    const prefix = await writeBothPrefix();
    try {
      // The daemon's first setup run has not finished: both changes are saved,
      // nothing restarts and the daemon is left alone.
      const early = await installerStep(prefix);
      assertEquals(early.code, 0, early.stderr);
      assertEquals(early.stdout.includes("REBOOTED"), false);
      assertEquals(
        early.stdout.includes(
          "TurboPanel has not finished setting up this server yet",
        ),
        true,
        early.stdout,
      );
      assertEquals(early.calls, "");
      assertEquals(
        (await Deno.readTextFile(join(prefix, "boot/firmware/config.txt")))
          .startsWith("kernel=kernel8.img\n"),
        true,
      );
      assertEquals(
        await Deno.readTextFile(join(prefix, "boot/firmware/cmdline.txt")),
        `${PI_CMDLINE} ${ON}`,
      );

      // The unattended-upgrades service's waiting helper runs for the whole
      // uptime and installs nothing: it never blocks the restart.
      await Deno.mkdir(join(prefix, "proc/857"), { recursive: true });
      await Deno.writeTextFile(
        join(prefix, "proc/857/comm"),
        "unattended-upgr\n",
      );
      await Deno.writeTextFile(
        join(prefix, "proc/857/cmdline"),
        "/usr/bin/python3\0/usr/share/unattended-upgrades/unattended-upgrade-shutdown\0--wait-for-signal\0",
      );

      // A package tool is running: still no restart.
      await markConvergeDone(prefix);
      await Deno.mkdir(join(prefix, "proc/4242"), { recursive: true });
      await Deno.writeTextFile(join(prefix, "proc/4242/comm"), "dpkg\n");
      const busy = await installerStep(prefix);
      assertEquals(busy.stdout.includes("REBOOTED"), false);
      assertEquals(
        busy.stdout.includes("Software is still being installed"),
        true,
        busy.stdout,
      );
      assertEquals(busy.calls, "");

      // An Ansible module run counts too (matched on its command line).
      await Deno.writeTextFile(join(prefix, "proc/4242/comm"), "python3\n");
      await Deno.writeTextFile(
        join(prefix, "proc/4242/cmdline"),
        "/usr/bin/python3\0/root/.ansible/tmp/x/AnsiballZ_apt.py\0",
      );
      const module = await installerStep(prefix);
      assertEquals(module.stdout.includes("REBOOTED"), false);

      // A real unattended-upgrades run does block it.
      await Deno.writeTextFile(
        join(prefix, "proc/4242/comm"),
        "unattended-upgr\n",
      );
      await Deno.writeTextFile(
        join(prefix, "proc/4242/cmdline"),
        "/usr/bin/python3\0/usr/bin/unattended-upgrade\0",
      );
      const upgrading = await installerStep(prefix);
      assertEquals(upgrading.stdout.includes("REBOOTED"), false);
      assertEquals(
        upgrading.stdout.includes("Software is still being installed"),
        true,
      );
      await Deno.remove(join(prefix, "proc/4242"), { recursive: true });

      // All clear: the daemon is stopped, then exactly one restart.
      const go = await installerStep(prefix);
      assertEquals(go.code, 0, go.stderr);
      assertEquals(go.stdout.split("REBOOTED").length - 1, 1, go.stdout);
      assertEquals(go.calls, "stop\n");

      // A restart that does not start leaves the daemon running again.
      const failed = await installerStep(prefix, {
        TP_KERNEL_TEST_REBOOT_CMD: "false",
      });
      assertEquals(failed.code, 1);
      assertEquals(failed.calls, "stop\nstart\n");
      assertEquals(
        failed.stderr.includes("the restart could not be started"),
        true,
        failed.stderr,
      );
      assertEquals(
        go.stdout.includes(
          "switch it to the 4 KiB kernel and turn memory limits on, then restart this server once",
        ),
        true,
        go.stdout,
      );
    } finally {
      await Deno.remove(prefix, { recursive: true });
    }
  },
});

test({
  name:
    "installer-step leaves memory limits off with TURBOPANEL_SKIP_MEMORY_LIMITS_SWITCH=1",
  ignore: linuxUnprivileged,
  fn: async () => {
    if (!await shExists() || !await mvSupportsDashT()) return;
    const prefix = await writeBothPrefix();
    try {
      await markConvergeDone(prefix);
      const out = await installerStep(prefix, {
        TURBOPANEL_SKIP_MEMORY_LIMITS_SWITCH: "1",
      });
      assertEquals(out.code, 0, out.stderr);
      assertEquals(
        out.stdout.includes("Skipping the memory limits switch"),
        true,
      );
      assertEquals(
        await Deno.readTextFile(join(prefix, "boot/firmware/cmdline.txt")),
        PI_CMDLINE,
      );
      assertEquals(out.stdout.split("REBOOTED").length - 1, 1, out.stdout);

      const all = await writeBothPrefix();
      try {
        const skipped = await installerStep(all, {
          TURBOPANEL_SKIP_KERNEL_SWITCH: "1",
        });
        assertEquals(skipped.stdout.includes("REBOOTED"), false);
        assertEquals(
          await Deno.readTextFile(join(all, "boot/firmware/cmdline.txt")),
          PI_CMDLINE,
        );
      } finally {
        await Deno.remove(all, { recursive: true });
      }
    } finally {
      await Deno.remove(prefix, { recursive: true });
    }
  },
});
