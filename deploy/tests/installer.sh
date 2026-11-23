#!/usr/bin/env bash
set -Eeuo pipefail
# Run on a disposable CI host. Only test-owned temporary files are used.
root=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
# shellcheck source=deploy/install.sh
source "$root/deploy/install.sh"
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* ]] ||
    { [[ "$(id -u)" != 0 ]] && ! command -v sudo >/dev/null 2>&1; }; then
  as_root() { "$@"; }
fi
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
chmod 0755 "$fixture"
if command -v runuser >/dev/null 2>&1 && id nobody >/dev/null 2>&1; then
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
else
  printf 'Skipping native-build identity test because runuser/nobody is unavailable.\n'
fi
# Native systemd resource limits are validated before installation mutates the host.
default_resource_properties="$( (unset CODEXDECK_NATIVE_MEMORY_MAX CODEXDECK_NATIVE_CPU_QUOTA CODEXDECK_NATIVE_TASKS_MAX; native_resource_properties) )"
[[ "$default_resource_properties" == $'MemoryMax=512M\nCPUQuota=50%\nTasksMax=192' ]]
grep -Fq '$resource_properties' "$root/deploy/install.sh"
printf '[Service]\n%s\n' "$default_resource_properties" > "$fixture/codexdeck.service"
grep -Fqx 'MemoryMax=512M' "$fixture/codexdeck.service"
grep -Fqx 'CPUQuota=50%' "$fixture/codexdeck.service"
grep -Fqx 'TasksMax=192' "$fixture/codexdeck.service"

assert_resource_output() {
  local variable="$1" value="$2" expected="$3" actual
  actual="$( (unset CODEXDECK_NATIVE_MEMORY_MAX CODEXDECK_NATIVE_CPU_QUOTA CODEXDECK_NATIVE_TASKS_MAX; export "$variable=$value"; native_resource_properties) )"
  grep -Fqx "$expected" <<< "$actual" || { printf 'Expected %s for %s=%s\n' "$expected" "$variable" "$value" >&2; exit 1; }
}
assert_resource_rejected() {
  local variable="$1" value="$2"
  if ( unset CODEXDECK_NATIVE_MEMORY_MAX CODEXDECK_NATIVE_CPU_QUOTA CODEXDECK_NATIVE_TASKS_MAX; export "$variable=$value"; native_resource_properties >/dev/null 2>&1 ); then
    printf 'Accepted invalid resource setting %s=%s\n' "$variable" "$value" >&2
    exit 1
  fi
}
assert_resource_output CODEXDECK_NATIVE_MEMORY_MAX 512M 'MemoryMax=512M'
assert_resource_output CODEXDECK_NATIVE_MEMORY_MAX 64G 'MemoryMax=64G'
assert_resource_rejected CODEXDECK_NATIVE_MEMORY_MAX 511M
assert_resource_rejected CODEXDECK_NATIVE_MEMORY_MAX 65G
assert_resource_rejected CODEXDECK_NATIVE_MEMORY_MAX '2G;ExecStart=/bin/sh'
assert_resource_output CODEXDECK_NATIVE_CPU_QUOTA 10% 'CPUQuota=10%'
assert_resource_output CODEXDECK_NATIVE_CPU_QUOTA 6400% 'CPUQuota=6400%'
assert_resource_rejected CODEXDECK_NATIVE_CPU_QUOTA 9%
assert_resource_rejected CODEXDECK_NATIVE_CPU_QUOTA 6401%
assert_resource_rejected CODEXDECK_NATIVE_CPU_QUOTA '200%;ExecStart=/bin/sh'
assert_resource_output CODEXDECK_NATIVE_TASKS_MAX 64 'TasksMax=64'
assert_resource_output CODEXDECK_NATIVE_TASKS_MAX 65536 'TasksMax=65536'
assert_resource_rejected CODEXDECK_NATIVE_TASKS_MAX 63
assert_resource_rejected CODEXDECK_NATIVE_TASKS_MAX 65537
assert_resource_rejected CODEXDECK_NATIVE_TASKS_MAX '1024;ExecStart=/bin/sh'

