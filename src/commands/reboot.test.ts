import { assertEquals, assertRejects } from "@std/assert";
import {
  handleReboot,
  REBOOT_HANDOFF_DELAY_MS,
  setRebootExecutorForTests,
} from "./reboot.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test({
  name: "handleReboot returns scheduled true without invoking systemctl",
  fn: async () => {
    let invoked = false;
    setRebootExecutorForTests(async () => {
      await Promise.resolve();
      invoked = true;
      return { success: true, stderr: "" };
    });
    try {
      const result = await handleReboot({}, new Date().toISOString());
      assertEquals(result, { scheduled: true });
      assertEquals(invoked, false);
    } finally {
      setRebootExecutorForTests(null);
    }
  },
});

test({
  name: "handleReboot invokes stub executor after handoff delay",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let invoked = false;
    setRebootExecutorForTests(async () => {
      await Promise.resolve();
      invoked = true;
      return { success: true, stderr: "" };
    });
    try {
      await handleReboot({}, new Date().toISOString());
      assertEquals(invoked, false);
      await new Promise((resolve) =>
        setTimeout(resolve, REBOOT_HANDOFF_DELAY_MS + 100)
      );
      assertEquals(invoked, true);
    } finally {
      setRebootExecutorForTests(null);
    }
  },
});

test({
  name: "handleReboot logs failed executor without throwing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    setRebootExecutorForTests(() =>
      Promise.resolve({
        success: false,
        stderr: "permission denied\r\nline2\tfail",
      })
    );
    try {
      const result = await handleReboot({}, new Date().toISOString());
      assertEquals(result, { scheduled: true });
      await new Promise((resolve) =>
        setTimeout(resolve, REBOOT_HANDOFF_DELAY_MS + 100)
      );
    } finally {
      setRebootExecutorForTests(null);
    }
  },
});

test({
  name: "handleReboot default executor invokes sudo systemctl reboot",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const originalCommand = Deno.Command;
    const calls: string[][] = [];
    try {
      Deno.Command = class {
        #args: string[];
        constructor(cmd: string, opts: Deno.CommandOptions) {
          if (cmd !== "sudo") {
            throw new TypeError(`unexpected command: ${cmd}`);
          }
          this.#args = (opts.args ?? []) as string[];
          calls.push([...this.#args]);
        }
        output() {
          return Promise.resolve({
            success: true,
            code: 0,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          });
        }
      } as unknown as typeof Deno.Command;

      setRebootExecutorForTests(null);
      const result = await handleReboot({}, new Date().toISOString());
      assertEquals(result, { scheduled: true });
      assertEquals(calls, []);
      await new Promise((resolve) =>
        setTimeout(resolve, REBOOT_HANDOFF_DELAY_MS + 100)
      );
      assertEquals(calls, [["-n", "systemctl", "reboot"]]);
    } finally {
      Deno.Command = originalCommand;
      setRebootExecutorForTests(null);
    }
  },
});

test({
  name: "handleReboot rejects invalid payload",
  fn: async () => {
    setRebootExecutorForTests(() =>
      Promise.resolve({ success: true, stderr: "" })
    );
    try {
      await assertRejects(
        () => handleReboot(null as unknown as Record<string, never>, ""),
        Error,
        "Invalid reboot payload",
      );
    } finally {
      setRebootExecutorForTests(null);
    }
  },
});
