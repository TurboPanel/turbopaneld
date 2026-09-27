import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  defaultDockerDiagnosisIo,
  diagnoseDockerUnreachable,
  explainDockerUnreachable,
  parseDockerGroup,
  parseProcessGroups,
  parseSystemctlShow,
} from "./docker-diagnosis.ts";

const test = Deno.test.bind(Deno);

// kore, 2026-09-27: tp in docker (989), daemon process started before that.
const KORE_GROUP_FILE = "root:x:0:\ntp:x:9999:\ndocker:x:989:tp\n";
const KORE_STALE_STATUS =
  "Name:\tturbopaneld\nUid:\t9999\t9999\t9999\t9999\nGroups:\t9999 \n";
const FRESH_STATUS = "Name:\tturbopaneld\nGroups:\t989 9999\n";

test("parseSystemctlShow reads ActiveState and Result", () => {
  assertEquals(
    parseSystemctlShow("ActiveState=failed\nResult=start-limit-hit\n"),
    {
      activeState: "failed",
      result: "start-limit-hit",
    },
  );
  assertEquals(parseSystemctlShow(""), { activeState: "", result: "" });
});

test("parseProcessGroups reads the Groups line", () => {
  assertEquals(parseProcessGroups(KORE_STALE_STATUS), [9999]);
  assertEquals(parseProcessGroups(FRESH_STATUS), [989, 9999]);
  assertEquals(parseProcessGroups("Name:\tx\n"), []);
});

test("parseDockerGroup finds the docker gid and members", () => {
  assertEquals(parseDockerGroup(KORE_GROUP_FILE), {
    gid: 989,
    members: ["tp"],
  });
  assertEquals(parseDockerGroup("root:x:0:\n"), null);
  assertEquals(parseDockerGroup("docker:x:abc:tp\n"), null);
});

test("a stopped Docker is reported first, with systemd's lockout spelled out", () => {
  const msg = explainDockerUnreachable({
    service: { activeState: "failed", result: "start-limit-hit" },
    processGroups: [9999],
    dockerGroup: { gid: 989, members: ["tp"] },
    username: "tp",
    probeStderr: "Cannot connect to the Docker daemon",
  });
  assertStringIncludes(
    msg,
    "Docker service is not running (ActiveState=failed, Result=start-limit-hit)",
  );
  assertStringIncludes(msg, "stopped retrying");
  assertStringIncludes(msg, "journalctl -u docker");
});

test("a daemon user outside the docker group is named", () => {
  const msg = explainDockerUnreachable({
    service: { activeState: "active", result: "success" },
    processGroups: [9999],
    dockerGroup: { gid: 989, members: [] },
    username: "tp",
    probeStderr: "permission denied",
  });
  assertStringIncludes(msg, "tp is not in the docker group");
});

test("stale process groups say to restart the daemon", () => {
  const msg = explainDockerUnreachable({
    service: { activeState: "active", result: "success" },
    processGroups: [9999],
    dockerGroup: { gid: 989, members: ["tp"] },
    username: "tp",
    probeStderr: "permission denied while trying to connect to the docker API",
  });
  assertStringIncludes(msg, "without the docker group (gid 989)");
  assertStringIncludes(msg, "restart the daemon");
});

test("otherwise Docker's own first error line is surfaced", () => {
  const msg = explainDockerUnreachable({
    service: { activeState: "active", result: "success" },
    processGroups: [989, 9999],
    dockerGroup: { gid: 989, members: ["tp"] },
    username: "tp",
    probeStderr: "\nerror during connect: context deadline exceeded\nmore",
  });
  assertEquals(
    msg,
    "Docker Engine API still unreachable after docker-setup: error during connect: context deadline exceeded",
  );
  assertEquals(
    explainDockerUnreachable({
      service: null,
      processGroups: [],
      dockerGroup: null,
      username: "",
      probeStderr: "",
    }),
    "Docker Engine API still unreachable after docker-setup",
  );
});

test("diagnoseDockerUnreachable reads the host through its seams", async () => {
  const msg = await diagnoseDockerUnreachable("permission denied", {
    systemctlShow: () =>
      Promise.resolve("ActiveState=active\nResult=success\n"),
    readProcStatus: () => Promise.resolve(KORE_STALE_STATUS),
    readGroupFile: () => Promise.resolve(KORE_GROUP_FILE),
    username: () => Promise.resolve("tp"),
  });
  assertStringIncludes(msg, "restart the daemon");
});

test("a stopped Docker without a failure Result omits the Result and lockout note", () => {
  const msg = explainDockerUnreachable({
    service: { activeState: "inactive", result: "success" },
    processGroups: [],
    dockerGroup: null,
    username: "tp",
    probeStderr: "",
  });
  assertEquals(
    msg,
    "Docker service is not running (ActiveState=inactive); check `journalctl -u docker`",
  );
});

test("an unknown service state falls through to the group checks", () => {
  const msg = explainDockerUnreachable({
    service: { activeState: "", result: "" },
    processGroups: [9999],
    dockerGroup: { gid: 989, members: ["tp"] },
    username: "tp",
    probeStderr: "",
  });
  assertStringIncludes(msg, "restart the daemon");
});

test("with no username the membership check is skipped", () => {
  const msg = explainDockerUnreachable({
    service: null,
    processGroups: [989],
    dockerGroup: { gid: 989, members: [] },
    username: "",
    probeStderr: "boom",
  });
  assertEquals(
    msg,
    "Docker Engine API still unreachable after docker-setup: boom",
  );
});

test("parseDockerGroup handles a docker line with no member field", () => {
  assertEquals(parseDockerGroup("docker:x:989\n"), { gid: 989, members: [] });
});

test("empty host reads still produce an explanation", async () => {
  const msg = await diagnoseDockerUnreachable("", {
    systemctlShow: () => Promise.resolve(""),
    readProcStatus: () => Promise.resolve(""),
    readGroupFile: () => Promise.resolve(""),
    username: () => Promise.resolve(""),
  });
  assertEquals(msg, "Docker Engine API still unreachable after docker-setup");
});

test("the default host reads never throw", async () => {
  const [show, status, group, user] = await Promise.all([
    defaultDockerDiagnosisIo.systemctlShow(),
    defaultDockerDiagnosisIo.readProcStatus(),
    defaultDockerDiagnosisIo.readGroupFile(),
    defaultDockerDiagnosisIo.username(),
  ]);
  for (const value of [show, status, group, user]) {
    assertEquals(typeof value, "string");
  }
  assertEquals(typeof (await diagnoseDockerUnreachable("x")), "string");
});
