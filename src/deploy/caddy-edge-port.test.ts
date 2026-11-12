import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  findOnPath,
  freePort,
  INSTANCE_LAUNCH_ROLES,
  panelCaddyTestSite,
  pinnedCaddy,
  required,
  runLocalPlaybook,
  startPanelCaddy,
} from "../testing/panel-caddy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * An edge in front of the control plane (a tunnel, a proxy) can answer the
 * same hostname on 443 and on 8443 and forward both to the panel's Caddy. The
 * Host header is what still tells them apart (443 sends the bare name). The
 * panel's Caddy answers a known hostname on the wrong port with a 308 to its
 * public port, except for the daemon's API and WebSocket, the health check,
 * Git webhooks and every WebSocket upgrade.
 */

const TEMPLATE = "instance-launch/templates/Caddyfile.j2";
const PARTIAL = "instance-launch/templates/Caddyfile-edge-port-redirect.j2";
const MARKER = "# Edge port redirect:";
const EXEMPT = "not path /api/daemon/* /ws/daemon/* /api/health /webhook/*";

const readRole = (path: string) =>
  Deno.readTextFile(new URL(path, INSTANCE_LAUNCH_ROLES));

const caddy = pinnedCaddy();
const ansiblePlaybook = findOnPath("ansible-playbook");

test("the redirect sits in the shared site snippet, before any handler", async () => {
  const template = await readRole(TEMPLATE);
  const snippet = template.indexOf("(turbopanel_app) {");
  const include = template.indexOf(
    "{% include 'Caddyfile-edge-port-redirect.j2' %}",
  );
  const baseline = template.indexOf("# Baseline response headers");
  assert(snippet >= 0 && snippet < include && include < baseline);

  const partial = await readRole(PARTIAL);
  assertStringIncludes(partial, MARKER);
  assertStringIncludes(partial, EXEMPT);
  assertStringIncludes(partial, "not header Upgrade *");
  assertStringIncludes(partial, 'Cache-Control "no-store"');
  assertStringIncludes(partial, "{uri} 308");
});

test("a kept Caddyfile is not patched: its names carry no public port", async () => {
  const main = await readRole("instance-launch/tasks/main.yml");
  assertEquals(main.includes("caddyfile-edge-port"), false);
  const template = await readRole(TEMPLATE);
  // The port comes only from public_port, never from the URL or a default.
  assertStringIncludes(template, "h.public_port | default('', true)");
  assertEquals(/default\('8443'\)|or '8443'/.test(template), false);
});

// ---- Optional checks: need ansible-playbook and/or the pinned Caddy. ----

type Hostname = {
  host: string;
  source: string;
  cert_id?: string;
  public_port?: number;
};

const HOSTNAMES: Hostname[] = [
  {
    host: "https://edge.example.com:8443",
    source: "platform-ca",
    public_port: 8443,
  },
  { host: "https://panel.lan:8443", source: "platform-ca", public_port: 8443 },
  {
    host: "https://Front.Example.com:8443",
    source: "platform-ca",
    public_port: 443,
  },
  // No public_port: the control plane did not send one, so no redirect.
  { host: "https://noport.example.com:8443", source: "platform-ca" },
  {
    host: "https://edge.example.com:8443/",
    source: "platform-ca",
    public_port: 9443,
  },
  { host: "https://[::1]:8443", source: "platform-ca", public_port: 8443 },
];

/** Render Caddyfile.j2 with Ansible for `hostnames`, under `root`. */
async function renderTemplate(
  root: string,
  hostnames: Hostname[],
): Promise<string> {
  const out = join(root, "Caddyfile.rendered");
  const vars = {
    turbopanel_hostnames: hostnames,
    turbopanel_letsencrypt_ready: [],
    turbopanel_instance_certs_dir: join(root, "certs"),
    turbopanel_caddy_admin_socket: join(root, "admin.sock"),
    turbopanel_run_dir: join(root, "run"),
    turbopanel_ui_dist_dir: join(root, "ui"),
    turbopanel_config_dir: root,
    turbopanel_caddyfile: join(root, "Caddyfile"),
  };
  const play = join(root, "render.yml");
  await Deno.writeTextFile(
    play,
    [
      "- hosts: localhost",
      "  connection: local",
      "  gather_facts: false",
      "  tasks:",
      "    - ansible.builtin.copy:",
      `        content: "{{ lookup('ansible.builtin.template', '${
        new URL(TEMPLATE, INSTANCE_LAUNCH_ROLES).pathname
      }') }}"`,
      `        dest: ${out}`,
      "",
    ].join("\n"),
  );
  await runLocalPlaybook(
    required(ansiblePlaybook, "ansible-playbook"),
    root,
    play,
    [
      "-e",
      JSON.stringify(vars),
    ],
  );
  return await Deno.readTextFile(out);
}

