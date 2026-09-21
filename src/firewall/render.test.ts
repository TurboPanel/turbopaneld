import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  FirewallReconcilePayload,
  FirewallRule,
} from "../contracts/commands-contracts.ts";
import {
  CONTAINER_INGRESS_INTERFACES,
  FIREWALL_FORWARD_CHAIN,
  FIREWALL_INPUT_CHAIN,
  renderFirewall,
} from "./render.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function payload(
  overrides: Partial<FirewallReconcilePayload> = {},
): FirewallReconcilePayload {
  return {
    generation: 1,
    mode: "managed",
    policy: { inputDefault: "accept", ipv6: "mirror" },
    rules: [],
    ...overrides,
  };
}

function rule(overrides: Partial<FirewallRule> & { id: string }): FirewallRule {
  return {
    scope: "host",
    action: "accept",
    proto: "tcp",
    sources: ["any"],
    origin: "user",
    ...overrides,
  };
}

const BOTH = { 4: true, 6: true } as const;

function lines(doc: string): string[] {
  return doc.split("\n").filter((line) => line.length > 0);
}

test("renders the invariants first, in both families, and never touches OUTPUT or a builtin policy", () => {
  const out = renderFirewall({
    payload: payload(),
    sshPorts: [22],
    includeForward: BOTH,
  });
  const v4 = lines(out.v4);
  assertEquals(v4[0], "*filter");
  assertEquals(v4[1], `:${FIREWALL_INPUT_CHAIN} - [0:0]`);
  assertEquals(v4[2], `:${FIREWALL_FORWARD_CHAIN} - [0:0]`);
  assertStringIncludes(v4[3]!, "-i lo");
  assertStringIncludes(v4[4]!, "--ctstate ESTABLISHED,RELATED");
  assertStringIncludes(v4[5]!, "-p icmp");
  assertStringIncludes(v4[6]!, "--sport 67 --dport 68");
  assertStringIncludes(v4[7]!, "-p tcp --dport 22");
  assertEquals(v4.at(-1), "COMMIT");
  assert(!out.v4.includes("OUTPUT"), "outbound is never rendered");
  assert(!out.v4.includes(":INPUT"), "builtin policy lines are never emitted");
  assert(
    !out.v4.includes("-j TP-"),
    "jumps are ensured by apply, not the document",
  );

  const v6 = lines(out.v6!);
  assertStringIncludes(v6.join("\n"), "-p ipv6-icmp");
  assertStringIncludes(v6.join("\n"), "--sport 547 --dport 546");
  assert(!out.v6!.includes("-p icmp "), "v4 icmp does not leak into v6");
  assertEquals(out.guaranteedTcpPorts, [22]);
  assertEquals(out.ruleCount, 0);
  assertEquals(out.warnings, []);
});

test("the forward chain opens with reply and container-egress RETURNs and ends without a default", () => {
  const out = renderFirewall({
    payload: payload(),
    sshPorts: [22],
    includeForward: BOTH,
  });
  const fwd = lines(out.v4).filter((l) =>
    l.startsWith(`-A ${FIREWALL_FORWARD_CHAIN}`)
  );
  assertStringIncludes(fwd[0]!, "--ctstate ESTABLISHED,RELATED");
  assertStringIncludes(fwd[0]!, "-j RETURN");
  for (const [index, iface] of CONTAINER_INGRESS_INTERFACES.entries()) {
    assertStringIncludes(fwd[index + 1]!, `-i ${iface}`);
    assertStringIncludes(fwd[index + 1]!, "-j RETURN");
  }
  assertEquals(fwd.length, 1 + CONTAINER_INGRESS_INTERFACES.length);
  assert(!fwd.some((l) => l.endsWith("-j DROP")), "no default drop in TP-FWD");
});

test("default drop lands last in TP-INPUT and only there", () => {
  const out = renderFirewall({
    payload: payload({ policy: { inputDefault: "drop", ipv6: "skip" } }),
    sshPorts: [22],
    includeForward: { 4: true, 6: false },
  });
  const input = lines(out.v4).filter((l) =>
    l.startsWith(`-A ${FIREWALL_INPUT_CHAIN}`)
  );
  assertEquals(
    input.at(-1),
    `-A ${FIREWALL_INPUT_CHAIN} -m comment --comment "tp:system:default" -j DROP`,
  );
  assertEquals(out.v6, null);
});

