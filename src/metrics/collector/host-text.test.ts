import { assertEquals } from "@std/assert";
import { METRICS_TEXT_FIELD_NAMES } from "../../contracts/metrics-contract.ts";
import {
  HOST_TEXT_TTL_MS,
  HostTextCollector,
  type HostTextIo,
  hostTextToExtended,
  parseCloudProvider,
  parseFailedUnits,
  parseLastOomVictim,
  parseOs,
  parsePhpPool,
  parseProcStat,
  parseSharedFpmPool,
  parseVirt,
  parseWebEngines,
  raidStateFromMdstat,
  readOnlyMounts,
  shortName,
} from "./host-text.ts";

const test = Deno.test.bind(Deno);

test("shortName strips everything but a short safe token", () => {
  assertEquals(shortName("nginx: worker; rm -rf /"), "nginxworkerrm-rf");
  assertEquals(shortName("   "), undefined);
});

test("parseOs reads ID and VERSION_ID only", () => {
  assertEquals(
    parseOs('PRETTY_NAME="Debian GNU/Linux 13"\nID=debian\nVERSION_ID="13"\n'),
    "debian 13",
  );
});

test("parseVirt: Hyper-V asset tag and vendor ambiguity", () => {
  assertEquals(
    parseVirt("Acme", "x", undefined, "7783-7084-3265-9"),
    "microsoft",
  );
  assertEquals(
    parseVirt("Microsoft Corporation", "Surface", undefined, undefined),
    "none",
  );
  assertEquals(parseVirt("QEMU", "Standard PC", undefined, undefined), "kvm");
});

test("parseCloudProvider maps DMI strings to provider names only", () => {
  assertEquals(parseCloudProvider("Amazon EC2", "t3", undefined), "aws");
  assertEquals(parseCloudProvider("Dell", "R740", undefined), undefined);
});

test("parseFailedUnits keeps unit names, caps the list", () => {
  const out =
    "● foo.service loaded failed failed Foo\nbar.timer loaded failed failed Bar\n";
  assertEquals(parseFailedUnits(out), ["foo.service", "bar.timer"]);
});

test("raidStateFromMdstat distinguishes none / ok / degraded", () => {
  assertEquals(
    raidStateFromMdstat("Personalities :\nunused devices: <none>\n"),
    "none",
  );
  assertEquals(
    raidStateFromMdstat(
      "md0 : active raid1 sdb1[1] sda1[0]\n      100 blocks [2/1] [U_]\n",
    ),
    "degraded",
  );
});

test("readOnlyMounts lists only real filesystems mounted ro", () => {
  const mounts =
    "/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /data ext4 ro,relatime 0 0\nsquash /snap/x squashfs ro 0 0\n";
  assertEquals(readOnlyMounts(mounts), ["/data"]);
});

test("parseLastOomVictim returns the last killed process short name", () => {
  assertEquals(
    parseLastOomVictim(
      "Killed process 1 (a) x\nKilled process 2 (php-fpm8.3) y",
    ),
    "php-fpm8.3",
  );
});

test("parseProcStat handles spaces/parens in comm and returns utime+stime", () => {
  const stat =
    "42 (my (odd) proc) S 1 1 1 0 -1 0 0 0 0 0 7 5 0 0 20 0 1 0 1 1 1";
  assertEquals(parseProcStat(stat), { comm: "myoddproc", ticks: 12 });
});

function fakeIo(): {
  io: HostTextIo;
  reads: string[];
  clock: { t: number };
  ticks: { v: number };
} {
  const reads: string[] = [];
  const clock = { t: 0 };
  const ticks = { v: 10 };
  const files: Record<string, string> = {
    "/proc/sys/kernel/osrelease": "6.12.1\n",
    "/etc/os-release": "ID=debian\nVERSION_ID=13\n",
    "/var/run/reboot-required": "",
  };
  const io: HostTextIo = {
    readFile: (p) => {
      reads.push(p);
      if (p === "/proc/100/stat") {
        return `100 (heavy) S 1 1 1 0 -1 0 0 0 0 0 ${ticks.v} 0 0 0`;
      }
      if (p === "/proc/200/stat") {
        return "200 (idle) S 1 1 1 0 -1 0 0 0 0 0 1 0 0 0";
      }
      if (p === "/proc/100/statm") return "10 50 0";
      if (p === "/proc/200/statm") return "10 5 0";
      return files[p];
    },
    listPids: () => Promise.resolve(["100", "200", "self"]),
    run: (cmd) =>
      Promise.resolve(
        cmd === "systemctl"
          ? { code: 0, stdout: "foo.service loaded failed failed Foo\n" }
          : null,
      ),
    clockSynced: () => true,
    phpVersions: () => ["8.3"],
    blockDisks: () => Promise.resolve([]),
    now: () => clock.t,
    pageSizeBytes: 4096,
  };
  return { io, reads, clock, ticks };
}

