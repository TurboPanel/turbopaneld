#!/bin/sh
# TurboPanel daemon bootstrap — single entrypoint served at turbopanel.sh.
# Co-located dev Caddy serves the same script at /run.sh.
#
# Fetches split release artifacts from the channel manifest. Without an
# overlay the manifest comes from the built-in rail — trunk from the CDN drop
# (https://dl.trbp.nl/channels/trunk/manifest.json), rc and release from
# GitHub Releases (see tp_builtin_channel_manifest_url); with
# $TURBOPANEL_DL_BASE set it comes from that overlay's channels.json instead,
# so remote servers on a development overlay never hit the public rail:
# host-arch native binary + orchestration tree, plus the JS bundle when the
# native binary cannot execute on this host. Installs the production FHS layout
# (bin/turbopaneld, optional bin/turbopaneld.js, share/orchestration/), probes
# native binary executability, bootstraps orchestration runtimes, and runs
# daemon-install.yml via Ansible (turbopaneld.service — native or Deno JS
# runtime; see AGENTS.md).
#
# Config: /etc/turbopanel  State: /var/lib/turbopanel  Runtime: /run/turbopanel
#
# Run as root or as a sudo-capable user (self-escalates via sudo when available).
#
# Typical install (production):
#   curl -fsSL turbopanel.sh | TURBOPANEL_LICENSE=<b64> sh
# Optional: TURBOPANEL_HOST, TURBOPANEL_INSECURE_TLS=1, TURBOPANEL_UPDATE_CHANNEL,
# TURBOPANEL_DL_BASE (dev overlay catalog; never falls back to the public CDN).
# Flags (--license, --host, …) remain supported for scripts and sudo re-exec.
#
# Self-hosted control plane — the one door, chosen by what you pass:
#   curl -fsSL turbopanel.sh | sh                        # nothing → panel install
#   curl -fsSL turbopanel.sh | TURBOPANEL_INSTANCE=1 sh  # the same, said explicitly
# Decided 2026-09-17: with no license and no daemon arguments the script
# installs the control plane. It prints a short welcome (and, on a non-release
# channel, a yellow non-stable warning) then proceeds; Ctrl-C or q at the
# continue prompt backs out. Daemon arguments without a license
# (--host, --tunnel-token, --instance-ca, TURBOPANEL_HOST …) still mean "you
# meant to enrol a daemon and forgot the license" and stop with that error.
# Downloads the daemon package for its orchestration tree, then the instance
# and UI release packages from the same channel (default: release), verifies
# every sha256 against each manifest, unpacks them under /opt/turbopanel, and
# runs instance-install.yml (Postgres, Redis, RabbitMQ, Docker, certs, units,
# Caddy, and the co-located turbopaneld) before handing off to the install
# wizard. The daemon starts without a license and waits; the wizard writes
# the first organization's license into the daemon state directory and the
# daemon enrols on its own — no second run of this script on this host.
#
# Manifest and release helpers below must stay in sync with scripts/lib/release-artifacts.sh.

# Shared curl prefixes for HTTPS downloads (and the insecure-TLS install path).
TP_CURL_FETCH='curl -fsSL'
TP_CURL_FETCH_INSECURE='curl -fsSLk'

# Release artifact downloads (channel manifest, verified binary/orchestration/JS
# artifacts, and the Deno runtime zip) always verify TLS against public trust.
# `--insecure-tls` only relaxes trust for the self-hosted *instance* bootstrap
# legs (the initial run.sh re-exec, the instance CA fetch, and the private
# uploaded-issuer fetch) — it must never
# weaken release/CDN trust, so bootstrapping a self-signed instance cannot
# silently disable verification of the code we execute. If a genuine
# release-download TLS emergency ever arises, TURBOPANEL_RELEASE_TLS_INSECURE_OVERRIDE=1
# is a deliberately undocumented, operator-only escape hatch: it is never derived
# from --insecure-tls and never emitted by the install-command builder.
tp_release_curl() {
  if [ "${TURBOPANEL_RELEASE_TLS_INSECURE_OVERRIDE:-}" = 1 ]; then
    printf '%s' "$TP_CURL_FETCH_INSECURE"
  else
    printf '%s' "$TP_CURL_FETCH"
  fi
}

tp_ca_fingerprint() {
  _fp_path="$1"
  openssl x509 -in "$_fp_path" -noout -fingerprint -sha256 2>/dev/null |
    sed 's/^.*=//'
}

tp_ca_parses() {
  _parse_path="$1"
  openssl x509 -in "$_parse_path" -noout >/dev/null 2>&1
}

# Capture curl's %{http_code} independently of curl's exit status.
# `curl ... || echo 000` concatenates onto an already-printed code (commonly
# producing 000000) so the CA-fetch `000)` retry never runs and leaf checks
# can treat a TLS/transport failure as success.
tp_curl_http_code() {
  if _tp_http_code=$("$@"); then
    printf '%s' "$_tp_http_code"
  else
    printf '%s' "000"
  fi
}

tp_ca_validates_leaf() {
  _leaf_ca="$1"
  _code=$(tp_curl_http_code curl -sSL --cacert "$_leaf_ca" -o /dev/null -w '%{http_code}' "${HOST_URL%/}/api/health")
  case "$_code" in
    000) return 1 ;;
    *) return 0 ;;
  esac
}

# True when TRUST_FILE holds an issuer (not the presented leaf itself) that
# verifies PRESENTED and PRESENTED's SAN covers HOST. A leaf pin is rejected:
# the daemon verifies the chain against an issuer and still checks the name.
tp_trust_has_distinct_issuer() {
  _trust="$1"
  _leaf_fp="$2"
  _dir="$(mktemp -d)"
  awk -v dir="$_dir" '
    /-----BEGIN CERTIFICATE-----/ { n++; file = dir "/c" n ".pem" }
    n > 0 { print >> file }
    /-----END CERTIFICATE-----/ { if (file != "") close(file) }
  ' "$_trust"
  _distinct=1
  for _cert in "$_dir"/c*.pem; do
    [ -f "$_cert" ] || continue
    _fp="$(tp_ca_fingerprint "$_cert")"
    if [ -n "$_fp" ] && [ "$_fp" != "$_leaf_fp" ]; then
      _distinct=0
      break
    fi
  done
  rm -rf "$_dir"
  return "$_distinct"
}

tp_uploaded_trust_verifies() {
  _trust="$1"
  _leaf="$2"
  _host="$3"
  if [ -z "$_trust" ] || [ -z "$_leaf" ] || [ -z "$_host" ]; then
    return 1
  fi
  if ! tp_ca_parses "$_trust" || ! tp_ca_parses "$_leaf"; then
    return 1
  fi
  _leaf_fp="$(tp_ca_fingerprint "$_leaf")"
  if [ -z "$_leaf_fp" ]; then
    return 1
  fi
  if ! tp_trust_has_distinct_issuer "$_trust" "$_leaf_fp"; then
    return 1
  fi
  openssl verify -verify_hostname "$_host" -partial_chain -CAfile "$_trust" "$_leaf" >/dev/null 2>&1
}

tp_url_host() {
  python3 -c 'import sys; from urllib.parse import urlparse; print(urlparse(sys.argv[1]).hostname or "")' "$1"
}

tp_url_port() {
  python3 -c 'import sys; from urllib.parse import urlparse; u=urlparse(sys.argv[1]); print(u.port or (443 if u.scheme=="https" else 80))' "$1"
}

tp_capture_presented_leaf() {
  _dest="$1"
  _host="$2"
  _port="$(tp_url_port "$HOST_URL")"
  _raw="$(mktemp)"
  openssl s_client -connect "${_host}:${_port}" -servername "$_host" -showcerts </dev/null >"$_raw" 2>/dev/null || true
  awk '
    /-----BEGIN CERTIFICATE-----/ { n++ }
    n == 1 { print }
    /-----END CERTIFICATE-----/ && n == 1 { exit }
  ' "$_raw" > "$_dest"
  rm -f "$_raw"
  tp_ca_parses "$_dest"
}

# Install TRUST only when it is the issuer of the certificate HOST_URL presents.
# Never copied onto the Platform CA path.
tp_install_verified_uploaded_trust() {
  _src="$1"
  _host="$(tp_url_host "$HOST_URL")"
  _presented="$(mktemp)"
  if ! tp_capture_presented_leaf "$_presented" "$_host"; then
    rm -f "$_presented"
    tp_print_error "Could not read the certificate presented by ${_host}. Refusing to store an unverified private issuer."
    return 1
  fi
  if ! tp_uploaded_trust_verifies "$_src" "$_presented" "$_host"; then
    rm -f "$_presented"
    tp_print_error "The uploaded trust document does not verify the certificate presented for ${_host}. Upload the private issuer that signed that leaf, with ${_host} on the certificate. Bootstrap insecure TLS is not runtime trust."
    return 1
  fi
  rm -f "$_presented"
  install -m 0640 "$_src" "$UPLOADED_TRUST_PATH"
  tp_print_ok "Private uploaded issuer installed ($(tp_ca_fingerprint "$UPLOADED_TRUST_PATH")); runtime TLS still verifies the chain and hostname"
}

# Bootstrap -k is not enough. A private upload must leave either a Platform CA
# that validates the live leaf or an uploaded issuer that signs the certificate
# HOST_URL is presenting now. An existing file from a previous install is not
# that proof: a non-404 fetch keeps it, including after the leaf was replaced.
tp_bootstrap_trust_anchored() {
  if [ "${INSECURE_TLS:-false}" != true ]; then
    return 0
  fi
  if [ -n "${CA_PATH:-}" ] && [ -f "$CA_PATH" ] && tp_ca_validates_leaf "$CA_PATH"; then
    return 0
  fi
  if [ -n "${UPLOADED_TRUST_PATH:-}" ] && [ -f "$UPLOADED_TRUST_PATH" ]; then
    _host="$(tp_url_host "${HOST_URL:-}")"
    _presented="$(mktemp)"
    if tp_capture_presented_leaf "$_presented" "$_host" &&
      tp_uploaded_trust_verifies "$UPLOADED_TRUST_PATH" "$_presented" "$_host"
    then
      rm -f "$_presented"
      return 0
    fi
    rm -f "$_presented"
  fi
  return 1
}

tp_instance_bootstrap_curl() {
  if [ "${INSECURE_TLS:-false}" = true ]; then
    printf '%s' "curl -sSLk"
    return 0
  fi
  if [ -n "${UPLOADED_TRUST_PATH:-}" ] && [ -f "$UPLOADED_TRUST_PATH" ]; then
    printf '%s' "curl -sSL --cacert $UPLOADED_TRUST_PATH"
    return 0
  fi
  if [ -n "${CA_PATH:-}" ] && [ -f "$CA_PATH" ]; then
    printf '%s' "curl -sSL --cacert $CA_PATH"
    return 0
  fi
  printf '%s' "curl -sSL"
}