# A clean host receives every runtime tool needed by its selected mode.
docker_packages="$(host_packages debian docker)"
for package in ca-certificates curl git jq nginx openssl python3 python3-venv ripgrep iproute2; do
  grep -Fxq "$package" <<< "$docker_packages"
done
native_packages="$(host_packages rpm native)"
for package in nginx python3 gcc-c++ make bubblewrap; do
  grep -Fxq "$package" <<< "$native_packages"
done
(
  package_commands="$fixture/package-commands"
  command() {
    if [[ "$1" == -v && ( "$2" == apt-get || "$2" == systemctl ) ]]; then
      printf '/usr/bin/%s\n' "$2"
      return 0
    fi
    builtin command "$@"
  }
  system_package_installed() { return 1; }
  as_root() {
    printf '%s\n' "$*" >> "$package_commands"
    [[ "$*" != 'systemctl is-enabled nginx.service' ]]
  }
  install_debian_packages() { printf 'install %s\n' "$*" >> "$package_commands"; }
  ensure_host_packages docker
  grep -Eq '^install .*nginx' "$package_commands"
  grep -Fqx 'systemctl mask --runtime nginx.service' "$package_commands"
  grep -Fqx 'systemctl unmask --runtime nginx.service' "$package_commands"
  grep -Fqx 'systemctl disable nginx.service' "$package_commands"
  ! grep -Eq 'systemctl (enable|start|restart) nginx' "$package_commands"
)
node_version_supported v22.13.0
node_version_supported v23.0.0
if node_version_supported v22.12.9; then
  printf 'Accepted an unsupported Node.js version.\n' >&2
  exit 1
fi

# A fresh native host installs the pinned Codex CLI when it is absent.
(
  INSTALL_DIR="$fixture/native-install"
  mkdir -p "$INSTALL_DIR" "$fixture/native-bin"
  PATH="$fixture/native-bin:$PATH"
  export PATH
  command() {
    if [[ "$1" == -v && "$2" == codex ]]; then return 1; fi
    builtin command "$@"
  }
  as_root() {
    if [[ "$1" == env ]]; then
      shift
      while [[ "$1" == *=* ]]; do export "$1"; shift; done
      "$@"
    else
      "$@"
    fi
  }
  runuser() {
    [[ "$1" == -u && "$3" == -- ]] || return 1
    shift 3
    "$@"
  }
  fetch_deploy_file() { printf 'ARG CODEX_VERSION=0.123.0\n' > "$2"; }
  cat > "$fixture/native-bin/npm" <<'NPM'
#!/usr/bin/env bash
set -e
[[ "$*" == 'install --global --omit=dev @openai/codex@0.123.0' ]]
mkdir -p "$NPM_CONFIG_PREFIX/bin"
printf '#!/bin/sh\nexit 0\n' > "$NPM_CONFIG_PREFIX/bin/codex"
chmod 0755 "$NPM_CONFIG_PREFIX/bin/codex"
NPM
  chmod 0755 "$fixture/native-bin/npm"
  ensure_native_codex codexdeck
  [[ "$NATIVE_CODEX_BIN" == "$INSTALL_DIR/toolchain/bin/codex" ]]
  [[ -x "$NATIVE_CODEX_BIN" ]]
)

PUBLIC_PORT=18443; ENTRY_PATH=/a1b2c3d4
[[ "$(public_entry_url 203.0.113.10)" == "https://203.0.113.10:18443/a1b2c3d4" ]]
[[ "$(public_entry_url 2001:db8::10)" == "https://[2001:db8::10]:18443/a1b2c3d4" ]]
(
  PUBLIC=true; PUBLIC_PORT=18443; ENTRY_PATH=/a1b2c3d4
  curl() {
    local url
    for url; do :; done
    [[ "$url" == "https://127.0.0.1:18443/a1b2c3d4" ]]
    printf '302'
  }
  wait_for_public_entry
)
(
  PUBLIC=true; DOMAIN=""; PORT=3000; PUBLIC_PORT=18443; ENTRY_PATH=/a1b2c3d4
  MODE=docker; DOCKER_SUDO=0; INSTALL_DIR=/opt/codexdeck
  detect_public_ipv4() { printf '203.0.113.10'; }
  output="$(print_success)"
  grep -Fq 'HTTPS entry:    https://203.0.113.10:18443/a1b2c3d4' <<<"$output"
  grep -Fq 'Required ingress: TCP 18443 in the cloud security group' <<<"$output"
)

