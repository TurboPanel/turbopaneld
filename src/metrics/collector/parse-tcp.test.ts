import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "./baseline.ts";
import {
  parseNetstatTcpOrigDataSent,
  parseSnmpRetransSegs,
  tcpRetransmitPercent,
} from "./parse-tcp.ts";

const test = Deno.test.bind(Deno);

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

test("parseSnmpRetransSegs extracts RetransSegs by column name", () => {
  assertEquals(parseSnmpRetransSegs(fixture("proc-net-snmp-1.txt")), 150);
  assertEquals(parseSnmpRetransSegs(fixture("proc-net-snmp-2.txt")), 200);
});

test("parseNetstatTcpOrigDataSent extracts TCPOrigDataSent by column name", () => {
  assertEquals(
    parseNetstatTcpOrigDataSent(fixture("proc-net-netstat-1.txt")),
    90000,
  );
  assertEquals(
    parseNetstatTcpOrigDataSent(fixture("proc-net-netstat-2.txt")),
    93500,
  );
});

test("parseNetstatTcpOrigDataSent returns null when the column doesn't exist (older kernels)", () => {
  assertEquals(
    parseNetstatTcpOrigDataSent(
      fixture("proc-net-netstat-no-origdatasent.txt"),
    ),
    null,
  );
});

test("tcpRetransmitPercent computes a correct percent from two snapshots", () => {
  const tracker = new CounterBaselineTracker();
  const retrans1 = parseSnmpRetransSegs(fixture("proc-net-snmp-1.txt"));
  const orig1 = parseNetstatTcpOrigDataSent(fixture("proc-net-netstat-1.txt"));
  tcpRetransmitPercent(retrans1, orig1, tracker, 0);

  const retrans2 = parseSnmpRetransSegs(fixture("proc-net-snmp-2.txt"));
  const orig2 = parseNetstatTcpOrigDataSent(fixture("proc-net-netstat-2.txt"));
  const percent = tcpRetransmitPercent(retrans2, orig2, tracker, 0);

  const retransDelta = 50;
  const origDelta = 3500;
  assertEquals(percent, (retransDelta / (origDelta + retransDelta)) * 100);
});

test("tcpRetransmitPercent returns null when TCPOrigDataSent is unavailable", () => {
  const tracker = new CounterBaselineTracker();
  const retrans = parseSnmpRetransSegs(fixture("proc-net-snmp-1.txt"));
  const orig = parseNetstatTcpOrigDataSent(
    fixture("proc-net-netstat-no-origdatasent.txt"),
  );
  assertEquals(tcpRetransmitPercent(retrans, orig, tracker, 0), null);
});

test("tcpRetransmitPercent returns null on a 0/0 interval", () => {
  const tracker = new CounterBaselineTracker();
  tcpRetransmitPercent(100, 5000, tracker, 0);
  assertEquals(tcpRetransmitPercent(100, 5000, tracker, 0), null);
});

test("tcpRetransmitPercent returns null on first observation", () => {
  const tracker = new CounterBaselineTracker();
  assertEquals(tcpRetransmitPercent(100, 5000, tracker, 0), null);
});
