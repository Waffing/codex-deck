#!/usr/bin/env bash
set -Eeuo pipefail
# Run on a disposable CI host. Only test-owned temporary files are used.
root=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
# shellcheck source=deploy/install.sh
source "$root/deploy/install.sh"
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
chmod 0755 "$fixture"
install -d -o nobody -m 0750 "$fixture/build"
cat > "$fixture/corepack" <<'BUILD'
#!/bin/sh
set -eu
[ "$(id -u)" != 0 ]
printf '%s %s\n' "$*" "$(id -u)" >> record
BUILD
chmod 0755 "$fixture/corepack"
native_build nobody "$fixture/build" "$fixture/build" "$fixture/corepack"
grep -q '^pnpm install --frozen-lockfile ' "$fixture/build/record"
grep -q '^pnpm build ' "$fixture/build/record"
# Model a failed candidate health check and assert the installer selects the live image ID.
INSTALL_DIR="$fixture/install"; mkdir -p "$INSTALL_DIR"
ACTION=upgrade; RELEASE=v0.1.9; IMAGE='codexdeck:test'; EXPLICIT_IMAGE="$IMAGE"; PORT=3251; STORED_PORT=3251
printf "CODEXDECK_IMAGE='codexdeck:previous'\nCODEXDECK_BIND_PORT='3251'\n" > "$INSTALL_DIR/.env"
printf 'version: fixture\n' > "$INSTALL_DIR/docker-compose.yml"
ensure_docker() { :; }
fetch_deploy_file() { printf 'candidate fixture\n' > "$2"; }
compose() { printf '%s\n' "${CODEXDECK_IMAGE:-candidate} $*" >> "$fixture/commands"; if [[ "$*" == 'ps -q codexdeck' ]]; then printf 'running\n'; fi; }
docker() { if [[ "$1" == 'inspect' ]]; then printf 'sha256:abc123\n'; fi; }
wait_for_health() { grep -q -- 'rollback-abc123' "$INSTALL_DIR/.env"; }
set +e
( set -e; docker_install )
result=$?
set -e
[[ "$result" != 0 ]]
grep -q 'rollback-abc123 up -d --pull never' "$fixture/commands"
grep -q 'rollback-abc123' "$INSTALL_DIR/.env"
