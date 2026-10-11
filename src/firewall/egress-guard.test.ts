import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * The always-on Docker egress block (`orchestration/roles/docker/files/
 * turbopanel-docker-egress`, audit P1-4). The script is run for real with
 * stub `iptables` / `ip6tables` / `-restore` binaries that keep chain state in a
 * temp dir, so these tests cover rule generation, idempotence, survival of a
 * Docker restart (Docker rebuilds DOCKER-USER), re-ordering, removal, and the
 * list of platform traffic the rules must never touch.
 */

const here = dirname(fromFileUrl(import.meta.url));
const SCRIPT = join(
  here,
  "../../orchestration/roles/docker/files/turbopanel-docker-egress",
);

const STUB_IPTABLES = (dir: string) =>
  `#!/bin/sh
D=${dir}
[ "$1" = -w ] && shift 2
cmd=$1; chain=$2
case $cmd in
  -S) [ -z "$chain" ] && exit 0; [ -f "$D/c.$chain" ] || exit 1; echo "-N $chain"; cat "$D/c.$chain" ;;
  -C) shift 2; [ -f "$D/c.$chain" ] || exit 1; grep -qxF -- "-A $chain $*" "$D/c.$chain" ;;
  -I) shift 3; [ -f "$D/c.$chain" ] || exit 1
      { echo "-A $chain $*"; cat "$D/c.$chain"; } > "$D/tmp"; mv "$D/tmp" "$D/c.$chain" ;;
  -D) shift 2; line="-A $chain $*"; [ -f "$D/c.$chain" ] || exit 1
      awk -v l="$line" '$0==l && !done {done=1; next} {print}' "$D/c.$chain" > "$D/tmp"
      mv "$D/tmp" "$D/c.$chain" ;;
  -F) : > "$D/c.$chain" ;;
  -X) rm -f "$D/c.$chain" ;;
  *) exit 2 ;;
esac
`;

const STUB_RESTORE = (dir: string) =>
  `#!/bin/sh
D=${dir}
[ "$1" = -w ] && shift 2
for a in "$@"; do [ "$a" = --test ] && exit 0; done
while IFS= read -r line; do
  case $line in
    :*) c=\${line#:}; c=\${c%% *}; : > "$D/c.$c" ;;
    -A*) c=\${line#-A }; c=\${c%% *}; echo "$line" >> "$D/c.$c" ;;
  esac
done
`;

type Host = {
  root: string;
  env: Record<string, string>;
  chain(family: 4 | 6, name: string): string[] | null;
  run(...args: string[]): Promise<{ code: number; out: string; err: string }>;
};