tp_fetch_uploaded_trust() {
  _curl_base="$(tp_instance_bootstrap_curl)"
  _trust_tmp="$(mktemp)"
  # shellcheck disable=SC2086
  _trust_code=$(tp_curl_http_code $_curl_base -o "$_trust_tmp" -w '%{http_code}' "${HOST_URL%/}/api/daemon/v1/instance/uploaded-trust")
  case "$_trust_code" in
    200)
      if ! tp_install_verified_uploaded_trust "$_trust_tmp"; then
        rm -f "$_trust_tmp"
        return 1
      fi
      ;;
    404)
      rm -f "$UPLOADED_TRUST_PATH"
      ;;
    000)
      if [ -f "$UPLOADED_TRUST_PATH" ]; then
        _retry="$(mktemp)"
        _retry_code=$(tp_curl_http_code curl -sSLk -o "$_retry" -w '%{http_code}' "${HOST_URL%/}/api/daemon/v1/instance/uploaded-trust")
        if [ "$_retry_code" = "200" ] && tp_install_verified_uploaded_trust "$_retry"; then
          rm -f "$_retry"
        else
          rm -f "$_trust_tmp" "$_retry"
          tp_print_error "private uploaded issuer changed and could not be verified"
          return 1
        fi
      fi
      ;;
    *)
      tp_print_step "~" "Could not download private uploaded issuer (HTTP ${_trust_code}) — keeping existing issuer if present"
      ;;
  esac
  rm -f "$_trust_tmp"
  return 0
}

tp_install_instance_ca() {
  _new_ca="$1"
  _old_fp=""
  if [ -f "$CA_PATH" ]; then
    _old_fp="$(tp_ca_fingerprint "$CA_PATH")"
  fi
  install -m 0640 "$_new_ca" "$CA_PATH"
  _new_fp="$(tp_ca_fingerprint "$CA_PATH")"
  if [ -n "$_old_fp" ]; then
    tp_print_ok "Instance CA downloaded (was ${_old_fp}; now ${_new_fp})"
  else
    tp_print_ok "Instance CA downloaded (${_new_fp})"
  fi
}

# Overlay artifact downloads (TURBOPANEL_DL_BASE) follow the *instance* TLS
# policy: platform CA via --cacert when available, else -k when INSECURE_TLS is
# set. Public tunnel TLS uses the system store. CDN downloads use tp_release_curl.
tp_artifact_curl() {
  if [ -z "${TURBOPANEL_DL_BASE:-}" ]; then
    tp_release_curl
    return 0
  fi
  if [ "${INSECURE_TLS:-false}" = true ]; then
    printf '%s' "$TP_CURL_FETCH_INSECURE"
    return 0
  fi
  _cacert=""
  if [ -n "${UPLOADED_TRUST_PATH:-}" ] && [ -f "$UPLOADED_TRUST_PATH" ]; then
    _cacert="$UPLOADED_TRUST_PATH"
  elif [ -f "/etc/turbopanel/instance-uploaded-trust.pem" ]; then
    _cacert="/etc/turbopanel/instance-uploaded-trust.pem"
  elif [ -n "${INSTANCE_CA:-}" ] && [ -f "$INSTANCE_CA" ]; then
    _cacert="$INSTANCE_CA"
  elif [ -n "${CA_PATH:-}" ] && [ -f "$CA_PATH" ]; then
    _cacert="$CA_PATH"
  elif [ -f "/etc/turbopanel/instance-ca.pem" ]; then
    _cacert="/etc/turbopanel/instance-ca.pem"
  fi
  if [ -n "$_cacert" ]; then
    printf 'curl -fsSL --cacert %s' "$_cacert"
    return 0
  fi
  printf '%s' "$TP_CURL_FETCH"
}

tp_join_url() {
  _base="$1"
  _ref="$2"
  case "$_ref" in
    https://*)
      printf '%s' "$_ref"
      return 0
      ;;
    http://*)
      echo "run.sh: refusing plaintext URL: $_ref" >&2
      return 1
      ;;
    *)
      ;;
  esac
  python3 -c 'import sys; from urllib.parse import urljoin; print(urljoin(sys.argv[1], sys.argv[2]))' \
    "$_base" "$_ref"
}

tp_strip_trailing_slashes() {
  _value="$1"
  while [ -n "$_value" ] && [ "${_value%/}" != "$_value" ]; do
    _value="${_value%/}"
  done
  printf '%s' "$_value"
}

tp_prod_home() { printf '/opt/turbopanel'; }
tp_daemon_binary_name() { printf 'turbopaneld'; }
tp_daemon_js_fallback_name() { printf 'turbopaneld.js'; }
tp_daemon_binary_path() {
  _home="${1:-$(tp_prod_home)}"
  printf '%s/bin/%s' "$_home" "$(tp_daemon_binary_name)"
}
# Mirrors tp_daemon_js_fallback_path in scripts/lib/release-artifacts.sh — run.sh
# inlines it because CDN bootstrap runs via curl | sh without a checkout to source.
tp_daemon_js_fallback_path() {
  _home="${1:-$(tp_prod_home)}"
  printf '%s/bin/%s' "$_home" "$(tp_daemon_js_fallback_name)"
}

tp_resolve_linux_arch() {
  _machine="$(uname -m)"
  case "$_machine" in
    x86_64) printf 'linux-amd64' ;;
    aarch64 | arm64) printf 'linux-arm64' ;;
    *)
      echo "run.sh: unsupported CPU architecture for daemon updates: $_machine" >&2
      return 1
      ;;
  esac
}

tp_manifest_compact() {
  _json="$1"
  # shellcheck disable=SC2086
  printf '%s' "$_json" | tr -d '[:space:]'
}

# The manifest field carrying an artifact's SHA-256, and the exec mode the
# systemd unit template takes when the native binary runs here.
TP_MANIFEST_SHA_FIELD="sha256"
TP_EXEC_MODE_NATIVE="native"

tp_manifest_field() {
  _json="$1"
  _field="$2"
  # shellcheck disable=SC2086
  printf '%s' "$_json" | grep -o "\"$_field\":\"[^\"]*\"" | head -1 | sed 's/.*":"//' | tr -d '"'
}

tp_manifest_artifact_field() {
  _json="$1"
  _artifact_key="$2"
  _field="$3"
  # shellcheck disable=SC2086
  _block="$(printf '%s' "$_json" | grep -o "\"$_artifact_key\"[^}]*{[^}]*\"$_field\":\"[^\"]*\"" | head -1)"
  [ -n "$_block" ] || return 1
  printf '%s' "$_block" | grep -o "\"$_field\":\"[^\"]*\"" | sed 's/.*":"//' | tr -d '"'
}

tp_manifest_binary_artifact_field() {
  _json="$1"
  _arch="$2"
  _field="$3"
  # shellcheck disable=SC2086
  _block="$(printf '%s' "$_json" | grep -o "\"$_arch\"[^}]*{[^}]*\"$_field\":\"[^\"]*\"" | head -1)"
  [ -n "$_block" ] || return 1
  printf '%s' "$_block" | grep -o "\"$_field\":\"[^\"]*\"" | sed 's/.*":"//' | tr -d '"'
}

# --- release manifest signatures -------------------------------------------
# Every production channel manifest carries an Ed25519 signature by the
# offline release key over its canonical JSON (keys sorted, no whitespace,
# `signature` removed — see src/update/signing.ts, which pins the same key;
# signing.test.ts pins this copy against that one). The manifest names the
# code this script installs and runs as root, so a manifest that is unsigned,
# signed by any other key, or altered after signing is refused before a single
# artifact is downloaded. python3 canonicalises (already a host prerequisite),
# openssl verifies (Ed25519 needs OpenSSL >= 1.1.1; Debian 12+ ships 3.x).
TP_RELEASE_SIGNING_PUBLIC_KEY="ce1a5ade02f9d2a0b0687d0f9cfd341bcec7a129ed426c37fc2686c22d6b43db"

# The canonicaliser, printed so it can be run here and byte-compared in tests
# (src/update/signing.test.ts). stdin: manifest JSON; stdout: canonical bytes.
tp_manifest_canonical_python() {
  cat <<'PY'
import json, sys
manifest = json.load(sys.stdin)
if not isinstance(manifest, dict):
    raise SystemExit("manifest root must be an object")
manifest.pop("signature", None)
sys.stdout.buffer.write(
    json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
)
PY
}

# Lay out what openssl needs in $2 from the manifest JSON on stdin:
#   canonical (signed bytes), sig (raw 64-byte signature), pub.pem (from $1).
# Exits non-zero, with the reason on stderr, when the signature field is
# missing or malformed — that is a refusal, not a retry.
tp_manifest_signature_material_python() {
  cat <<'PY'
import base64, binascii, json, sys
from pathlib import Path

pub_hex, out = sys.argv[1], Path(sys.argv[2])
manifest = json.load(sys.stdin)
if not isinstance(manifest, dict):
    raise SystemExit("manifest root must be an object")
signature = manifest.pop("signature", None)
if signature is None:
    raise SystemExit("channel manifest is unsigned (missing signature)")
if not isinstance(signature, dict) or signature.get("alg") != "ed25519":
    raise SystemExit("channel manifest signature must be an ed25519 signature object")
value = signature.get("value")
if not isinstance(value, str) or not value.strip():
    raise SystemExit("channel manifest signature missing value")
try:
    sig = base64.b64decode(value.strip(), validate=True)
except (binascii.Error, ValueError):
    raise SystemExit("channel manifest signature value is not base64")
if len(sig) != 64:
    raise SystemExit("channel manifest signature must be 64 bytes, got %d" % len(sig))
try:
    pub = bytes.fromhex(pub_hex)
except ValueError:
    raise SystemExit("release public key is not valid hex")
if len(pub) != 32:
    raise SystemExit("release public key must be 32 bytes")
canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
(out / "canonical").write_bytes(canonical)
(out / "sig").write_bytes(sig)
# SubjectPublicKeyInfo for an Ed25519 raw key: fixed 12-byte DER prefix.
spki = bytes.fromhex("302a300506032b6570032100") + pub
pem = "-----BEGIN PUBLIC KEY-----\n" + base64.encodebytes(spki).decode("ascii") + "-----END PUBLIC KEY-----\n"
(out / "pub.pem").write_text(pem)
PY
}

# Verify $1 (manifest JSON) against the pinned release key. Returns 0 only for
# a well-formed signature by that key over exactly these bytes.
tp_verify_manifest_signature() {
  _sig_json="$1"
  _sig_key="${2:-$TP_RELEASE_SIGNING_PUBLIC_KEY}"
  if ! command -v openssl >/dev/null 2>&1; then
    echo "run.sh: openssl is required to verify the release manifest signature" >&2
    return 1
  fi
  _sig_dir="$(mktemp -d)"
  if ! printf '%s' "$_sig_json" | python3 -c "$(tp_manifest_signature_material_python)" "$_sig_key" "$_sig_dir" 2>"$_sig_dir/err"; then
    echo "run.sh: release manifest signature rejected: $(cat "$_sig_dir/err" 2>/dev/null)" >&2
    rm -rf "$_sig_dir"
    return 1
  fi
  if ! openssl pkeyutl -verify -pubin -inkey "$_sig_dir/pub.pem" -rawin \
      -in "$_sig_dir/canonical" -sigfile "$_sig_dir/sig" >/dev/null 2>&1; then
    echo "run.sh: release manifest signature is invalid (not signed by the TurboPanel release key, or altered after signing)" >&2
    rm -rf "$_sig_dir"
    return 1
  fi
  rm -rf "$_sig_dir"
  return 0
}

# The development-only bypass: a TURBOPANEL_DL_BASE overlay is a contributor's
# own build served from their dev host, and the dev catalog writer signs
# nothing. Host-side and explicit (the --dl-base flag), never something a
# manifest can switch on; the built-in rail and --manifest-url pins always
# verify. Printed loudly so nobody mistakes an overlay install for a release.
tp_manifest_signature_bypass() {
  [ -n "${TURBOPANEL_DL_BASE:-}" ]
}