test("host rules: blocks before accepts, sources split by family, comments carry origin and id", () => {
  const out = renderFirewall({
    payload: payload({
      rules: [
        rule({
          id: "ssh-dc",
          ports: "22",
          sources: ["10.0.0.0/8", "2001:db8::/32"],
          origin: "derived",
          comment: "sshd from the datacenter",
        }),
        rule({
          id: "block-scanner",
          action: "drop",
          proto: "any",
          sources: ["203.0.113.9/32"],
        }),
        rule({
          id: "reject-udp",
          action: "reject",
          proto: "udp",
          ports: "5000-5010",
          sources: ["any"],
        }),
      ],
    }),
    sshPorts: [22],
    includeForward: BOTH,
  });
  const v4 = lines(out.v4).filter((l) =>
    l.startsWith(`-A ${FIREWALL_INPUT_CHAIN}`) && l.includes("tp:user") ||
    l.includes("tp:derived")
  );
  assertEquals(v4, [
    `-A TP-INPUT -s 203.0.113.9/32 -m comment --comment "tp:user:block-scanner" -j DROP`,
    `-A TP-INPUT -p udp --dport 5000:5010 -m comment --comment "tp:user:reject-udp" -j REJECT --reject-with icmp-port-unreachable`,
    `-A TP-INPUT -s 10.0.0.0/8 -p tcp --dport 22 -m comment --comment "tp:derived:ssh-dc sshd from the datacenter" -j ACCEPT`,
  ]);
  const v6 = lines(out.v6!).filter((l) =>
    l.includes("tp:user") || l.includes("tp:derived")
  );
  assertEquals(v6, [
    `-A TP-INPUT -p udp --dport 5000:5010 -m comment --comment "tp:user:reject-udp" -j REJECT --reject-with icmp6-port-unreachable`,
    `-A TP-INPUT -s 2001:db8::/32 -p tcp --dport 22 -m comment --comment "tp:derived:ssh-dc sshd from the datacenter" -j ACCEPT`,
  ]);
  assertEquals(out.ruleCount, 3);
  assertEquals(out.warnings, []);
});

test("published accept from any renders nothing; narrowed accept renders RETURNs then a DROP", () => {
  const out = renderFirewall({
    payload: payload({
      rules: [
        rule({
          id: "traefik-443",
          scope: "published",
          ports: "443",
          sources: ["any"],
          origin: "derived",
        }),
        rule({
          id: "proxysql",
          scope: "published",
          ports: "5432",
          sources: ["10.1.0.0/16", "10.2.0.0/16"],
          destinations: ["198.51.100.4/32"],
          origin: "derived",
        }),
      ],
    }),
    sshPorts: [22],
    includeForward: BOTH,
  });
  const fwd = lines(out.v4).filter((l) => l.includes("tp:derived"));
  assertEquals(fwd, [
    `-A TP-FWD -s 10.1.0.0/16 -p tcp -m conntrack --ctorigdstport 5432 --ctorigdst 198.51.100.4/32 -m comment --comment "tp:derived:proxysql" -j RETURN`,
    `-A TP-FWD -s 10.2.0.0/16 -p tcp -m conntrack --ctorigdstport 5432 --ctorigdst 198.51.100.4/32 -m comment --comment "tp:derived:proxysql" -j RETURN`,
    `-A TP-FWD -p tcp -m conntrack --ctorigdstport 5432 --ctorigdst 198.51.100.4/32 -m comment --comment "tp:derived:proxysql" -j DROP`,
  ]);
  // v6: the destination is v4-only, so the rule says nothing there
  assert(!out.v6!.includes("proxysql"));
  assertEquals(out.ruleCount, 1);
  // an accept-from-any on a published port is not a warning
  assertEquals(out.warnings, []);
});

