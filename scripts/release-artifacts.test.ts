import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const RELEASE_LIB = join(ROOT, "scripts/lib/release-artifacts.sh");

async function runBash(
  script: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await new Deno.Command("bash", {
    args: ["-c", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

test("tp_install_verified_channel_release installs verified THIRD_PARTY_NOTICES.md", async () => {
  const work = await Deno.makeTempDir({ prefix: "tp-release-install-" });
  try {
    const script = String.raw`
set -eu
WORK='${work}'
. '${RELEASE_LIB}'

NOTICE_TEXT='# Third-party notices
fixture-notice
'
mkdir -p "$WORK/src/binary/opt/turbopanel/bin" \
  "$WORK/src/binary/opt/turbopanel/share" \
  "$WORK/src/js/opt/turbopanel/bin" \
  "$WORK/src/js/opt/turbopanel/share" \
  "$WORK/src/orch/opt/turbopanel/share/orchestration"
printf 'native-bin\n' > "$WORK/src/binary/opt/turbopanel/bin/turbopaneld"
printf 'js-bundle\n' > "$WORK/src/js/opt/turbopanel/bin/turbopaneld.js"
printf '[defaults]\n' > "$WORK/src/orch/opt/turbopanel/share/orchestration/ansible.cfg"
printf '%s' "$NOTICE_TEXT" > "$WORK/src/binary/opt/turbopanel/share/THIRD_PARTY_NOTICES.md"
printf '%s' "$NOTICE_TEXT" > "$WORK/src/js/opt/turbopanel/share/THIRD_PARTY_NOTICES.md"
printf '%s' "$NOTICE_TEXT" > "$WORK/src/orch/opt/turbopanel/share/THIRD_PARTY_NOTICES.md"

tar -I 'zstd -19 -T0' -cf "$WORK/binary.tar.zst" -C "$WORK/src/binary" opt
tar -I 'zstd -19 -T0' -cf "$WORK/js.tar.zst" -C "$WORK/src/js" opt
tar -I 'zstd -19 -T0' -cf "$WORK/orch.tar.zst" -C "$WORK/src/orch" opt

BIN_SHA="$(sha256sum "$WORK/binary.tar.zst" | awk '{print $1}')"
JS_SHA="$(sha256sum "$WORK/js.tar.zst" | awk '{print $1}')"
ORCH_SHA="$(sha256sum "$WORK/orch.tar.zst" | awk '{print $1}')"

tp_download_verified_artifact() {
	_url="$1"
	_sha256="$2"
	_dest="$3"
	case "$_url" in
		https://fixture.example/binary.tar.zst) cp "$WORK/binary.tar.zst" "$_dest" ;;
		https://fixture.example/js.tar.zst) cp "$WORK/js.tar.zst" "$_dest" ;;
		https://fixture.example/orch.tar.zst) cp "$WORK/orch.tar.zst" "$_dest" ;;
		*)
			echo "unexpected url: $_url" >&2
			return 1
			;;
	esac
	if ! printf '%s  %s\n' "$_sha256" "$_dest" | sha256sum -c - >/dev/null 2>&1; then
		echo "fixture sha mismatch" >&2
		return 1
	fi
	return 0
}

DEST="$WORK/install"
if ! tp_install_verified_channel_release \
	"https://fixture.example/binary.tar.zst" "$BIN_SHA" \
	"https://fixture.example/js.tar.zst" "$JS_SHA" \
	"https://fixture.example/orch.tar.zst" "$ORCH_SHA" \
	"$DEST"; then
	echo "install failed" >&2
	exit 1
fi

if [[ ! -f "$DEST/share/THIRD_PARTY_NOTICES.md" ]]; then
	echo "missing installed notices" >&2
	exit 1
fi
if ! grep -q 'fixture-notice' "$DEST/share/THIRD_PARTY_NOTICES.md"; then
	echo "installed notices did not match the verified artifact" >&2
	exit 1
fi
if [[ ! -f "$DEST/bin/turbopaneld" ]] || [[ ! -f "$DEST/bin/turbopaneld.js" ]]; then
	echo "missing installed binaries" >&2
	exit 1
fi
if [[ ! -f "$DEST/share/orchestration/ansible.cfg" ]]; then
	echo "missing installed orchestration" >&2
	exit 1
fi
printf 'ok\n'
`;
    const result = await runBash(script);
    assertEquals(result.code, 0, result.stderr || result.stdout);
    assertEquals(result.stdout.trim(), "ok");
  } finally {
    await Deno.remove(work, { recursive: true });
  }
});
