#!/bin/sh
# Forge CLI installer — downloads the standalone `forge` binary for your
# platform from the latest cli-v* GitHub release and puts it on your PATH.
# No Node required.
#
#   curl -fsSL https://raw.githubusercontent.com/Codename-11/Forge/main/tools/forge-cli/install.sh | bash
#
# Env: FORGE_INSTALL_DIR (default ~/.local/bin)
set -eu

REPO="Codename-11/Forge"
BIN_NAME="forge"
INSTALL_DIR="${FORGE_INSTALL_DIR:-$HOME/.local/bin}"

err() { echo "forge-install: $*" >&2; }

# --- detect platform ---
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
  linux) os=linux ;;
  darwin) os=darwin ;;
  *) err "unsupported OS '$os' — use the Windows installer or grab a binary from the release"; exit 1 ;;
esac
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) err "unsupported arch '$arch'"; exit 1 ;;
esac
asset="${BIN_NAME}-${os}-${arch}"

command -v curl >/dev/null 2>&1 || { err "curl is required"; exit 1; }

# --- resolve latest cli-v* release (kept separate from app 'latest') ---
err "resolving latest CLI release…"
tag=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases" \
  | grep '"tag_name"' | grep '"cli-v' | head -1 \
  | sed -E 's/.*"(cli-v[^"]+)".*/\1/')
[ -n "${tag:-}" ] || { err "could not find a cli-v* release"; exit 1; }
base="https://github.com/${REPO}/releases/download/${tag}"

# --- download ---
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
err "downloading ${asset} (${tag})…"
curl -fsSL "${base}/${asset}" -o "$tmp" || { err "download failed: ${base}/${asset}"; exit 1; }

# --- verify checksum (REQUIRED — fail closed: abort if we can't verify) ---
sums=$(curl -fsSL "${base}/SHA256SUMS") \
  || { err "could not fetch SHA256SUMS — refusing to install an unverified binary"; exit 1; }
want=$(echo "$sums" | grep " ${asset}\$" | awk '{print $1}')
[ -n "$want" ] || { err "no published checksum for ${asset} — aborting"; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$tmp" | awk '{print $1}')
else err "need sha256sum or shasum to verify the download — aborting"; exit 1; fi
[ "$got" = "$want" ] || { err "checksum mismatch for ${asset} — aborting"; exit 1; }

# --- install ---
mkdir -p "$INSTALL_DIR"
chmod +x "$tmp"
mv "$tmp" "$INSTALL_DIR/$BIN_NAME"
trap - EXIT
[ "$os" = "darwin" ] && xattr -d com.apple.quarantine "$INSTALL_DIR/$BIN_NAME" 2>/dev/null || true
err "installed ${tag} → ${INSTALL_DIR}/${BIN_NAME}"

# --- PATH hint + next steps ---
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) err "note: ${INSTALL_DIR} is not on your PATH — add:  export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac
echo "" >&2
err "next:  forge login --url <your Forge URL> --workspace <slug> --token forge_sk_..."
