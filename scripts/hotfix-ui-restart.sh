#!/bin/sh
# One-shot hotfix: UI update reconcile succeeds but daemon never restarts.
# Patches the running checkout in place (no CDN publish required).
#
# Run on the managed server as root:
#   sudo sh /opt/turbopanel/platform/daemon/scripts/hotfix-ui-restart.sh

set -eu

DAEMON_DIR="${TURBOPANEL_DAEMON_DIR:-/opt/turbopanel/platform/daemon}"
CLIENT="$DAEMON_DIR/src/instance/client.ts"
RESTART_MODULE="$DAEMON_DIR/src/instance/restart-daemon-service.ts"
UNIT="${TURBOPANEL_SERVICE_NAME:-turbopanel-daemon}"

if [ "$(id -u)" != "0" ]; then
	echo "hotfix-ui-restart.sh: run as root (sudo sh …)" >&2
	exit 1
fi

if [ ! -f "$CLIENT" ]; then
	echo "hotfix-ui-restart.sh: missing $CLIENT" >&2
	exit 1
fi

if grep -q 'restart-daemon-service.ts' "$CLIENT" 2>/dev/null \
	&& grep -q 'Deno.Command("sudo"' "$RESTART_MODULE" 2>/dev/null; then
	echo "hotfix-ui-restart.sh: restart fix already present"
else
	echo "hotfix-ui-restart.sh: installing restart-daemon-service.ts …"
	cat > "$RESTART_MODULE" <<'EOF'
import { logWarn } from "../logger.ts";

export const DEFAULT_DAEMON_UNIT = "turbopanel-daemon";

function stripLogInjection(text: string): string {
  return text.replace(/[\r\n\t]/g, " ");
}

export function buildDaemonRestartSystemctlArgs(
  unit = DEFAULT_DAEMON_UNIT,
): string[][] {
  return [
    ["-n", "systemctl", "enable", unit],
    ["-n", "systemctl", "restart", unit],
  ];
}

export function resolveDaemonServiceUnit(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const trimmed = env.TURBOPANEL_SERVICE_NAME?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_DAEMON_UNIT;
}

export async function restartDaemonService(
  options: {
    unit?: string;
    runSystemctl?: (args: string[]) => Promise<{ success: boolean; stderr: string }>;
  } = {},
): Promise<boolean> {
  const unit = options.unit ?? resolveDaemonServiceUnit();
  const runSystemctl = options.runSystemctl ??
    (async (args: string[]) => {
      const result = await new Deno.Command("sudo", {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        success: result.success,
        stderr: new TextDecoder().decode(result.stderr).trim(),
      };
    });

  for (const args of buildDaemonRestartSystemctlArgs(unit)) {
    const result = await runSystemctl(args);
    if (!result.success) {
      logWarn(
        "daemon",
        "sudo",
        stripLogInjection(args.join(" ")),
        stripLogInjection(unit),
        "failed:",
        stripLogInjection(result.stderr || "unknown error"),
      );
      return false;
    }
  }
  return true;
}
EOF

	if ! grep -q 'restart-daemon-service.ts' "$CLIENT"; then
		# Insert import after run-reconcile import block.
		sed -i '/from "\.\/run-reconcile\.ts";/a import { restartDaemonService } from "./restart-daemon-service.ts";' "$CLIENT"
	fi

	# Remove legacy inline restartDaemonService if present.
	if grep -q '^async function restartDaemonService' "$CLIENT"; then
		sed -i '/^async function restartDaemonService/,/^}$/d' "$CLIENT"
	fi

	# Replace enable --now with module import usage is already done if module exists.
	# Ensure #applyUpdate clears in-progress flag after restart attempt.
	if grep -q '#updateInstallInProgress = false' "$CLIENT"; then
		:
	else
		echo "hotfix-ui-restart.sh: warning — client.ts may need manual #applyUpdate patch" >&2
	fi

	chown turbopanel:turbopanel "$RESTART_MODULE" "$CLIENT" 2>/dev/null || true
	echo "hotfix-ui-restart.sh: patched $RESTART_MODULE"
fi

echo "hotfix-ui-restart.sh: restarting $UNIT …"
if ! sudo -u turbopanel sudo -n systemctl enable "$UNIT" \
	&& sudo -u turbopanel sudo -n systemctl restart "$UNIT"; then
	systemctl enable "$UNIT"
	systemctl restart "$UNIT"
fi

echo "hotfix-ui-restart.sh: done — try UI Update again"
