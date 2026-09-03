import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  ensureDrivetempLoaded,
  setDrivetempDropinWriterForTests,
  setDrivetempExecutorForTests,
} from "./drivetemp.ts";

it("ensureDrivetempLoaded loads the module and writes the modules-load.d drop-in", async () => {
  const dropinWrites: Array<{ path: string; contents: string }> = [];
  setDrivetempExecutorForTests(() =>
    Promise.resolve({ success: true, stderr: "" })
  );
  setDrivetempDropinWriterForTests((path, contents) => {
    dropinWrites.push({ path, contents });
    return Promise.resolve();
  });
  try {
    const result = await ensureDrivetempLoaded();
    assertEquals(result, { loaded: true });
    assertEquals(dropinWrites, [{
      path: "/etc/modules-load.d/turbopanel-drivetemp.conf",
      contents: "drivetemp\n",
    }]);
  } finally {
    setDrivetempExecutorForTests(null);
    setDrivetempDropinWriterForTests(null);
  }
});

it("ensureDrivetempLoaded reports failure without throwing when modprobe exits non-zero", async () => {
  setDrivetempExecutorForTests(() =>
    Promise.resolve({ success: false, stderr: "module not found" })
  );
  try {
    const result = await ensureDrivetempLoaded();
    assertEquals(result.loaded, false);
    assertEquals(result.summary?.includes("module not found"), true);
  } finally {
    setDrivetempExecutorForTests(null);
  }
});

it("ensureDrivetempLoaded never rejects when the executor itself throws (no sudo/modprobe binary)", async () => {
  setDrivetempExecutorForTests(() => {
    throw new Error("No such file or directory (os error 2)");
  });
  try {
    // The daemon fires this fire-and-forget (`void ensureDrivetempLoaded()`)
    // with no .catch() — a rejection here would be an unhandled rejection
    // that takes the process down, so this must resolve, never reject.
    const result = await ensureDrivetempLoaded();
    assertEquals(result.loaded, false);
    assertEquals(
      result.summary?.includes("No such file or directory"),
      true,
    );
  } finally {
    setDrivetempExecutorForTests(null);
  }
});

it("ensureDrivetempLoaded reports loaded:true with a summary when the drop-in write fails", async () => {
  setDrivetempExecutorForTests(() =>
    Promise.resolve({ success: true, stderr: "" })
  );
  setDrivetempDropinWriterForTests(() => {
    throw new Error("Permission denied");
  });
  try {
    const result = await ensureDrivetempLoaded();
    assertEquals(result.loaded, true);
    assertEquals(result.summary?.includes("Permission denied"), true);
  } finally {
    setDrivetempExecutorForTests(null);
    setDrivetempDropinWriterForTests(null);
  }
});