test("HostTextCollector gathers short-name facts and never reads command lines", async () => {
  const { io, reads, clock, ticks } = fakeIo();
  const collector = new HostTextCollector(io);
  const first = await collector.read();
  assertEquals(first.kernel, "6.12.1");
  assertEquals(first.os, "debian 13");
  assertEquals(first.rebootRequired, true);
  assertEquals(first.unhealthyUnits, ["foo.service"]);
  assertEquals(first.phpVersions, ["8.3"]);
  assertEquals(first.topMemProcess, "heavy");
  assertEquals(first.topCpuProcess, undefined);
  clock.t = HOST_TEXT_TTL_MS + 1;
  ticks.v = 500;
  const second = await collector.read();
  assertEquals(second.topCpuProcess, "heavy");
  assertEquals(reads.some((p) => p.endsWith("/cmdline")), false);
});

test("HostTextCollector serves the cache inside the TTL", async () => {
  const { io, reads } = fakeIo();
  const collector = new HostTextCollector(io);
  await collector.read();
  const n = reads.length;
  await collector.read();
  assertEquals(reads.length, n);
});

test("parseWebEngines reads installed engine packages only", () => {
  const status = [
    "Package: nginx\nStatus: install ok installed\nVersion: 1:1.26.3-1~deb13u1",
    "Package: apache2\nStatus: deinstall ok config-files\nVersion: 2.4.62-1",
    "Package: caddy\nStatus: install ok installed\nVersion: 2.8.4",
    "Package: vim\nStatus: install ok installed\nVersion: 9.1",
  ].join("\n\n");
  assertEquals(parseWebEngines(status), ["nginx 1.26.3", "caddy 2.8.4"]);
  assertEquals(parseWebEngines(undefined), []);
});

test("parsePhpPool pulls the site id from the php unit cgroup", () => {
  assertEquals(
    parsePhpPool("0::/system.slice/turbopanel-php-abc123.service\n"),
    "abc123",
  );
  assertEquals(parsePhpPool("0::/system.slice/ssh.service"), undefined);
  assertEquals(parsePhpPool(undefined), undefined);
});

test("HostTextCollector reports the busiest PHP pool and engines", async () => {
  const stat = (n: number) =>
    `1 (php-fpm8.3) S 1 1 1 0 -1 0 0 0 0 0 ${n} 0 0 0`;
  let busy = 0;
  const io: HostTextIo = {
    readFile: (p) => {
      if (p === "/proc/11/stat") return stat(busy);
      if (p === "/proc/12/stat") return stat(5);
      if (p.endsWith("/statm")) return "1 10 0";
      if (p === "/proc/11/cgroup") return "0::/turbopanel-php-aaa.service";
      if (p === "/proc/12/cgroup") return "0::/turbopanel-php-bbb.service";
      if (p === "/var/lib/dpkg/status") {
        return "Package: nginx\nStatus: install ok installed\nVersion: 1.2.3";
      }
      return undefined;
    },
    listPids: () => Promise.resolve(["11", "12"]),
    run: () => Promise.resolve(null),
    clockSynced: () => undefined,
    phpVersions: () => [],
    blockDisks: () => Promise.resolve([]),
    now: () => clock.t,
    pageSizeBytes: 4096,
  };
  const clock = { t: 0 };
  const collector = new HostTextCollector(io);
  const first = await collector.read();
  assertEquals(first.webEngines, ["nginx 1.2.3"]);
  assertEquals(first.fpmBusiest, "aaa");
  clock.t = HOST_TEXT_TTL_MS + 1;
  busy = 900;
  assertEquals((await collector.read()).fpmBusiest, "aaa");
});