# A healthy HTTP endpoint with a broken executor must restore the live image.
INSTALL_DIR="$fixture/install"; mkdir -p "$INSTALL_DIR"
ACTION=upgrade; RELEASE=v0.1.9; IMAGE='codexdeck:test'; EXPLICIT_IMAGE="$IMAGE"; PORT=3251; STORED_PORT=3251
printf "CODEXDECK_IMAGE='codexdeck:previous'\nCODEXDECK_BIND_PORT='3251'\n" > "$INSTALL_DIR/.env"
printf 'version: fixture\n' > "$INSTALL_DIR/docker-compose.yml"
ensure_docker() { :; }
ensure_host_packages() { :; }
fetch_deploy_file() { printf 'candidate fixture\n' > "$2"; }
compose() {
  printf '%s\n' "${CODEXDECK_IMAGE:-candidate} $*" >> "$fixture/commands"
  if [[ "$*" == 'ps -q codexdeck' ]]; then printf 'running\n'; fi
  [[ "$*" != *require-executor* ]]
}
docker() { if [[ "$1" == 'inspect' ]]; then printf 'sha256:abc123\n'; fi; }
wait_for_health() { return 0; }
set +e
( set -e; docker_install )
result=$?
set -e
[[ "$result" != 0 ]]
grep -q 'rollback-abc123 up -d --pull never' "$fixture/commands"
grep -q 'rollback-abc123' "$INSTALL_DIR/.env"
[[ "$(grep -c require-executor "$fixture/commands")" == 1 ]]

# A first install pairs the control image with its executor and waits for both checks.
(
  ACTION=install; EXISTING_INSTALL=0; EXEC_IMAGE=""; INSTALL_DIR="$fixture/clean"; WORKSPACES=""
  mkdir "$INSTALL_DIR"
  prompt_value() { fail "Unexpected executor image prompt"; }
  compose() { printf '%s\n' "$*" >> "$fixture/clean-commands"; }
  docker_install
  [[ "$(native_setting "$INSTALL_DIR/.env" CODEXDECK_EXEC_IMAGE)" == "$IMAGE" ]]
  grep -q require-executor "$fixture/clean-commands"
)

# Noninteractive first installs choose loopback by default and a gated TLS entry on request.
(
  MODE=docker; PUBLIC=""; ENTRY_PATH=""; PUBLIC_PORT=""; DOMAIN=""; DOMAIN_SET=0
  YES=1; PORT=3000; PORT_SET=0; EXISTING_INSTALL=0; ACTION=install
  free_high_port() { printf '18001'; }
  port_available() { return 0; }
  choose_install_options
  [[ "$PUBLIC" == false && -z "$ENTRY_PATH" && "$MANAGED_CADDY" == 0 ]]
  PUBLIC=true; choose_install_options
  [[ "$ENTRY_PATH" =~ ^/[[:xdigit:]]{8}$ && "$PUBLIC_PORT" -ge 18000 && "$PUBLIC_PORT" -le 39999 ]]
  [[ "$PORT" != "$PUBLIC_PORT" ]]
  port_available() { [[ "$1" != 80 && "$1" != 443 ]]; }
  DOMAIN=panel.example.test; DOMAIN_SET=1; choose_install_options
  [[ "$MANAGED_CADDY" == 0 ]]
  if [[ "$(uname -s)" == Linux ]]; then
    mkdir "$fixture/tls"; panel_cert "$fixture/tls" "$(id -u)" "$(id -g)"
    openssl x509 -in "$fixture/tls/panel-tls.crt" -checkend 86400 -noout
    [[ "$(stat -c '%a' "$fixture/tls/panel-tls.key")" == 600 ]]
  else
    printf 'Skipping Linux TLS file-permission test on %s.\n' "$(uname -s)"
  fi
)