async function withRoot(prefix: string, fn: (root: string) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test({
  name: "the template lists every DNS hostname once with its public port",
  ignore: ansiblePlaybook === undefined,
  permissions: { read: true, write: true, run: true, env: true },
  fn: () =>
    withRoot("tp-edge-port-render-", async (root) => {
      const rendered = await renderTemplate(root, HOSTNAMES);
      assertEquals(rendered.split(MARKER).length - 1, 1);
      assertStringIncludes(
        rendered,
        "redir @tp_edge_port_0 https://edge.example.com:8443{uri} 308",
      );
      assertStringIncludes(rendered, "not header Host edge.example.com:8443");
      // A hostname whose visitors use 443 gets the bare name, both spellings
      // of it pass, and the name is lowercased.
      assertStringIncludes(
        rendered,
        "redir @tp_edge_port_2 https://front.example.com{uri} 308",
      );
      assertStringIncludes(rendered, "not header Host front.example.com\n");
      assertStringIncludes(rendered, "not header Host front.example.com:443");
      // No public_port, no redirect: the URL port is the origin's.
      assertEquals(rendered.includes("noport.example.com"), false);
      // The duplicate (first entry wins) and the IPv6 literal are left out.
      assertEquals(rendered.includes("@tp_edge_port_3 {"), false);
      assertEquals(rendered.includes(":9443"), false);
      assertEquals(rendered.includes("::1]"), false);

      const none = await renderTemplate(root, []);
      assertEquals(none.includes(MARKER), false);
      assertEquals(none.includes("tp_edge_port"), false);
    }),
});

interface RawResponse {
  status: number;
  headers: Map<string, string>;
}

/** One request with an explicit Host header; reads the head only. */
async function rawRequest(
  port: number,
  host: string,
  path: string,
  extra: string[] = ["Connection: close"],
): Promise<RawResponse> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const head = [`GET ${path} HTTP/1.1`, `Host: ${host}`, ...extra, "", ""]
      .join("\r\n");
    await conn.write(new TextEncoder().encode(head));
    let text = "";
    const buf = new Uint8Array(4096);
    const decoder = new TextDecoder();
    while (!text.includes("\r\n\r\n")) {
      const n = await conn.read(buf);
      if (n === null) break;
      text += decoder.decode(buf.subarray(0, n));
    }
    const [statusLine, ...lines] = text.split("\r\n\r\n")[0].split("\r\n");
    const headers = new Map<string, string>();
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon > 0) {
        headers.set(
          line.slice(0, colon).toLowerCase(),
          line.slice(colon + 1).trim(),
        );
      }
    }
    return { status: Number(statusLine.split(" ")[1]), headers };
  } finally {
    conn.close();
  }
}

test({
  name:
    "the pinned Caddy sends the wrong port to the public port and nothing else",
  ignore: ansiblePlaybook === undefined || caddy === undefined,
  permissions: { read: true, write: true, run: true, env: true, net: true },
  fn: () =>
    withRoot("tp-edge-port-run-", async (root) => {
      await Deno.mkdir(join(root, "ui"), { recursive: true });
      await Deno.writeTextFile(join(root, "ui", "index.html"), "<html></html>");
      const port = freePort();
      const config = join(root, "Caddyfile");
      await Deno.writeTextFile(
        config,
        panelCaddyTestSite(await renderTemplate(root, HOSTNAMES), root, port),
      );
      const { stop } = await startPanelCaddy(
        required(caddy, "caddy"),
        config,
        root,
        port,
      );
      try {
        const redirects: [string, string, string][] = [
          [
            "edge.example.com",
            "/?a=1&b=2",
            "https://edge.example.com:8443/?a=1&b=2",
          ],
          [
            "edge.example.com",
            "/settings/updates",
            "https://edge.example.com:8443/settings/updates",
          ],
          ["edge.example.com:9000", "/", "https://edge.example.com:8443/"],
          ["EDGE.example.com", "/", "https://edge.example.com:8443/"],
          [
            "edge.example.com",
            "/api/client/v1/me",
            "https://edge.example.com:8443/api/client/v1/me",
          ],
          [
            "front.example.com:8443",
            "/x?y=1",
            "https://front.example.com/x?y=1",
          ],
        ];
        for (const [host, path, location] of redirects) {
          const res = await rawRequest(port, host, path);
          assertEquals(res.status, 308, `${host}${path}`);
          assertEquals(res.headers.get("location"), location);
          assertEquals(res.headers.get("cache-control"), "no-store");
        }

        // The public port, unknown names and LAN names never redirect, so
        // there is no loop.
        const stays: [string, string][] = [
          ["edge.example.com:8443", "/"],
          ["front.example.com", "/"],
          ["front.example.com:443", "/"],
          ["panel.lan:8443", "/"],
          ["10.0.0.5:8443", "/"],
          ["other.example.com", "/"],
          ["noport.example.com", "/"],
          // Exempt paths on the wrong port.
          ["edge.example.com", "/api/health"],
          ["edge.example.com", "/api/daemon/v1/instance/identity"],
          ["edge.example.com", "/ws/daemon/v1"],
          ["edge.example.com", "/webhook/github/abc"],
        ];
        for (const [host, path] of stays) {
          const res = await rawRequest(port, host, path);
          assert(res.status !== 308, `${host}${path} redirected`);
        }
        const upgrade = await rawRequest(port, "edge.example.com", "/ws/x", [
          "Connection: keep-alive, Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ]);
        assert(upgrade.status !== 308, "WebSocket upgrade redirected");
      } finally {
        await stop();
      }
    }),
});
