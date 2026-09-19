/**
 * Render a `server.firewall.reconcile` payload into `iptables-restore` /
 * `ip6tables-restore` documents. Pure: no host access, no clock, no randomness
 * — the same payload always renders the same bytes, which is what makes the
 * digest a drift key and the hostfree tests a real proof.
 *
 * **Two hooks, deliberately different.**
 *
 *  - `INPUT` → {@link FIREWALL_INPUT_CHAIN}: the host's own listeners (sshd,
 *    the co-located control plane, WireGuard, host-native sites). This is where
 *    ufw lived. A `host`-scoped rule renders here.
 *  - `DOCKER-USER` → {@link FIREWALL_FORWARD_CHAIN}: ports Docker publishes for
 *    containers. Those never traverse `INPUT` (the ufw + Docker footgun); they
 *    are DNAT'd in `nat/PREROUTING` and arrive in `FORWARD`, where Docker's own
 *    `DOCKER-USER` is the sanctioned operator hook. A `published` rule renders
 *    here, matched on the **original** destination port via
 *    `conntrack --ctorigdstport`, because by the time the packet is here the
 *    destination is already the container's. `TP-FWD` ends in an implicit
 *    `RETURN`, so Docker keeps governing everything this chain does not
 *    restrict — far fewer invariants to get right than a separate nftables
 *    table with `policy drop` on the forward hook, which would have needed every
 *    legitimate forward path enumerated (considered, rejected 2026-09-19).
 *
 * **Telling inbound from container egress in `DOCKER-USER`.** `xt_conntrack`
 * has no DNAT status match (`--ctstatus DNAT` is refused; that is nftables'
 * `ct status dnat`), so the chain opens with `RETURN`s for reply traffic and
 * for anything that *entered* on a container-side interface (`docker0`,
 * `br-+`, `tp0`). What is left came in from outside and is heading for a
 * published port, and only then do the port rules apply.
 *
 * **Invariants are rendered here, first, and cannot be removed by a rule:**
 * loopback, `ESTABLISHED,RELATED`, ICMP (and ICMPv6 — neighbour discovery, or
 * v6 dies on the spot), the DHCP client (broadcast replies do not reliably
 * match `ESTABLISHED`, and with boot persistence the ruleset is up before the
 * lease), every effective sshd port, and the co-located control plane's ports.
 * Outbound is never touched: no `OUTPUT` chain is emitted.
 *
 * **Order within a chain** is fixed and documented: invariants → explicit
 * `drop` / `reject` rows → `accept` rows → the default. A block therefore beats
 * an allow, and the default only speaks when nothing else did.
 *
 * **What is deliberately not in the document.** The jumps (`INPUT -j TP-INPUT`,
 * `DOCKER-USER -j TP-FWD`) — under `--noflush` an `-I` line in the file would
 * add a duplicate on every apply, so `apply.ts` ensures them with `-C` → `-I`.
 * And no `:INPUT ACCEPT [0:0]` line: that would reset the builtin policy the
 * operator may have set.
 *
 * Verified 2026-09-19 on iptables v1.8.11 (nf_tables) in a Debian 13
 * container: `--noflush` with `:TP-X - [0:0]` flushes and rebuilds only that
 * chain; `-i br-+` parses; `--ctorigdstport` parses; `--test` validates.
 */

import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import {
  type FirewallReconcilePayload,
  type FirewallRule,
  isValidIpv4Literal,
  parseFirewallPortRange,
} from "../instance/commands/contracts.ts";

/** Hung off `INPUT`; the host's own listeners. */
export const FIREWALL_INPUT_CHAIN = "TP-INPUT";
/** Hung off `DOCKER-USER`; ports Docker publishes for containers. */
export const FIREWALL_FORWARD_CHAIN = "TP-FWD";

/**
 * Interfaces a packet enters `FORWARD` on when it comes *from* a container or
 * the fabric — traffic `TP-FWD` must never restrict. `br-+` is iptables'
 * prefix wildcard for every Docker user bridge (`br-<network id>`), which is
 * also what TurboFabric's routed bridges are.
 */
export const CONTAINER_INGRESS_INTERFACES = ["docker0", "br-+", "tp0"] as const;

export type FirewallFamily = 4 | 6;