tp_resolve_channel_manifest() {
  _manifest_json="$1"
  _compact="$(tp_manifest_compact "$_manifest_json")"
  _manifest_host="$(tp_manifest_field "$_compact" "defaultControlPlaneUrl")"
  _manifest_commit="$(tp_manifest_field "$_compact" "commit")"
  _manifest_build_id="$(tp_manifest_field "$_compact" "buildId")"
  _linux_arch="$(tp_resolve_linux_arch)" || return 1
  _binary_artifact_url="$(tp_manifest_binary_artifact_field "$_compact" "$_linux_arch" "url")"
  _binary_artifact_sha256="$(tp_manifest_binary_artifact_field "$_compact" "$_linux_arch" "$TP_MANIFEST_SHA_FIELD")"
  _js_fallback_artifact_url="$(tp_manifest_artifact_field "$_compact" "jsFallbackArtifact" "url")"
  _js_fallback_artifact_sha256="$(tp_manifest_artifact_field "$_compact" "jsFallbackArtifact" "$TP_MANIFEST_SHA_FIELD")"
  _orchestration_artifact_url="$(tp_manifest_artifact_field "$_compact" "orchestrationArtifact" "url")"
  _orchestration_artifact_sha256="$(tp_manifest_artifact_field "$_compact" "orchestrationArtifact" "$TP_MANIFEST_SHA_FIELD")"
  if [ -z "$_manifest_host" ]; then
    _manifest_host="https://turbopanel.app"
  fi
  if [ -z "$_binary_artifact_url" ] || [ -z "$_binary_artifact_sha256" ] \
    || [ -z "$_js_fallback_artifact_url" ] || [ -z "$_js_fallback_artifact_sha256" ] \
    || [ -z "$_orchestration_artifact_url" ] || [ -z "$_orchestration_artifact_sha256" ]; then
    return 1
  fi
  return 0
}

tp_extract_tar_zst_archive() {
  _archive="$1"
  _dest_root="$2"
  if ! command -v zstd >/dev/null 2>&1; then
    echo "run.sh: zstd is required" >&2
    return 1
  fi
  mkdir -p "$_dest_root"
  if ! zstd -d -q -c "$_archive" | tar -x -C "$_dest_root"; then
    echo "run.sh: failed to extract $_archive" >&2
    return 1
  fi
  return 0
}

tp_extract_orchestration_release() {
  _archive="$1"
  _dest_root="$2"
  _home="${3:-$(tp_prod_home)}"
  if ! command -v zstd >/dev/null 2>&1; then
    echo "run.sh: zstd is required" >&2
    return 1
  fi
  mkdir -p "$_dest_root"
  if ! zstd -d -q -c "$_archive" | tar -x -C "$_dest_root"; then
    echo "run.sh: failed to extract $_archive" >&2
    return 1
  fi
  if [ ! -f "$_dest_root/$_home/share/orchestration/ansible.cfg" ]; then
    echo "run.sh: orchestration archive missing $_home/share/orchestration/ansible.cfg" >&2
    return 1
  fi
  return 0
}

tp_release_download_url() {
  _url="$1"
  printf '%s' "$_url"
}

tp_download_verified_artifact() {
  _url="$1"
  _sha256="$2"
  _dest="$3"

  case "$_url" in
    https://*) ;;
    *)
      echo "run.sh: release URL must use HTTPS: $_url" >&2
      return 1
      ;;
  esac

  _curl="$(tp_artifact_curl)"
  _fetch_url="$(tp_release_download_url "$_url")"
  _attempt=1
  _max_attempts=5

  while [ "$_attempt" -le "$_max_attempts" ]; do
    rm -f "$_dest"
    # shellcheck disable=SC2086
    if ! $_curl "$_fetch_url" -o "$_dest"; then
      echo "run.sh: failed to download $_fetch_url" >&2
      return 1
    fi
    if printf '%s  %s\n' "$_sha256" "$_dest" | sha256sum -c - >/dev/null 2>&1; then
      return 0
    fi
    if [ "$_attempt" -lt "$_max_attempts" ]; then
      echo "run.sh: SHA-256 mismatch for $_url (attempt $_attempt/$_max_attempts), retrying…" >&2
      sleep 3
    fi
    _attempt=$((_attempt + 1))
  done

  _actual_sha256="$(sha256sum "$_dest" | awk '{print $1}')"
  echo "run.sh: SHA-256 mismatch for $_url (expected $_sha256, got $_actual_sha256)" >&2
  return 1
}

tp_remove_js_fallback_binaries() {
  _home="$(tp_prod_home)"
  _js="$(tp_daemon_js_fallback_path "$_home")"
  if [ -e "$_js" ]; then
    rm -f "$_js"
  fi
}

tp_install_verified_binary_and_orchestration() {
  _home="$(tp_prod_home)"
  _binary_name="$(tp_daemon_binary_name)"
  _binary_archive=""
  _orchestration_archive=""
  _staging=""

  _cleanup() {
    rm -f "$_binary_archive" "$_orchestration_archive"
    rm -rf "$_staging"
  }
  trap _cleanup EXIT INT HUP TERM

  _binary_archive="$(mktemp)"
  _orchestration_archive="$(mktemp)"
  _staging="$(mktemp -d)"

  if ! tp_download_verified_artifact "$_binary_artifact_url" "$_binary_artifact_sha256" "$_binary_archive"; then
    return 1
  fi
  if ! tp_download_verified_artifact "$_orchestration_artifact_url" "$_orchestration_artifact_sha256" "$_orchestration_archive"; then
    return 1
  fi

  _binary_staging="$_staging/binary"
  _orchestration_staging="$_staging/orchestration"
  mkdir -p "$_binary_staging" "$_orchestration_staging"

  if ! tp_extract_tar_zst_archive "$_binary_archive" "$_binary_staging"; then
    return 1
  fi
  if ! tp_extract_orchestration_release "$_orchestration_archive" "$_orchestration_staging" "$_home"; then
    return 1
  fi

  if [ ! -f "$_binary_staging/$_home/bin/$_binary_name" ] \
    || [ ! -f "$_orchestration_staging/$_home/share/orchestration/ansible.cfg" ]; then
    echo "run.sh: release artifacts missing expected production layout" >&2
    return 1
  fi

  mkdir -p "$_home/bin" "$_home/share/orchestration"
  # Keep exactly one previous generation beside the new one (update-rollback,
  # Road to 0.1.x): bin/turbopaneld.prev and share/orchestration.prev. A
  # rollback is a re-run of this script pinned to the previous release's
  # manifest (--manifest-url, or TURBOPANEL_MANIFEST_URL in daemon.env); the
  # .prev copies are the offline emergency — swap them back by hand when the
  # rail itself is unreachable.
  if [ -f "$_home/bin/$_binary_name" ]; then
    rm -f "$_home/bin/$_binary_name.prev"
    mv "$_home/bin/$_binary_name" "$_home/bin/$_binary_name.prev"
  fi
  install -m 0755 "$_binary_staging/$_home/bin/$_binary_name" "$_home/bin/$_binary_name"
  if [ -d "$_home/share/orchestration" ]; then
    rm -rf "$_home/share/orchestration.prev"
    mv "$_home/share/orchestration" "$_home/share/orchestration.prev"
  fi
  cp -a "$_orchestration_staging/$_home/share/orchestration" "$_home/share/"
  trap - EXIT INT HUP TERM
  _cleanup
  return 0
}

tp_install_verified_js_fallback() {
  _home="$(tp_prod_home)"
  _js_name="$(tp_daemon_js_fallback_name)"
  _js_archive=""
  _staging=""

  _cleanup() {
    rm -f "$_js_archive"
    rm -rf "$_staging"
  }
  trap _cleanup EXIT INT HUP TERM

  _js_archive="$(mktemp)"
  _staging="$(mktemp -d)"

  if ! tp_download_verified_artifact "$_js_fallback_artifact_url" "$_js_fallback_artifact_sha256" "$_js_archive"; then
    return 1
  fi

  if ! tp_extract_tar_zst_archive "$_js_archive" "$_staging"; then
    return 1
  fi

  if [ ! -f "$_staging/$_home/bin/$_js_name" ]; then
    echo "run.sh: Deno JS runtime release missing $_home/bin/$_js_name" >&2
    return 1
  fi

  mkdir -p "$_home/bin"
  install -m 0644 "$_staging/$_home/bin/$_js_name" "$_home/bin/$_js_name"
  trap - EXIT INT HUP TERM
  _cleanup
  return 0
}

tp_is_root() { [ "$(id -u)" = "0" ]; }
tp_is_interactive() {
  if [ -t 0 ]; then
    return 0
  fi
  # `[ -r /dev/tty ]` only checks the node's permissions; without a
  # controlling terminal the open itself fails ("No such device or
  # address"), so try the open.
  ( : </dev/tty >/dev/tty ) 2>/dev/null
}
tp_sudo_installed() { command -v sudo >/dev/null 2>&1; }
tp_validate_sudo() {
  if ! tp_sudo_installed; then
    return 2
  fi
  if sudo -n true 2>/dev/null; then
    return 0
  fi
  if tp_is_interactive && sudo -v 2>/dev/null; then
    return 0
  fi
  return 1
}
tp_install_privilege_denied() {
  _reason="${1:-}"
  case "$_reason" in
  no_sudo)
    tp_print_error "run as root (su -); sudo is not installed yet — the daemon installer will install it"
    ;;
  sudo_failed)
    tp_print_error "sudo validation failed — run as root or enter a valid sudo password"
    ;;
  *)
    tp_print_error "must run as root or have sudo privileges"
    ;;
  esac
  exit 1
}

tp_print_step() {
  _glyph="$1"; _msg="$2"
  if [ -t 1 ]; then
    printf '\033[36m%s\033[0m %s\n' "$_glyph" "$_msg"
  else
    printf '%s %s\n' "$_glyph" "$_msg"
  fi
}

tp_print_ok() {
  _msg="$1"
  if [ -t 1 ]; then
    printf '\033[32m✓\033[0m %s\n' "$_msg"
  else
    printf '✓ %s\n' "$_msg"
  fi
}

tp_print_error() {
  _msg="$1"
  if [ -t 2 ]; then
    printf '\033[31m✗\033[0m %s\n' "$_msg" >&2
  else
    printf '✗ %s\n' "$_msg" >&2
  fi
}

DAEMON_SERVICE_NAME="turbopaneld.service"

# Stop the running daemon before replacing release binaries on manual reconcile.
# Skipped for --no-start (in-process UI update): that path must not stop the
# caller; the daemon chdirs away and restarts itself after run.sh completes.
tp_stop_running_daemon_for_release_swap() {
  if [ "$NO_START" = true ]; then
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi
  if ! systemctl cat "$DAEMON_SERVICE_NAME" >/dev/null 2>&1; then
    return 0
  fi
  if ! systemctl is-active --quiet "$DAEMON_SERVICE_NAME" 2>/dev/null; then
    return 0
  fi
  tp_print_step "▸" "Stopping $DAEMON_SERVICE_NAME for release update…"
  if ! systemctl stop "$DAEMON_SERVICE_NAME"; then
    tp_print_error "Failed to stop $DAEMON_SERVICE_NAME"
    exit 1
  fi
  tp_print_ok "Daemon stopped ($DAEMON_SERVICE_NAME)"
}

tp_start_or_restart_daemon() {
  if [ "$NO_START" = true ]; then
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi
  if ! systemctl cat "$DAEMON_SERVICE_NAME" >/dev/null 2>&1; then
    return 0
  fi
  tp_print_step "▸" "Starting $DAEMON_SERVICE_NAME…"
  if ! systemctl enable --now "$DAEMON_SERVICE_NAME"; then
    tp_print_error "Failed to enable/start $DAEMON_SERVICE_NAME"
    exit 1
  fi
  tp_print_ok "Daemon running"
}