async function makeHost(resolv = ""): Promise<Host> {
  const root = await Deno.makeTempDir({ prefix: "tp-egress-" });
  const bin = join(root, "bin");
  await Deno.mkdir(bin);
  for (const fam of [4, 6] as const) {
    const state = join(root, `v${fam}`);
    await Deno.mkdir(state);
    await Deno.writeTextFile(join(state, "c.INPUT"), "");
    await Deno.writeTextFile(
      join(state, "c.DOCKER-USER"),
      "-A DOCKER-USER -j RETURN\n",
    );
    await Deno.writeTextFile(join(bin, `ipt${fam}`), STUB_IPTABLES(state));
    await Deno.writeTextFile(join(bin, `res${fam}`), STUB_RESTORE(state));
    await Deno.chmod(join(bin, `ipt${fam}`), 0o755);
    await Deno.chmod(join(bin, `res${fam}`), 0o755);
  }
  const resolvFile = join(root, "resolv.conf");
  await Deno.writeTextFile(resolvFile, resolv);
  const env = {
    PATH: `${bin}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
    TP_EGRESS_IPTABLES: "ipt4",
    TP_EGRESS_IP6TABLES: "ipt6",
    TP_EGRESS_IPTABLES_RESTORE: "res4",
    TP_EGRESS_IP6TABLES_RESTORE: "res6",
    TP_EGRESS_RESOLV_FILES: resolvFile,
    TP_EGRESS_ALLOW_NONROOT: "1",
  };
  return {
    root,
    env,
    chain(family, name) {
      try {
        const text = Deno.readTextFileSync(
          join(root, `v${family}`, `c.${name}`),
        );
        return text.split("\n").filter((l) => l !== "");
      } catch {
        return null;
      }
    },
    async run(...args) {
      const out = await new Deno.Command("sh", {
        args: [SCRIPT, ...args],
        env,
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const dec = new TextDecoder();
      return {
        code: out.code,
        out: dec.decode(out.stdout),
        err: dec.decode(out.stderr),
      };
    },
  };
}

const JUMPS = [
  "-A INPUT -i br-+ -j TP-EGRESS",
  "-A INPUT -i docker0 -j TP-EGRESS",
];
// Forwarded traffic is matched on every interface, so a network with a custom
// bridge name (not docker0 or br-*) cannot step around the block.
const FWD_JUMPS = [
  "-A DOCKER-USER -j TP-EGRESS",
];

Deno.test("print4 drops link-local and cloud metadata with DNS exceptions first", async () => {
  const h = await makeHost("nameserver 169.254.10.2\nnameserver 8.8.8.8\n");
  const { code, out } = await h.run("print4");
  assertEquals(code, 0);
  const rules = out.split("\n").filter((l) => l.startsWith("-A "));
  const firstDrop = rules.findIndex((r) => r.endsWith("-j DROP"));
  const lastReturn = rules.map((r) => r.endsWith("-j RETURN")).lastIndexOf(
    true,
  );
  assert(lastReturn < firstDrop, "DNS exceptions must precede every DROP");
  for (const ns of ["169.254.169.253", "169.254.169.254", "169.254.10.2"]) {
    for (const p of ["udp", "tcp"]) {
      assertStringIncludes(
        out,
        `-A TP-EGRESS -p ${p} -m ${p} --dport 53 -d ${ns}/32 -j RETURN`,
      );
    }
  }
  assert(!out.includes("8.8.8.8"), "only link-local resolvers are excepted");
  for (
    const dst of ["169.254.0.0/16", "168.63.129.16/32", "100.100.100.200/32"]
  ) assertStringIncludes(out, `-A TP-EGRESS -d ${dst} -j DROP`);
  assert(out.startsWith("*filter\n:TP-EGRESS - [0:0]\n"));
  assert(out.endsWith("COMMIT\n"));
});

Deno.test("print6 drops fe80::/10 and AWS v6 metadata, keeps ICMPv6 and DNS", async () => {
  const h = await makeHost();
  const { out } = await h.run("print6");
  assertStringIncludes(out, "-A TP-EGRESS -p ipv6-icmp -j RETURN");
  assertStringIncludes(out, "-A TP-EGRESS -d fe80::/10 -j DROP");
  assertStringIncludes(out, "-A TP-EGRESS -d fd00:ec2::254/128 -j DROP");
  assertStringIncludes(out, "--dport 53 -d fd00:ec2::253/128 -j RETURN");
  assert(out.indexOf("ipv6-icmp") < out.indexOf("fe80::/10"));
});

Deno.test("platform traffic is never matched: only DNS RETURNs and the four metadata/link-local DROPs", async () => {
  const h = await makeHost();
  const four = (await h.run("print4")).out;
  const six = (await h.run("print6")).out;
  const allowedDrops4 = new Set([
    "169.254.0.0/16",
    "168.63.129.16/32",
    "100.100.100.200/32",
  ]);
  for (const line of four.split("\n").filter((l) => l.startsWith("-A "))) {
    if (line.endsWith("-j DROP")) {
      assert(allowedDrops4.has(line.split(" ")[3]), line);
    } else {
      assert(
        /--dport 53 -d (169\.254\.\d+\.\d+|168\.63\.129\.16)\/32 -j RETURN$/
          .test(line),
        line,
      );
    }
  }
  for (const line of six.split("\n").filter((l) => l.startsWith("-A "))) {
    assert(
      line.endsWith("-j DROP")
        ? ["fe80::/10", "fd00:ec2::254/128"].includes(line.split(" ")[3])
        : /ipv6-icmp -j RETURN$|--dport 53 -d fd00:ec2::253\/128 -j RETURN$/
          .test(line),
      line,
    );
  }
  // Nothing platform-facing is named anywhere: private ranges (project
  // networks, ProxySQL, Caddy/ingress, the daemon), loopback, published ports.
  for (
    const forbidden of [
      "10.0.0.0",
      "172.16.",
      "192.168.",
      "127.",
      "100.64.",
      "--dport 80",
      "--dport 443",
      "--dport 6033",
      "ACCEPT",
      "--sport",
      "conntrack",
    ]
  ) {
    assert(!four.includes(forbidden), forbidden);
    assert(!six.includes(forbidden), forbidden);
  }
  // Host-bound traffic is diverted from container-side interfaces only; forwarded traffic from any interface.
  const script = await Deno.readTextFile(SCRIPT);
  assertStringIncludes(script, 'IFACES="docker0 br-+"');
  assertStringIncludes(script, 'FORWARD_IFACES="any"');
  assertStringIncludes(script, 'HOOKS="INPUT DOCKER-USER"');
});

Deno.test("apply installs the chain and jumps, twice gives the same state", async () => {
  const h = await makeHost();
  assertEquals((await h.run("apply")).code, 0);
  const first = [4, 6].map((f) => [
    h.chain(f as 4 | 6, "TP-EGRESS"),
    h.chain(f as 4 | 6, "INPUT"),
    h.chain(f as 4 | 6, "DOCKER-USER"),
  ]);
  for (const f of [4, 6] as const) {
    assert(h.chain(f, "TP-EGRESS")!.length > 0);
    assertEquals(h.chain(f, "INPUT"), JUMPS);
    assertEquals(h.chain(f, "DOCKER-USER"), [
      ...FWD_JUMPS,
      "-A DOCKER-USER -j RETURN",
    ]);
  }
  assertEquals((await h.run("apply")).code, 0);
  const second = [4, 6].map((f) => [
    h.chain(f as 4 | 6, "TP-EGRESS"),
    h.chain(f as 4 | 6, "INPUT"),
    h.chain(f as 4 | 6, "DOCKER-USER"),
  ]);
  assertEquals(second, first);
});

Deno.test("apply after a Docker restart rebuilds DOCKER-USER and puts the jump back", async () => {
  const h = await makeHost();
  await h.run("apply");
  // dockerd recreated DOCKER-USER empty.
  await Deno.writeTextFile(
    join(h.root, "v4", "c.DOCKER-USER"),
    "-A DOCKER-USER -j RETURN\n",
  );
  assertEquals((await h.run("apply")).code, 0);
  assertEquals(h.chain(4, "DOCKER-USER"), [
    ...FWD_JUMPS,
    "-A DOCKER-USER -j RETURN",
  ]);
});

Deno.test("apply moves the jumps back to the front when another rule was inserted ahead", async () => {
  const h = await makeHost();
  await h.run("apply");
  const f = join(h.root, "v4", "c.DOCKER-USER");
  await Deno.writeTextFile(
    f,
    `-A DOCKER-USER -j TP-FWD\n${await Deno.readTextFile(f)}`,
  );
  await h.run("apply");
  const rules = h.chain(4, "DOCKER-USER")!;
  assertEquals(rules.slice(0, FWD_JUMPS.length), FWD_JUMPS);
  assertEquals(
    rules.filter((r) => r.includes("TP-EGRESS")).length,
    FWD_JUMPS.length,
  );
  assert(rules.includes("-A DOCKER-USER -j TP-FWD"));
});

Deno.test("apply without a DOCKER-USER chain (ip6tables off) still hangs INPUT", async () => {
  const h = await makeHost();
  await Deno.remove(join(h.root, "v6", "c.DOCKER-USER"));
  assertEquals((await h.run("apply")).code, 0);
  assertEquals(h.chain(6, "INPUT"), JUMPS);
  assertEquals(h.chain(6, "DOCKER-USER"), null);
});

Deno.test("remove takes every jump and the chain out and leaves foreign rules", async () => {
  const h = await makeHost();
  await h.run("apply");
  assertEquals((await h.run("remove")).code, 0);
  for (const f of [4, 6] as const) {
    assertEquals(h.chain(f, "TP-EGRESS"), null);
    assertEquals(h.chain(f, "INPUT"), []);
    assertEquals(h.chain(f, "DOCKER-USER"), ["-A DOCKER-USER -j RETURN"]);
  }
  assertEquals((await h.run("remove")).code, 0);
});

Deno.test("apply refuses to run as a non-root caller without the test override", async () => {
  const h = await makeHost();
  delete h.env.TP_EGRESS_ALLOW_NONROOT;
  const out = await new Deno.Command("sh", {
    args: [SCRIPT, "apply"],
    env: h.env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (Deno.uid() !== 0) assertEquals(out.code, 1);
});

Deno.test("the docker role installs the unit, script and wires it into main.yml", async () => {
  const role = join(here, "../../orchestration/roles/docker");
  const unit = await Deno.readTextFile(
    join(role, "templates/turbopanel-docker-egress.service.j2"),
  );
  assertStringIncludes(unit, "PartOf=docker.service");
  assertStringIncludes(unit, "After=docker.service");
  assertStringIncludes(unit, "WantedBy=multi-user.target docker.service");
  assert(!unit.includes("ExecStop"), "stopping must never open the block");
  const main = await Deno.readTextFile(join(role, "tasks/main.yml"));
  assertStringIncludes(main, "egress-guard.yml");
  const defaults = await Deno.readTextFile(join(role, "defaults/main.yml"));
  assertStringIncludes(defaults, "turbopanel_docker_egress_guard: true");
});

Deno.test("Azure wireserver DNS stays reachable while its other ports are dropped", async () => {
  const h = await makeHost("nameserver 168.63.129.16\n");
  const { code, out } = await h.run("print4");
  assertEquals(code, 0);
  for (const p of ["udp", "tcp"]) {
    const ret =
      `-A TP-EGRESS -p ${p} -m ${p} --dport 53 -d 168.63.129.16/32 -j RETURN`;
    assertStringIncludes(out, ret);
    assert(
      out.indexOf(ret) < out.indexOf("-d 168.63.129.16/32 -j DROP"),
      "DNS RETURN must precede the wireserver DROP",
    );
  }
  assertStringIncludes(out, "-A TP-EGRESS -d 168.63.129.16/32 -j DROP");
});

Deno.test("apply and remove skip IPv6 when ip6tables has no filter table", async () => {
  const h = await makeHost();
  await Deno.writeTextFile(
    join(h.root, "bin", "ipt6"),
    "#!/bin/sh\necho 'ip6tables: can not initialize' >&2\nexit 3\n",
  );
  const a = await h.run("apply");
  assertEquals(a.code, 0, a.err);
  assertStringIncludes(a.err, "IPv6 rules skipped");
  assertEquals(h.chain(4, "INPUT")?.slice(0, 2), JUMPS);
  const r = await h.run("remove");
  assertEquals(r.code, 0, r.err);
  assertEquals(h.chain(4, "TP-EGRESS"), null);
});

Deno.test("forwarded traffic is diverted whatever the ingress interface is called", async () => {
  const h = await makeHost();
  await h.run("apply");
  const rules = h.chain(4, "DOCKER-USER")!;
  // No `-i` on the forwarded jump: a bridge named `tpx0` is covered like br-*.
  assert(rules.some((r) => r === "-A DOCKER-USER -j TP-EGRESS"));
  assert(!rules.some((r) => r.includes("TP-EGRESS") && r.includes(" -i ")));
});

Deno.test("apply and remove clear the per-interface forwarded jumps of an older version", async () => {
  const h = await makeHost();
  const legacy = [
    "-A DOCKER-USER -i br-+ -j TP-EGRESS",
    "-A DOCKER-USER -i docker0 -j TP-EGRESS",
  ];
  await Deno.writeTextFile(
    join(h.root, "v4", "c.DOCKER-USER"),
    `${legacy.join("\n")}\n-A DOCKER-USER -j RETURN\n`,
  );
  await h.run("apply");
  assertEquals(h.chain(4, "DOCKER-USER"), [
    ...FWD_JUMPS,
    "-A DOCKER-USER -j RETURN",
  ]);
  await Deno.writeTextFile(
    join(h.root, "v4", "c.DOCKER-USER"),
    `${FWD_JUMPS.join("\n")}\n${legacy.join("\n")}\n-A DOCKER-USER -j RETURN\n`,
  );
  const r = await h.run("remove");
  assertEquals(r.code, 0, r.err);
  assertEquals(h.chain(4, "DOCKER-USER"), ["-A DOCKER-USER -j RETURN"]);
  assertEquals(h.chain(4, "TP-EGRESS"), null);
});
