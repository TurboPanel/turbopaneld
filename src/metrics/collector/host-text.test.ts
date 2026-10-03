import { assertEquals } from "@std/assert";
import {
  HOST_TEXT_TTL_MS,
  HostTextCollector,
  type HostTextIo,
  parseCloudProvider,
  parseFailedUnits,
  parseLastOomVictim,
  parseOs,
  parseProcStat,
  parseVirt,
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
