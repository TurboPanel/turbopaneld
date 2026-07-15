#!/usr/bin/env bash
# Pack daemon/orchestration/ into the standalone orchestration release tarball.
# Co-located dev uses the git checkout (orchestration/ + dev/orchestration overlay);
# production installs extract this artifact to /opt/turbopanel/share/orchestration/.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/release-artifacts.sh
. "$ROOT/scripts/lib/release-artifacts.sh"

if ! command -v zstd >/dev/null 2>&1; then
	echo "bundle-orchestration.sh: zstd is required (apt install zstd)" >&2
	exit 1
fi

DIST="$ROOT/dist"
VERSION="${TURBOPANEL_RELEASE_VERSION:-}"
PROD_HOME="$(tp_prod_home)"
ARCHIVE_STAGING="$DIST/.orchestration-archive-staging"
ORCH_ARCHIVE="$DIST/$(tp_orchestration_release_filename "$VERSION")"

# Release layout: opt/turbopanel/share/orchestration/…
rm -rf "$ARCHIVE_STAGING"
tp_build_orchestration_archive_staging "$ARCHIVE_STAGING" "$PROD_HOME" "$ROOT/orchestration"
if ! tp_verify_release_root "$ARCHIVE_STAGING" "orchestration"; then
	echo "bundle-orchestration.sh: orchestration release verification failed" >&2
	exit 1
fi
tp_pack_orchestration_archive "$ARCHIVE_STAGING" "$ORCH_ARCHIVE" "$PROD_HOME"
rm -rf "$ARCHIVE_STAGING"

echo "bundle-orchestration.sh: wrote $ORCH_ARCHIVE"
