/**
 * Pins the renderer's output byte-for-byte to the two documents in
 * `fixtures/` that were applied on a real iptables (v1.8.11, nf_tables
 * backend, Debian 13) with `iptables-restore --noflush --test`, then applied
 * twice to prove idempotence, on 2026-09-19. The hostfree suite can check
 * *shape*; only a kernel can check that the bytes parse. Any edit to a rule
 * template shows up here as a diff a reviewer reads — and the proof is only
 * as good as the fixture, so **re-run the container proof before regenerating
 * a fixture**, never regenerate it to make a red test green:
 *
 *   docker run --rm --cap-add NET_ADMIN --cap-add NET_RAW \
 *     -v "$PWD/src/firewall/fixtures:/fx:ro" debian:13-slim bash -c \
 *     'apt-get -qq update && apt-get -qq install -y iptables && \
 *      iptables-restore -w 5 --noflush --test < /fx/golden.v4 && \
 *      ip6tables-restore -w 5 --noflush --test < /fx/golden.v6'
 *
 * The payload covers every rule shape the contract admits: host accept /
 * drop / reject with `any` and named sources, a range, a dual-stack source
 * list on one rule, published accept from `any`, published accept narrowed by
 * source *and* destination, a published proto-`any` drop, control-plane and
 * sshd invariants, and the v6 document dropping v4-only rows.
 */

import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import type { FirewallReconcilePayload } from "../contracts/commands-contracts.ts";
import { renderFirewall } from "./render.ts";

const test = Deno.test.bind(Deno);

const FIXTURES = join(dirname(fromFileUrl(import.meta.url)), "fixtures");

export const GOLDEN_PAYLOAD: FirewallReconcilePayload = {
  generation: 7,
  mode: "managed",
  policy: { inputDefault: "accept", ipv6: "mirror" },
  controlPlane: { tcpPorts: [8443] },
  sshPorts: [2222],
  rules: [
    {
      id: "cp-http",
      scope: "host",
      action: "accept",
      proto: "tcp",
      ports: "80",
      sources: ["any"],
      origin: "derived",
      comment: "Caddy",
    },
    {
      id: "cp-https",
      scope: "host",
      action: "accept",
      proto: "tcp",
      ports: "443",
      sources: ["any"],
      origin: "derived",
      comment: "Caddy",
    },
    {
      id: "wg",
      scope: "host",
      action: "accept",
      proto: "udp",
      ports: "51820",
      sources: ["any"],
      origin: "derived",
    },
    {
      id: "raft",
      scope: "host",
      action: "accept",
      proto: "tcp",
      ports: "33002",
      sources: ["10.100.0.0/24", "fd00:100::/64"],
      origin: "system",
    },
    {
      id: "pgadmin",
      scope: "host",
      action: "drop",
      proto: "tcp",
      ports: "5432",
      sources: ["any"],
      origin: "user",
      comment: "no external pg",
    },
    {
      id: "office-only",
      scope: "host",
      action: "reject",
      proto: "tcp",
      ports: "9000-9010",
      sources: ["203.0.113.9/32"],
      origin: "user",
    },
    {
      id: "site-web",
      scope: "published",
      action: "accept",
      proto: "tcp",
      ports: "8080",
      sources: ["any"],
      origin: "derived",
    },
    {
      id: "site-db",
      scope: "published",
      action: "accept",
      proto: "tcp",
      ports: "3306",
      sources: ["198.51.100.4/32", "2001:db8::4/128"],
      destinations: ["192.0.2.10/32"],
      origin: "user",
    },
    {
      id: "blocked-src",
      scope: "published",
      action: "drop",
      proto: "any",
      sources: ["192.0.2.0/24"],
      origin: "user",
      comment: "abuser",
    },
  ],
};

test("renders byte-for-byte the v4 and v6 documents proven on iptables 1.8.11", async () => {
  const out = renderFirewall({
    payload: GOLDEN_PAYLOAD,
    sshPorts: [22, 2222],
    includeForward: { 4: true, 6: true },
  });
  assertEquals(out.v4, await Deno.readTextFile(join(FIXTURES, "golden.v4")));
  assertEquals(out.v6, await Deno.readTextFile(join(FIXTURES, "golden.v6")));
  assertEquals(out.ruleCount, 8);
  assertEquals(out.sshPorts, [22, 2222]);
  assertEquals(out.warnings, []);
  // The digest covers both documents, so it is as stable as the fixtures.
  assertEquals(
    out.digest,
    "348fc79fe90afc378a232045df8df5a38cd2bfe5696012113c36400dd48ef33a",
  );
});
