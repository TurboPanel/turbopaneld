/**
 * Every place the daemon asks root for something, with what it really sends.
 *
 * The daemon reaches root only through `sudo -n …` argvs built at the call
 * sites that pass them through {@link hostSudoArgs}. On a managed host those
 * argvs land in `tp-host` (orchestration/scripts/tp-host), which accepts a
 * fixed set of shapes, or — for the few commands tp-host does not implement —
 * straight in sudo, where `/etc/sudoers.d/tp` must allow them. Each side had
 * its own tests; the seam between them did not, and a daemon argv one element
 * off from what tp-host expected (the ACME certificate `find`) or a group
 * name tp-host does not know silently broke a feature on every host.
 *
 * `tp-host-callsites.test.ts` scans the source for every hostSudoArgs
 * call and fails when one is missing here (so a new call site cannot land
 * without a sample), then runs each `tpHost` sample through the real tp-host
 * in its test mode and matches each `sudo` sample against the rendered
 * sudoers file.
 *
 * Keys are `<file>|<argument text>` with comments and whitespace removed and
 * trailing commas dropped — the test's scanner produces them. Samples are the
 * argv after `-n`, with `{P}` standing for tp-host's test prefix (the host's
 * `/`). Values are what production passes: real unit names, real layout
 * paths under `/etc/turbopanel`, `/var/lib/turbopanel`, `/srv/users`, … .
 */

import {
  backupServiceContent,
  backupServicePath,
  backupTimerContent,
  backupTimerPath,
} from "../backups/units.ts";
import { cronTimerContent, cronTimerPath } from "../deploy/cron/unit.ts";
import { caddyUnit } from "../deploy/ingress.ts";
import { nativeAppUnitContent } from "../deploy/native/unit.ts";
import {
  sitePhpFpmConf,
  sitePhpIni,
  type SitePhpRuntimeSpec,
  sitePhpServiceUnit,
  sitePhpSocketUnit,
} from "../deploy/site/php-runtime.ts";
import { resolveLayout } from "../paths/layout.ts";

/** A path tp-host's test harness must create before the sample runs. */
export type CallSiteSetup = {
  /** Directories to create (with parents). */
  dirs?: string[];
  /** Files to create, `path → contents`. */
  files?: Record<string, string>;
  /** Symlinks to create, `[target, path]`. */
  links?: Array<[string, string]>;
  /** `/etc/group` lines to add. */
  groups?: string[];
  /** Unix sockets to bind (left in place, unlistened). */
  sockets?: string[];
};

export type TpHostSample = {
  argv: string[];
  stdin?: string;
  setup?: CallSiteSetup;
};

export type SudoSample = {
  /** `sudo -u <runas>`; root when omitted. */
  runas?: string;
  /** The command and its arguments, absolute paths as on a managed host. */
  argv: string[];
};

export type CallSite =
  & { key: string; knownBug?: KnownBug }
  & (
    | { via: "tp-host"; samples: TpHostSample[] }
    | { via: "sudo"; samples: SudoSample[] }
    | { via: "none"; why: string }
  );

const P = "{P}";
const UNITS = `${P}/etc/systemd/system`;
const CONF = `${P}/etc/turbopanel`;
const STATE = `${P}/var/lib/turbopanel`;
const HOME = `${P}/srv/users/alice`;
const SITE = `${HOME}/sites/svc1`;
const RELEASE = `${SITE}/releases/20260927-120000`;
const STAGED = `${P}/tmp/staged`;
const SSH_KEYS = `${P}/etc/ssh/turbopanel/authorized_keys`;
/** A sandboxed build: `work/<id>` holding the clone, the runner installed. */
const BUILD_ID = "0123456789abcdef0123456789abcdef";
const PROJECT_ID = "01a0e39d-0418-7852-bc47-bc2f8422d404";
const BUILD_TREE: CallSiteSetup = {
  dirs: [
    `${P}/var/lib/turbopanel-build/work/${BUILD_ID}/source`,
    `${P}/var/lib/turbopanel-build/cache`,
  ],
  files: {
    [`${P}/opt/turbopanel/lib/tp-build-runner`]: "#!/bin/sh\n",
    [`${P}/etc/resolv.conf`]: "nameserver 9.9.9.9\n",
  },
};
const DROP_IN = `${P}/etc/ssh/sshd_config.d/60-turbopanel.conf`;
const ACME_CERTS = `${STATE}/instance-acme/caddy/certificates`;
const ACME_CERT =
  `${ACME_CERTS}/acme-v02.api.letsencrypt.org-directory/panel.example.com/panel.example.com.crt`;
/** A production layout (paths as a managed host has them). */
const LAYOUT = resolveLayout({}, {
  skipDiscovery: true,
  forceMode: "production",
});
/** The vendored runtimes root on a managed host. */
const VENDOR = LAYOUT.runtimesDir;
const CADDY_BIN = `${P}${VENDOR}/caddy/2.11.4/caddy`;
const NGINX_CONF = `${CONF}/nginx/sites/svc1.conf`;
const FABRIC_DIR = `${STATE}/network`;
const WG_CONF = `${P}/etc/wireguard/tp0.conf`;
const FABRIC_SYSCTL = `${P}/etc/sysctl.d/99-turbopanel-fabric.conf`;
/** A WireGuard key's shape (32 bytes, base64), built so no key sits in source. */
const WG_KEY = `${"A".repeat(43)}=`;
const MGD_CHAIN = "TP-MGD-0a1b2c3d";
const MGD_MATCH = [
  "-p",
  "tcp",
  "-m",
  "conntrack",
  "--ctorigdst",
  "198.51.100.2",
  "--ctorigdstport",
  "5432",
];
const APP_UNIT = "turbopanel-app-svc1.service";
const PROBE =
  "a version probe runs as the daemon and never gets a permission error, " +
  "so runHost never retries it through sudo";
const DOCKER_DIRECT =
  "fabric's runDefault sends docker through runDocker, never sudo";

/** What the harness writes to {@link STAGED}. */
export const STAGED_CONTENT = "staged content\n";

/**
 * Unit text as the daemon renders it for a production layout, with the
 * managed roots moved under `{P}` (tp-host checks some exec paths exactly).
 */
const underPrefix = (text: string) =>
  ["/opt/turbopanel", "/etc/turbopanel", "/var/lib/turbopanel", "/srv/users"]
    .reduce((out, root) => out.replaceAll(root, `${P}${root}`), text);
const CRON = {
  layout: LAYOUT,
  environmentId: "env1",
  composeServiceName: "web",
  username: "alice",
  workingDirectory: "/srv/users/alice/sites/svc1/current",
  siteWritableDirs: ["/srv/users/alice/sites/svc1/shared"],
  job: { name: "backup", schedule: "*-*-* 03:00:00", command: ["/bin/true"] },
};
const CRON_TIMER = cronTimerPath(
  { ...CRON, jobName: CRON.job.name },
  UNITS,
);
/** A scheduled-backup policy's units (turbopanel-backup-<policyId>.*). */
const BACKUP_POLICY = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b";
const BACKUP_SERVICE = backupServicePath(BACKUP_POLICY, UNITS);
const BACKUP_TIMER = backupTimerPath(BACKUP_POLICY, UNITS);
const BACKUP_TIMER_UNIT = `turbopanel-backup-${BACKUP_POLICY}.timer`;
const unitSetup = (text: string): CallSiteSetup => ({
  files: { [STAGED]: underPrefix(text) },
});

// One per-site PHP runtime of alice's, as `php-runtime.ts` renders it.
const PHP_APPLY = "src/deploy/site/php-runtime-apply.ts|";
const PHP_ID = "shop-0a1b2c3d4e5f-fcgi84";
const PHP_FPM_ID = "shop-0a1b2c3d4e5f-fpm84";
const PHP_UNIT = `turbopanel-php-${PHP_ID}`;
const PHP_FPM_UNIT = `turbopanel-php-${PHP_FPM_ID}`;
const PHP_CONF_DIR = `${CONF}/php/sites/${PHP_ID}`;
const PHP_FPM_CONF_DIR = `${CONF}/php/sites/${PHP_FPM_ID}`;
const PHP_INI = `${PHP_CONF_DIR}/php.ini`;
const PHP_SPEC: SitePhpRuntimeSpec = {
  id: PHP_ID,
  mode: "fastcgi",
  series: "8.4",
  user: "alice",
  group: "alice-grp",
  home: "/srv/users/alice",
  configDir: "/etc/turbopanel",
  webAccount: "tpnginx",
};
const PHP_FPM_SPEC: SitePhpRuntimeSpec = {
  ...PHP_SPEC,
  id: PHP_FPM_ID,
  mode: "fpm",
};
const PHP_WRITABLE = { writablePaths: ["-/srv/users/alice/sites/svc1/shared"] };
const PHP_INI_TEXT = sitePhpIni([]);
const PHP_SERVICE_TEXT = underPrefix(
  sitePhpServiceUnit(PHP_SPEC, PHP_WRITABLE),
);
const PHP_FPM_SERVICE_TEXT = underPrefix(
  sitePhpServiceUnit(PHP_FPM_SPEC, PHP_WRITABLE),
);
const PHP_SOCKET_TEXT = sitePhpSocketUnit(PHP_SPEC);
const PHP_FPM_CONF_TEXT = sitePhpFpmConf(PHP_FPM_SPEC, { pool: [] });
/** What `php-test` needs on disk: the installed unit and its php.ini. */
const PHP_TEST_SETUP: CallSiteSetup = {
  files: {
    [`${UNITS}/${PHP_UNIT}.service`]: PHP_SERVICE_TEXT,
    [PHP_INI]: PHP_INI_TEXT,
  },
};