# Probe whether the native release binary can execute a trivial subcommand.
# Records DAEMON_EXEC_MODE=native|js for the systemd unit template.
tp_probe_native_daemon() {
  _bin="$(tp_daemon_binary_path)"
  if [ ! -x "$_bin" ]; then
    return 1
  fi
  if "$_bin" --version >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Host-local carry-over for release swaps lives under FHS paths (not the old
# platform/daemon checkout). Keep this list in sync with HOST_LOCAL_ARTIFACTS
# in src/dev-sync/apply.ts — identity/config are under /var/lib and /etc, so
# only checkout leftovers that may still appear under a source tree remain.
# shellcheck disable=SC2034
TP_HOST_LOCAL_ARTIFACTS=".git .github logs cloudflared"

# Keep in sync with orchestration/roles/deno-runtime/defaults/main.yml
# (deno_version + deno_sha256; src/orchestration/assets.test.ts pins all three).
TP_DENO_VERSION="2.9.7"

# Scoped Deno grants for the JS-fallback installer verbs (bootstrap-orchestration,
# run-installer), which run as root before the unit exists. Rendered by
# src/permissions/daemon-permissions.ts renderInstallerPermissionFlags() and pinned by
# src/permissions/daemon-permissions.test.ts — never --allow-all.
TP_INSTALLER_DENO_PERMISSIONS="--allow-read=/opt/turbopanel,/etc/turbopanel,/var/lib/turbopanel,/var/log/turbopanel,/run/turbopanel,/tmp,/root/.ansible,/etc/os-release,/etc/hostname,/etc/machine-id,/etc/passwd,/etc/group,/etc/ssl,/etc/systemd,/proc,/sys,/dev,/usr,/bin,/sbin,/lib,/lib64 --allow-write=/opt/turbopanel,/etc/turbopanel,/var/lib/turbopanel,/var/log/turbopanel,/run/turbopanel,/tmp,/root/.ansible --allow-run=sh,/bin/sh,bash,cat,ls,cp,chmod,ln,id,/usr/bin/id,getent,systemctl,tar,/usr/bin/tar,curl,/usr/bin/curl,git,openssl,/usr/bin/openssl,/opt/turbopanel/vendor/deno/bin/deno,/opt/turbopanel/vendor/deno/current/deno,/opt/turbopanel/vendor/uv/0.11.21/uv,/opt/turbopanel/vendor/uv/0.11.21/uvx,/opt/turbopanel/vendor/ansible/2.20/bin/ansible-playbook,/opt/turbopanel/vendor/ansible/2.20/bin/ansible-galaxy,/opt/turbopanel/vendor/ansible/2.20/bin/ansible-lint --allow-env --allow-net --deny-net=169.254.169.254,metadata.google.internal,[fd00:ec2::254] --allow-sys=networkInterfaces,hostname,statfs,uid"
# Upstream SHA-256 of the release zip per architecture (dl.deno.land publishes
# `<asset>.sha256sum` beside each asset). The download below is verified
# against these before extraction — this path runs as root before any Ansible
# hardening on JS-fallback hosts, so it cannot lean on the role's check.
TP_DENO_SHA256_X86_64="c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490"
TP_DENO_SHA256_AARCH64="c832298b1ad4422481334855f6003e0f54145762c5a134f20a489511d2f65bbf"

# Print the pinned digest for the host architecture ($1 = uname -m), or fail
# when none is pinned — a bump without digests must not install anything.
tp_deno_pinned_sha256() {
  case "$1" in
    aarch64 | arm64) _sum="$TP_DENO_SHA256_AARCH64" ;;
    x86_64 | amd64) _sum="$TP_DENO_SHA256_X86_64" ;;
    *) return 1 ;;
  esac
  case "$_sum" in
    ????????????????????????????????????????????????????????????????) printf '%s' "$_sum" ;;
    *) return 1 ;;
  esac
}

# Verify $1 against the pinned Deno digest for architecture $2.
tp_verify_deno_archive() {
  _archive="$1"
  _sum="$(tp_deno_pinned_sha256 "$2")" || {
    echo "run.sh: no pinned SHA-256 for Deno ${TP_DENO_VERSION} on $2" >&2
    return 1
  }
  if printf '%s  %s\n' "$_sum" "$_archive" | sha256sum -c - >/dev/null 2>&1; then
    return 0
  fi
  _actual="$(sha256sum "$_archive" | awk '{print $1}')"
  echo "run.sh: SHA-256 mismatch for Deno ${TP_DENO_VERSION} (expected $_sum, got $_actual)" >&2
  return 1
}

# Install Deno into the runtimes tree (idempotent), mirroring uv/ansible/cloudflared:
#   $RUNTIMES_DIR/deno/$TP_DENO_VERSION/deno  plus `current` and `bin/deno` symlinks.
# Keep the download/extract path in sync with orchestration/roles/deno-runtime/tasks/main.yml
# (dl.deno.land release zip + python3 stdlib — host-base only guarantees python3, not unzip).
tp_install_deno_runtime() {
  _deno_versioned_dir="$RUNTIMES_DIR/deno/$TP_DENO_VERSION"
  _deno_bin="$_deno_versioned_dir/deno"
  if [ ! -x "$_deno_bin" ]; then
    case "$(uname -m)" in
    aarch64 | arm64) _deno_arch="aarch64-unknown-linux-gnu" ;;
    x86_64 | amd64) _deno_arch="x86_64-unknown-linux-gnu" ;;
    *)
      tp_print_error "Unsupported architecture for Deno: $(uname -m)"
      return 1
      ;;
    esac
    _deno_asset="deno-${_deno_arch}.zip"
    _deno_url="https://dl.deno.land/release/v${TP_DENO_VERSION}/${_deno_asset}"
    _deno_tmp="$(mktemp -d)"
    _curl="$(tp_release_curl)"
    # shellcheck disable=SC2086
    if ! $_curl -o "$_deno_tmp/$_deno_asset" "$_deno_url" 2>"$_deno_tmp/curl.err"; then
      tp_print_error "Failed to download Deno from $_deno_url"
      [ -s "$_deno_tmp/curl.err" ] && cat "$_deno_tmp/curl.err" >&2
      rm -rf "$_deno_tmp"
      return 1
    fi
    # Pinned digest before anything is extracted or executed.
    if ! tp_verify_deno_archive "$_deno_tmp/$_deno_asset" "$(uname -m)"; then
      tp_print_error "Deno release zip failed SHA-256 verification"
      rm -rf "$_deno_tmp"
      return 1
    fi
    mkdir -p "$_deno_versioned_dir"
    if ! python3 - "$_deno_tmp/$_deno_asset" "$_deno_bin" 2>"$_deno_tmp/python.err" <<'PY'
import shutil, sys, tempfile, zipfile
from pathlib import Path

archive, dest = Path(sys.argv[1]), Path(sys.argv[2])
dest.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="deno-zip-") as tmp:
    tmp_path = Path(tmp)
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(tmp_path)
    candidates = list(tmp_path.rglob("deno"))
    if not candidates:
        raise SystemExit("deno binary not found in release zip")
    shutil.copy2(candidates[0], dest)
dest.chmod(0o755)
PY
    then
      tp_print_error "Failed to extract Deno release zip"
      [ -s "$_deno_tmp/python.err" ] && cat "$_deno_tmp/python.err" >&2
      rm -rf "$_deno_tmp"
      return 1
    fi
    rm -rf "$_deno_tmp"
  fi
  # Always restore stable symlinks (repair/retry may leave them drifted).
  ln -sfn "$TP_DENO_VERSION" "$RUNTIMES_DIR/deno/current"
  # Stable path for the JS-fallback systemd ExecStart (next phase).
  mkdir -p "$RUNTIMES_DIR/deno/bin"
  ln -sfn "../current/deno" "$RUNTIMES_DIR/deno/bin/deno"
}

# Built-in manifest location per advertised channel and artifact kind, used
# when no overlay catalog is configured. Mirrors src/update/urls.ts
# builtinChannelManifestUrl (urls.test.ts pins this copy against that one) —
# keep the two in step. Kind is daemon (default), instance, or ui.
# Daemon trunk is the CDN drop. Instance and UI publish only through GitHub
# Releases, so their trunk has no location. canary is the rolling GitHub
# pre-release carrying the newest green trunk build; edge is reserved and
# unadvertised: no built-in location.
tp_builtin_channel_manifest_url() {
  _channel="$1"
  _kind="${2:-daemon}"
  case "$_kind" in
    daemon) _repo="turbopaneld" ;;
    instance) _repo="turbopanel" ;;
    ui) _repo="ui" ;;
    *) return 1 ;;
  esac
  case "$_channel" in
    trunk)
      if [ "$_kind" != "daemon" ]; then
        return 1
      fi
      printf '%s' "https://dl.trbp.nl/channels/trunk/manifest.json"
      ;;
    canary) printf '%s' "https://github.com/TurboPanel/${_repo}/releases/download/canary/manifest.json" ;;
    rc) printf '%s' "https://github.com/TurboPanel/${_repo}/releases/download/rc/manifest.json" ;;
    release) printf '%s' "https://github.com/TurboPanel/${_repo}/releases/latest/download/manifest.json" ;;
    *) return 1 ;;
  esac
}

# The same rail addressed by repository name (turbopaneld, turbopanel, ui).
# Instance and UI publish only through GitHub Releases: canary, rc, release.
# There is no CDN drop for them, so trunk has no location and an --instance
# install must name canary, rc or release.
tp_builtin_repo_manifest_url() {
  case "$1" in
    turbopaneld) _kind="daemon" ;;
    turbopanel) _kind="instance" ;;
    ui) _kind="ui" ;;
    *) return 1 ;;
  esac
  tp_builtin_channel_manifest_url "$2" "$_kind"
}

tp_fetch_channel_manifest() {
  _channel="${TURBOPANEL_UPDATE_CHANNEL:-trunk}"
  _dl_base="${TURBOPANEL_DL_BASE:-}"
  if [ -n "$_dl_base" ]; then
    _catalog_url="${_dl_base}/channels.json"
    _curl="$(tp_artifact_curl)"

    _channels_json=""
    if ! _channels_json="$($_curl "$_catalog_url" 2>/dev/null)"; then
      echo "run.sh: overlay catalog missing at ${_catalog_url} — rebuild the daemon on the development host" >&2
      return 1
    fi

    _channels_oneline="$(tp_manifest_compact "$_channels_json")"
    _manifest_url="$(printf '%s' "$_channels_oneline" | grep -o "\"${_channel}\"[^}]*manifestUrl\":\"[^\"]*\"" | sed 's/.*manifestUrl":"//' | tr -d '"')"
    if [ -z "$_manifest_url" ]; then
      return 1
    fi
    _manifest_url="$(tp_join_url "$_catalog_url" "$_manifest_url")" || return 1
  elif [ -n "${TURBOPANEL_MANIFEST_URL:-}" ]; then
    # Pinned: this exact manifest, whatever the channel points at now.
    _curl="$(tp_release_curl)"
    _manifest_url="$TURBOPANEL_MANIFEST_URL"
  else
    _curl="$(tp_release_curl)"
    if ! _manifest_url="$(tp_builtin_channel_manifest_url "$_channel")"; then
      echo "run.sh: channel ${_channel} has no built-in manifest location; set TURBOPANEL_DL_BASE to a catalog that names it" >&2
      return 1
    fi
  fi

  _manifest_json=""
  if ! _manifest_json="$($_curl "${_manifest_url}?$(date +%s)" 2>/dev/null)"; then
    return 1
  fi

  # Signature first — nothing in the manifest is read before it is trusted.
  if tp_manifest_signature_bypass; then
    tp_print_styled_line "1;33" "*** DEVELOPMENT OVERLAY: release manifest signature not verified (TURBOPANEL_DL_BASE=${_dl_base}) ***" >&2
  elif ! tp_verify_manifest_signature "$_manifest_json"; then
    return 1
  fi

  if ! tp_resolve_channel_manifest "$_manifest_json"; then
    return 1
  fi

  if [ -n "$_dl_base" ]; then
    _binary_artifact_url="$(tp_join_url "$_manifest_url" "$_binary_artifact_url")" || return 1
    _js_fallback_artifact_url="$(tp_join_url "$_manifest_url" "$_js_fallback_artifact_url")" || return 1
    _orchestration_artifact_url="$(tp_join_url "$_manifest_url" "$_orchestration_artifact_url")" || return 1
  fi

  return 0
}

