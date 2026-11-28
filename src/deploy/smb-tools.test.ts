import { assertEquals, assertRejects } from "@std/assert";
import {
  decideSmbTools,
  ensureSmbTools,
  SMB_TOOLS_LOG_LINE,
} from "./smb-tools.ts";

const test = Deno.test.bind(Deno);

const DEBIAN = 'ID=debian\nVERSION_ID="12"\n';
const UBUNTU = "ID=ubuntu\nID_LIKE=debian\n";
const MINT = 'ID=linuxmint\nID_LIKE="ubuntu debian"\n';
const FEDORA = "ID=fedora\n";

test("decideSmbTools: present, install on Debian family, else unsupported", () => {
  assertEquals(decideSmbTools(true, { ID: "fedora" }), "present");
  assertEquals(decideSmbTools(false, { ID: "debian" }), "install");
  assertEquals(
    decideSmbTools(false, { ID: "linuxmint", ID_LIKE: "ubuntu debian" }),
    "install",
  );
  assertEquals(decideSmbTools(false, { ID: "fedora" }), "unsupported");
  assertEquals(decideSmbTools(false, {}), "unsupported");
});

function harness(present: boolean, osText: string, fail = false) {
  const calls = { setup: 0, log: [] as string[] };
  return {
    calls,
    deps: {
      helperPresent: () => Promise.resolve(present),
      readOsRelease: () => Promise.resolve(osText),
      runSetup: () => {
        calls.setup++;
        return fail ? Promise.reject(new Error("apt lock")) : Promise.resolve();
      },
      log: (line: string) => calls.log.push(line),
    },
  };
}

test("ensureSmbTools does nothing when mount.cifs exists (idempotent)", async () => {
  const h = harness(true, FEDORA);
  await ensureSmbTools(h.deps);
  await ensureSmbTools(h.deps);
  assertEquals(h.calls.setup, 0);
  assertEquals(h.calls.log, []);
});

test("ensureSmbTools logs and installs on Debian and Ubuntu", async () => {
  for (const os of [DEBIAN, UBUNTU, MINT]) {
    const h = harness(false, os);
    await ensureSmbTools(h.deps);
    assertEquals(h.calls.setup, 1);
    assertEquals(h.calls.log, [SMB_TOOLS_LOG_LINE]);
  }
  assertEquals(SMB_TOOLS_LOG_LINE, "Installing SMB tools (cifs-utils)");
});

test("ensureSmbTools reports other distros as not supported without installing", async () => {
  const h = harness(false, FEDORA);
  await assertRejects(
    () => ensureSmbTools(h.deps),
    Error,
    "not supported",
  );
  assertEquals(h.calls.setup, 0);
});

test("ensureSmbTools fails the deploy clearly when the install fails", async () => {
  const h = harness(false, DEBIAN, true);
  await assertRejects(
    () => ensureSmbTools(h.deps),
    Error,
    "Installing SMB tools (cifs-utils) failed",
  );
});