/** `install -m 0644 -o root -g root STAGED <unit>` with the unit's text staged. */
function phpUnitSample(path: string, text: string): TpHostSample {
  return {
    argv: ["install", "-m", "0644", "-o", "root", "-g", "root", STAGED, path],
    setup: { files: { [STAGED]: text } },
  };
}

/** tp-host's `-n <verb> …` samples for one call-site key. */
function tpHost(key: string, ...samples: TpHostSample[]): CallSite {
  return { key, via: "tp-host", samples };
}

/** Samples that bypass tp-host and must match a sudoers rule. */
function sudo(key: string, ...samples: SudoSample[]): CallSite {
  return { key, via: "sudo", samples };
}

/** A wrapper call that never reaches sudo (so root never sees it). */
function notRoot(key: string, why: string): CallSite {
  return { key, via: "none", why };
}

const file = (path: string, contents = "x\n"): CallSiteSetup => ({
  files: { [path]: contents },
});
const dir = (...paths: string[]): CallSiteSetup => ({ dirs: paths });

/** `install -d -m MODE -o USER -g GROUP PATH`, under an existing `parent`. */
function installDir(
  mode: string,
  owner: string,
  path: string,
  parent?: string,
): TpHostSample {
  const [user, group] = owner.split(":");
  return {
    argv: ["install", "-d", "-m", mode, "-o", user, "-g", group, path],
    ...(parent === undefined ? {} : { setup: dir(parent) }),
  };
}