# --- self-hosted instance install (--instance) ---------------------------
# The instance (TurboPanel/turbopanel) and UI (TurboPanel/ui) packages come
# from the same channel as the daemon package, over the same public-trust
# TLS, and are verified against their own manifest.json exactly like the
# daemon's artifacts (sha256 from the manifest, retried on mismatch).

# Fetch a repo's channel manifest into $_repo_manifest_compact (one line).
tp_fetch_repo_manifest() {
  _repo="$1"
  _channel="${TURBOPANEL_UPDATE_CHANNEL:-release}"
  # A pin names one exact manifest for that package and wins over the
  # channel pointer. The daemon pin (TURBOPANEL_MANIFEST_URL) is not read
  # here: --instance also reinstalls the daemon, and that package keeps its
  # own pin.
  _pin=""
  case "$_repo" in
    turbopanel) _pin="${TURBOPANEL_INSTANCE_MANIFEST_URL:-}" ;;
    ui) _pin="${TURBOPANEL_UI_MANIFEST_URL:-}" ;;
  esac
  if [ -n "$_pin" ]; then
    _manifest_url="$_pin"
  elif ! _manifest_url="$(tp_builtin_repo_manifest_url "$_repo" "$_channel")"; then
    echo "run.sh: ${_repo} has no ${_channel} channel — use --channel canary, rc or release" >&2
    return 1
  fi
  _curl="$(tp_release_curl)"
  _manifest_json=""
  if ! _manifest_json="$($_curl "${_manifest_url}?$(date +%s)" 2>/dev/null)"; then
    echo "run.sh: failed to fetch ${_manifest_url} — does TurboPanel/${_repo} have a ${_channel} release yet?" >&2
    return 1
  fi
  # TurboPanel/turbopanel and TurboPanel/ui publish their manifests from their
  # own release jobs. A signature they carry is verified against the same
  # release key; one they do not carry yet is reported, not waved through
  # silently — the artifact checksums below still bind bytes to the manifest.
  case "$_manifest_json" in
    *'"signature"'*)
      if ! tp_verify_manifest_signature "$_manifest_json"; then
        echo "run.sh: ${_repo} ${_channel} manifest signature rejected" >&2
        return 1
      fi
      ;;
    *)
      tp_print_styled_line "1;33" "*** ${_repo} ${_channel} manifest is unsigned — verified by SHA-256 only ***" >&2
      ;;
  esac
  _repo_manifest_compact="$(tp_manifest_compact "$_manifest_json")"
  [ -n "$_repo_manifest_compact" ]
}

# Download one artifacts.<key> entry of the last fetched repo manifest to $2.
tp_download_repo_artifact() {
  _key="$1"
  _dest="$2"
  _url="$(tp_manifest_binary_artifact_field "$_repo_manifest_compact" "$_key" "url")" || {
    echo "run.sh: manifest has no artifacts.${_key}.url" >&2
    return 1
  }
  _sha="$(tp_manifest_binary_artifact_field "$_repo_manifest_compact" "$_key" "$TP_MANIFEST_SHA_FIELD")" || {
    echo "run.sh: manifest has no artifacts.${_key}.sha256" >&2
    return 1
  }
  tp_download_verified_artifact "$_url" "$_sha" "$_dest"
}

tp_run_instance_install() {
  _ui_dir="$INSTALL_ROOT/share/ui"
  _work="$(mktemp -d)"

  tp_print_step "▸" "Fetching instance release manifest (TurboPanel/turbopanel, channel ${TURBOPANEL_UPDATE_CHANNEL:-release})…"
  tp_fetch_repo_manifest turbopanel || { rm -rf "$_work"; return 1; }
  _instance_version="$(tp_manifest_field "$_repo_manifest_compact" "version")"
  _instance_commit="$(tp_manifest_field "$_repo_manifest_compact" "commit")"
  tp_print_step "  " "Instance: v${_instance_version:-?} (${_instance_commit:-unknown})"
  tp_print_step "▸" "Downloading instance package (${_linux_arch})…"
  tp_download_repo_artifact "instance-${_linux_arch}" "$_work/instance.tar.zst" || { rm -rf "$_work"; return 1; }
  tp_print_ok "Instance package verified (SHA-256 ok)"

  tp_print_step "▸" "Fetching UI release manifest (TurboPanel/ui)…"
  tp_fetch_repo_manifest ui || { rm -rf "$_work"; return 1; }
  _ui_version="$(tp_manifest_field "$_repo_manifest_compact" "version")"
  tp_print_step "  " "UI: v${_ui_version:-?}"
  tp_print_step "▸" "Downloading UI export…"
  tp_download_repo_artifact ui "$_work/ui.tar.gz" || { rm -rf "$_work"; return 1; }
  tp_print_ok "UI export verified (SHA-256 ok)"

  tp_print_step "▸" "Unpacking under $INSTALL_ROOT…"
  # The instance package lies flat in the install root beside the daemon:
  # bin/turbopanel, lib/libduckdb.so. Email runs in-process (no separate
  # mailer binary). Each file is replaced by name — never the directories
  # (bin/ holds turbopaneld, lib/ the update-origin pin) and never state
  # (/var/lib/turbopanel) or config (/etc/turbopanel).
  mkdir -p "$INSTALL_ROOT/bin" "$INSTALL_ROOT/lib"
  # Drop retired names from older packages so upgrades do not leave stale
  # binaries beside the renamed instance binary.
  rm -f "$INSTALL_ROOT/bin/turbopanel" "$INSTALL_ROOT/bin/turbopanel-instance" \
    "$INSTALL_ROOT/bin/turbopanel-mailer" "$INSTALL_ROOT/lib/libduckdb.so"
  # --no-overwrite-dir: the archive carries bin/ and lib/ directory entries;
  # never let them re-own or re-mode the shared install dirs (root:tp 0750).
  zstd -d -q -c "$_work/instance.tar.zst" | tar -x --no-same-owner --no-overwrite-dir -C "$INSTALL_ROOT"
  # Earlier packages unpacked into lib/instance/ (a nested bin/lib/share tree)
  # and the install copied libduckdb.so into vendor/duckdb/; a package built
  # before the flat layout also carries share/caddy/, which is now rendered
  # by instance-launch instead. All three are package content, never state.
  rm -rf "$INSTALL_ROOT/lib/instance" "$INSTALL_ROOT/vendor/duckdb" "$INSTALL_ROOT/share/caddy"
  rm -rf "$_ui_dir"
  mkdir -p "$_ui_dir"
  tar -xzf "$_work/ui.tar.gz" -C "$_ui_dir"
  rm -rf "$_work"
  for _required in \
    "$INSTALL_ROOT/bin/turbopanel" \
    "$INSTALL_ROOT/lib/libduckdb.so" \
    "$_ui_dir/index.html"; do
    if [ ! -e "$_required" ]; then
      tp_print_error "Instance package missing $_required"
      return 1
    fi
  done
  chmod 0755 "$INSTALL_ROOT/bin/turbopanel"
  chmod 0644 "$INSTALL_ROOT/lib/libduckdb.so"
  tp_print_ok "Packages unpacked (instance v${_instance_version:-?}, UI v${_ui_version:-?})"

  _vars="$(mktemp)"
  {
    printf 'turbopanel_update_channel: %s\n' "${TURBOPANEL_UPDATE_CHANNEL:-release}"
    printf 'turbopanel_vendor_dir: %s\n' "$RUNTIMES_DIR"
    printf 'turbopanel_orchestration_dir: %s\n' "$ORCHESTRATION_DIR"
    printf 'instance_start: %s\n' "$([ "$NO_START" = true ] && echo false || echo true)"
    # The co-located daemon: same unit contract as a managed node (native or
    # JS-fallback ExecStart), no control-plane URL — it dials the socket.
    printf 'turbopanel_daemon_exec_mode: %s\n' "$DAEMON_EXEC_MODE"
    printf 'turbopanel_daemon_bin: %s\n' "$(tp_daemon_binary_path)"
    printf 'turbopanel_daemon_js: %s\n' "$(tp_daemon_js_fallback_path)"
    if [ "$DAEMON_EXEC_MODE" = "js" ]; then
      printf 'turbopanel_daemon_deno_bin: %s\n' "$DENO_BIN"
    fi
    printf 'turbopanel_config_dir: %s\n' "$CONFIG_DIR"
    printf 'turbopanel_daemon_state_dir: %s\n' "$STATE_DIR"
    printf 'turbopanel_daemon_env_file: %s\n' "$ENV_FILE"
  } > "$_vars"
  tp_print_step "▸" "Provisioning the self-hosted instance (Postgres, Redis, RabbitMQ, Docker, certs, units, Caddy, co-located daemon)…"
  _rc=0
  if [ "$DAEMON_EXEC_MODE" = "$TP_EXEC_MODE_NATIVE" ]; then
    "$(tp_daemon_binary_path)" run-installer --playbook instance-install.yml --vars-file "$_vars" || _rc=$?
  else
    HOME="$INSTALL_ROOT" "$DENO_BIN" run $TP_INSTALLER_DENO_PERMISSIONS "$(tp_daemon_js_fallback_path)" run-installer --playbook instance-install.yml --vars-file "$_vars" || _rc=$?
  fi
  rm -f "$_vars"
  rm -rf /tmp/turbopanel-ansible /root/.ansible
  if [ "$_rc" -ne 0 ]; then
    tp_print_error "Instance provisioning failed"
    return "$_rc"
  fi
  tp_print_ok "Self-hosted instance installed — open the wizard URL printed above (https://<this host>:8443/install); this host's daemon enrols itself once the wizard has issued the first license"
  return 0
}

set -eu

# Quiet instance-manifest peek for the welcome banner. Failures stay silent —
# the real fetch in tp_run_instance_install is the one that can abort. Capped
# so a slow GitHub cannot hold the warning off the screen.
tp_peek_instance_version() {
  _channel="${TURBOPANEL_UPDATE_CHANNEL:-release}"
  if ! _url="$(tp_builtin_repo_manifest_url turbopanel "$_channel")"; then
    return 1
  fi
  _curl="$(tp_release_curl)"
  _json=""
  # shellcheck disable=SC2086
  if ! _json="$($_curl -m 5 "${_url}?$(date +%s)" 2>/dev/null)"; then
    return 1
  fi
  _ver="$(tp_manifest_field "$(tp_manifest_compact "$_json")" "version")"
  [ -n "$_ver" ] || return 1
  printf '%s' "$_ver"
}

tp_print_styled_line() {
  _codes="$1"
  _text="$2"
  if [ -t 1 ]; then
    printf '\033[%sm%s\033[0m\n' "$_codes" "$_text"
  else
    printf '%s\n' "$_text"
  fi
}

