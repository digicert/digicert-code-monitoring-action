#!/usr/bin/env bash
# Selects the Node.js that runs every step of this action and exports it as DC_NODE.
# A suitable Node.js already on PATH is used as is; otherwise a pinned, checksum-verified
# Node.js is installed privately, so the caller's PATH and Node.js are never changed.
set -euo pipefail

MIN_MAJOR=20
# Pinned release; the SHA-256 comes from https://nodejs.org/dist/v24.22.3/SHASUMS256.txt
NODE_VERSION="${DC_NODE_FALLBACK_VERSION:-24.22.3}"
NODE_SHA256="${DC_NODE_FALLBACK_SHA256:-061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2}"

: "${GITHUB_ENV:?GITHUB_ENV is not set}"

fail() {
  echo "$1" >&2
  exit 1
}

export_node() {
  echo "DC_NODE=$1" >> "$GITHUB_ENV"
  echo "Using Node.js $("$1" --version) at $1"
}

node_major() {
  local major
  major="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  case "$major" in
    ''|*[!0-9]*) major=0 ;;
  esac
  echo "$major"
}

if existing="$(command -v node 2>/dev/null)" && [ "$(node_major "$existing")" -ge "$MIN_MAJOR" ]; then
  export_node "$existing"
  exit 0
fi

echo "Node.js ${MIN_MAJOR} or newer was not found on PATH; installing Node.js ${NODE_VERSION} for this action only."

[ "$(uname -s)" = "Linux" ] || fail "Cannot install Node.js automatically on this OS. Install Node.js ${MIN_MAJOR} or newer (for example with actions/setup-node) before this action."
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "Cannot install Node.js automatically on this CPU architecture. Install Node.js ${MIN_MAJOR} or newer (for example with actions/setup-node) before this action." ;;
esac

tarball="node-v${NODE_VERSION}-linux-x64.tar.gz"
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/dc-node.XXXXXX")"
trap 'status=$?; [ "$status" -eq 0 ] || rm -rf "$work"' EXIT

curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 10 --max-time 300 \
  -o "$work/$tarball" "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}" \
  || fail "Failed to download Node.js ${NODE_VERSION}. Allow access to nodejs.org or install Node.js ${MIN_MAJOR} or newer before this action."

actual="$(sha256sum "$work/$tarball")"
actual="${actual%% *}"
if [ "$actual" != "$NODE_SHA256" ]; then
  fail "SECURITY ERROR: Node.js checksum mismatch.
Expected: ${NODE_SHA256}
Actual:   ${actual}"
fi

tar -xzf "$work/$tarball" -C "$work" --strip-components=2 "node-v${NODE_VERSION}-linux-x64/bin/node"
rm -f "$work/$tarball"
chmod +x "$work/node"

[ "$("$work/node" --version 2>/dev/null)" = "v${NODE_VERSION}" ] \
  || fail "The downloaded Node.js ${NODE_VERSION} cannot run here (is the runner temp directory mounted noexec?)."

export_node "$work/node"