test("published narrowing with sources of only one family still closes the port in the other", () => {
  const out = renderFirewall({
    payload: payload({
      rules: [
        rule({
          id: "listener",
          scope: "published",
          ports: "15432",
          sources: ["10.9.0.0/24"],
          origin: "derived",
        }),
      ],
    }),
    sshPorts: [22],
    includeForward: BOTH,
  });
  const v6 = lines(out.v6!).filter((l) => l.includes("listener"));
  assertEquals(v6, [
    `-A TP-FWD -p tcp -m conntrack --ctorigdstport 15432 -m comment --comment "tp:derived:listener" -j DROP`,
  ]);
});

test("published drop / reject render directly; every-port drop needs no port match", () => {
  const out = renderFirewall({
    payload: payload({
      rules: [
        rule({
          id: "ban",
          scope: "published",
          action: "drop",
          proto: "any",
          sources: ["192.0.2.0/24"],
        }),
        rule({
          id: "no-udp",
          scope: "published",
          action: "reject",
          proto: "udp",
          ports: "53",
          sources: ["any"],
        }),
      ],
    }),
    sshPorts: [22],
    includeForward: { 4: true, 6: false },
  });
  const fwd = lines(out.v4).filter((l) => l.includes("tp:user"));
  assertEquals(fwd, [
    `-A TP-FWD -s 192.0.2.0/24 -m comment --comment "tp:user:ban" -j DROP`,
    `-A TP-FWD -p udp -m conntrack --ctorigdstport 53 -m comment --comment "tp:user:no-udp" -j REJECT --reject-with icmp-port-unreachable`,
  ]);
});

test("without DOCKER-USER the forward chain is left out and published rules are reported as deferred", () => {
  const out = renderFirewall({
    payload: payload({
      rules: [
        rule({
          id: "p",
          scope: "published",
          ports: "80",
          sources: ["10.0.0.0/8"],
          origin: "derived",
        }),
      ],
    }),
    sshPorts: [22],
    includeForward: { 4: false, 6: false },
  });
  assert(!out.v4.includes(FIREWALL_FORWARD_CHAIN));
  assertEquals(out.ruleCount, 0);
  assertEquals(out.warnings.length, 1);
  assertStringIncludes(out.warnings[0]!, "DOCKER-USER is absent");
});

test("sshd and control-plane ports are guaranteed ACCEPTs, deduplicated and sorted; no ssh port at all keeps 22 with a warning", () => {
  const out = renderFirewall({
    payload: payload({
      policy: { inputDefault: "drop", ipv6: "skip" },
      controlPlane: { tcpPorts: [8443, 443] },
    }),
    sshPorts: [2222, 22],
    includeForward: { 4: true, 6: false },
  });
  assertEquals(out.guaranteedTcpPorts, [22, 443, 2222, 8443]);
  for (const port of [22, 443, 2222, 8443]) {
    assertStringIncludes(
      out.v4,
      `-A TP-INPUT -p tcp --dport ${port} -m comment --comment "tp:system:tcp-${port}" -j ACCEPT`,
    );
  }
  const none = renderFirewall({
    payload: payload(),
    sshPorts: [],
    includeForward: BOTH,
  });
  assertEquals(none.guaranteedTcpPorts, [22]);
  assertEquals(none.warnings.length, 1);
  assertStringIncludes(none.warnings[0]!, "port 22 is kept open");
});

test("the digest is a function of the rendered bytes only", () => {
  const a = renderFirewall({
    payload: payload(),
    sshPorts: [22],
    includeForward: BOTH,
  });
  const b = renderFirewall({
    payload: payload({ generation: 99 }),
    sshPorts: [22],
    includeForward: BOTH,
  });
  const c = renderFirewall({
    payload: payload({ policy: { inputDefault: "drop", ipv6: "mirror" } }),
    sshPorts: [22],
    includeForward: BOTH,
  });
  assertEquals(
    a.digest,
    b.digest,
    "generation is not rendered, so it cannot move the digest",
  );
  assert(a.digest !== c.digest);
  assertEquals(a.digest.length, 64);
});