tp_print_nonstable_channel_warning() {
  _channel="$1"
  _channel_upper="$(printf '%s' "$_channel" | tr '[:lower:]' '[:upper:]')"
  _rule='  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  _title=" WARNING: PRE-RELEASE UPDATE CHANNEL (${_channel_upper})"
  tp_print_styled_line "1;33" "$_rule"
  if [ -t 1 ]; then
    # Full-width black-on-yellow bar. The padding is byte-wise in POSIX sh,
    # so the title stays plain ASCII to fill the width exactly.
    printf '  \033[1;30;43m%-68s\033[0m\n' "$_title"
  else
    printf '  %s\n' "$_title"
  fi
  tp_print_styled_line "1;33" "$_rule"
  case "$_channel" in
    canary)
      tp_print_styled_line "33" "   Canary follows every green trunk merge. It is not a supported"
      tp_print_styled_line "33" "   release: builds can break, change behaviour or need a fresh install"
      tp_print_styled_line "33" "   at any time. Do not run it in production."
      ;;
    rc)
      tp_print_styled_line "33" "   This is a release candidate, not a supported release. It may still"
      tp_print_styled_line "33" "   change before the final tag. Do not run it in production."
      ;;
    *)
      tp_print_styled_line "33" "   This channel is not a supported release. Use it only if you intend"
      tp_print_styled_line "33" "   to run pre-release software. Do not run it in production."
      ;;
  esac
  printf '\n'
  tp_print_styled_line "33" "   Supported release:  curl -fsSL turbopanel.sh | sh"
  tp_print_styled_line "1;33" "$_rule"
}

tp_print_instance_welcome() {
  _channel="${TURBOPANEL_UPDATE_CHANNEL:-release}"

  printf '\n'
  tp_print_styled_line "1" '  ╭──────────────────────────────────────────────────────────────╮'
  tp_print_styled_line "1" '  │  ⚡ TurboPanel  ·  Self-Hosted Instance Installer / Updater  │'
  tp_print_styled_line "1" '  ╰──────────────────────────────────────────────────────────────╯'
  _version=""
  _version="$(tp_peek_instance_version 2>/dev/null)" || _version=""
  if [ -n "$_version" ]; then
    tp_print_styled_line "1;36" "  v${_version}"
  else
    tp_print_styled_line "1;36" "  channel ${_channel}"
  fi
  printf '\n'
  if [ "$_channel" != "release" ]; then
    tp_print_nonstable_channel_warning "$_channel"
    printf '\n'
  fi
  printf '  This installs the full TurboPanel control plane on this host.\n'
  printf '\n'
  printf '  Connecting a server to an existing control plane? Sign in to that\n'
  printf '  panel and copy the install command from Servers. It includes the\n'
  printf '  license this host needs.\n'
  printf '\n'
  if [ -t 1 ] && tp_is_interactive; then
    if [ "$_channel" != "release" ]; then
      printf '  Press Enter to continue on the %s channel, or q to quit. ' "$_channel"
    else
      printf '  Press Enter to continue, or q to quit. '
    fi
    _cont=""
    read -r _cont </dev/tty || _cont=""
    printf '\n'
    case "$_cont" in
      q|Q)
        echo "run.sh: nothing installed"
        exit 0
        ;;
      *)
        ;;
    esac
  fi
}

tp_print_header() {
  if [ "$INSTANCE_INSTALL" = true ]; then
    tp_print_instance_welcome
    return 0
  fi
  if [ -t 1 ]; then
    printf '\n'
    printf '  ╭─────────────────────────────────────────╮\n'
    printf '  │  ⚡ TurboPanel  ·  Daemon Installer     │\n'
    printf '  ╰─────────────────────────────────────────╯\n'
    printf '\n'
  else
    printf 'TurboPanel Daemon Installer\n'
  fi
}

LICENSE=""
HOST_URL=""
DL_BASE=""
INSTANCE_CA=""
TUNNEL_TOKEN=""
INSECURE_TLS=false
NO_START=false
INSTANCE_INSTALL=false
MANIFEST_URL=""
INSTANCE_MANIFEST_URL=""
UI_MANIFEST_URL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --license)
      [ $# -ge 2 ] || { tp_print_error "--license requires an argument"; exit 1; }
      LICENSE="$2"; shift 2 ;;
    --host)
      [ $# -ge 2 ] || { tp_print_error "--host requires an argument"; exit 1; }
      HOST_URL="$2"; shift 2 ;;
    --dl-base)
      [ $# -ge 2 ] || { tp_print_error "--dl-base requires an argument"; exit 1; }
      DL_BASE="$2"; shift 2 ;;
    --instance-ca)
      [ $# -ge 2 ] || { tp_print_error "--instance-ca requires an argument"; exit 1; }
      INSTANCE_CA="$2"; shift 2 ;;
    --tunnel-token)
      [ $# -ge 2 ] || { tp_print_error "--tunnel-token requires an argument"; exit 1; }
      TUNNEL_TOKEN="$2"; shift 2 ;;
    --insecure-tls)
      INSECURE_TLS=true; shift ;;
    --no-start)
      NO_START=true; shift ;;
    --instance)
      INSTANCE_INSTALL=true; shift ;;
    --manifest-url)
      [ $# -ge 2 ] || { tp_print_error "--manifest-url requires an argument"; exit 1; }
      MANIFEST_URL="$2"; shift 2 ;;
    --instance-manifest-url)
      [ $# -ge 2 ] || { tp_print_error "--instance-manifest-url requires an argument"; exit 1; }
      INSTANCE_MANIFEST_URL="$2"; shift 2 ;;
    --ui-manifest-url)
      [ $# -ge 2 ] || { tp_print_error "--ui-manifest-url requires an argument"; exit 1; }
      UI_MANIFEST_URL="$2"; shift 2 ;;
    --channel)
      [ $# -ge 2 ] || { tp_print_error "--channel requires an argument"; exit 1; }
      export TURBOPANEL_UPDATE_CHANNEL="$2"; shift 2 ;;
    *)
      tp_print_error "unknown option: $1"; exit 1 ;;
  esac
done

# Piped install form prefers env vars so the copy-paste command stays clean:
#   curl -fsSL turbopanel.sh | TURBOPANEL_LICENSE=… sh
# Explicit flags win when both are set (sudo re-exec always uses flags).
[ -n "$LICENSE" ] || LICENSE="${TURBOPANEL_LICENSE:-}"
[ -n "$HOST_URL" ] || HOST_URL="${TURBOPANEL_HOST:-}"
[ -n "$DL_BASE" ] || DL_BASE="${TURBOPANEL_DL_BASE:-}"
DL_BASE="$(tp_strip_trailing_slashes "$DL_BASE")"
if [ -n "$HOST_URL" ]; then
  case "$HOST_URL" in
    https://*) ;;
    *)
      tp_print_error "--host must be an https:// URL (got $HOST_URL)"
      exit 1
      ;;
  esac
fi
if [ -n "$DL_BASE" ]; then
  case "$DL_BASE" in
    https://*) ;;
    *)
      tp_print_error "TURBOPANEL_DL_BASE must be an https:// URL (got $DL_BASE)"
      exit 1
      ;;
  esac
  export TURBOPANEL_DL_BASE="$DL_BASE"
fi
# A pin: one exact daemon manifest (a tag's
# releases/download/vX.Y.Z/manifest.json) instead of whatever the channel
# points at now. Written to daemon.env so panel-driven updates hold the pin
# too (the daemon's resolver reads the same variable); clear it with a plain
# channel install. Rolling back is pinning the previous tag.
[ -n "$MANIFEST_URL" ] || MANIFEST_URL="${TURBOPANEL_MANIFEST_URL:-}"
if [ -n "$MANIFEST_URL" ]; then
  case "$MANIFEST_URL" in
    https://*) ;;
    *) tp_print_error "--manifest-url must be an https:// URL (got $MANIFEST_URL)"; exit 1 ;;
  esac
  if [ -n "$DL_BASE" ]; then
    tp_print_error "--manifest-url and TURBOPANEL_DL_BASE are exclusive: a pin names one manifest, an overlay names a catalog"
    exit 1
  fi
  export TURBOPANEL_MANIFEST_URL="$MANIFEST_URL"
fi
# Independent pins for the control plane and the UI. They must not share
# TURBOPANEL_MANIFEST_URL: that variable pins the daemon package, which an
# --instance run also reinstalls.
[ -n "$INSTANCE_MANIFEST_URL" ] || INSTANCE_MANIFEST_URL="${TURBOPANEL_INSTANCE_MANIFEST_URL:-}"
if [ -n "$INSTANCE_MANIFEST_URL" ]; then
  case "$INSTANCE_MANIFEST_URL" in
    https://*) ;;
    *) tp_print_error "--instance-manifest-url must be an https:// URL (got $INSTANCE_MANIFEST_URL)"; exit 1 ;;
  esac
  export TURBOPANEL_INSTANCE_MANIFEST_URL="$INSTANCE_MANIFEST_URL"
fi
[ -n "$UI_MANIFEST_URL" ] || UI_MANIFEST_URL="${TURBOPANEL_UI_MANIFEST_URL:-}"
if [ -n "$UI_MANIFEST_URL" ]; then
  case "$UI_MANIFEST_URL" in
    https://*) ;;
    *) tp_print_error "--ui-manifest-url must be an https:// URL (got $UI_MANIFEST_URL)"; exit 1 ;;
  esac
  export TURBOPANEL_UI_MANIFEST_URL="$UI_MANIFEST_URL"
fi
case "${TURBOPANEL_INSECURE_TLS:-}" in
  1|true|TRUE|yes|YES) INSECURE_TLS=true ;;
  *)
    # Leave INSECURE_TLS unchanged (may already be set by --insecure-tls).
    ;;
esac
case "${TURBOPANEL_INSTANCE:-}" in
  1|true|TRUE|yes|YES) INSTANCE_INSTALL=true ;;
  *) ;;
esac

# A bare run — no license, no daemon arguments — is a control plane install.
# Daemon arguments without a license keep the old error: that is an enrolment
# that forgot its license, not a request for a panel. The welcome (and the
# non-stable-channel warning) print from tp_print_header once privileges are
# settled, so a sudo re-exec does not show the banner twice.
if [ "$INSTANCE_INSTALL" != true ] && [ -z "$LICENSE" ] && [ -z "$HOST_URL" ] \
  && [ -z "$TUNNEL_TOKEN" ] && [ -z "$INSTANCE_CA" ] && [ -z "$DL_BASE" ] \
  && [ -z "$MANIFEST_URL" ] && [ -z "$INSTANCE_MANIFEST_URL" ] \
  && [ -z "$UI_MANIFEST_URL" ]; then
  INSTANCE_INSTALL=true
fi

if [ "$INSTANCE_INSTALL" = true ]; then
  # A control plane install: no license (the wizard issues the first one),
  # no control-plane URL (this host becomes one), and the packages only exist
  # on the GitHub rail — so the channel defaults to release, not trunk.
  [ -n "${TURBOPANEL_UPDATE_CHANNEL:-}" ] || export TURBOPANEL_UPDATE_CHANNEL=release
  if [ -n "$LICENSE" ] || [ -n "$TUNNEL_TOKEN" ] || [ -n "$INSTANCE_CA" ]; then
    tp_print_error "--instance installs a control plane: it takes no --license, --tunnel-token or --instance-ca (the co-located daemon is installed with it and enrols itself once the wizard has issued the first license)"
    exit 1
  fi
  if ! tp_builtin_repo_manifest_url turbopanel "$TURBOPANEL_UPDATE_CHANNEL" >/dev/null; then
    tp_print_error "--instance needs --channel canary, rc or release (the instance and UI packages publish only through GitHub Releases; got ${TURBOPANEL_UPDATE_CHANNEL})"
    exit 1
  fi
