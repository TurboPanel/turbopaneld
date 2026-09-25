/**
 * The daemon's real playbook argv builders, run through tp-orchestrate's real
 * extra-var validator (lifted verbatim from the shipped script).
 *
 * On a managed host every playbook the daemon starts goes through
 * `sudo -n tp-orchestrate playbook …`, which refuses any extra-var key it
 * does not list and any value out of shape. A builder that starts passing a
 * new key, or a value the helper rejects, fails here instead of failing the
 * playbook on a customer host with "refusing extra-var". The hostile corpus
 * pins what the helper must keep refusing.
 */
import { assertEquals } from "@std/assert";
import {
  buildBuildToggleExtraArgs,
  buildDockerSetupExtraArgs,
  buildSetHostnameExtraArgs,
  buildTimeSyncApplyExtraArgs,
  devInstanceExtraArgs,
} from "./ansible.ts";
import { runInstanceCertsApply } from "../instance/public-urls-apply.ts";
import { rootHelperPlaybookInvocation } from "../instance/run-reconcile.ts";
import {
  resolveSiteEngineNeeds,
  siteEngineApplyExtraArgs,
} from "../deploy/site.ts";
import { ensureNativeAppRuntime } from "../deploy/native/apply-native-apps.ts";
import type { EnvironmentDeployNativeAppService } from "../contracts/commands-contracts.ts";
import {
  checkExtraVars,
  extraVarValues,
  makeFakeVendorDir,
} from "../testing/tp-orchestrate-validator.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const INSTALL_ROOT = "/opt/turbopanel";

/** Env keys that would make a builder emit dev-only vars; a managed host has none. */
const DEV_ENV_KEYS = [
  "TURBOPANEL_DEV_USER",
  "TURBOPANEL_DEV_UID",
  "TURBOPANEL_DEV_GID",
  "TURBOPANEL_DEV_ROOT",
  "TURBOPANEL_PUBLIC_URLS",
  "TURBOPANEL_UI_MODE",
  "TURBOPANEL_INSTANCE_RUN_MODE",
  "TURBOPANEL_INSTANCE_RUNTIME",
];

