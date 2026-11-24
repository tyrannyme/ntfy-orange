#!/usr/bin/env bash
# Runs the official ntfy server locally as a black-box reference for test/e2e/compat.test.ts,
# configured with the same users, tokens and ACL as the e2e tests. Downloads the release
# binary from GitHub on first use.
#
#   scripts/reference-server.sh            # serves http://127.0.0.1:2586
#   NTFY_REF_URL=http://127.0.0.1:2586 NTFY_BIN=~/.cache/ntfy-orange-ref/ntfy bun test test/e2e
set -euo pipefail

VERSION="${NTFY_VERSION:-2.38.1}"
PORT="${PORT:-2586}"
DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ntfy-orange-ref"
BIN="$DIR/ntfy"
mkdir -p "$DIR"

if [[ ! -x "$BIN" ]] || ! "$BIN" --help | grep -q "$VERSION"; then
  arch=$(uname -m); case "$arch" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; esac
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/binwiederhier/ntfy/releases/download/v${VERSION}/ntfy_${VERSION}_${os}_${arch}.tar.gz" | tar xz -C "$tmp"
  mv "$tmp/ntfy_${VERSION}_${os}_${arch}/ntfy" "$BIN"
  rm -rf "$tmp"
fi

STATE=$(mktemp -d)
trap 'rm -rf "$STATE"' EXIT
hash() { printf '%s\n%s\n' "$1" "$1" | "$BIN" user hash 2>/dev/null | tail -1; }

cat > "$STATE/server.yml" <<YAML
base-url: "http://127.0.0.1:${PORT}"
listen-http: "127.0.0.1:${PORT}"
cache-file: "${STATE}/cache.db"
auth-file: "${STATE}/user.db"
auth-default-access: "deny-all"
attachment-cache-dir: "${STATE}/attachments"
visitor-request-limit-exempt-hosts: "127.0.0.1"
visitor-topic-creation-limit-burst: 100000
visitor-topic-creation-limit-replenish: "1s"
auth-users:
  - "phil:$(hash phil-password):admin"
  - "ben:$(hash ben-password):user"
auth-tokens:
  - "phil:tk_3gd7d2yftt4b8ixyfe9mnmro88o76"
auth-access:
  - "ben:bentopic:rw"
  - "ben:readonly:ro"
  - "*:public:rw"
  - "*:up*:wo"
YAML

echo "ntfy v${VERSION} reference server on http://127.0.0.1:${PORT} (binary: $BIN)"
exec "$BIN" serve --config "$STATE/server.yml"