elif [ -z "$LICENSE" ]; then
  tp_print_error "TURBOPANEL_LICENSE (or --license) is required to enrol a daemon (run with no arguments to install a control plane instead)"
  exit 1
fi

LICENSE_ID=""
LICENSE_TOKEN=""
if [ "$INSTANCE_INSTALL" != true ]; then
  _padded="$LICENSE"
  while [ $(( ${#_padded} % 4 )) -ne 0 ]; do
    _padded="${_padded}="
  done
  _decoded="$(printf '%s' "$_padded" | tr -- '-_' '+/' | base64 -d 2>/dev/null)" || {
    tp_print_error "invalid --license format; expected base64url-encoded id:token"
    exit 1
  }
  LICENSE_ID="$(echo "$_decoded" | cut -d: -f1)"
  LICENSE_TOKEN="$(echo "$_decoded" | cut -d: -f2-)"
  if [ -z "$LICENSE_ID" ] || [ -z "$LICENSE_TOKEN" ]; then
    tp_print_error "invalid --license format; expected base64url-encoded id:token"
    exit 1
  fi
fi

if ! tp_is_root; then
  _sudo_rc=0
  tp_validate_sudo || _sudo_rc=$?
  if [ "$_sudo_rc" -eq 2 ]; then
    tp_install_privilege_denied no_sudo
  fi
  if [ "$_sudo_rc" -ne 0 ]; then
    tp_install_privilege_denied sudo_failed
  fi
  if [ -n "$DL_BASE" ]; then
    if [ -z "$HOST_URL" ]; then
      tp_print_error "TURBOPANEL_DL_BASE requires TURBOPANEL_HOST (or --host)"
      exit 1
    fi
    _REEXEC_SCRIPT_URL="${HOST_URL%/}/run.sh"
  else
    _REEXEC_SCRIPT_URL="https://turbopanel.sh"
  fi
  set --
  [ -n "$LICENSE" ] && set -- "$@" --license "$LICENSE"
  [ "$INSTANCE_INSTALL" = true ] && set -- "$@" --instance
  [ -n "$MANIFEST_URL" ] && set -- "$@" --manifest-url "$MANIFEST_URL"
  [ -n "$INSTANCE_MANIFEST_URL" ] && set -- "$@" --instance-manifest-url "$INSTANCE_MANIFEST_URL"
  [ -n "$UI_MANIFEST_URL" ] && set -- "$@" --ui-manifest-url "$UI_MANIFEST_URL"
  [ -n "$HOST_URL" ] && set -- "$@" --host "$HOST_URL"
  [ -n "$DL_BASE" ] && set -- "$@" --dl-base "$DL_BASE"
  [ -n "$INSTANCE_CA" ] && set -- "$@" --instance-ca "$INSTANCE_CA"
  [ -n "$TUNNEL_TOKEN" ] && set -- "$@" --tunnel-token "$TUNNEL_TOKEN"
  [ "$INSECURE_TLS" = true ] && set -- "$@" --insecure-tls
  [ "$NO_START" = true ] && set -- "$@" --no-start
  [ -n "${TURBOPANEL_UPDATE_CHANNEL:-}" ] && set -- "$@" --channel "$TURBOPANEL_UPDATE_CHANNEL"
  _curl="$TP_CURL_FETCH"
  [ "$INSECURE_TLS" = true ] && _curl="$TP_CURL_FETCH_INSECURE"
  # Re-run the script under sudo. `exec` cannot be used here: in a pipeline
  # each command runs in its own subshell, so `exec` would only replace the
  # curl subshell, not this shell — leaving the original non-root shell to
  # fall through and fail on the privileged mkdir calls below. Run the
  # pipeline, then exit with its status so the parent shell never continues.
  # shellcheck disable=SC2086
  $_curl "$_REEXEC_SCRIPT_URL" | sudo sh -s -- "$@"
  exit $?
fi

tp_print_header

INSTALL_ROOT="/opt/turbopanel"
BIN_DIR="$INSTALL_ROOT/bin"
ORCHESTRATION_DIR="$INSTALL_ROOT/share/orchestration"
RUNTIMES_DIR="$INSTALL_ROOT/vendor"
CONFIG_DIR="/etc/turbopanel"
STATE_DIR="/var/lib/turbopanel"
RUN_DIR="/run/turbopanel"
ENV_FILE="$CONFIG_DIR/daemon.env"
CA_PATH="$CONFIG_DIR/instance-ca.pem"
UPLOADED_TRUST_PATH="$CONFIG_DIR/instance-uploaded-trust.pem"
LICENSE_STAGING_DIR="$STATE_DIR/daemon-license-staging"

# NOTE: `--insecure-tls` (INSECURE_TLS) deliberately does NOT export any
# release-insecure flag. It only relaxes trust for the self-hosted instance
# bootstrap legs below (the run.sh re-exec, the instance CA fetch, and the
# private uploaded-issuer fetch). The issuer is verified against the presented
# leaf before it is stored. It is not written to instance-ca.pem, and it is
# not a permanent insecure TLS setting.
# Release/CDN downloads stay TLS-verified via tp_release_curl(); the only way to
# relax them is the undocumented operator-only TURBOPANEL_RELEASE_TLS_INSECURE_OVERRIDE.

mkdir -p "$STATE_DIR" "$CONFIG_DIR" "$BIN_DIR" "$INSTALL_ROOT/share" "$RUN_DIR"
if [ "$INSTANCE_INSTALL" != true ]; then
  STAGING_DIR="$LICENSE_STAGING_DIR"
  mkdir -p "$STAGING_DIR"
  printf '%s' "$LICENSE_ID" > "$STAGING_DIR/license.id"
  printf '%s' "$LICENSE_TOKEN" > "$STAGING_DIR/license.token"
  chmod 0640 "$STAGING_DIR/license.id" "$STAGING_DIR/license.token"
fi

export DEBIAN_FRONTEND=noninteractive
tp_print_step "▸" "Checking host operating system…"
# TurboPanel's orchestration (the docker role's distro map,
# turbopaneld/orchestration/roles/docker/vars/main.yml) supports Debian and
# Raspbian only — Ubuntu is explicitly rejected downstream by an Ansible
# assert. Fail here, in plain language, before apt-get runs at all: apt
# exists on Ubuntu too, so without this check the bootstrap looks like it's
# working right up until Ansible fails deep into the install.
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    debian | raspbian) ;;
    *)
      tp_print_error "Unsupported operating system '${PRETTY_NAME:-${ID:-unknown}}' — TurboPanel supports Debian and Raspbian only."
      exit 1
      ;;
  esac
else
  tp_print_error "Cannot read /etc/os-release to identify the operating system — TurboPanel supports Debian and Raspbian only."
  exit 1
fi
tp_print_ok "Operating system supported (${PRETTY_NAME:-$ID})"

tp_print_step "▸" "Checking host prerequisites…"
# Host-base boundary (not TurboPanel-managed vendors): tools required to
# download/extract release artifacts and bootstrap vendor. Vendor runtimes
# (uv, Deno, Node, Caddy, Redis, …) are installed by orchestration — never via
# apt in run.sh. zstd is required here, not just later by orchestration:
# tp_extract_tar_zst_archive() (above) needs it to unpack the release
# artifacts this same script downloads, and daemon-prereqs only installs it
# afterward — a minimal Debian host used to die at the first extraction.
_tp_host_missing=""
for _tp_host_cmd in sudo curl tar python3 zstd openssl; do
  if ! command -v "$_tp_host_cmd" >/dev/null 2>&1; then
    _tp_host_missing="$_tp_host_missing $_tp_host_cmd"
  fi
done
_tp_host_prereq_fail() {
  _msg="$1"
  tp_print_error "$_msg"
  cat "$_apt_log" >&2
  rm -f "$_apt_log"
  exit 1
}
_apt_log="$(mktemp)"
if [ -n "$_tp_host_missing" ] \
  && { ! apt-get update -qq >>"$_apt_log" 2>&1 \
    || ! apt-get install -y -qq sudo curl ca-certificates tar python3-minimal zstd openssl >>"$_apt_log" 2>&1; }; then
  _tp_host_prereq_fail "host prerequisites failed (need:${_tp_host_missing})"
fi
if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1 \
  || ! command -v python3 >/dev/null 2>&1 || ! command -v zstd >/dev/null 2>&1 \
  || ! command -v openssl >/dev/null 2>&1; then
  _tp_host_prereq_fail "host prerequisites missing after install (need curl tar python3 zstd openssl)"
fi
rm -f "$_apt_log"
tp_print_ok "Host prerequisites ready"

tp_print_step "▸" "Fetching release manifest…"
if ! tp_fetch_channel_manifest; then
  tp_print_error "Failed to fetch release manifest"
  exit 1
fi
if [ -z "$HOST_URL" ]; then
  HOST_URL="$_manifest_host"
fi
if [ -n "$HOST_URL" ]; then
  case "$HOST_URL" in
    https://*) ;;
    *)
      tp_print_error "control plane URL must use https:// (got $HOST_URL)"
      exit 1
      ;;
  esac
fi
if [ -n "$MANIFEST_URL" ]; then
  tp_print_ok "Release manifest resolved (pinned to $MANIFEST_URL, arch ${_linux_arch:-unknown})"
else
  tp_print_ok "Release manifest resolved (channel ${TURBOPANEL_UPDATE_CHANNEL:-trunk}, arch ${_linux_arch:-unknown})"
fi
tp_print_step "  " "Binary (${_linux_arch:-unknown}): $_binary_artifact_url"
tp_print_step "  " "JS bundle (if needed): $_js_fallback_artifact_url"
tp_print_step "  " "Commit: ${_manifest_commit:-unknown}"
if [ "$INSTANCE_INSTALL" = true ]; then
  tp_print_step "  " "Control plane: this host (self-hosted instance install)"
else
  tp_print_step "  " "Control plane: $HOST_URL"
fi

mkdir -p "$CONFIG_DIR"
if [ "$INSTANCE_INSTALL" = true ]; then
  # No control plane to fetch a CA from — this host mints its own
  # (instance-certs, via the binary's generate-self-signed-cert verb).
  :
elif [ -n "$INSTANCE_CA" ]; then
  # Compare resolved paths, not raw strings: a symlink or path-variant (e.g. a
  # trailing slash or relative form) pointing at the canonical CA otherwise
  # slips past a string-only check and makes `install` fail with
  # "are the same file". Resolve both sides before deciding to copy.
  _ca_src_resolved="$(readlink -f "$INSTANCE_CA" 2>/dev/null || echo "$INSTANCE_CA")"
  _ca_dst_resolved="$(readlink -f "$CA_PATH" 2>/dev/null || echo "$CA_PATH")"
  if [ "$_ca_src_resolved" != "$_ca_dst_resolved" ]; then
    install -m 0640 "$INSTANCE_CA" "$CA_PATH"
  fi
else
  tp_print_step "▸" "Fetching instance CA…"
      _curl_base="$(tp_instance_bootstrap_curl)"
      _ca_tmp="$(mktemp)"
      _ca_http_code=""
      # shellcheck disable=SC2086
      _ca_http_code=$(tp_curl_http_code $_curl_base -o "$_ca_tmp" -w '%{http_code}' "${HOST_URL%/}/api/daemon/v1/instance/ca")
      case "$_ca_http_code" in
        200)
          tp_install_instance_ca "$_ca_tmp"
          ;;
        404)
          # Not a Platform CA leaf. A public upload or Let's Encrypt name uses
          # the system roots. A private upload is handled by the issuer fetch
          # below — do not announce system trust until that fetch also misses.
          rm -f "$CA_PATH"
          ;;
        000)
          if [ -f "$CA_PATH" ]; then
            _old_fp="$(tp_ca_fingerprint "$CA_PATH")"
            _ca_retry="$(mktemp)"
            # Unpinned fetch of the CA document only; acceptance is gated below.
            _ca_retry_code=$(tp_curl_http_code curl -sSLk -o "$_ca_retry" -w '%{http_code}' "${HOST_URL%/}/api/daemon/v1/instance/ca")
            if [ "$_ca_retry_code" = "200" ] && tp_ca_parses "$_ca_retry" && tp_ca_validates_leaf "$_ca_retry"; then
              tp_install_instance_ca "$_ca_retry"
            else
              _new_fp=""
              if [ -f "$_ca_retry" ]; then
                _new_fp="$(tp_ca_fingerprint "$_ca_retry")"
              fi
              tp_print_error "platform CA changed and could not be verified (existing ${_old_fp:-unknown}; fetched ${_new_fp:-unknown})"
              rm -f "$_ca_tmp" "$_ca_retry"
              exit 1
            fi
            rm -f "$_ca_retry"
          else
            tp_print_step "~" "Could not download instance CA (HTTP ${_ca_http_code}) — keeping existing CA if present"
          fi
          ;;
        *)
          tp_print_step "~" "Could not download instance CA (HTTP ${_ca_http_code}) — keeping existing CA if present"
          ;;
      esac
      rm -f "$_ca_tmp"