export type RenderFirewallInput = {
  payload: FirewallReconcilePayload;
  /** Effective sshd ports (detected ∪ payload); every one gets an ACCEPT. */
  sshPorts: number[];
  /**
   * Whether `DOCKER-USER` exists per family. When it does not (a host before
   * Docker is installed; `ip6tables` unless Docker's ip6tables is on) the
   * forward chain is left out of that family's document rather than rendered
   * against a jump that cannot be made.
   */
  includeForward: Record<FirewallFamily, boolean>;
};

export type RenderedFirewall = {
  /** The `iptables-restore --noflush` document. */
  v4: string;
  /** The `ip6tables-restore --noflush` document, or `null` under `ipv6: skip`. */
  v6: string | null;
  /** sha256 hex over `v4 + "\n" + (v6 ?? "")`. */
  digest: string;
  /** Rules that rendered at least one line in at least one family. */
  ruleCount: number;
  /** Ports the renderer guaranteed a host `ACCEPT` for (sshd + control plane). */
  guaranteedTcpPorts: number[];
  /** The effective sshd ports, including the port-22 fallback when none was known. */
  sshPorts: number[];
  warnings: string[];
};

/** `comment` text is already parse-validated to `[A-Za-z0-9 ._:/-]`; ids to `[A-Za-z0-9_.:-]`. */
function commentFor(rule: FirewallRule): string {
  const label = rule.comment ? ` ${rule.comment}` : "";
  return `-m comment --comment "tp:${rule.origin}:${rule.id}${label}"`;
}

function systemComment(label: string): string {
  return `-m comment --comment "tp:system:${label}"`;
}

function familyOf(literal: string): FirewallFamily {
  const slash = literal.lastIndexOf("/");
  const address = slash === -1 ? literal : literal.slice(0, slash);
  return isValidIpv4Literal(address) ? 4 : 6;
}

/** `any` → `[null]` (no `-s`); otherwise the literals of this family, or `[]`. */
function sourcesFor(
  rule: FirewallRule,
  family: FirewallFamily,
): (string | null)[] {
  if (rule.sources.includes("any")) return [null];
  return rule.sources.filter((source) => familyOf(source) === family);
}

function destinationsFor(
  rule: FirewallRule,
  family: FirewallFamily,
): (string | null)[] {
  if (!rule.destinations || rule.destinations.length === 0) return [null];
  const mine = rule.destinations.filter((dest) => familyOf(dest) === family);
  // A rule limited to addresses of the other family has nothing to say here.
  return mine;
}

function protoArgs(rule: FirewallRule): string {
  return rule.proto === "any" ? "" : `-p ${rule.proto}`;
}

/** `--dport 80` / `--dport 80:90` for a host rule. */
function hostPortArgs(rule: FirewallRule): string {
  if (!rule.ports) return "";
  const range = parseFirewallPortRange(rule.ports)!;
  return range.from === range.to
    ? `--dport ${range.from}`
    : `--dport ${range.from}:${range.to}`;
}

/**
 * The post-DNAT match for a published rule: `-m conntrack` with the original
 * destination port (`--ctorigdstport 80[:90]`) and, when the rule names one,
 * the original destination address (`--ctorigdst`). One module instance
 * carries both, so the address never appears without the module.
 */
function publishedMatchArgs(rule: FirewallRule, dest: string | null): string {
  const parts: string[] = [];
  if (rule.ports) {
    const range = parseFirewallPortRange(rule.ports)!;
    parts.push(
      range.from === range.to
        ? `--ctorigdstport ${range.from}`
        : `--ctorigdstport ${range.from}:${range.to}`,
    );
  }
  if (dest !== null) parts.push(`--ctorigdst ${dest}`);
  return parts.length === 0 ? "" : `-m conntrack ${parts.join(" ")}`;
}

function targetFor(rule: FirewallRule, family: FirewallFamily): string {
  switch (rule.action) {
    case "accept":
      return "ACCEPT";
    case "drop":
      return "DROP";
    case "reject":
      // A TCP reset tells a client "nothing here" immediately; ICMP
      // unreachable is the equivalent for everything else.
      if (rule.proto === "tcp") return "REJECT --reject-with tcp-reset";
      return family === 4
        ? "REJECT --reject-with icmp-port-unreachable"
        : "REJECT --reject-with icmp6-port-unreachable";
  }
}

