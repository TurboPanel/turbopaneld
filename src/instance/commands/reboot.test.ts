import { assertEquals, assertRejects } from "jsr:@std/assert";
import {
  handleReboot,
  REBOOT_HANDOFF_DELAY_MS,
  setRebootExecutorForTests,
} from "./reboot.ts";

Deno.test({
  name: "handleReboot returns scheduled true without invoking systemctl",
  fn: async () => {
    let invoked = false;
    setRebootExecutorForTests(async () => {
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

Deno.test({
  name: "handleReboot invokes stub executor after handoff delay",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let invoked = false;
    setRebootExecutorForTests(async () => {
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

Deno.test({
  name: "handleReboot rejects invalid payload",
  fn: async () => {
    setRebootExecutorForTests(async () => ({ success: true, stderr: "" }));
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
