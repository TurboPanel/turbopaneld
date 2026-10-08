import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  addBootConfigLineTop,
  KERNEL_FEATURE_BOOT_LINE,
  KERNEL_FEATURE_IDS,
  needsReboot,
  type PiFourKPagesizeFacts,
  piFourKPagesizeState,
  removeBootConfigLineTop,
  scanBootConfigKernelLines,
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

test("KERNEL_FEATURE_IDS lists pi-4k-pagesize and that feature needs a reboot", () => {
  assertEquals(KERNEL_FEATURE_IDS, ["pi-4k-pagesize"]);
  assertEquals(needsReboot("pi-4k-pagesize"), true);
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
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("sh", {
    args: [SCRIPT, ...verb],
    clearEnv: true,
    env: {
      PATH: "/usr/bin:/bin",
      TP_KERNEL_TEST_PREFIX: prefix,
      TP_KERNEL_TEST_PAGESIZE: pageSize,
      TP_KERNEL_TEST_ENROL_WAIT: "0",
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