function joinArgs(parts: (string | null | undefined)[]): string {
  return parts.filter((part) => part && part.length > 0).join(" ");
}

/**
 * The lines one `host` rule contributes, in this family. A rule whose sources
 * or destinations are all of the other family contributes none.
 */
function renderHostRule(rule: FirewallRule, family: FirewallFamily): string[] {
  const lines: string[] = [];
  for (const dest of destinationsFor(rule, family)) {
    for (const source of sourcesFor(rule, family)) {
      lines.push(joinArgs([
        `-A ${FIREWALL_INPUT_CHAIN}`,
        source === null ? null : `-s ${source}`,
        dest === null ? null : `-d ${dest}`,
        protoArgs(rule),
        hostPortArgs(rule),
        commentFor(rule),
        `-j ${targetFor(rule, family)}`,
      ]));
    }
  }
  return lines;
}

/**
 * The lines one `published` rule contributes. An `accept` from `any` renders
 * nothing (Docker already accepts). An `accept` from named sources narrows the
 * port: `RETURN` for each source — handing the packet back to Docker's own
 * accept — then `DROP` for everyone else on that port. `drop` / `reject` render
 * directly against their sources. The original-destination address, when the
 * rule names one, is matched with `--ctorigdst` for the same post-DNAT reason
 * as the port.
 */
function renderPublishedRule(
  rule: FirewallRule,
  family: FirewallFamily,
): string[] {
  const lines: string[] = [];
  const destinations = destinationsFor(rule, family);
  if (destinations.length === 0) return lines;
  if (rule.action === "accept") {
    if (rule.sources.includes("any")) return lines;
    // When every allowed source is of the other family, `sources` is empty
    // here: in *this* family nobody is allowed, and the port still closes.
    const sources = sourcesFor(rule, family);
    for (const dest of destinations) {
      for (const source of sources) {
        lines.push(joinArgs([
          `-A ${FIREWALL_FORWARD_CHAIN}`,
          `-s ${source}`,
          protoArgs(rule),
          publishedMatchArgs(rule, dest),
          commentFor(rule),
          "-j RETURN",
        ]));
      }
      lines.push(joinArgs([
        `-A ${FIREWALL_FORWARD_CHAIN}`,
        protoArgs(rule),
        publishedMatchArgs(rule, dest),
        commentFor(rule),
        "-j DROP",
      ]));
    }
    return lines;
  }
  for (const dest of destinations) {
    for (const source of sourcesFor(rule, family)) {
      lines.push(joinArgs([
        `-A ${FIREWALL_FORWARD_CHAIN}`,
        source === null ? null : `-s ${source}`,
        protoArgs(rule),
        publishedMatchArgs(rule, dest),
        commentFor(rule),
        `-j ${targetFor(rule, family)}`,
      ]));
    }
  }
  return lines;
}

function inputInvariants(
  family: FirewallFamily,
  guaranteedTcpPorts: number[],
): string[] {
  const c = FIREWALL_INPUT_CHAIN;
  const lines = [
    `-A ${c} -i lo ${systemComment("loopback")} -j ACCEPT`,
    `-A ${c} -m conntrack --ctstate ESTABLISHED,RELATED ${
      systemComment("established")
    } -j ACCEPT`,
  ];
  if (family === 4) {
    lines.push(`-A ${c} -p icmp ${systemComment("icmp")} -j ACCEPT`);
    lines.push(
      `-A ${c} -p udp --sport 67 --dport 68 ${systemComment("dhcp")} -j ACCEPT`,
    );
  } else {
    lines.push(`-A ${c} -p ipv6-icmp ${systemComment("icmpv6")} -j ACCEPT`);
    lines.push(
      `-A ${c} -p udp --sport 547 --dport 546 ${
        systemComment("dhcpv6")
      } -j ACCEPT`,
    );
  }
  for (const port of guaranteedTcpPorts) {
    lines.push(
      `-A ${c} -p tcp --dport ${port} ${
        systemComment(`tcp-${port}`)
      } -j ACCEPT`,
    );
  }
  return lines;
}