async function withManagedHostEnv<T>(fn: () => Promise<T> | T): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of DEV_ENV_KEYS) {
    saved.set(key, Deno.env.get(key));
    Deno.env.delete(key);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

/** Every `-e` value the daemon produces on a managed host, by builder. */
async function daemonExtraVars(): Promise<Array<[string, string[]]>> {
  const captured: Array<[string, string[]]> = [];
  const capture = (label: string) => (_playbook: string, args?: string[]) => {
    captured.push([label, extraVarValues(args ?? [])]);
    return Promise.resolve();
  };

  captured.push([
    "time-sync-apply",
    extraVarValues(buildTimeSyncApplyExtraArgs({
      timezone: "America/New_York",
      ntpServers: ["pool.ntp.org", "192.0.2.123", "2001:db8::123"],
      ntpFallbackServers: ["time.cloudflare.com"],
      ntpEnabled: true,
    })),
  ]);
  captured.push([
    "docker-setup",
    extraVarValues(buildDockerSetupExtraArgs({
      addressPools: [{ base: "10.200.0.0/16", size: 24 }],
      defaultBridgeCidr: "10.210.0.1/24",
    })),
  ]);
  captured.push([
    "docker-setup (clear)",
    extraVarValues(buildDockerSetupExtraArgs({ clearAddressing: true })),
  ]);
  captured.push([
    "daemon-converge",
    extraVarValues(await withManagedHostEnv(() => devInstanceExtraArgs())),
  ]);
  captured.push([
    "set-hostname",
    extraVarValues(buildSetHostnameExtraArgs("web-01.example.com")),
  ]);
  captured.push([
    "build-toggle",
    extraVarValues(
      buildBuildToggleExtraArgs(
        { uiMode: "static", instanceRunMode: "compiled", forceBuild: true },
        {},
      ),
    ),
  ]);
  await runInstanceCertsApply(
    INSTALL_ROOT,
    [
      { host: "panel.example.com", source: "platform-ca" },
      { host: "192.0.2.10", source: "platform-ca" },
      { host: "le.example.com", source: "lets-encrypt" },
      {
        host: "uploaded.example.com",
        source: "uploaded",
        uploadedCertId: "0b7c6f4e-2a51-4c3e-9d1b-7f6a5e4d3c2b",
      },
    ],
    {
      runPlaybook: capture("instance-certs-apply"),
      instanceAcme: {
        contactEmail: "ops@example.com",
        tosAccepted: true,
        directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
        useStaging: false,
      },
      env: {},
    },
  );
  for (
    const [playbook, extra] of [
      ["instance-backup.yml", {
        turbopanel_backup_dir: "/backup",
        turbopanel_install_root: INSTALL_ROOT,
        turbopanel_upgrade_id: "01J9Z8Y7X6W5V4T3S2R1Q0P9N8",
        turbopanel_instance_version: "0.1.1+build.7",
        turbopanel_instance_revision: "70bfa6da",
      }],
      ["instance-launch-only.yml", { turbopanel_install_root: INSTALL_ROOT }],
      ["instance-rollback.yml", {
        turbopanel_upgrade_id: "01J9Z8Y7X6W5V4T3S2R1Q0P9N8",
      }],
    ] as const
  ) {
    captured.push([
      playbook,
      extraVarValues(rootHelperPlaybookInvocation(playbook, extra).args),
    ]);
  }
  const needs = resolveSiteEngineNeeds(
    [
      { engine: "caddy", php: { version: "8.4" } },
      { engine: "nginx", php: { version: "8.3" } },
      { engine: "apache" },
      { engine: "openlitespeed", php: { version: "8.4" } },
    ] as unknown as Parameters<typeof resolveSiteEngineNeeds>[0],
  );
  for (const engine of ["caddy", "nginx", "apache", "openlitespeed"] as const) {
    captured.push([
      `site-${engine}-apply`,
      extraVarValues(
        siteEngineApplyExtraArgs(engine, needs, ["8.4", "8.3"], {
          "8.4": ["intl", "gd"],
          "8.3": ["mbstring"],
        }),
      ),
    ]);
  }
  await ensureNativeAppRuntime(
    [{ nodeVersion: "24" }, {
      nodeVersion: "22",
    }] as unknown as EnvironmentDeployNativeAppService[],
    {
      runPlaybook: (_playbook, _label, args) => {
        captured.push(["node-app-runtime-apply", extraVarValues(args ?? [])]);
        return Promise.resolve();
      },
    },
  );
  return captured;
}

test("tp-orchestrate accepts every extra-var the daemon passes on a managed host", async () => {
  const vendorDir = await makeFakeVendorDir();
  try {
    const all = await daemonExtraVars();
    const values = all.flatMap(([, v]) => v);
    assertEquals(values.length > 20, true, "builders produced too few values");
    const verdicts = await checkExtraVars(values, { vendorDir });
    const refused = verdicts.filter((v) => !v.accepted).map((v) => {
      const builder = all.find(([, vs]) => vs.includes(v.value))?.[0];
      return `${builder}: ${v.value}`;
    });
    assertEquals(refused, [], "tp-orchestrate would refuse these");
  } finally {
    await Deno.remove(vendorDir, { recursive: true });
  }
});

test("tp-orchestrate refuses keys and values that would steer root Ansible", async () => {
  const vendorDir = await makeFakeVendorDir();
  try {
    const hostile = [
      // Ansible's own knobs: interpreter, connection, privilege.
      "ansible_python_interpreter=/var/lib/turbopanel/py",
      "ansible_become_exe=/tmp/x",
      "ansible_connection=local",
      // Co-located dev ownership on a managed host.
      "turbopanel_dev_user=root",
      "turbopanel_dev_root=/var/lib/turbopanel",
      // Not a key the daemon passes.
      "turbopanel_something_new=1",
      "foo=bar",
      // Root-read/written paths are pinned, not trusted.
      "turbopanel_install_root=/var/lib/turbopanel/fake-root",
      "turbopanel_instance_dir=/tmp/evil",
      "turbopanel_backup_dir=/etc/cron.d",
      "turbopanel_backup_dir=/backup/../etc",
      "turbopanel_backup_dir=/root",
      "turbopanel_backup_dir=relative/dir",
      // Whitespace splits into extra variables; Jinja is templated by Ansible.
      "turbopanel_acme_email=ops@example.com ansible_python_interpreter=/tmp/x",
      "turbopanel_hostname=a b",
      "turbopanel_hostname={{lookup('pipe','id')}}.example.com",
      "turbopanel_hostname=-bad.example.com",
      "turbopanel_hostname=a..b",
      "turbopanel_public_urls=panel.example.com,{{x}}",
      "turbopanel_public_urls=panel.example.com,,x.com",
      "turbopanel_public_urls=*.example.com",
      'turbopanel_hostnames_json=[{"host":"{{x}}"}]',
      'turbopanel_hostnames_json=[{"host":"a b"}]',
      "turbopanel_acme_email=no-at-sign",
      "turbopanel_acme_email=a@localhost",
      "turbopanel_acme_directory=http://acme.example.com/directory",
      "turbopanel_acme_directory=https://acme.example.com/../x",
      "turbopanel_acme_directory=https://acme.example.com/dir?x=1",
      "turbopanel_ui_mode=prod",
      "postgres_expose_port=5432",
      "turbopanel_upgrade_id=../x",
      // JSON: unknown or Ansible keys, templated or spaced strings, non-objects.
      '{"ansible_become":true}',
      "{\"turbopanel_timezone\":\"{{lookup('pipe','id')}}\"}",
      '{"php_fpm_versions":["8.4 ; id"]}',
      '{"unknown_key":1}',
      '["php_fpm_versions"]',
      "{}",
      "@/tmp/vars.yml",
      "turbopanel_hostname=ok.example.com\nansible_connection=local",
    ];
    const verdicts = await checkExtraVars(hostile, { vendorDir });
    const accepted = verdicts.filter((v) => v.accepted).map((v) => v.value);
    assertEquals(accepted, [], "tp-orchestrate accepted hostile extra-vars");
  } finally {
    await Deno.remove(vendorDir, { recursive: true });
  }
});

test("the daemon refuses an unsafe host name or ACME value before any playbook", async () => {
  let ran = false;
  const runPlaybook = () => {
    ran = true;
    return Promise.resolve();
  };
  for (
    const [hostnames, acme] of [
      [
        [{ host: "a b.example.com", source: "platform-ca" as const }],
        undefined,
      ],
      [
        [{ host: "{{x}}.example.com", source: "platform-ca" as const }],
        undefined,
      ],
      [[{ host: "ok.example.com", source: "lets-encrypt" as const }], {
        contactEmail: "ops@example.com extra=1",
        tosAccepted: true,
        directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
        useStaging: false,
      }],
      [[{ host: "ok.example.com", source: "lets-encrypt" as const }], {
        contactEmail: "ops@example.com",
        tosAccepted: true,
        directoryUrl: "https://acme.example.com/{{x}}",
        useStaging: false,
      }],
    ] as const
  ) {
    let threw = false;
    try {
      await runInstanceCertsApply(INSTALL_ROOT, hostnames, {
        runPlaybook,
        instanceAcme: acme,
        env: {},
      });
    } catch {
      threw = true;
    }
    assertEquals(threw, true, JSON.stringify(hostnames));
  }
  assertEquals(ran, false);
  let hostnameThrew = false;
  try {
    buildSetHostnameExtraArgs("bad host");
  } catch {
    hostnameThrew = true;
  }
  assertEquals(hostnameThrew, true);
});
