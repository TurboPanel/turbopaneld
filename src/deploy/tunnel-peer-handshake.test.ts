/**
 * A real handshake against a real Caddy: the peer-facing server on its own
 * port refuses a connection with no client certificate or with one from
 * another authority, forwards a valid one with the original Host, and leaves
 * the hosting server (here on a stand-in for 443) alone: no client certificate
 * asked for and no 421 for a connection that names the real host.
 *
 * Runs only where a Caddy binary is named (TURBOPANEL_TEST_CADDY=/path/to/caddy, or the pinned caddy on PATH) and
 * `openssl` and `curl` exist, like the other real-Caddy tests.
 */
import { pinnedCaddy } from "../testing/panel-caddy.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  renderTunnelFile,
  TUNNEL_ERROR_STATUS,
  TUNNEL_ERROR_TEXT,
  TUNNEL_PEER_HOST_HEADER as PEER_HOST_HEADER,
  TUNNEL_PEER_PORT,
} from "./tunnel-caddy.ts";

const test = Deno.test.bind(Deno);

/** Stand-ins for 443 and the peer port, so nothing needs privileges. */
const CADDY = pinnedCaddy();
const HOSTING_PORT = 18443;
const PEER_PORT = 19443;
const SENDER_PORT = 18444;
const HOST = "app.example.test";