function forwardPrefix(): string[] {
  const c = FIREWALL_FORWARD_CHAIN;
  const lines = [
    `-A ${c} -m conntrack --ctstate ESTABLISHED,RELATED ${
      systemComment("established")
    } -j RETURN`,
  ];
  for (const iface of CONTAINER_INGRESS_INTERFACES) {
    lines.push(
      `-A ${c} -i ${iface} ${systemComment("container-egress")} -j RETURN`,
    );
  }
  return lines;
}

/** Blocks first, then accepts, in payload order within each group. */
function orderedRules(rules: FirewallRule[]): FirewallRule[] {
  const blocks = rules.filter((rule) => rule.action !== "accept");
  const accepts = rules.filter((rule) => rule.action === "accept");
  return [...blocks, ...accepts];
}

function renderFamily(
  input: RenderFirewallInput,
  family: FirewallFamily,
  guaranteedTcpPorts: number[],
  rendered: Set<string>,
): string {
  const { payload } = input;
  const includeForward = input.includeForward[family];
  const lines: string[] = ["*filter", `:${FIREWALL_INPUT_CHAIN} - [0:0]`];
  if (includeForward) lines.push(`:${FIREWALL_FORWARD_CHAIN} - [0:0]`);

  lines.push(...inputInvariants(family, guaranteedTcpPorts));
  for (
    const rule of orderedRules(payload.rules.filter((r) => r.scope === "host"))
  ) {
    const ruleLines = renderHostRule(rule, family);
    if (ruleLines.length > 0) rendered.add(rule.id);
    lines.push(...ruleLines);
  }
  if (payload.policy.inputDefault === "drop") {
    lines.push(
      `-A ${FIREWALL_INPUT_CHAIN} ${systemComment("default")} -j DROP`,
    );
  }

  if (includeForward) {
    lines.push(...forwardPrefix());
    for (
      const rule of orderedRules(
        payload.rules.filter((r) => r.scope === "published"),
      )
    ) {
      const ruleLines = renderPublishedRule(rule, family);
      if (ruleLines.length > 0) rendered.add(rule.id);
      lines.push(...ruleLines);
    }
  }

  lines.push("COMMIT");
  return lines.join("\n") + "\n";
}

/**
 * Render the payload. Throws only on a contract violation the parser should
 * already have refused; every operational condition is a warning on the
 * result, because a renderer that refuses is a host left as it was, not a
 * host protected.
 */
export function renderFirewall(input: RenderFirewallInput): RenderedFirewall {
  const warnings: string[] = [];
  const { payload } = input;

  const sshPorts = [...new Set(input.sshPorts)].sort((a, b) => a - b);
  if (sshPorts.length === 0) {
    // The invariant is "sshd stays reachable"; with no port known, the only
    // safe reading is the default one.
    sshPorts.push(22);
    warnings.push(
      "no sshd port was detected or supplied; port 22 is kept open as the invariant",
    );
  }
  const guaranteed = new Set<number>(sshPorts);
  for (const port of payload.controlPlane?.tcpPorts ?? []) guaranteed.add(port);
  const guaranteedTcpPorts = [...guaranteed].sort((a, b) => a - b);

  const rendered = new Set<string>();
  const v4 = renderFamily(input, 4, guaranteedTcpPorts, rendered);
  const v6 = payload.policy.ipv6 === "mirror"
    ? renderFamily(input, 6, guaranteedTcpPorts, rendered)
    : null;

  for (const rule of payload.rules) {
    if (!rendered.has(rule.id)) {
      if (rule.scope === "published" && !input.includeForward[4]) {
        warnings.push(
          `rule ${rule.id} targets a published port but DOCKER-USER is absent; deferred until dockerd creates it`,
        );
      } else if (
        rule.scope === "published" && rule.action === "accept" &&
        rule.sources.includes("any")
      ) {
        // Not a warning: an accept-from-anywhere on a published port is what
        // Docker does already, so there is nothing to render.
      } else {
        warnings.push(
          `rule ${rule.id} rendered no line (every source or destination is of a family this ruleset does not cover)`,
        );
      }
    }
  }

  const digestBytes = crypto.subtle.digestSync(
    "SHA-256",
    new TextEncoder().encode(`${v4}\n${v6 ?? ""}`),
  );

  return {
    v4,
    v6,
    digest: encodeHex(new Uint8Array(digestBytes)),
    ruleCount: rendered.size,
    guaranteedTcpPorts,
    sshPorts,
    warnings,
  };
}
