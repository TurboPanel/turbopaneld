/**
 * Where the co-located development host keeps its checkouts and job files,
 * and whether the development host feature is on at all (`dev-host-v1`).
 *
 * The feature exists only on a development install (a daemon run from its
 * source checkout) with `TURBOPANEL_DEV_INSTANCE=1`. Anywhere else it is inert
 * and every action is answered `not_development`.
 */
import { join } from "@std/path";
import {
  detectInstallMode,
  type InstallMode,
  resolveDevRoot,
  resolveLayout,
} from "../paths/layout.ts";
import { resolveDaemonServiceUnit } from "../instance/restart-daemon-service.ts";
import type { DevHostPart } from "../contracts/cell-messages.ts";

export type DevHostPartName = DevHostPart["name"];

/** One part of the development host: its checkout, its unit and how it reloads. */
export type DevHostPartSpec = {
  name: DevHostPartName;
  /** Folder under the development root. */
  repo: string;
  /** systemd unit, without `.service`. */
  unit: string;
  /** Has a `pnpm-lock.yaml` whose packages must be installed. */
  installs: boolean;
  /**
   * `source`: no file watch, so any newer source file means a restart.
   * `config`: a hot-reloading dev server, restarted only for package or
   * config changes.
   */
  reload: "source" | "config";
  /** Files (relative to the checkout) whose change needs a restart. */
  restartFiles: readonly string[];
};

const NODE_CONFIG_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
] as const;

/** The four parts, in the order the bar lists them. */
export function devHostParts(
  env: Record<string, string | undefined> = {},
): DevHostPartSpec[] {
  return [
    {
      name: "daemon",
      repo: "turbopaneld",
      unit: resolveDaemonServiceUnit(env),
      installs: false,
      reload: "source",
      restartFiles: ["main.ts", "deno.json", "deno.lock"],
    },
    {
      name: "control-plane",
      repo: "turbopanel",
      unit: "turbopanel-instance",
      installs: true,
      reload: "source",
      restartFiles: [...NODE_CONFIG_FILES, "deno.json", "deno.lock"],
    },
    {
      name: "web-interface",
      repo: "ui",
      unit: "turbopanel-ui",
      installs: true,
      reload: "config",
      restartFiles: [
        ...NODE_CONFIG_FILES,
        "app.json",
        "app.config.ts",
        "app.config.js",
        "metro.config.js",
        "babel.config.js",
        "global.css",
      ],
    },
    {
      name: "website",
      repo: "website",
      unit: "turbopanel-website",
      installs: true,
      reload: "config",
      restartFiles: [
        ...NODE_CONFIG_FILES,
        "next.config.js",
        "next.config.mjs",
        "next.config.ts",
        "source.config.ts",
        "postcss.config.mjs",
      ],
    },
  ];
}

/** Files and folders the development host uses. */
export type DevHostPaths = {
  /** The folder that holds the checkouts (`TURBOPANEL_DEV_ROOT`). */
  devRoot: string;
  /** `<daemonStateDir>/dev-updates`. */
  dir: string;
  jobFile: string;
  statusFile: string;
  lockFile: string;
  backupsDir: string;
};

export function resolveDevHostPaths(
  env: Record<string, string | undefined> = {},
): DevHostPaths {
  const dir = join(
    resolveLayout(env, { forceMode: "development" }).daemonStateDir,
    "dev-updates",
  );
  return {
    devRoot: resolveDevRoot(env),
    dir,
    jobFile: join(dir, "job.json"),
    statusFile: join(dir, "status.json"),
    lockFile: join(dir, "job.lock"),
    backupsDir: join(dir, "backups"),
  };
}

/** The checkout of one part. */
export function partCheckout(
  paths: Pick<DevHostPaths, "devRoot">,
  spec: Pick<DevHostPartSpec, "repo">,
): string {
  return join(paths.devRoot, spec.repo);
}

/** True only on a development install with `TURBOPANEL_DEV_INSTANCE=1`. */
export function devHostEnabled(
  env: Record<string, string | undefined>,
  mode: InstallMode = detectInstallMode(env),
): boolean {
  return mode === "development" && env.TURBOPANEL_DEV_INSTANCE?.trim() === "1";
}