async function run(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; out: string; err: string }> {
  const out = await new Deno.Command(cmd, {
    args,
    ...(cwd ? { cwd } : {}),
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder();
  return {
    code: out.code,
    out: text.decode(out.stdout),
    err: text.decode(out.stderr),
  };
}

async function openssl(dir: string, args: string[]): Promise<void> {
  const result = await run("openssl", args, dir);
  assertEquals(result.code, 0, result.err);
}

async function makeCa(dir: string, name: string): Promise<void> {
  await openssl(dir, [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.pem`,
    "-subj",
    `/CN=${name}`,
    "-days",
    "2",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
}

async function makeLeaf(
  dir: string,
  ca: string,
  name: string,
  san: string,
): Promise<void> {
  await Deno.writeTextFile(
    join(dir, `${name}.ext`),
    `subjectAltName=${san}\nextendedKeyUsage=serverAuth,clientAuth\nbasicConstraints=CA:FALSE\n`,
  );
  await openssl(dir, [
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
    "-subj",
    `/CN=${name}`,
  ]);
  await openssl(dir, [
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    `${ca}.pem`,
    "-CAkey",
    `${ca}.key`,
    "-CAcreateserial",
    "-out",
    `${name}.pem`,
    "-days",
    "2",
    "-extfile",
    `${name}.ext`,
  ]);
}

async function waitFor(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      (await Deno.connect({ port, hostname: "127.0.0.1" })).close();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`nothing listens on ${port}`);
}

type Reply = { code: number; status: string; body: string };

/**
 * `abort` closes the connection with no answer: curl reports no status (000)
 * and an empty reply, a reset or an HTTP/2 stream reset (52, 56 or 92). A bind
 * or connect failure, or an error page, is a different result and must not pass.
 */
function assertAborted(reply: Reply, what: string): void {
  assertEquals(reply.status, "000", `${what}: an HTTP status came back`);
  assert([52, 56, 92].includes(reply.code), `${what}: curl exit ${reply.code}`);
}

async function curl(args: string[]): Promise<Reply> {
  const result = await run("curl", [
    "-sS",
    "--max-time",
    "10",
    "-o",
    "-",
    "-w",
    "\n%{http_code}",
    ...args,
  ]);
  const at = result.out.lastIndexOf("\n");
  return {
    code: result.code,
    status: result.out.slice(at + 1),
    body: result.out.slice(0, at),
  };
}

test({
  name:
    "a real Caddy: no certificate and a foreign one are refused, a valid one is forwarded, 443 is untouched",
  ignore: CADDY === undefined,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-peer-mtls-" });
    let child: Deno.ChildProcess | undefined;
    let logs: Promise<string> | undefined;
    try {
      await makeCa(dir, "org");
      await makeCa(dir, "other");
      await makeLeaf(
        dir,
        "org",
        "server",
        "DNS:tp-peer.internal,IP:127.0.0.1",
      );
      await makeLeaf(dir, "org", "peer", "DNS:tp-peer.internal");
      await makeLeaf(dir, "other", "stranger", "DNS:tp-peer.internal");
      await makeLeaf(dir, "org", "hosting", `DNS:${HOST}`);

      // The file a server with a dedicated peer hop gets: a forward block for
      // the site (the sender side) and the peer-facing server (the receiver
      // side), moved to unprivileged stand-in ports.
      const rendered = renderTunnelFile(
        [{
          hostname: HOST,
          local: false,
          lock: false,
          upstreams: [{
            serverId: "0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e01",
            addresses: ["127.0.0.1"],
            port: PEER_PORT,
          }],
        }],
        {
          peerAddresses: ["127.0.0.1"],
          material: {
            certificate: join(dir, "server.pem"),
            key: join(dir, "server.key"),
            trust: join(dir, "org.pem"),
          },
          clientAuth: "require",
          presentCertificate: true,
          inbound: [
            { hostname: HOST, peers: ["127.0.0.1"] },
            { hostname: "elsewhere.example.net", peers: ["192.0.2.9"] },
            { hostname: "local.example.net", peers: [], lock: true },
          ],
        },
        new Set(),
      ).contents
        .replace("https://127.0.0.1:443", `https://127.0.0.1:${HOSTING_PORT}`)
        .replace(`https://:${TUNNEL_PEER_PORT}`, `https://:${PEER_PORT}`)
        .replace(
          `${HOST} {\n  tls internal`,
          `https://${HOST}:${SENDER_PORT} {\n  tls internal`,
        );
      assertStringIncludes(rendered, `https://:${PEER_PORT} {`);
      assertStringIncludes(rendered, `https://${HOST}:${SENDER_PORT} {`);

      const caddyfile = `{
  admin off
  auto_https disable_redirects
  skip_install_trust
}
https://:${HOSTING_PORT} {
  tls ${join(dir, "hosting.pem")} ${join(dir, "hosting.key")}
  respond "hosted {host} hop={header.X-Tp-Peer-Hop} spoof={header.X-Tp-Peer-Host}" 200
}
${rendered}`;
      const path = join(dir, "Caddyfile");
      await Deno.writeTextFile(path, caddyfile);
      child = new Deno.Command(CADDY!, {
        args: ["run", "--config", path, "--adapter", "caddyfile"],
        env: { XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, HOME: dir },
        stdout: "null",
        stderr: "piped",
      }).spawn();
      logs = new Response(child.stderr).text();
      await waitFor(HOSTING_PORT);
      await waitFor(PEER_PORT);
      await waitFor(SENDER_PORT);

      const peer = [
        "--resolve",
        `tp-peer.internal:${PEER_PORT}:127.0.0.1`,
        "--cacert",
        join(dir, "org.pem"),
        "-H",
        `X-Tp-Peer-Host: ${HOST}`,
        `https://tp-peer.internal:${PEER_PORT}/`,
      ];

      // No client certificate: the handshake is refused.
      const none = await curl(peer);
      assert(none.code !== 0, "a connection with no certificate was accepted");

      // A certificate from another authority: refused.
      const foreign = await curl([
        "--cert",
        join(dir, "stranger.pem"),
        "--key",
        join(dir, "stranger.key"),
        ...peer,
      ]);
      assert(foreign.code !== 0, "a foreign certificate was accepted");

      // A certificate of the organization's authority: forwarded with the
      // real Host put back, no 421, and the hop marked by the peer server.
      const good = await curl([
        "--cert",
        join(dir, "peer.pem"),
        "--key",
        join(dir, "peer.key"),
        ...peer,
      ]);
      assertEquals(good.code, 0);
      assertEquals(good.status, "200");
      assertEquals(good.body, `hosted ${HOST} hop=1 spoof=`);

      // A valid certificate alone reaches nothing else: a name the table does
      // not list, a listed name whose peers leave this address out, and a
      // local-only name are all cut.
      for (
        const name of [
          "unlisted.example.net",
          "elsewhere.example.net",
          "local.example.net",
        ]
      ) {
        const refused = await curl([
          "--cert",
          join(dir, "peer.pem"),
          "--key",
          join(dir, "peer.key"),
          "--resolve",
          `tp-peer.internal:${PEER_PORT}:127.0.0.1`,
          "--cacert",
          join(dir, "org.pem"),
          "-H",
          `X-Tp-Peer-Host: ${name}`,
          `https://tp-peer.internal:${PEER_PORT}/`,
        ]);
        assert(
          refused.status !== "200" && !refused.body.includes("hosted"),
          `${name} was handed on`,
        );
      }

      // No certificate, with the real hostname as the server name: refused.
      const named443 = await curl([
        "-k",
        "--resolve",
        `${HOST}:${PEER_PORT}:127.0.0.1`,
        `https://${HOST}:${PEER_PORT}/`,
      ]);
      assert(named443.code !== 0, "a certificate-less connection got in");

      // The whole path as a visitor sees it: the sender block shows its
      // certificate, the receiver lets it in and the site answers.
      const visitor = await curl([
        "-k",
        "--resolve",
        `${HOST}:${SENDER_PORT}:127.0.0.1`,
        `https://${HOST}:${SENDER_PORT}/`,
      ]);
      assertEquals(visitor.code, 0);
      assertEquals(visitor.status, "200");
      assertEquals(visitor.body, `hosted ${HOST} hop=1 spoof=`);

      // The hosting server is unaffected: no client certificate is asked for
      // and a connection that names the real host is answered, never turned
      // away with a 421.
      const named = await curl([
        "-k",
        "--resolve",
        `${HOST}:${HOSTING_PORT}:127.0.0.1`,
        `https://${HOST}:${HOSTING_PORT}/`,
      ]);
      assertEquals(named.code, 0);
      assertEquals(named.status, "200");
      assertEquals(named.body, `hosted ${HOST} hop= spoof=`);

      // A visitor cannot pick the Host with the peer header: on 443 it is
      // ignored (the Host stays the one the connection named), and through the
      // sender block the sender's own value replaces the visitor's.
      const spoofed = await curl([
        "-k",
        "-H",
        `${PEER_HOST_HEADER}: evil.example.net`,
        "--resolve",
        `${HOST}:${HOSTING_PORT}:127.0.0.1`,
        `https://${HOST}:${HOSTING_PORT}/`,
      ]);
      assertEquals(spoofed.status, "200");
      assertEquals(
        spoofed.body,
        `hosted ${HOST} hop= spoof=evil.example.net`,
      );
      const viaSender = await curl([
        "-k",
        "-H",
        `${PEER_HOST_HEADER}: evil.example.net`,
        "--resolve",
        `${HOST}:${SENDER_PORT}:127.0.0.1`,
        `https://${HOST}:${SENDER_PORT}/`,
      ]);
      assertEquals(viaSender.status, "200");
      assertEquals(viaSender.body, `hosted ${HOST} hop=1 spoof=`);
    } finally {
      try {
        child?.kill();
        await child?.status;
      } catch {
        // Already gone.
      }
      if (Deno.env.get("TP_TEST_CADDY_LOG")) console.log(await logs);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/**
 * The sender pins its source address with `local_address`: the receiver's door
 * allows only 127.0.0.3, so the request gets through only when the sender
 * dials from it. Without the field the kernel picks 127.0.0.1 and the door
 * refuses.
 */
test({
  name:
    "a real Caddy: the sender's local_address is the source the receiver's door allows",
  ignore: CADDY === undefined,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-peer-src-" });
    let child: Deno.ChildProcess | undefined;
    let logs: Promise<string> | undefined;
    try {
      await makeCa(dir, "org");
      await makeLeaf(
        dir,
        "org",
        "server",
        "DNS:tp-peer.internal,IP:127.0.0.1",
      );
      await makeLeaf(dir, "org", "hosting", `DNS:${HOST}`);
      const upstream = (localAddress?: string) => ({
        serverId: "0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e01",
        addresses: ["127.0.0.1"],
        port: PEER_PORT,
        ...(localAddress ? { localAddress } : {}),
      });
      const render = (name: string, port: number, localAddress?: string) =>
        renderTunnelFile(
          [{
            hostname: name,
            local: false,
            lock: false,
            upstreams: [upstream(localAddress)],
          }],
          {
            peerAddresses: ["127.0.0.1", "127.0.0.3"],
            material: {
              certificate: join(dir, "server.pem"),
              key: join(dir, "server.key"),
              trust: join(dir, "org.pem"),
            },
            clientAuth: "require",
            presentCertificate: true,
            localAddresses: new Set(["127.0.0.1", "127.0.0.3"]),
            inbound: [{ hostname: HOST, peers: ["127.0.0.3"] }],
          },
          new Set(),
        ).contents
          .replace(
            `${name} {\n  tls internal`,
            `https://${name}:${port} {\n  tls internal`,
          );
      const pinned = render(HOST, SENDER_PORT, "127.0.0.3");
      const unpinned = render(HOST, SENDER_PORT + 1);
      assertStringIncludes(pinned, "local_address 127.0.0.3");
      assertEquals(unpinned.includes("local_address"), false);
      // One file holds the receiver once; the second sender block is only the forward.
      const receiverAt = unpinned.indexOf(`https://:${TUNNEL_PEER_PORT} {`);
      const unpinnedForward = unpinned.slice(0, receiverAt);
      const receiver = pinned.slice(
        pinned.indexOf(`https://:${TUNNEL_PEER_PORT} {`),
      )
        .replace(`https://:${TUNNEL_PEER_PORT}`, `https://:${PEER_PORT}`)
        .replace("https://127.0.0.1:443", `https://127.0.0.1:${HOSTING_PORT}`);
      const pinnedForward = pinned.slice(
        0,
        pinned.indexOf(`https://:${TUNNEL_PEER_PORT} {`),
      );
      const caddyfile = `{
  admin off
  auto_https disable_redirects
  skip_install_trust
}
https://:${HOSTING_PORT} {
  tls ${join(dir, "hosting.pem")} ${join(dir, "hosting.key")}
  respond "hosted {host}" 200
}
${pinnedForward}
${
        unpinnedForward.replace(
          `https://${HOST}:${SENDER_PORT + 1}`,
          `https://${HOST}:${SENDER_PORT + 1}`,
        )
      }
${receiver}`;
      const path = join(dir, "Caddyfile");
      await Deno.writeTextFile(path, caddyfile);
      child = new Deno.Command(CADDY!, {
        args: ["run", "--config", path, "--adapter", "caddyfile"],
        env: { XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, HOME: dir },
        stdout: "null",
        stderr: "piped",
      }).spawn();
      logs = new Response(child.stderr).text();
      await waitFor(HOSTING_PORT);
      await waitFor(PEER_PORT);
      await waitFor(SENDER_PORT);
      await waitFor(SENDER_PORT + 1);

      const viaPinned = await curl([
        "-k",
        "--resolve",
        `${HOST}:${SENDER_PORT}:127.0.0.1`,
        `https://${HOST}:${SENDER_PORT}/`,
      ]);
      assertEquals(viaPinned.code, 0);
      assertEquals(viaPinned.status, "200");
      assertEquals(viaPinned.body, `hosted ${HOST}`);

      // Missing field: the kernel's choice (127.0.0.1) is not on the door's list.
      const viaKernel = await curl([
        "-k",
        "--resolve",
        `${HOST}:${SENDER_PORT + 1}:127.0.0.1`,
        `https://${HOST}:${SENDER_PORT + 1}/`,
      ]);
      // The sender cannot get through, so the visitor sees the fixed error page.
      assertEquals(viaKernel.status, String(TUNNEL_ERROR_STATUS));
      assertStringIncludes(viaKernel.body, TUNNEL_ERROR_TEXT);

      // The refusal itself is the door aborting the connection: straight to the
      // peer port, 127.0.0.1 (the kernel's choice) is cut and 127.0.0.3 is let in.
      const direct = (from: string) =>
        curl([
          "--interface",
          from,
          "--cert",
          join(dir, "server.pem"),
          "--key",
          join(dir, "server.key"),
          "--resolve",
          `tp-peer.internal:${PEER_PORT}:127.0.0.1`,
          "--cacert",
          join(dir, "org.pem"),
          "-H",
          `${PEER_HOST_HEADER}: ${HOST}`,
          `https://tp-peer.internal:${PEER_PORT}/`,
        ]);
      assertAborted(await direct("127.0.0.1"), "an unpinned source");
      const listed = await direct("127.0.0.3");
      assertEquals(listed.status, "200");
      assertEquals(listed.body, `hosted ${HOST}`);
    } finally {
      try {
        child?.kill();
        await child?.status;
      } catch {
        // Already gone.
      }
      if (Deno.env.get("TP_TEST_CADDY_LOG")) console.log(await logs);
      await Deno.remove(dir, { recursive: true });
    }
  },
});