fi
if [ "$INSTANCE_INSTALL" != true ] && [ -n "$HOST_URL" ]; then
  tp_print_step "▸" "Fetching private uploaded issuer…"
  if ! tp_fetch_uploaded_trust; then
    exit 1
  fi
  if [ "$INSECURE_TLS" != true ] && [ ! -f "$CA_PATH" ] && [ ! -f "$UPLOADED_TRUST_PATH" ]; then
    tp_print_step "–" "No platform CA (public TLS — using system trust store)"
  fi
  if ! tp_bootstrap_trust_anchored; then
    tp_print_error "Private control-plane TLS has no trust anchor. The Platform CA does not validate this uploaded certificate. In Admin → Access, upload the leaf together with the private issuer that signed it. Bootstrap insecure TLS is not runtime trust."
    exit 1
  fi
fi

# Root-pinned update origin for tp-orchestrate (orchestration/scripts): the
# control plane this host enrols with, the overlay catalog when one is used,
# and the Platform CA file it trusts. Lives under the root-owned lib/ tree —
# never /etc/turbopanel, which the daemon account owns — so a panel-driven
# update can only ever re-run this installer against these same origins.
tp_write_update_origin_pin() {
  _pin_dir="$INSTALL_ROOT/lib"
  mkdir -p "$_pin_dir"
  _pin_tmp="$(mktemp)"
  {
    printf 'host=%s\n' "$HOST_URL"
    printf 'dl_base=%s\n' "$DL_BASE"
    if [ -f "$CA_PATH" ]; then
      printf 'instance_ca=%s\n' "$CA_PATH"
    else
      printf 'instance_ca=\n'
    fi
    if [ -f "$UPLOADED_TRUST_PATH" ]; then
      printf 'uploaded_trust=%s\n' "$UPLOADED_TRUST_PATH"
    else
      printf 'uploaded_trust=\n'
    fi
  } > "$_pin_tmp"
  install -m 0600 -o root -g root "$_pin_tmp" "$_pin_dir/update-origin"
  rm -f "$_pin_tmp"
}
if [ "$INSTANCE_INSTALL" != true ]; then
  tp_write_update_origin_pin
fi

# Production FHS layout — never point TURBOPANEL_DAEMON_ROOT at a source
# checkout or detectInstallMode() may classify this managed install as dev.
export TURBOPANEL_RUNTIMES_DIR="$RUNTIMES_DIR"
export TURBOPANEL_ORCHESTRATION_DIR="$ORCHESTRATION_DIR"
export TURBOPANEL_CONFIG_DIR="$CONFIG_DIR"
export TURBOPANEL_STATE_DIR="$STATE_DIR"
export TURBOPANEL_DAEMON_STATE_DIR="$STATE_DIR"
export TURBOPANEL_RUN_DIR="$RUN_DIR"

tp_print_step "▸" "Downloading daemon release…"
tp_stop_running_daemon_for_release_swap

if ! tp_install_verified_binary_and_orchestration; then
  tp_print_error "Failed to install daemon release artifacts"
  exit 1
fi

if [ ! -x "$(tp_daemon_binary_path)" ]; then
  tp_print_error "Daemon release missing native binary at $(tp_daemon_binary_path)"
  exit 1
fi
if [ ! -f "$ORCHESTRATION_DIR/ansible.cfg" ]; then
  tp_print_error "Daemon release missing orchestration tree at $ORCHESTRATION_DIR"
  exit 1
fi
tp_print_ok "Release installed (SHA-256 ok)"

tp_print_step "▸" "Probing native daemon binary…"
if tp_probe_native_daemon; then
  DAEMON_EXEC_MODE="$TP_EXEC_MODE_NATIVE"
  tp_print_ok "Native binary is executable — using turbopaneld"
  tp_remove_js_fallback_binaries
else
  DAEMON_EXEC_MODE="js"
  tp_print_step "~" "Native binary not executable on this host — using Deno JS runtime (turbopaneld.js)"
  tp_print_step "▸" "Downloading Deno JS runtime bundle…"
  if ! tp_install_verified_js_fallback; then
    tp_print_error "Failed to install Deno JS runtime bundle"
    exit 1
  fi
  if [ ! -f "$BIN_DIR/$(tp_daemon_js_fallback_name)" ]; then
    tp_print_error "Daemon release missing turbopaneld.js at $BIN_DIR/$(tp_daemon_js_fallback_name)"
    exit 1
  fi
  tp_print_ok "Deno JS runtime installed"
fi

if [ "$DAEMON_EXEC_MODE" = "js" ]; then
  tp_print_step "▸" "Installing Deno runtime…"
  if ! tp_install_deno_runtime; then
    tp_print_error "Failed to install Deno runtime"
    exit 1
  fi
  DENO_BIN="$RUNTIMES_DIR/deno/bin/deno"
  tp_print_ok "Deno ${TP_DENO_VERSION} ready"
else
  tp_print_step "–" "Skipping Deno runtime (native binary)"
fi

if [ "$DAEMON_EXEC_MODE" = "$TP_EXEC_MODE_NATIVE" ]; then
  "$(tp_daemon_binary_path)" bootstrap-orchestration
else
  HOME="$INSTALL_ROOT" "$DENO_BIN" run $TP_INSTALLER_DENO_PERMISSIONS "$(tp_daemon_js_fallback_path)" bootstrap-orchestration
  # Warm the JS module cache so first start is fast/offline.
  HOME="$INSTALL_ROOT" "$DENO_BIN" cache "$(tp_daemon_js_fallback_path)" >/dev/null 2>&1 || true
fi

if [ ! -f "$ORCHESTRATION_DIR/ansible.cfg" ]; then
  tp_print_error "Bootstrap did not leave orchestration/ansible.cfg in place"
  exit 1
fi

if [ "$INSTANCE_INSTALL" = true ]; then
  # The daemon package above is the co-located daemon's binary and the
  # orchestration tree instance-install.yml runs; the play configures and
  # starts turbopaneld itself (socket mode), so nothing daemon-specific
  # happens in this script for a control-plane install.
  if ! command -v zstd >/dev/null 2>&1; then
    tp_print_error "zstd is required to unpack the instance package (apt install zstd)"
    exit 1
  fi
  tp_run_instance_install
  exit $?
fi

VARS_FILE="$(mktemp)"
trap 'rm -f "$VARS_FILE"' EXIT
{
  printf 'turbopanel_instance_url: %s\n' "$HOST_URL"
  printf 'turbopanel_start: %s\n' "$([ "$NO_START" = true ] && echo false || echo true)"
  printf 'turbopanel_manage_service_state: %s\n' "$([ "$NO_START" = true ] && echo false || echo true)"
  printf 'turbopanel_restart_daemon: %s\n' "$([ "$NO_START" = true ] && echo false || echo true)"
  printf 'turbopanel_daemon_exec_mode: %s\n' "$DAEMON_EXEC_MODE"
  printf 'turbopanel_vendor_dir: %s\n' "$RUNTIMES_DIR"
  printf 'turbopanel_orchestration_dir: %s\n' "$ORCHESTRATION_DIR"
  printf 'turbopanel_config_dir: %s\n' "$CONFIG_DIR"
  printf 'turbopanel_daemon_state_dir: %s\n' "$STATE_DIR"
  printf 'turbopanel_daemon_env_file: %s\n' "$ENV_FILE"
  printf 'turbopanel_daemon_bin: %s\n' "$(tp_daemon_binary_path)"
  printf 'turbopanel_daemon_js: %s\n' "$(tp_daemon_js_fallback_path)"
  printf 'turbopanel_daemon_workdir: %s\n' "$INSTALL_ROOT"
  if [ "$DAEMON_EXEC_MODE" = "js" ]; then
    printf 'turbopanel_daemon_deno_bin: %s\n' "$DENO_BIN"
  fi
  printf 'turbopanel_service_name: %s\n' "turbopaneld"
  if [ -f "$CA_PATH" ]; then
    printf 'turbopanel_instance_ca: %s\n' "$CA_PATH"
    _ca_fp="$(openssl x509 -in "$CA_PATH" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' | tr 'A-F' 'a-f' | tr -d ':')"
    if [ -n "$_ca_fp" ]; then
      printf 'turbopanel_instance_ca_fingerprint: %s\n' "$_ca_fp"
    fi
  fi
  printf 'turbopanel_update_channel: %s\n' "${TURBOPANEL_UPDATE_CHANNEL:-trunk}"
  if [ -n "$DL_BASE" ]; then
    printf 'turbopanel_dl_base: %s\n' "$DL_BASE"
  fi
  if [ -n "$MANIFEST_URL" ]; then
    printf 'turbopanel_manifest_url: %s\n' "$MANIFEST_URL"
  fi
  if [ -n "$INSTANCE_MANIFEST_URL" ]; then
    printf 'turbopanel_instance_manifest_url: %s\n' "$INSTANCE_MANIFEST_URL"
  fi
  if [ -n "$UI_MANIFEST_URL" ]; then
    printf 'turbopanel_ui_manifest_url: %s\n' "$UI_MANIFEST_URL"
  fi
  if [ -n "$TUNNEL_TOKEN" ]; then
    printf 'turbopanel_tunnel_token: %s\n' "$TUNNEL_TOKEN"
  fi
} > "$VARS_FILE"

if [ "$DAEMON_EXEC_MODE" = "$TP_EXEC_MODE_NATIVE" ]; then
  if ! "$(tp_daemon_binary_path)" run-installer --vars-file "$VARS_FILE"; then
    rm -rf /tmp/turbopanel-ansible /root/.ansible
    exit 1
  fi
else
  if ! HOME="$INSTALL_ROOT" "$DENO_BIN" run $TP_INSTALLER_DENO_PERMISSIONS "$(tp_daemon_js_fallback_path)" run-installer --vars-file "$VARS_FILE"; then
    rm -rf /tmp/turbopanel-ansible /root/.ansible
    exit 1
  fi
fi
# Disposable ansible scratch (ANSIBLE_HOME); roles/collections already live under FHS.
rm -rf /tmp/turbopanel-ansible /root/.ansible