const SITES: CallSite[] = [
  // --- commands -------------------------------------------------------------
  tpHost(
    'src/commands/fabric.ts|["-n",cmd,...args]',
    { argv: ["ip", "link", "set", "dev", "tp0", "up"] },
    { argv: ["ip", "-o", "-4", "addr", "show", "dev", "tp0"] },
    { argv: ["wg", "show", "tp0", "dump"] },
  ),
  tpHost('src/commands/reboot.ts|["-n","systemctl","reboot"]', {
    argv: ["systemctl", "reboot"],
  }),
  tpHost('src/commands/stop-environment.ts|["-n","rm","-rf","--",path]', {
    argv: ["rm", "-rf", "--", SITE],
    setup: dir(SITE),
  }),
  tpHost(
    'src/commands/stop-environment.ts|["-n","rm","-rf","--",deploymentDir]',
    {
      argv: ["rm", "-rf", "--", `${STATE}/deployments/proj1/env1`],
      setup: dir(`${STATE}/deployments/proj1/env1/data`),
    },
  ),

  // --- per-site PHP runtimes (site/php-runtime-apply.ts) -------------------
  tpHost(
    `${PHP_APPLY}["-n",...args]`,
    { argv: ["php-test", PHP_ID], setup: PHP_TEST_SETUP },
    { argv: ["systemctl", "start", `${PHP_UNIT}.socket`] },
  ),
  tpHost(`${PHP_APPLY}sudo(io,args)`, {
    argv: ["systemctl", "restart", `${PHP_UNIT}.service`],
  }),
  tpHost(
    `${PHP_APPLY}sudo(io,["cp","-p","--",path,\`\${path}\${CONFIG_PREVIOUS_SUFFIX}\`])`,
    {
      argv: ["cp", "-p", "--", PHP_INI, `${PHP_INI}.tpprev`],
      setup: { files: { [PHP_INI]: PHP_INI_TEXT } },
    },
  ),
  tpHost(`${PHP_APPLY}sudo(io,["ls","-1","--",io.unitDir])`, {
    argv: ["ls", "-1", "--", UNITS],
  }),
  tpHost(`${PHP_APPLY}sudo(io,["php-test",files.spec.id])`, {
    argv: ["php-test", PHP_ID],
    setup: PHP_TEST_SETUP,
  }),
  tpHost(
    `${PHP_APPLY}sudo(io,["systemctl","is-active","--quiet",service])`,
    { argv: ["systemctl", "is-active", "--quiet", `${PHP_UNIT}.service`] },
  ),
  tpHost(`${PHP_APPLY}sudo(io,["systemctl","is-active","--quiet",unit])`, {
    argv: ["systemctl", "is-active", "--quiet", `${PHP_UNIT}.socket`],
  }),
  tpHost(`${PHP_APPLY}sudo(io,["systemctl","start",unit])`, {
    argv: ["systemctl", "start", `${PHP_UNIT}.socket`],
  }),
  tpHost(
    `${PHP_APPLY}sudoOrThrow(io,["install","-d","-m","0750","-o","root","-g",spec.group,sitePhpConfigDir(spec.configDir,spec.id)],\`PHPruntime\${spec.id}:configdirectory\`)`,
    installDir("0750", "root:alice-grp", PHP_CONF_DIR),
  ),
  tpHost(
    `${PHP_APPLY}sudoOrThrow(io,["install","-m","0640","-o","root","-g",spec.group,tmp,path],\`PHPruntime\${spec.id}:tp-hostrefused\${name}\`)`,
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "root",
        "-g",
        "alice-grp",
        STAGED,
        PHP_INI,
      ],
      setup: { dirs: [PHP_CONF_DIR], files: { [STAGED]: PHP_INI_TEXT } },
    },
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "root",
        "-g",
        "alice-grp",
        STAGED,
        `${PHP_FPM_CONF_DIR}/php-fpm.conf`,
      ],
      setup: {
        dirs: [PHP_FPM_CONF_DIR],
        files: { [STAGED]: PHP_FPM_CONF_TEXT },
      },
    },
  ),
  tpHost(
    `${PHP_APPLY}sudoOrThrow(io,["install","-m","0644","-o","root","-g","root",tmp,path],\`tp-hostrefused\${name}\`)`,
    phpUnitSample(`${UNITS}/${PHP_UNIT}.socket`, PHP_SOCKET_TEXT),
    phpUnitSample(`${UNITS}/${PHP_UNIT}.service`, PHP_SERVICE_TEXT),
    phpUnitSample(`${UNITS}/${PHP_FPM_UNIT}.service`, PHP_FPM_SERVICE_TEXT),
  ),
  tpHost(
    `${PHP_APPLY}sudoOrThrow(io,["systemctl","daemon-reload"],"daemon-reload")`,
    { argv: ["systemctl", "daemon-reload"] },
  ),
  tpHost(
    `${PHP_APPLY}sudoOrThrow(io,["systemctl","enable","--now",socket],\`PHPruntime\${spec.id}:socket\`)`,
    { argv: ["systemctl", "enable", "--now", `${PHP_UNIT}.socket`] },
  ),
  tpHost(
    `${PHP_APPLY}sudoOrThrow(io,["systemctl","enable",service],\`PHPruntime\${spec.id}:enable\`)`,
    { argv: ["systemctl", "enable", `${PHP_FPM_UNIT}.service`] },
  ),
  tpHost(
    `${PHP_APPLY}sudoOrThrow(io,["systemctl","restart",service],\`PHPruntime\${spec.id}:start\`)`,
    { argv: ["systemctl", "restart", `${PHP_UNIT}.service`] },
  ),
  tpHost(
    `${PHP_APPLY}sudoOrThrow(io,["systemctl",action,service],\`PHPruntime\${spec.id}:\${action}\`)`,
    { argv: ["systemctl", "restart", `${PHP_FPM_UNIT}.service`] },
    { argv: ["systemctl", "reload", `${PHP_FPM_UNIT}.service`] },
  ),
  tpHost(
    `${PHP_APPLY}sudoQuietly(io,["install","-m","0644","-o","root","-g","root",tmp,unit.path],\`couldnotrestore\${unit.path}\`)`,
    phpUnitSample(`${UNITS}/${PHP_UNIT}.service`, PHP_SERVICE_TEXT),
  ),
  tpHost(
    `${PHP_APPLY}sudoQuietly(io,["rm","-f","--",\`\${config.path}\${CONFIG_PREVIOUS_SUFFIX}\`],\`couldnotdrop\${config.path}\${CONFIG_PREVIOUS_SUFFIX}\`)`,
    { argv: ["rm", "-f", "--", `${PHP_INI}.tpprev`], setup: dir(PHP_CONF_DIR) },
  ),
  tpHost(
    `${PHP_APPLY}sudoQuietly(io,["rm","-f","--",join(io.unitDir,name)],\`couldnotremove\${name}\`)`,
    { argv: ["rm", "-f", "--", `${UNITS}/${PHP_UNIT}.socket`] },
    { argv: ["rm", "-f", "--", `${UNITS}/${PHP_UNIT}.service`] },
  ),
  tpHost(
    `${PHP_APPLY}sudoQuietly(io,["rm","-rf","--",sitePhpConfigDir(configDir,id)],\`couldnotremovethePHPconfigof\${id}\`)`,
    { argv: ["rm", "-rf", "--", PHP_CONF_DIR], setup: dir(PHP_CONF_DIR) },
  ),
  tpHost(
    `${PHP_APPLY}sudoQuietly(io,["systemctl","daemon-reload"],"daemon-reload")`,
    { argv: ["systemctl", "daemon-reload"] },
  ),
  tpHost(
    `${PHP_APPLY}sudoQuietly(io,["systemctl","disable",...names],\`disable\${id}\`)`,
    {
      argv: [
        "systemctl",
        "disable",
        `${PHP_UNIT}.socket`,
        `${PHP_UNIT}.service`,
      ],
    },
  ),
  tpHost(
    `${PHP_APPLY}sudoQuietly(io,["systemctl","reset-failed",unit],\`reset\${unit}\`)`,
    { argv: ["systemctl", "reset-failed", `${PHP_FPM_UNIT}.service`] },
  ),
  tpHost(
    `${PHP_APPLY}sudoQuietly(io,["systemctl","restart",sitePhpServiceName(spec.id)],\`couldnotrestart\${sitePhpServiceName(spec.id)}onitspreviousconfig\`)`,
    { argv: ["systemctl", "restart", `${PHP_FPM_UNIT}.service`] },
  ),
  tpHost(
    `${PHP_APPLY}sudoQuietly(io,["systemctl","stop",...names],\`stop\${id}\`)`,
    {
      argv: ["systemctl", "stop", `${PHP_UNIT}.socket`, `${PHP_UNIT}.service`],
    },
  ),
  tpHost(
    `${PHP_APPLY}sudoQuietly(io,args,\`couldnotrestore\${config.path}\`)`,
    {
      argv: ["mv", "-f", "--", `${PHP_INI}.tpprev`, PHP_INI],
      setup: { files: { [`${PHP_INI}.tpprev`]: PHP_INI_TEXT } },
    },
    { argv: ["rm", "-f", "--", PHP_INI], setup: dir(PHP_CONF_DIR) },
  ),

  // --- systemd unit sets (tenant cron, scheduled backups) ------------------
  tpHost(
    'src/deploy/systemd-unit-set.ts|["-n","systemctl",...args]',
    { argv: ["systemctl", "daemon-reload"] },
    {
      argv: [
        "systemctl",
        "enable",
        "--now",
        "turbopanel-cron-svc1-backup.timer",
      ],
    },
    {
      argv: [
        "systemctl",
        "disable",
        "--now",
        "turbopanel-cron-svc1-backup.timer",
      ],
    },
    { argv: ["systemctl", "enable", "--now", BACKUP_TIMER_UNIT] },
    { argv: ["systemctl", "disable", "--now", BACKUP_TIMER_UNIT] },
  ),
  tpHost('src/deploy/systemd-unit-set.ts|["-n","cmp","-s","--",staged,path]', {
    argv: [
      "cmp",
      "-s",
      "--",
      STAGED,
      `${UNITS}/turbopanel-cron-svc1-backup.service`,
    ],
    setup: file(`${UNITS}/turbopanel-cron-svc1-backup.service`, STAGED_CONTENT),
  }),
  tpHost(
    'src/deploy/systemd-unit-set.ts|["-n","install","-m","0644","-o","root","-g","root",staged,path]',
    {
      argv: [
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        STAGED,
        CRON_TIMER,
      ],
      setup: unitSetup(cronTimerContent(CRON)),
    },
    {
      argv: [
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        STAGED,
        BACKUP_SERVICE,
      ],
      setup: unitSetup(backupServiceContent(LAYOUT, BACKUP_POLICY)),
    },
    {
      argv: [
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        STAGED,
        BACKUP_TIMER,
      ],
      setup: unitSetup(backupTimerContent(BACKUP_POLICY, "*-*-* 03:00:00")),
    },
  ),
  tpHost('src/deploy/systemd-unit-set.ts|["-n","ls","-1","--",unitDir]', {
    argv: ["ls", "-1", "--", UNITS],
  }),
  tpHost(
    'src/deploy/systemd-unit-set.ts|["-n","rm","-f","--",join(unitDir,`${unit}${suffix}`)]',
    { argv: ["rm", "-f", "--", `${UNITS}/turbopanel-cron-svc1-backup.timer`] },
    { argv: ["rm", "-f", "--", BACKUP_TIMER] },
    { argv: ["rm", "-f", "--", BACKUP_SERVICE] },
  ),

  // --- hosting Caddy --------------------------------------------------------
  tpHost(
    'src/deploy/ensure-hosting-caddy.ts|["-n","chown","root",binPath]',
    { argv: ["chown", "root", CADDY_BIN], setup: file(CADDY_BIN) },
  ),

  // --- principals -----------------------------------------------------------
  tpHost('src/deploy/ensure-principal.ts|["-n","setfacl","-m","o::x",path]', {
    argv: ["setfacl", "-m", "o::x", `${P}/srv/users`],
  }),
  tpHost(
    'src/deploy/ensure-principal.ts|["-n","install","-d","-m",mode,"-o",user,"-g",group,path]',
    // The home root, then the principal home skeleton, parent before child.
    installDir("0750", "root:root", `${P}/srv/users`),
    installDir("0750", "root:alice-grp", HOME, `${P}/srv/users`),
    installDir("0700", "alice:alice-grp", `${HOME}/home`, HOME),
    installDir("0700", "alice:alice-grp", `${HOME}/data`, HOME),
    installDir("0700", "alice:alice-grp", `${HOME}/tmp`, HOME),
    installDir("0750", "root:alice-grp", `${HOME}/sites`, HOME),
    installDir("0750", "root:alice-grp", `${HOME}/volumes`, HOME),
    // Managed lane (site.ts) and release lane (release-layout.ts).
    installDir("0750", "root:alice-grp", SITE, `${HOME}/sites`),
    installDir("0750", "alice:tpnginx", `${SITE}/webroot`, SITE),
    installDir("0750", "alice:alice-grp", `${SITE}/shared`, SITE),
    installDir("0750", "root:alice-grp", `${SITE}/releases`, SITE),
  ),
  tpHost(
    "src/deploy/ensure-principal.ts|args",
    {
      argv: [
        "groupadd",
        "-K",
        "GID_MIN=15001",
        "-K",
        "GID_MAX=60000",
        "bob-grp",
      ],
    },
    { argv: ["groupadd", "-g", "15002", "bob-grp"] },
    {
      argv: [
        "useradd",
        "-K",
        "UID_MIN=15001",
        "-K",
        "UID_MAX=60000",
        "-g",
        "bob-grp",
        "-d",
        `${P}/srv/users/bob/home`,
        "-M",
        "-s",
        "/bin/bash",
        "bob",
      ],
      // The groupadd sample above runs first.
      setup: { groups: ["bob-grp:x:15002:"] },
    },
  ),
  tpHost(
    'src/deploy/ensure-principal.ts|["-n","usermod","-s",shell,principal.username]',
    { argv: ["usermod", "-s", "/usr/sbin/nologin", "alice"] },
  ),
  tpHost(
    'src/deploy/ensure-principal.ts|["-n","getent","shadow","--",username]',
    {
      argv: ["getent", "shadow", "--", "alice"],
    },
  ),
  tpHost('src/deploy/ensure-principal.ts|["-n","chpasswd","-e"]', {
    argv: ["chpasswd", "-e"],
    // A crypt(3) SHA-512 shape, assembled so no hash literal sits in source.
    stdin: `alice:${["", "6", "salt", "hash"].join("$")}\n`,
  }),
  tpHost('src/deploy/ensure-principal.ts|["-n","usermod","-p","!",username]', {
    argv: ["usermod", "-p", "!", "alice"],
  }),
  tpHost(
    'src/deploy/ensure-principal.ts|["-n","usermod","-aG",groupName,user]',
    {
      argv: ["usermod", "-aG", "tpsftp", "alice"],
    },
  ),
  tpHost(
    'src/deploy/ensure-principal.ts|["-n","gpasswd","-d",user,groupName]',
    {
      argv: ["gpasswd", "-d", "alice", "tpsftp"],
    },
  ),

  // --- hosting ingress ------------------------------------------------------
  tpHost(
    'src/deploy/ingress.ts|["-n","install","-m","0640",unitSource,join("/etc/systemd/system",CADDY_SERVICE)]',
    {
      argv: [
        "install",
        "-m",
        "0640",
        STAGED,
        `${UNITS}/turbopanel-hosting-caddy.service`,
      ],
      setup: unitSetup(caddyUnit(LAYOUT)),
    },
  ),
  tpHost('src/deploy/ingress.ts|["-n","systemctl","daemon-reload"]', {
    argv: ["systemctl", "daemon-reload"],
  }),
  tpHost(
    'src/deploy/ingress.ts|["-n","systemctl","enable","--now",CADDY_SERVICE]',
    {
      argv: [
        "systemctl",
        "enable",
        "--now",
        "turbopanel-hosting-caddy.service",
      ],
    },
  ),
  tpHost('src/deploy/ingress.ts|["-n","systemctl","restart",CADDY_SERVICE]', {
    argv: ["systemctl", "restart", "turbopanel-hosting-caddy.service"],
  }),
  tpHost('src/deploy/ingress.ts|["-n","systemctl","reload",CADDY_SERVICE]', {
    argv: ["systemctl", "reload", "turbopanel-hosting-caddy.service"],
  }),

  // --- control-plane Let's Encrypt ------------------------------------------
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","systemctl","reload",CONTROL_PLANE_CADDY_SERVICE]',
    { argv: ["systemctl", "reload", "turbopanel-caddy.service"] },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","ss","-H","-ltnp","sport=:80"]',
    {
      argv: ["ss", "-H", "-ltnp", "sport = :80"],
    },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","systemctl","reload",HOSTING_CADDY_SERVICE]',
    { argv: ["systemctl", "reload", "turbopanel-hosting-caddy.service"] },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","systemctl","enable","--now",HOSTING_CADDY_SERVICE]',
    {
      argv: [
        "systemctl",
        "enable",
        "--now",
        "turbopanel-hosting-caddy.service",
      ],
    },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","systemctl","disable","--now",HOSTING_CADDY_SERVICE]',
    {
      argv: [
        "systemctl",
        "disable",
        "--now",
        "turbopanel-hosting-caddy.service",
      ],
    },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","systemctl","start",INSTANCE_ACME_SERVICE]',
    { argv: ["systemctl", "start", "turbopanel-instance-acme.service"] },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","setfacl","-P","-m",INSTANCE_ACME_SOCKET_ACL,socketPath]',
    {
      argv: [
        "setfacl",
        "-P",
        "-m",
        "u:tpedge:rw",
        `${P}/run/turbopanel/instance-acme.sock`,
      ],
      setup: { sockets: [`${P}/run/turbopanel/instance-acme.sock`] },
    },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","systemctl","stop",INSTANCE_ACME_SERVICE]',
    { argv: ["systemctl", "stop", "turbopanel-instance-acme.service"] },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","install","-m",modeText(mode),"-o","root","-g",INSTANCE_ACME_CERT_GROUP,"--",staged,dest]',
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "root",
        "-g",
        "tp",
        "--",
        STAGED,
        `${CONF}/tls/instance-acme/panel.example.com.crt`,
      ],
      // The daemon creates the directory first (as itself).
      setup: dir(`${CONF}/tls/instance-acme`),
    },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","chown",`:${INSTANCE_ACME_CERT_GROUP}`,dest]',
    {
      argv: ["chown", ":tp", `${CONF}/tls/instance-acme/panel.example.com.key`],
      setup: file(`${CONF}/tls/instance-acme/panel.example.com.key`),
    },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","chmod",modeText(mode),dest]',
    {
      argv: [
        "chmod",
        "0600",
        `${CONF}/tls/instance-acme/panel.example.com.key`,
      ],
      setup: file(`${CONF}/tls/instance-acme/panel.example.com.key`),
    },
  ),
  tpHost('src/deploy/instance-acme-http01.ts|["-n","cat","--",path]', {
    argv: ["cat", "--", ACME_CERT],
    setup: file(ACME_CERT),
  }),
  tpHost(
    'src/deploy/instance-acme-http01.ts|sudoBytes(["-n",...issuedCertificateFindArgs(root,host)])',
    {
      argv: [
        "find",
        ACME_CERTS,
        "-mindepth",
        "3",
        "-maxdepth",
        "3",
        "-type",
        "f",
        "-name",
        "panel.example.com.crt",
      ],
      setup: file(ACME_CERT),
    },
  ),
  tpHost("src/deploy/instance-acme-http01.ts|[...args]", {
    argv: [
      "find",
      ACME_CERTS,
      "-mindepth",
      "3",
      "-maxdepth",
      "3",
      "-type",
      "f",
      "-name",
      "panel.example.com.crt",
    ],
    setup: file(ACME_CERT),
  }),
  tpHost('src/deploy/instance-acme-http01.ts|["-n","tee",path]', {
    argv: ["tee", `${CONF}/instance-acme/Caddyfile`],
    stdin: "{\n}\n",
    setup: dir(`${CONF}/instance-acme`),
  }),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","chown",`root:${INSTANCE_ACME_CERT_GROUP}`,path]',
    {
      argv: ["chown", "root:tp", `${CONF}/instance-acme/Caddyfile`],
      setup: file(`${CONF}/instance-acme/Caddyfile`),
    },
  ),
  tpHost('src/deploy/instance-acme-http01.ts|["-n","chmod","0640",path]', {
    argv: ["chmod", "0640", `${CONF}/instance-acme/Caddyfile`],
    setup: file(`${CONF}/instance-acme/Caddyfile`),
  }),

  // --- native apps ----------------------------------------------------------
  tpHost(
    'src/deploy/native/apply-native-apps.ts|["-n","cmp","-s","--",stagedPath,installedPath]',
    {
      argv: [
        "cmp",
        "-s",
        "--",
        STAGED,
        `${UNITS}/turbopanel-app-svc1.service`,
      ],
      setup: file(`${UNITS}/turbopanel-app-svc1.service`, STAGED_CONTENT),
    },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|["-n","install","-m","0644","-o","root","-g","root",params.stagedPath,params.installedPath]',
    {
      argv: [
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        STAGED,
        `${UNITS}/turbopanel-app-svc1.service`,
      ],
      setup: unitSetup(
        nativeAppUnitContent({
          layout: LAYOUT,
          app: {
            composeServiceName: "api",
            serviceId: "svc1",
            listenPort: 4100,
            framework: "node",
          },
          username: "alice",
          environmentId: "env1",
        }),
      ),
    },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|["-n","systemctl",...args]',
    { argv: ["systemctl", "restart", "turbopanel-app-svc1.service"] },
    {
      argv: [
        "systemctl",
        "is-active",
        "--quiet",
        "turbopanel-app-svc1.service",
      ],
    },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|["-n","journalctl",`--unit=${unit}`,"-n",String(NATIVE_APP_JOURNAL_TAIL),"--no-pager","--output=short-iso"]',
    {
      argv: [
        "journalctl",
        "--unit=turbopanel-app-svc1.service",
        "-n",
        "80",
        "--no-pager",
        "--output=short-iso",
      ],
    },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|["-n","rm","-f","--",nativeAppUnitPath(serviceId,deps?.systemdUnitDir)]',
    { argv: ["rm", "-f", "--", `${UNITS}/turbopanel-app-svc1.service`] },
  ),

  // --- release promotion ----------------------------------------------------
  tpHost(
    'src/deploy/release/build-sandbox.ts|["-n","build-run",work.buildId,work.projectKey],MANAGED',
    {
      argv: ["build-run", BUILD_ID, PROJECT_ID],
      stdin: "tp-build-spec 1\ncwd source\nrun dHJ1ZQ==\nend\n",
      setup: BUILD_TREE,
    },
  ),
  tpHost(
    'src/deploy/release/build-sandbox.ts|["-n","build-return",work.buildId],MANAGED',
    { argv: ["build-return", BUILD_ID], setup: BUILD_TREE },
  ),
  tpHost(
    'src/deploy/release/build-sandbox.ts|["-n","systemctl","stop",`turbopanel-build-${work.buildId}.service`],MANAGED',
    { argv: ["systemctl", "stop", `turbopanel-build-${BUILD_ID}.service`] },
  ),
  tpHost('src/deploy/release/promote.ts|["-n","mkdir","-p","--",to]', {
    argv: ["mkdir", "-p", "--", RELEASE],
  }),
  tpHost('src/deploy/release/promote.ts|["-n","cp","-a","--",`${from}/.`,to]', {
    argv: ["cp", "-a", "--", `${STATE}/release-handoff/svc1/.`, RELEASE],
    setup: {
      files: {
        [`${STATE}/release-handoff/svc1/index.html`]: "<h1>hi</h1>\n",
      },
      dirs: [RELEASE],
    },
  }),
  tpHost('src/deploy/release/promote.ts|["-n","mkdir","-p","--",destDir]', {
    argv: ["mkdir", "-p", "--", `${RELEASE}/config`],
  }),
  tpHost(
    'src/deploy/release/promote.ts|["-n","install","-m","0640","-o","root","-g","root","--",staged,dest]',
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "root",
        "-g",
        "root",
        "--",
        STAGED,
        `${RELEASE}/config/app.env`,
      ],
      setup: dir(`${RELEASE}/config`),
    },
  ),
  tpHost('src/deploy/release/promote.ts|["-n","test","-e",currentLink]', {
    argv: ["test", "-e", `${SITE}/current`],
    setup: {
      dirs: [RELEASE],
      links: [["releases/20260927-120000", `${SITE}/current`]],
    },
  }),
  tpHost('src/deploy/release/promote.ts|["-n","test","-L",currentLink]', {
    argv: ["test", "-L", `${SITE}/current`],
    setup: {
      dirs: [RELEASE],
      links: [["releases/20260927-120000", `${SITE}/current`]],
    },
  }),
  tpHost('src/deploy/release/promote.ts|["-n","readlink","--",currentLink]', {
    argv: ["readlink", "--", `${SITE}/current`],
    setup: {
      dirs: [RELEASE],
      links: [["releases/20260927-120000", `${SITE}/current`]],
    },
  }),
  tpHost('src/deploy/release/promote.ts|["-n","rm","-f","--",tmpLink]', {
    argv: ["rm", "-f", "--", `${SITE}/current.tmp`],
    setup: dir(SITE),
  }),
  tpHost('src/deploy/release/promote.ts|["-n","ln","-s","--",target,tmpLink]', {
    argv: ["ln", "-s", "--", "releases/20260927-120000", `${SITE}/current.tmp`],
    setup: dir(RELEASE),
  }),
  tpHost(
    'src/deploy/release/promote.ts|["-n","mv","-Tf","--",tmpLink,currentLink]',
    {
      argv: ["mv", "-Tf", "--", `${SITE}/current.tmp`, `${SITE}/current`],
      setup: {
        dirs: [RELEASE],
        links: [["releases/20260927-120000", `${SITE}/current.tmp`]],
      },
    },
  ),
  tpHost('src/deploy/release/promote.ts|["-n","test","-e",path]', {
    argv: ["test", "-e", `${SITE}/shared`],
    setup: dir(`${SITE}/shared`),
  }),
  tpHost('src/deploy/release/promote.ts|["-n","test","-d",target]', {
    argv: ["test", "-d", `${RELEASE}/public`],
    setup: dir(`${RELEASE}/public`),
  }),
  tpHost('src/deploy/release/promote.ts|["-n","rm","-rf","--",linkPath]', {
    argv: ["rm", "-rf", "--", `${RELEASE}/storage`],
    setup: dir(`${RELEASE}/storage`),
  }),
  tpHost(
    'src/deploy/release/promote.ts|["-n","ln","-s","--",RELEASE_SHARED_LINK_TARGET,linkPath]',
    {
      argv: ["ln", "-s", "--", "../../shared", `${RELEASE}/shared`],
      setup: dir(RELEASE, `${SITE}/shared`),
    },
  ),
  tpHost(
    'src/deploy/release/release-layout.ts|["-n","chown","-R",owner,releaseDir]',
    {
      argv: ["chown", "-R", "root:alice-grp", RELEASE],
      setup: dir(RELEASE),
    },
  ),
  tpHost(
    'src/deploy/release/release-layout.ts|["-n","chmod",mode,releaseDir]',
    {
      argv: ["chmod", "0750", RELEASE],
      setup: dir(RELEASE),
    },
  ),
  tpHost(
    'src/deploy/release/release-layout.ts|["-n","rm","-rf","--",releaseDir]',
    {
      argv: ["rm", "-rf", "--", RELEASE],
      setup: dir(RELEASE),
    },
  ),
  tpHost('src/deploy/release/retention.ts|["-n","ls","-1t","--",releasesDir]', {
    argv: ["ls", "-1t", "--", `${SITE}/releases`],
    setup: dir(RELEASE),
  }),
  tpHost('src/deploy/release/retention.ts|["-n","rm","-rf","--",path]', {
    argv: ["rm", "-rf", "--", RELEASE],
    setup: dir(RELEASE),
  }),

  // --- sites ----------------------------------------------------------------
  tpHost(
    'src/deploy/site.ts|["-n","install","-d","-m","0750","-o","root","-g",group,metaDir]',
    {
      argv: [
        "install",
        "-d",
        "-m",
        "0750",
        "-o",
        "root",
        "-g",
        "alice-grp",
        `${SITE}/meta`,
      ],
    },
  ),
  tpHost(
    'src/deploy/site.ts|["-n","install","-m","0640","-o","root","-g",group,staged,target]',
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "root",
        "-g",
        "alice-grp",
        STAGED,
        `${SITE}/meta/robots.txt`,
      ],
      setup: dir(`${SITE}/meta`),
    },
  ),
  tpHost(
    'src/deploy/site.ts|["-n","install","-d","-m","0750","-o","root","-g",group,path]',
    {
      argv: [
        "install",
        "-d",
        "-m",
        "0750",
        "-o",
        "root",
        "-g",
        "tpnginx",
        `${CONF}/nginx/sites`,
      ],
      setup: dir(`${CONF}/nginx`),
    },
  ),
  tpHost('src/deploy/site.ts|["-n","ls","-A","--",dir]', {
    argv: ["ls", "-A", "--", `${CONF}/nginx/sites`],
    setup: dir(`${CONF}/nginx/sites`),
  }),
  tpHost('src/deploy/site.ts|["-n","cat","--",path]', {
    argv: ["cat", "--", `${CONF}/openlitespeed/sites/tp-env1-www.conf`],
    setup: file(`${CONF}/openlitespeed/sites/tp-env1-www.conf`),
  }),
  tpHost('src/deploy/site.ts|["-n","rm","-f",path]', {
    argv: ["rm", "-f", `${CONF}/php/8.4/pool.d/svc1.conf`],
  }),
  tpHost('src/deploy/site.ts|["-n","chown","-R",`${user}:${group}`,base]', {
    argv: ["chown", "-R", "alice:alice-grp", `${SITE}/webroot`],
    setup: dir(`${SITE}/webroot`),
  }),
  tpHost('src/deploy/site.ts|["-n","chmod","-R","u=rwX,g=rX,o=",base]', {
    argv: ["chmod", "-R", "u=rwX,g=rX,o=", `${SITE}/webroot`],
    setup: dir(`${SITE}/webroot`),
  }),
  tpHost(
    'src/deploy/site.ts|["-n",...setgidDirectoriesFindArgs(base)]',
    {
      argv: [
        "find",
        `${SITE}/webroot`,
        "-type",
        "d",
        "-exec",
        "chmod",
        "g+s",
        "{}",
        "+",
      ],
      setup: dir(`${SITE}/webroot`),
    },
  ),
  tpHost(
    'src/deploy/release/release-links.ts|["-n",...releaseLinkTargetsFindArgs(releaseDir)]',
    {
      argv: [
        "find",
        RELEASE,
        "-type",
        "l",
        "-exec",
        "realpath",
        "-m",
        "-z",
        "--",
        "{}",
        "+",
      ],
      setup: dir(RELEASE),
    },
  ),
  tpHost('src/deploy/site.ts|["-n","ls","-A","--",documentRoot]', {
    argv: ["ls", "-A", "--", `${SITE}/webroot`],
    setup: dir(`${SITE}/webroot`),
  }),
  tpHost('src/deploy/site/app-detect.ts|["-n","ls","-A","--",path]', {
    argv: ["ls", "-A", "--", `${SITE}/webroot`],
    setup: dir(`${SITE}/webroot`),
  }),
  tpHost(
    'src/deploy/site.ts|["-n","install","-m","0640","-o",userasstring,"-g",groupasstring,staged,join(documentRoot,"index.html")]',
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "alice",
        "-g",
        "alice-grp",
        STAGED,
        `${SITE}/webroot/index.html`,
      ],
      setup: dir(`${SITE}/webroot`),
    },
  ),
  tpHost('src/deploy/site.ts|["-n","systemctl","disable","--now",unit]', {
    argv: ["systemctl", "disable", "--now", "turbopanel-php-fpm@8.4.service"],
  }),
  tpHost('src/deploy/site.ts|["-n","rm","-rf",vhostDir]', {
    argv: ["rm", "-rf", `${CONF}/openlitespeed/vhosts/svc1`],
    setup: dir(`${CONF}/openlitespeed/vhosts/svc1`),
  }),

  // --- web engine configs ---------------------------------------------------
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","cmp","-s","--",stagedPath,configPath]',
    {
      argv: ["cmp", "-s", "--", `${NGINX_CONF}.tmp`, NGINX_CONF],
      setup: {
        files: { [`${NGINX_CONF}.tmp`]: "a\n", [NGINX_CONF]: "a\n" },
      },
    },
  ),
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","install","-m","0640","-o","root","-g",group,tmp,configPath]',
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "root",
        "-g",
        "tpnginx",
        `${NGINX_CONF}.tmp`,
        NGINX_CONF,
      ],
      setup: file(`${NGINX_CONF}.tmp`),
    },
  ),
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","install","-m","0640","-o","root","-g",group,tmp,candidatePath]',
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "root",
        "-g",
        "tpnginx",
        `${NGINX_CONF}.tmp`,
        `${NGINX_CONF}.candidate`,
      ],
      setup: file(`${NGINX_CONF}.tmp`),
    },
  ),
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","cp","-p","--",configPath,previousPath]',
    {
      argv: ["cp", "-p", "--", NGINX_CONF, `${NGINX_CONF}.previous`],
      setup: file(NGINX_CONF),
    },
  ),
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","mv","-f","--",staged.candidatePath,staged.path]',
    {
      argv: ["mv", "-f", "--", `${NGINX_CONF}.candidate`, NGINX_CONF],
      setup: file(`${NGINX_CONF}.candidate`),
    },
  ),
  tpHost('src/deploy/site/engine-driver.ts|["-n","rm","-f","--",path]', {
    argv: ["rm", "-f", "--", `${NGINX_CONF}.candidate`],
  }),
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","mv","-f","--",staged.previousPath,staged.path]',
    {
      argv: ["mv", "-f", "--", `${NGINX_CONF}.previous`, NGINX_CONF],
      setup: file(`${NGINX_CONF}.previous`),
    },
  ),
  tpHost('src/deploy/site/engine-driver.ts|["-n","rm","-f","--",staged.path]', {
    argv: ["rm", "-f", "--", NGINX_CONF],
  }),
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","systemctl",action,unit]',
    { argv: ["systemctl", "reload", "turbopanel-nginx"] },
    { argv: ["systemctl", "restart", "turbopanel-php-fpm@8.4"] },
  ),
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","systemctl","enable","--now",unit]',
    {
      argv: ["systemctl", "enable", "--now", "turbopanel-nginx"],
    },
  ),
  sudo(
    'src/deploy/site/engine-driver.ts|["-n","-u","tpnginx","--",nginxBinaryPath(layout),"-t","-c",nginxMainConfigPath(layout)]',
    {
      runas: "tpnginx",
      argv: [
        `${VENDOR}/nginx/current/sbin/nginx`,
        "-t",
        "-c",
        "/etc/turbopanel/nginx/nginx.conf",
      ],
    },
  ),
  sudo(
    'src/deploy/site/engine-driver.ts|["-n","-u","tpapache","--",apacheBinaryPath(layout),"-t","-f",apacheMainConfigPath(layout)]',
    {
      runas: "tpapache",
      argv: [
        `${VENDOR}/apache/current/bin/httpd`,
        "-t",
        "-f",
        "/etc/turbopanel/apache/httpd.conf",
      ],
    },
  ),
  sudo(
    'src/deploy/site/engine-driver.ts|["-n","-u","tpols","--",openlitespeedBinaryPath(layout),"-t","-c",openlitespeedMainConfigPath(layout)]',
    {
      runas: "tpols",
      argv: [
        `${VENDOR}/openlitespeed/current/bin/openlitespeed`,
        "-t",
        "-c",
        "/etc/turbopanel/openlitespeed/httpd_config.conf",
      ],
    },
  ),
  sudo(
    'src/deploy/site/engine-driver.ts|["-n","-u","tpcaddysite","--",siteCaddyBinaryPath(layout),"validate","--adapter","caddyfile","--config",siteCaddyMainConfigPath(layout)]',
    {
      runas: "tpcaddysite",
      argv: [
        `${VENDOR}/caddy/current/caddy`,
        "validate",
        "--adapter",
        "caddyfile",
        "--config",
        "/etc/turbopanel/caddy/Caddyfile",
      ],
    },
  ),
  sudo(
    'src/deploy/site/engine-driver.ts|["-n",phpFpmBinaryPath(series),"--fpm-config",phpFpmMainConfigPath(layout,series),"--test"]',
    {
      argv: [
        "/usr/sbin/php-fpm8.4",
        "--fpm-config",
        "/etc/turbopanel/php/8.4/php-fpm.conf",
        "--test",
      ],
    },
  ),

  // --- Reads behind closed trees ---------------------------------------------
  tpHost('src/permissions/privileged-read.ts|["-n","cat","--",path]', {
    argv: ["cat", "--", `${CONF}/caddy/instance-acme-settings.json`],
    setup: file(`${CONF}/caddy/instance-acme-settings.json`),
  }),
  tpHost('src/permissions/privileged-read.ts|["-n","test","-e",path]', {
    argv: ["test", "-e", `${HOME}/volumes/stor-1`],
    setup: dir(`${HOME}/volumes/stor-1`),
  }),

  // --- SSH ------------------------------------------------------------------
  tpHost('src/deploy/ssh/apply.ts|["-n","cat","--",path]', {
    argv: ["cat", "--", `${SSH_KEYS}/alice`],
    setup: file(`${SSH_KEYS}/alice`, "ssh-ed25519 AAAA alice\n"),
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","cmp","-s","--",staged,path]', {
    argv: ["cmp", "-s", "--", STAGED, `${SSH_KEYS}/alice`],
    setup: file(`${SSH_KEYS}/alice`, STAGED_CONTENT),
  }),
  tpHost(
    'src/deploy/ssh/apply.ts|["-n","install","-m",mode,"-o","root","-g","root",staged,path]',
    {
      argv: [
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        STAGED,
        `${SSH_KEYS}/alice`,
      ],
    },
    {
      argv: [
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        STAGED,
        DROP_IN,
      ],
    },
  ),
  tpHost('src/deploy/ssh/apply.ts|["-n","ls","-1","--",dir]', {
    argv: ["ls", "-1", "--", SSH_KEYS],
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","rm","-f","--",`${dir}/${name}`]', {
    argv: ["rm", "-f", "--", `${SSH_KEYS}/bob`],
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","sftp-chroot","status"]', {
    argv: ["sftp-chroot", "status"],
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","sftp-chroot","verify"]', {
    argv: ["sftp-chroot", "verify"],
    setup: file(`${P}/etc/ssh/turbopanel-sftp-chroot`, "on\n"),
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","sftp-chroot","check"]', {
    argv: ["sftp-chroot", "check"],
    // alice is in tpsftp; on the new layout the check is clean.
    setup: dir(`${P}/srv/users/alice/home`),
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","sshd","-t"]', {
    argv: ["sshd", "-t"],
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","systemctl","reload",unit]', {
    argv: ["systemctl", "reload", "ssh.service"],
  }),
  tpHost(
    'src/deploy/ssh/apply.ts|["-n","install","-d","-m","0750","-o","root","-g","root",dir]',
    {
      argv: [
        "install",
        "-d",
        "-m",
        "0750",
        "-o",
        "root",
        "-g",
        "root",
        SSH_KEYS,
      ],
    },
  ),
  tpHost('src/deploy/ssh/apply.ts|["-n","cp","-p","--",dropInPath,backup]', {
    argv: ["cp", "-p", "--", DROP_IN, `${DROP_IN}.tpprev`],
    setup: file(DROP_IN),
  }),
  tpHost(
    'src/deploy/ssh/apply.ts|["-n","install","-d","-m","0755",dirname(dropInPath)]',
    { argv: ["install", "-d", "-m", "0755", `${P}/etc/ssh/sshd_config.d`] },
  ),
  tpHost('src/deploy/ssh/apply.ts|["-n","rm","-f","--",backup]', {
    argv: ["rm", "-f", "--", `${DROP_IN}.tpprev`],
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","rm","-f","--",dropInPath]', {
    argv: ["rm", "-f", "--", DROP_IN],
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","mv","-f","--",backup,dropInPath]', {
    argv: ["mv", "-f", "--", `${DROP_IN}.tpprev`, DROP_IN],
    setup: file(`${DROP_IN}.tpprev`),
  }),

  // --- firewall -------------------------------------------------------------
  tpHost(
    'src/firewall/run.ts|["-n",cmd,...finalArgs]',
    { argv: ["iptables", "-w", "5", "-S", "INPUT"] },
    { argv: ["ip6tables", "-w", "5", "-S", "INPUT"] },
    { argv: ["iptables-save", "-w", "5", "-t", "filter"] },
    {
      argv: ["iptables-restore", "-w", "5", "--noflush"],
      stdin: "*filter\nCOMMIT\n",
    },
  ),
  tpHost('src/managed/firewall.ts|["-n","iptables",...args]', {
    argv: [
      "iptables",
      "-w",
      "5",
      "-C",
      "INPUT",
      "-p",
      "tcp",
      "--dport",
      "5432",
      "-j",
      "ACCEPT",
    ],
  }),

  // --- control-plane settings and the co-located daemon --------------------
  tpHost(
    'src/instance/public-urls-env.ts|["-n",...args]',
    {
      argv: ["install", "-d", "-m", "0750", `${CONF}/instance`],
    },
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "0",
        "-g",
        "9999",
        STAGED,
        `${CONF}/instance/runtime.env`,
      ],
      // The `install -d` sample above runs first.
      setup: dir(`${CONF}/instance`),
    },
    {
      argv: ["chown", "0:9999", `${CONF}/instance/runtime.env`],
      setup: file(`${CONF}/instance/runtime.env`),
    },
  ),
  tpHost(
    "src/instance/restart-daemon-service.ts|args",
    { argv: ["systemctl", "enable", "turbopaneld.service"] },
    // --no-block: restarting one's own unit must not wait for the job to
    // finish (see restart-daemon-service.ts for why).
    { argv: ["systemctl", "restart", "--no-block", "turbopaneld.service"] },
  ),
  tpHost(
    "src/instance/run-reconcile.ts|args",
    { argv: ["systemctl", "restart", "turbopanel-instance.service"] },
    { argv: ["systemctl", "restart", "turbopanel-caddy.service"] },
    { argv: ["systemctl", "reload", "turbopanel-caddy.service"] },
  ),
  sudo(
    'src/instance/run-reconcile.ts|["-n","--",ORCHESTRATE_HELPER,"migrate"]',
    {
      argv: [
        "/opt/turbopanel/share/orchestration/scripts/tp-orchestrate",
        "migrate",
      ],
    },
  ),

  // --- metrics ------------------------------------------------------------
  tpHost(
    'src/metrics/collector/sensors/drivetemp.ts|["-n","modprobe","drivetemp"]',
    { argv: ["modprobe", "drivetemp"] },
  ),

  // --- wrapper calls: each shape a forwarding wrapper is handed -------------
  // TurboFabric: `runHost` tries the command as the daemon first and retries
  // through sudo on a permission error; Docker never goes through sudo.
  notRoot(
    'src/commands/fabric.ts|probeFabricTool("docker",["--version"])',
    DOCKER_DIRECT,
  ),
  notRoot('src/commands/fabric.ts|probeFabricTool("ip",["-V"])', PROBE),
  tpHost('src/commands/fabric.ts|probeFabricTool("iptables",["--version"])', {
    argv: ["iptables", "--version"],
  }),
  notRoot('src/commands/fabric.ts|probeFabricTool("wg",["--version"])', PROBE),
  tpHost("src/commands/fabric.ts|runDefault(cmd,args,options)", {
    argv: ["ip", "link", "set", "dev", "tp0", "up"],
  }),
  tpHost("src/commands/fabric.ts|runHost(cmd,args)", {
    argv: ["ip", "link", "set", "dev", "tp0", "up"],
  }),
  tpHost(
    "src/commands/fabric.ts|runHost(cmd,args,{timeoutMs:PREFLIGHT_TIMEOUT_MS})",
    { argv: ["iptables", "--version"] },
  ),
  tpHost('src/commands/fabric.ts|runHost("chmod",["600",WG_QUICK_CONF_PATH])', {
    argv: ["chmod", "600", WG_CONF],
    setup: file(WG_CONF),
  }),
  tpHost(
    'src/commands/fabric.ts|runHost("chmod",["644",FABRIC_SYSCTL_DROPIN])',
    {
      argv: ["chmod", "644", FABRIC_SYSCTL],
      setup: file(FABRIC_SYSCTL),
    },
  ),
  tpHost('src/commands/fabric.ts|runHost("chmod",["700","/etc/wireguard"])', {
    argv: ["chmod", "700", `${P}/etc/wireguard`],
  }),
  tpHost('src/commands/fabric.ts|runHost("cp",[confPath,WG_QUICK_CONF_PATH])', {
    argv: ["cp", `${FABRIC_DIR}/wireguard/tp0.conf`, WG_CONF],
    setup: file(`${FABRIC_DIR}/wireguard/tp0.conf`),
  }),
  notRoot(
    'src/commands/fabric.ts|runHost("docker",["network","create","--driver","bridge","--subnet",network.subnet,"--opt",DOCKER_ROUTED_BRIDGE_OPT,"--opt",`${DOCKER_MTU_OPT_KEY}=${mtu}`,network.name])',
    DOCKER_DIRECT,
  ),
  notRoot(
    'src/commands/fabric.ts|runHost("docker",["network","inspect","-f",`{{index.Options"${DOCKER_MTU_OPT_KEY}"}}`,network.name])',
    DOCKER_DIRECT,
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("ip",["-o","-4","addr","show","dev",FABRIC_INTERFACE_NAME])',
    { argv: ["ip", "-o", "-4", "addr", "show", "dev", "tp0"] },
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("ip",["-o","link","show","dev",FABRIC_INTERFACE_NAME])',
    {
      argv: ["ip", "-o", "link", "show", "dev", "tp0"],
    },
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("ip",["addr","replace",address,"dev",FABRIC_INTERFACE_NAME])',
    { argv: ["ip", "addr", "replace", "10.99.0.1/24", "dev", "tp0"] }, // NOSONAR typescript:S1313 — sample TurboFabric address for this test fixture, not a reachable host
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("ip",["link","add","dev",FABRIC_INTERFACE_NAME,"type","wireguard"])',
    { argv: ["ip", "link", "add", "dev", "tp0", "type", "wireguard"] },
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("ip",["link","set","dev",FABRIC_INTERFACE_NAME,"mtu",String(mtu)])',
    { argv: ["ip", "link", "set", "dev", "tp0", "mtu", "1420"] },
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("ip",["link","set","dev",FABRIC_INTERFACE_NAME,"up"])',
    {
      argv: ["ip", "link", "set", "dev", "tp0", "up"],
    },
  ),
  tpHost('src/commands/fabric.ts|runHost("iptables",["-C",...checkArgs])', {
    argv: ["iptables", "-C", "TP-FORWARD", "-i", "tp0", "-j", "ACCEPT"],
  }),
  tpHost('src/commands/fabric.ts|runHost("iptables",["-D",...checkArgs])', {
    argv: ["iptables", "-D", "DOCKER-USER", "-j", "TP-FORWARD"],
  }),
  tpHost('src/commands/fabric.ts|runHost("iptables",["-N",name])', {
    argv: ["iptables", "-N", "TP-FORWARD"],
  }),
  tpHost('src/commands/fabric.ts|runHost("iptables",addArgs)', {
    argv: ["iptables", "-A", "TP-FORWARD", "-i", "tp0", "-j", "ACCEPT"],
  }),
  tpHost('src/commands/fabric.ts|runHost("mkdir",["-p","/etc/wireguard"])', {
    argv: ["mkdir", "-p", `${P}/etc/wireguard`],
  }),
  tpHost(
    'src/commands/fabric.ts|runHost("sysctl",["-p",FABRIC_SYSCTL_DROPIN])',
    {
      argv: ["sysctl", "-p", FABRIC_SYSCTL],
      setup: file(FABRIC_SYSCTL, "net.ipv4.ip_forward=1\n"),
    },
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("sysctl",["-w","net.ipv4.ip_forward=1"])',
    {
      argv: ["sysctl", "-w", "net.ipv4.ip_forward=1"],
    },
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("systemctl",["disable","--now",WG_QUICK_UNIT])',
    {
      argv: ["systemctl", "disable", "--now", "wg-quick@tp0"],
    },
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("systemctl",["enable","--now",WG_QUICK_UNIT])',
    {
      argv: ["systemctl", "enable", "--now", "wg-quick@tp0"],
    },
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("systemctl",["enable",WG_QUICK_UNIT])',
    {
      argv: ["systemctl", "enable", "wg-quick@tp0"],
    },
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("systemctl",["is-active",WG_QUICK_UNIT])',
    {
      argv: ["systemctl", "is-active", "wg-quick@tp0"],
    },
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("systemctl",["is-enabled",WG_QUICK_UNIT])',
    {
      argv: ["systemctl", "is-enabled", "wg-quick@tp0"],
    },
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("tee",[FABRIC_SYSCTL_DROPIN],{stdin:FABRIC_SYSCTL_CONTENTS,})',
    { argv: ["tee", FABRIC_SYSCTL], stdin: "net.ipv4.ip_forward=1\n" },
  ),
  tpHost('src/commands/fabric.ts|runHost("wg",["genkey"])', {
    argv: ["wg", "genkey"],
  }),
  tpHost('src/commands/fabric.ts|runHost("wg",["pubkey"],{stdin:privateKey})', {
    argv: ["wg", "pubkey"],
    stdin: `${WG_KEY}\n`,
  }),
  tpHost(
    'src/commands/fabric.ts|runHost("wg",["set",FABRIC_INTERFACE_NAME,"peer",publicKey,"endpoint",endpoint,"persistent-keepalive",String(keepalive)])',
    {
      argv: [
        "wg",
        "set",
        "tp0",
        "peer",
        WG_KEY,
        "endpoint",
        "203.0.113.5:51820",
        "persistent-keepalive",
        "25",
      ],
    },
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("wg",["show",FABRIC_INTERFACE_NAME,"dump"])',
    {
      argv: ["wg", "show", "tp0", "dump"],
    },
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("wg",["show",FABRIC_INTERFACE_NAME])',
    {
      argv: ["wg", "show", "tp0"],
    },
  ),
  tpHost(
    'src/commands/fabric.ts|runHost("wg",["syncconf",FABRIC_INTERFACE_NAME,syncPath])',
    {
      argv: ["wg", "syncconf", "tp0", `${FABRIC_DIR}/wireguard/tp0.sync.conf`],
      setup: file(`${FABRIC_DIR}/wireguard/tp0.sync.conf`),
    },
  ),
  notRoot(
    'src/commands/fabric.ts|runTeardownBestEffort("docker",["network","rm",name],(result)=>isMissingDeviceText(result)||isActiveEndpointsText(result))',
    DOCKER_DIRECT,
  ),
  tpHost(
    'src/commands/fabric.ts|runTeardownBestEffort("ip",["link","delete",FABRIC_INTERFACE_NAME],isMissingDeviceText)',
    { argv: ["ip", "link", "delete", "tp0"] },
  ),
  tpHost(
    'src/commands/fabric.ts|runTeardownBestEffort("iptables",["-D",DOCKER_USER_CHAIN,"-j",FABRIC_FORWARD_CHAIN],isMissingIptablesText)',
    { argv: ["iptables", "-D", "DOCKER-USER", "-j", "TP-FORWARD"] },
  ),
  tpHost(
    'src/commands/fabric.ts|runTeardownBestEffort("iptables",["-F",FABRIC_FORWARD_CHAIN],isMissingIptablesText)',
    { argv: ["iptables", "-F", "TP-FORWARD"] },
  ),
  tpHost(
    'src/commands/fabric.ts|runTeardownBestEffort("iptables",["-X",FABRIC_FORWARD_CHAIN],isMissingIptablesText)',
    { argv: ["iptables", "-X", "TP-FORWARD"] },
  ),
  tpHost(
    'src/commands/fabric.ts|runTeardownBestEffort("rm",["-f",FABRIC_SYSCTL_DROPIN],()=>true)',
    { argv: ["rm", "-f", FABRIC_SYSCTL], setup: file(FABRIC_SYSCTL) },
  ),
  tpHost(
    'src/commands/fabric.ts|runTeardownBestEffort("rm",["-f",WG_QUICK_CONF_PATH],()=>true)',
    {
      argv: ["rm", "-f", WG_CONF],
      setup: file(WG_CONF),
    },
  ),

  // Managed-database public listener scoping.
  tpHost(
    'src/managed/firewall.ts|removeBestEffort(["-D",MANAGED_PUBLIC_CHAIN,"-j",chain])',
    {
      argv: ["iptables", "-D", "TP-MANAGED-PUB", "-j", MGD_CHAIN],
    },
  ),
  tpHost('src/managed/firewall.ts|removeBestEffort(["-F",chain])', {
    argv: ["iptables", "-F", MGD_CHAIN],
  }),
  tpHost('src/managed/firewall.ts|removeBestEffort(["-X",chain])', {
    argv: ["iptables", "-X", MGD_CHAIN],
  }),
  tpHost('src/managed/firewall.ts|runIptables(["-A",...rule])', {
    argv: [
      "iptables",
      "-A",
      MGD_CHAIN,
      "-s",
      "203.0.113.7",
      ...MGD_MATCH,
      "-j",
      "ACCEPT",
    ],
  }),
  tpHost(
    'src/managed/firewall.ts|runIptables(["-A",chain,...match,"-j","DROP"])',
    {
      argv: ["iptables", "-A", MGD_CHAIN, ...MGD_MATCH, "-j", "DROP"],
    },
  ),
  tpHost('src/managed/firewall.ts|runIptables(["-C",...checkArgs])', {
    argv: ["iptables", "-C", "DOCKER-USER", "-j", "TP-MANAGED-PUB"],
  }),
  tpHost('src/managed/firewall.ts|runIptables(["-F",chain])', {
    argv: ["iptables", "-F", MGD_CHAIN],
  }),
  tpHost('src/managed/firewall.ts|runIptables(["-N",name])', {
    argv: ["iptables", "-N", "TP-MANAGED-PUB"],
  }),
  tpHost("src/managed/firewall.ts|runIptables(addArgs)", {
    argv: ["iptables", "-I", "DOCKER-USER", "1", "-j", "TP-MANAGED-PUB"],
  }),
  tpHost("src/managed/firewall.ts|runIptables(args)", {
    argv: ["iptables", "-X", MGD_CHAIN],
  }),

  // Cron, scheduled-backup and native-app units.
  tpHost('src/deploy/systemd-unit-set.ts|systemctl(runFn,["daemon-reload"])', {
    argv: ["systemctl", "daemon-reload"],
  }),
  tpHost(
    'src/deploy/systemd-unit-set.ts|systemctl(runFn,["disable","--now",`${unit}.timer`])',
    {
      argv: [
        "systemctl",
        "disable",
        "--now",
        "turbopanel-cron-env1-web-backup.timer",
      ],
    },
  ),
  tpHost(
    'src/deploy/systemd-unit-set.ts|systemctl(runFn,["enable","--now",`${unit}.timer`])',
    {
      argv: [
        "systemctl",
        "enable",
        "--now",
        "turbopanel-cron-env1-web-backup.timer",
      ],
    },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|systemctl(io,["daemon-reload"])',
    {
      argv: ["systemctl", "daemon-reload"],
    },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|systemctl(io,["disable","--now",unit])',
    {
      argv: ["systemctl", "disable", "--now", APP_UNIT],
    },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|systemctl(io,["enable","--now",unit])',
    {
      argv: ["systemctl", "enable", "--now", APP_UNIT],
    },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|systemctl(io,["is-active","--quiet",unit])',
    {
      argv: ["systemctl", "is-active", "--quiet", APP_UNIT],
    },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|systemctl(io,["is-failed","--quiet",unit])',
    {
      argv: ["systemctl", "is-failed", "--quiet", APP_UNIT],
    },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|systemctl(io,["restart",nativeAppUnitName(params.app.serviceId)])',
    { argv: ["systemctl", "restart", APP_UNIT] },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|systemctl(io,["restart",unit])',
    {
      argv: ["systemctl", "restart", APP_UNIT],
    },
  ),
  tpHost(
    "src/deploy/native/apply-native-apps.ts|systemctl(io,[action,unit])",
    { argv: ["systemctl", "start", APP_UNIT] },
    { argv: ["systemctl", "stop", APP_UNIT] },
    { argv: ["systemctl", "restart", APP_UNIT] },
  ),

  // Control-plane settings (`runtime.env`).
  tpHost(
    'src/instance/public-urls-env.ts|runSudo(["chown",`${uid}:${gid}`,path])',
    {
      argv: ["chown", "0:9999", `${CONF}/instance/runtime.env`],
      setup: file(`${CONF}/instance/runtime.env`),
    },
  ),
  tpHost(
    'src/instance/public-urls-env.ts|runSudo(["install","-d","-m","0750",configDir])',
    {
      argv: ["install", "-d", "-m", "0750", `${CONF}/instance`],
    },
  ),
  tpHost(
    "src/instance/public-urls-env.ts|runSudo(installArgs)",
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "0",
        "-g",
        "9999",
        STAGED,
        `${CONF}/instance/runtime.env`,
      ],
      setup: dir(`${CONF}/instance`),
    },
    {
      argv: ["install", "-m", "0640", STAGED, `${CONF}/instance/runtime.env`],
      setup: dir(`${CONF}/instance`),
    },
  ),
];

/**
 * A call site the host refuses today. Its test asserts the refusal still
 * happens (with `refusal` in tp-host's message, or a sudoers denial), so the
 * fix that makes it pass must delete the entry; a `pending` entry is skipped
 * until the named change lands (another PR owns that fix).
 */
export type KnownBug =
  | { why: string; refusal: string }
  | { why: string; pending: string };

const KNOWN_BUGS: Record<string, KnownBug> = {};

export const CALL_SITES: readonly CallSite[] = SITES.map((site) =>
  KNOWN_BUGS[site.key] === undefined
    ? site
    : { ...site, knownBug: KNOWN_BUGS[site.key] }
);

/** Known-bug keys that match no call site (a fix renamed or removed it). */
export const STALE_KNOWN_BUGS: readonly string[] = Object.keys(KNOWN_BUGS)
  .filter((key) => !SITES.some((site) => site.key === key));