test("OOM victim: dmesg only runs when the kernel counter moved, victim sticks", async () => {
  let kills = 0;
  let dmesgRuns = 0;
  const clock = { t: 0 };
  const io: HostTextIo = {
    readFile: (p) => p === "/proc/vmstat" ? `oom_kill ${kills}\n` : undefined,
    listPids: () => Promise.resolve([]),
    run: (cmd) => {
      if (cmd === "dmesg") dmesgRuns++;
      return Promise.resolve(
        cmd === "dmesg"
          ? {
            code: 0,
            stdout: "Out of memory: Killed process 9 (php-fpm8.3) x",
          }
          : null,
      );
    },
    clockSynced: () => undefined,
    phpVersions: () => [],
    blockDisks: () => Promise.resolve([]),
    now: () => clock.t,
    pageSizeBytes: 4096,
  };
  const collector = new HostTextCollector(io);
  assertEquals((await collector.read()).lastOomVictim, undefined);
  assertEquals(dmesgRuns, 0);
  kills = 1;
  clock.t = HOST_TEXT_TTL_MS + 1;
  assertEquals((await collector.read()).lastOomVictim, "php-fpm8.3");
  clock.t *= 3;
  assertEquals((await collector.read()).lastOomVictim, "php-fpm8.3");
  assertEquals(dmesgRuns, 1);
});

Deno.test("hostTextToExtended uses exactly the contract's text keys", () => {
  const { text, blockDeviceText } = hostTextToExtended({
    kernel: "6.1",
    unhealthyUnits: ["a.service", "b.service"],
    rebootRequired: true,
    clockSynced: false,
    pendingUpdates: 4,
    phpVersions: ["8.2", "8.3"],
    topCpuProcess: "php-fpm",
    topMemProcess: "mysqld",
    readOnlyFilesystems: ["/data"],
    lastOomVictim: "node",
    smart: { sda: "ok" },
  });
  assertEquals(text, {
    kernel: "6.1",
    failedUnits: "a.service,b.service",
    rebootRequired: "yes",
    timeSync: "unsynced",
    pendingUpdates: "4",
    phpVersions: "8.2,8.3",
    topCpu: "php-fpm",
    topMem: "mysqld",
    fsReadOnly: "/data",
    lastOom: "node",
  });
  assertEquals(blockDeviceText, [{ deviceId: "sda", smart: "ok" }]);
  for (const key of Object.keys(text ?? {})) {
    assertEquals(
      (METRICS_TEXT_FIELD_NAMES as readonly string[]).includes(key),
      true,
    );
  }
  assertEquals(hostTextToExtended({}), {});
});

Deno.test("shared php-fpm masters attribute workers to the pool in the process title", () => {
  const cg =
    "0::/system.slice/system-turbopanel\\x2dphp\\x2dfpm.slice/turbopanel-php-fpm@8.3.service\n";
  assertEquals(parsePhpPool(cg), undefined);
  assertEquals(parseSharedFpmPool(cg, "php-fpm: pool site42\0"), "site42");
  assertEquals(
    parseSharedFpmPool(cg, "php-fpm: master process (/x.conf)\0"),
    undefined,
  );
  assertEquals(
    parseSharedFpmPool("0::/other.service\n", "php-fpm: pool a\0"),
    undefined,
  );
});

Deno.test("fpmBusiest includes workers of a shared php-fpm master", async () => {
  const stat = `1 (php-fpm8.3) S 1 1 1 0 -1 0 0 0 0 0 1 0 0 0`;
  const io: HostTextIo = {
    readFile: (p) => {
      if (p.endsWith("/stat")) return stat;
      if (p === "/proc/21/statm") return "1 900 0";
      if (p === "/proc/22/statm") return "1 100 0";
      if (p.endsWith("/cgroup")) return "0::/turbopanel-php-fpm@8.3.service";
      if (p === "/proc/21/cmdline") return "php-fpm: pool shared-a\0";
      if (p === "/proc/22/cmdline") return "php-fpm: pool shared-b\0";
      return undefined;
    },
    listPids: () => Promise.resolve(["21", "22"]),
    run: () => Promise.resolve(null),
    clockSynced: () => undefined,
    phpVersions: () => [],
    blockDisks: () => Promise.resolve([]),
    now: () => 0,
    pageSizeBytes: 4096,
  };
  assertEquals((await new HostTextCollector(io).read()).fpmBusiest, "shared-a");
});
