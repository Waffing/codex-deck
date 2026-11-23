#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -eq 0 ]; then
  DEFAULT_DIR="/opt/codexdeck"
else
  DEFAULT_DIR="${HOME:-/tmp}"/codexdeck
fi
REPOSITORY="${CODEXDECK_REPOSITORY:-}"
IMAGE="${CODEXDECK_IMAGE:-}"
RELEASE="${CODEXDECK_VERSION:-}"
EXPLICIT_IMAGE="$IMAGE"
EXEC_IMAGE="${CODEXDECK_EXEC_IMAGE:-${CODEXDECK_EXECUTOR_IMAGE:-}}"
INSTALL_DIR=""
WORKSPACES=""
DOMAIN=""
PORT="3000"
STORED_PORT=""
MODE="docker"
ACTION="install"
YES=0
WITH_PLAYWRIGHT=0
PORT_SET=0
WORKSPACES_SET=0
DOMAIN_SET=0
DIR_SET=0
PLAYWRIGHT_SET=0
UPGRADE_SET=0
UNINSTALL_SET=0
EXISTING_INSTALL=0
SOURCE_DIR=""
DOCKER_SUDO=0
PUBLIC=""
ACCESS_EXPLICIT=0
ENTRY_PATH=""
PUBLIC_PORT=""
MANAGED_CADDY=0
NATIVE_CODEX_BIN=""

usage() {
  cat <<'USAGE'
CodexDeck installer

Usage:
  install.sh [--native] [--upgrade] [--uninstall] [--yes]
             [--port PORT] [--workspaces PATH] [--domain DOMAIN]
             [--public | --local-only] [--with-playwright] [--dir PATH] [--version vX.Y.Z]

Environment overrides:
  CODEXDECK_REPOSITORY=Waffing/codex-deck
  CODEXDECK_VERSION=v0.1.0
  CODEXDECK_NATIVE_MEMORY_MAX=512M (512M..64G)
  CODEXDECK_NATIVE_CPU_QUOTA=50% (10%..6400%)
  CODEXDECK_NATIVE_TASKS_MAX=192 (64..65536)

Install directory defaults to /opt/codexdeck for root and $HOME/codexdeck otherwise.
Use --native for a systemd installation on the host. --yes keeps data on uninstall.
USAGE
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || fail "This operation requires root or sudo."
    sudo "$@"
  fi
}

prompt_value() {
  local prompt="$1" default="$2" value=""
  if [ "$YES" -eq 1 ] || [ ! -r /dev/tty ]; then
    REPLY="$default"
    return
  fi
  printf '%s [%s] ' "$prompt" "$default" >/dev/tty
  IFS= read -r value </dev/tty || value=""
  REPLY="${value:-$default}"
}

script_repository() {
  local origin=""
  if [ -n "$REPOSITORY" ]; then
    printf '%s' "$REPOSITORY"
    return
  fi
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    local script_dir
    script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
    if git -C "$script_dir" rev-parse --show-toplevel >/dev/null 2>&1; then
      origin="$(git -C "$script_dir" config --get remote.origin.url || true)"
    fi
  fi
  if [[ "$origin" =~ github\.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]]; then
    printf '%s/%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  else
    printf '%s' "Waffing/codex-deck"
  fi
}

discover_local_source() {
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    local candidate
    candidate="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
    if [ -f "$candidate/pnpm-workspace.yaml" ] && [ -d "$candidate/apps/server/src" ]; then
      SOURCE_DIR="$candidate"
    fi
  fi
}

fetch_deploy_file() {
  local name="$1" destination="$2" downloaded
  if [ -n "$SOURCE_DIR" ] && [ "$(git -C "$SOURCE_DIR" describe --tags --exact-match 2>/dev/null || true)" = "$RELEASE" ] && git -C "$SOURCE_DIR" diff --quiet HEAD -- "deploy/$name" && [ -f "$SOURCE_DIR/deploy/$name" ]; then
    install -m 0644 "$SOURCE_DIR/deploy/$name" "$destination"
    return
  fi
  local repo
  repo="$(script_repository)"
  downloaded="$(mktemp "$destination.XXXXXX")"
  if ! curl -fsSL "https://raw.githubusercontent.com/$repo/$RELEASE/deploy/$name" -o "$downloaded"; then
    rm -f -- "$downloaded"
    fail "Could not download deploy/$name from $repo. Verify CODEXDECK_REPOSITORY."
  fi
  chmod 0644 "$downloaded"
  mv -f -- "$downloaded" "$destination"
}

valid_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]
}

port_available() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn | awk -v port=":$port" '$4 ~ (port "$") { found=1 } END { exit found+0 }'
    return
  fi
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import socket' >/dev/null 2>&1; then
    python3 - "$port" <<'PY'
import socket, sys
sock = socket.socket()
sock.settimeout(0.5)
try:
    sys.exit(1 if sock.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 0)
finally:
    sock.close()
PY
    return
  fi
  if (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1; then return 1; fi
  return 0
}

check_port() {
  valid_port "$PORT" || fail "Port must be between 1024 and 65535."
  if port_available "$PORT"; then return 0; fi
  if [ "$EXISTING_INSTALL" -eq 1 ] && [ "$PORT" = "$STORED_PORT" ]; then
    if [[ "$MODE" == docker ]] && [[ -n "$(compose ps --status running -q codexdeck)" ]]; then return 0; fi
    if [[ "$MODE" == native ]] && systemctl is-active --quiet codexdeck; then return 0; fi
  fi
  fail "Port $PORT is already accepting local connections. Choose another port."
}

canonical_directory() {
  local requested="$1"
  mkdir -p -- "$requested"
  (cd -- "$requested" && pwd -P)
}

validate_domain() {
  [ -z "$DOMAIN" ] && return 0
  [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] ||
    fail "Domain must be a hostname without a scheme, path, or port."
  [[ "$DOMAIN" == *.* && "$DOMAIN" != *..* ]] || fail "Enter a fully qualified domain name."
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --native) MODE="native"; shift ;;
      --public|--local-only)
        [ -z "$PUBLIC" ] || fail "Choose one access mode."
        if [[ "$1" == --public ]]; then PUBLIC=true; else PUBLIC=false; fi
        ACCESS_EXPLICIT=1
        shift ;;
      --upgrade) ACTION="upgrade"; UPGRADE_SET=1; shift ;;
      --uninstall) ACTION="uninstall"; UNINSTALL_SET=1; shift ;;
      --yes|-y) YES=1; shift ;;
      --with-playwright) WITH_PLAYWRIGHT=1; PLAYWRIGHT_SET=1; shift ;;
      --version) [ "$#" -ge 2 ] || fail "--version needs a release tag"; RELEASE="$2"; shift 2 ;;
      --port)
        [ "$#" -ge 2 ] || fail "--port requires a value."
        PORT="$2"; PORT_SET=1; shift 2 ;;
      --workspaces)
        [ "$#" -ge 2 ] || fail "--workspaces requires a path."
        WORKSPACES="$2"; WORKSPACES_SET=1; shift 2 ;;
      --domain)
        [ "$#" -ge 2 ] || fail "--domain requires a value."
        DOMAIN="$2"; DOMAIN_SET=1; shift 2 ;;
      --dir)
        [ "$#" -ge 2 ] || fail "--dir requires a path."
        INSTALL_DIR="$2"; DIR_SET=1; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) fail "Unknown option: $1. See --help." ;;
    esac
  done
  if [ "$UPGRADE_SET" -eq 1 ] && [ "$UNINSTALL_SET" -eq 1 ]; then
    fail "--upgrade and --uninstall cannot be combined."
  fi
  if [ -n "$REPOSITORY" ] && ! [[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    fail "CODEXDECK_REPOSITORY must be a GitHub repository slug."
  fi
}

load_existing_config() {
  local file="$INSTALL_DIR/.env"
  [ -f "$file" ] || return 0
  read_access_settings "$file"
  STORED_PORT="$(sed -n 's/^CODEXDECK_BIND_PORT=//p' "$file" | head -n 1 | tr -d "\"'")"
  if [ -z "$STORED_PORT" ]; then
    STORED_PORT="$(sed -n 's/^CODEXDECK_PORT=//p' "$file" | head -n 1 | tr -d '"')"
    [ "$STORED_PORT" != "3000" ] || STORED_PORT=""
  fi
  if [ "$PORT_SET" -eq 0 ]; then
    PORT="${STORED_PORT:-3000}"
  fi
  if [ "$WORKSPACES_SET" -eq 0 ]; then
    WORKSPACES="$(sed -n 's/^CODEXDECK_WORKSPACES_HOST=//p' "$file" | head -n 1 | tr -d '"' | tr -d "'")"
    if [ -z "$WORKSPACES" ]; then
      WORKSPACES="$(sed -n 's/^CODEXDECK_WORKSPACES=//p' "$file" | head -n 1 | tr -d '"' | tr -d "'")"
    fi
  fi
  if [ "$DOMAIN_SET" -eq 0 ]; then
    DOMAIN="$(sed -n 's/^CODEXDECK_DOMAIN=//p' "$file" | head -n 1 | tr -d '"' | tr -d "'")"
  fi
  if [ "$PLAYWRIGHT_SET" -eq 0 ] && grep -q -- '-playwright' "$file"; then WITH_PLAYWRIGHT=1; fi
  # Existing explicit third-party images survive a regular reinstall.
  if [ -z "$IMAGE" ] && [ "$ACTION" != "upgrade" ]; then
    IMAGE="$(sed -n 's/^CODEXDECK_IMAGE=//p' "$file" | head -n 1 | tr -d "\"'")"
  fi
}

load_native_config() {
  local file="/etc/codexdeck/codexdeck.env"
  as_root test -f "$file" || return 0
  read_access_settings "$file"
  if [ "$DOMAIN_SET" -eq 0 ]; then DOMAIN="$(native_setting "$file" CODEXDECK_DOMAIN)"; fi
  STORED_PORT="$(native_setting "$file" CODEXDECK_PORT)"
  if [ "$PORT_SET" -eq 0 ]; then
    PORT="${STORED_PORT:-3000}"
  fi
  if [ "$WORKSPACES_SET" -eq 0 ]; then
    WORKSPACES="$(native_setting "$file" CODEXDECK_WORKSPACES)"
  fi
}

native_setting() {
  local value
  value="$(as_root sed -n "s/^$2=//p" "$1" | head -n 1)"
  if [[ "$value" == \"*\" ]]; then
    value="${value:1:${#value}-2}"
    value="${value//\\\"/\"}"
    value="${value//\\\\/\\}"
  fi
  if [[ "$value" == \'*\' ]]; then value="${value:1:${#value}-2}"; fi
  printf '%s' "$value"
}

read_access_settings() {
  local file="$1"
  if [ -z "$PUBLIC" ]; then PUBLIC="$(native_setting "$file" CODEXDECK_PUBLIC_ENABLED)"; fi
  ENTRY_PATH="$(native_setting "$file" CODEXDECK_ENTRY_PATH)"
  PUBLIC_PORT="$(native_setting "$file" CODEXDECK_PUBLIC_PORT)"
  MANAGED_CADDY="$(native_setting "$file" CODEXDECK_MANAGED_CADDY)"
  # Releases before V1.2 enabled the optional Caddy profile whenever a domain was set.
  if [[ -z "$MANAGED_CADDY" && "$MODE" == docker && -f "$INSTALL_DIR/Caddyfile" && -n "$(native_setting "$file" CODEXDECK_DOMAIN)" ]]; then
    MANAGED_CADDY=1
    [[ -n "$PUBLIC" ]] || PUBLIC=true
  fi
  MANAGED_CADDY="${MANAGED_CADDY:-0}"
}

free_high_port() {
  local candidate attempt
  for ((attempt=0;attempt<80;attempt++)); do
    candidate=$((18000 + 16#$(openssl rand -hex 2) % 22000))
    if [[ "$candidate" != "$PORT" && "$candidate" != "$PUBLIC_PORT" ]] && port_available "$candidate"; then printf '%s' "$candidate"; return; fi
  done
  fail "No free panel port found."
}

panel_cert() {
  local directory="$1" owner="$2" group="$3" ip san temp
  as_root test ! -L "$directory" || fail "TLS directory must not be a symlink."
  if as_root test -e "$directory/panel-tls.key" || as_root test -e "$directory/panel-tls.crt"; then
    if ! as_root test -f "$directory/panel-tls.key" || as_root test -L "$directory/panel-tls.key" ||
      ! as_root test -f "$directory/panel-tls.crt" || as_root test -L "$directory/panel-tls.crt"; then fail "Invalid panel TLS key pair."; fi
    return
  fi
  san="IP:127.0.0.1,DNS:localhost"
  for ip in $(hostname -I 2>/dev/null || true); do
    if [[ "$ip" =~ ^[0-9.]+$ || "$ip" =~ ^[a-fA-F0-9:]+$ ]]; then san+=",IP:$ip"; fi
  done
  if [[ -n "$DOMAIN" ]]; then san+=",DNS:$DOMAIN"; fi
  temp="$(mktemp -d)"
  if ! openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 -subj '/CN=CodexDeck' \
      -addext "subjectAltName=$san" -keyout "$temp/key" -out "$temp/crt" 2>/dev/null; then
    rm -f -- "$temp/key" "$temp/crt"; rmdir "$temp"; fail "Could not create panel certificate."
  fi
  as_root install -o "$owner" -g "$group" -m 0600 "$temp/key" "$directory/panel-tls.key"
  as_root install -o "$owner" -g "$group" -m 0644 "$temp/crt" "$directory/panel-tls.crt"
  rm -f -- "$temp/key" "$temp/crt"; rmdir "$temp"
}

install_environment_file() {
  local file="$INSTALL_DIR/.env"
  if [ -f "$file" ]; then
    update_env_key "$file" CODEXDECK_BIND_PORT "$PORT"
    update_env_key "$file" CODEXDECK_PORT "3000"
    update_env_key "$file" CODEXDECK_HOST "0.0.0.0"
    update_env_key "$file" CODEXDECK_WORKSPACES_HOST "$WORKSPACES"
    update_env_key "$file" CODEXDECK_DATA_DIR "/data"
    update_env_key "$file" CODEXDECK_DEPLOYMENT_NETWORK "codexdeck-net"
    update_env_key "$file" CODEXDECK_DOMAIN "$DOMAIN"
    update_env_key "$file" CODEXDECK_IMAGE "$IMAGE"
    update_env_key "$file" CODEXDECK_EXEC_IMAGE "$EXEC_IMAGE"
    update_env_key "$file" CODEXDECK_PUBLIC_ENABLED "${PUBLIC:-false}"
    update_env_key "$file" CODEXDECK_ENTRY_PATH "$ENTRY_PATH"
    update_env_key "$file" CODEXDECK_PUBLIC_PORT "$PUBLIC_PORT"
    update_env_key "$file" CODEXDECK_MANAGED_CADDY "$MANAGED_CADDY"
    chmod 0600 "$file"
    return
  fi

  local master_key uid gid
  master_key="$(openssl rand -hex 32)" || fail "Could not generate CODEXDECK_MASTER_KEY. Install openssl."
  uid="${INSTALL_UID:-1000}"
  gid="${INSTALL_GID:-1000}"
  umask 077
  cat >"$file" <<EOF
CODEXDECK_PORT=3000
CODEXDECK_BIND_PORT=$PORT
CODEXDECK_HOST=0.0.0.0
CODEXDECK_MASTER_KEY=$master_key
CODEXDECK_IMAGE=$IMAGE
CODEXDECK_EXEC_IMAGE=$EXEC_IMAGE
CODEXDECK_DATA_DIR=/data
CODEXDECK_WORKSPACES_HOST='$WORKSPACES'
CODEXDECK_DEPLOYMENT_NETWORK=codexdeck-net
CODEXDECK_DOMAIN=$DOMAIN
CODEXDECK_PUBLIC_ENABLED=${PUBLIC:-false}
CODEXDECK_ENTRY_PATH=$ENTRY_PATH
CODEXDECK_PUBLIC_PORT=$PUBLIC_PORT
CODEXDECK_MANAGED_CADDY=$MANAGED_CADDY
PUID=$uid
PGID=$gid
EOF
  chmod 0600 "$file"
}

update_env_key() {
  local file="$1" key="$2" value="$3" temporary
  temporary="$(mktemp "$file.XXXXXX")"
  awk -v key="$key" 'index($0, key "=") != 1 { print }' "$file" >"$temporary"
  printf "%s='%s'\n" "$key" "$value" >>"$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$file"
}

compose() {
  local files=(-f docker-compose.yml)
  if [[ -f "$INSTALL_DIR/docker-compose.public.yml" ]] && grep -Eq "^CODEXDECK_PUBLIC_ENABLED=['\"]?true['\"]?$" "$INSTALL_DIR/.env"; then
    files+=(-f docker-compose.public.yml)
  fi
  if [ "$WITH_PLAYWRIGHT" -eq 1 ] && [ -f "$INSTALL_DIR/docker-compose.playwright.yml" ]; then files+=(-f docker-compose.playwright.yml); fi
  if [ "$DOCKER_SUDO" -eq 1 ]; then
    (cd -- "$INSTALL_DIR" && sudo docker compose --env-file .env "${files[@]}" "$@")
  else
    (cd -- "$INSTALL_DIR" && docker compose --env-file .env "${files[@]}" "$@")
  fi
}

detect_docker_access() {
  if docker info >/dev/null 2>&1; then
    DOCKER_SUDO=0
  elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER_SUDO=1
  else
    fail "Docker is unavailable or this account cannot access the daemon."
  fi
}

compose_version_available() {
  if [ "$DOCKER_SUDO" -eq 1 ]; then
    sudo docker compose version >/dev/null 2>&1
  else
    docker compose version >/dev/null 2>&1
  fi
}

ensure_docker() {
  [[ "$(uname -s)" == Linux ]] || fail "Docker installation mode is supported on Linux only."
  case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) fail "Docker installation supports amd64 and arm64 only." ;; esac
  if ! command -v docker >/dev/null 2>&1; then
    command -v curl >/dev/null 2>&1 || fail "Install curl before installing Docker."
    local installer
    installer="$(mktemp)"
    curl -fsSL https://get.docker.com -o "$installer" || fail "Could not download the Docker installer."
    as_root sh "$installer"
    rm -f -- "$installer"
    if command -v systemctl >/dev/null 2>&1; then as_root systemctl enable --now docker; fi
  fi
  if ! docker info >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
    as_root systemctl enable --now docker || true
  fi
  detect_docker_access
  if ! compose_version_available; then
    if command -v apt-get >/dev/null 2>&1; then
      as_root apt-get update
      as_root apt-get install -y docker-compose-plugin
    elif command -v dnf >/dev/null 2>&1; then
      as_root dnf install -y docker-compose-plugin
    elif command -v yum >/dev/null 2>&1; then
      as_root yum install -y docker-compose-plugin
    else
      fail "Docker Compose v2 is missing. Install docker-compose-plugin for this distribution."
    fi
    detect_docker_access
  fi
}

host_packages() {
  local family="$1" mode="$2"
  case "$family:$mode" in
    debian:docker)
      printf '%s\n' ca-certificates curl git jq nginx openssl python3 python3-venv ripgrep iproute2
      ;;
    debian:native)
      printf '%s\n' ca-certificates curl git jq nginx openssl python3 python3-venv ripgrep iproute2 util-linux passwd build-essential bubblewrap
      ;;
    rpm:docker)
      printf '%s\n' ca-certificates curl git jq nginx openssl python3 python3-pip ripgrep iproute
      ;;
    rpm:native)
      printf '%s\n' ca-certificates curl git jq nginx openssl python3 python3-pip ripgrep iproute util-linux-user shadow-utils gcc-c++ make bubblewrap
      ;;
    *)
      fail "Unsupported package set $family:$mode."
      ;;
  esac
}

system_package_installed() {
  local package="$1"
  if command -v dpkg-query >/dev/null 2>&1; then
    dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'
  elif command -v rpm >/dev/null 2>&1; then
    rpm -q "$package" >/dev/null 2>&1
  else
    return 1
  fi
}

install_debian_packages() (
  local policy="/usr/sbin/policy-rc.d" temporary="" created_policy=0
  trap 'if [[ "$created_policy" == 1 ]]; then as_root rm -f -- "$policy"; fi' EXIT

  if ! as_root test -e "$policy" && ! as_root test -L "$policy"; then
    temporary="$(mktemp)"
    printf '#!/bin/sh\nexit 101\n' >"$temporary"
    created_policy=1
    as_root install -m 0755 "$temporary" "$policy"
    rm -f -- "$temporary"
  fi
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update || return 1
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends "$@" || return 1
)

ensure_host_packages() {
  local mode="$1" family="" package missing=0 nginx_missing=0
  local -a packages=()
  if command -v apt-get >/dev/null 2>&1; then family=debian
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then family=rpm
  else fail "Automatic prerequisites support Debian/Ubuntu and DNF/YUM-based Linux servers."; fi

  mapfile -t packages < <(host_packages "$family" "$mode")
  for package in "${packages[@]}"; do
    if ! system_package_installed "$package"; then
      missing=1
      [[ "$package" != nginx ]] || nginx_missing=1
    fi
  done
  if [[ "$missing" == 0 ]]; then
    note "Required host packages are already installed."
    return
  fi

  note "Installing required host packages for $mode mode."
  local nginx_masked=0 nginx_unit_state=""
  if [[ "$nginx_missing" == 1 ]] && command -v systemctl >/dev/null 2>&1; then
    nginx_unit_state="$(as_root systemctl is-enabled nginx.service 2>/dev/null || true)"
    if [[ "$nginx_unit_state" != masked* ]]; then
      as_root systemctl mask --runtime nginx.service
      nginx_masked=1
    fi
  fi
  if [[ "$family" == debian ]]; then
    if ! install_debian_packages "${packages[@]}"; then
      if [[ "$nginx_masked" == 1 ]]; then
        as_root systemctl unmask --runtime nginx.service || true
        as_root systemctl disable nginx.service >/dev/null 2>&1 || true
      fi
      fail "Could not install required Debian/Ubuntu packages."
    fi
  elif command -v dnf >/dev/null 2>&1; then
    if ! as_root dnf install --assumeyes "${packages[@]}"; then
      if [[ "$nginx_masked" == 1 ]]; then
        as_root systemctl unmask --runtime nginx.service || true
        as_root systemctl disable nginx.service >/dev/null 2>&1 || true
      fi
      fail "Could not install required DNF packages."
    fi
  else
    if ! as_root yum install --assumeyes "${packages[@]}"; then
      if [[ "$nginx_masked" == 1 ]]; then
        as_root systemctl unmask --runtime nginx.service || true
        as_root systemctl disable nginx.service >/dev/null 2>&1 || true
      fi
      fail "Could not install required YUM packages."
    fi
  fi
  if [[ "$nginx_masked" == 1 ]]; then
    as_root systemctl unmask --runtime nginx.service
    as_root systemctl disable nginx.service >/dev/null 2>&1 || true
    note "Nginx is installed and left inactive. Its package defaults will not claim ports 80 or 443."
  fi
}

node_version_supported() {
  local version="${1#v}" major minor
  IFS=. read -r major minor _ <<<"$version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  (( 10#$major > 22 || (10#$major == 22 && 10#$minor >= 13) ))
}

ensure_native_node() {
  local node_bin version installer npm_bin corepack_bin
  export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
  node_bin="$(command -v node || true)"
  if [[ -n "$node_bin" ]]; then version="$("$node_bin" --version 2>/dev/null || true)"; fi
  if [[ -z "$node_bin" || ( "$node_bin" != /usr/bin/* && "$node_bin" != /usr/local/bin/* ) ]] ||
      ! node_version_supported "${version:-}"; then
    note "Installing Node.js 22 for native mode."
    if command -v apt-get >/dev/null 2>&1; then
      installer="$(mktemp)"
      curl -fsSL https://deb.nodesource.com/setup_22.x -o "$installer" ||
        fail "Could not download the Node.js 22 repository setup."
      as_root bash "$installer"
      rm -f -- "$installer"
      install_debian_packages nodejs
    elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
      installer="$(mktemp)"
      curl -fsSL https://rpm.nodesource.com/setup_22.x -o "$installer" ||
        fail "Could not download the Node.js 22 repository setup."
      as_root bash "$installer"
      rm -f -- "$installer"
      if command -v dnf >/dev/null 2>&1; then as_root dnf install --assumeyes nodejs
      else as_root yum install --assumeyes nodejs
      fi
    else
      fail "Native mode can install Node.js automatically on Debian/Ubuntu and DNF/YUM-based servers."
    fi
    export PATH="/usr/bin:/usr/local/bin:/bin:$PATH"
    node_bin="$(command -v node || true)"
    version="$("$node_bin" --version 2>/dev/null || true)"
    node_version_supported "$version" || fail "Node.js 22.13 or newer could not be installed."
  fi
  npm_bin="$(command -v npm || true)"
  [[ -n "$npm_bin" ]] || fail "Node.js is present but npm is unavailable."
  corepack_bin="$(command -v corepack || true)"
  if [[ -z "$corepack_bin" ]]; then
    as_root env PATH="$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin" NPM_CONFIG_PREFIX=/usr/local \
      "$npm_bin" install --global corepack
    corepack_bin="$(command -v corepack || true)"
  fi
  [[ -n "$corepack_bin" ]] || fail "Could not install Corepack."
  as_root env PATH="$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin" "$corepack_bin" enable
}

ensure_native_codex() {
  local service_user="$1" dockerfile codex_version toolchain
  NATIVE_CODEX_BIN="$(command -v codex || true)"
  if [[ -n "$NATIVE_CODEX_BIN" ]] &&
      as_root runuser -u "$service_user" -- test -x "$NATIVE_CODEX_BIN"; then
    return
  fi

  dockerfile="$(mktemp)"
  fetch_deploy_file Dockerfile "$dockerfile"
  codex_version="$(sed -n 's/^ARG CODEX_VERSION=//p' "$dockerfile" | head -n 1)"
  rm -f -- "$dockerfile"
  [[ "$codex_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    fail "Could not read the pinned Codex CLI version from deploy/Dockerfile."
  toolchain="$INSTALL_DIR/toolchain"
  as_root install -d -m 0755 "$toolchain"
  note "Installing the pinned OpenAI Codex CLI $codex_version for native mode."
  as_root env NPM_CONFIG_PREFIX="$toolchain" npm install --global --omit=dev "@openai/codex@$codex_version"
  NATIVE_CODEX_BIN="$toolchain/bin/codex"
  as_root runuser -u "$service_user" -- test -x "$NATIVE_CODEX_BIN" ||
    fail "The installed Codex CLI is not executable by the codexdeck service account."
}

prepare_install_directory() {
  if [ "$DIR_SET" -eq 0 ]; then
    prompt_value "安装目录" "$DEFAULT_DIR"
    INSTALL_DIR="$REPLY"
  fi
  [ -n "$INSTALL_DIR" ] || fail "Install directory cannot be empty."
  case "$INSTALL_DIR" in *$'\n'*|*$'\r'*) fail "Install directory cannot contain line breaks.";; esac
  case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;; esac
  [ ! -L "$INSTALL_DIR" ] || fail "Install directory cannot be a symlink."
  mkdir -p -- "$INSTALL_DIR" 2>/dev/null ||
    as_root install -d -o "$(id -u)" -g "$(id -g)" -m 0755 "$INSTALL_DIR"
  INSTALL_DIR="$(cd -- "$INSTALL_DIR" && pwd -P)"
  [ "$INSTALL_DIR" != "/" ] || fail "Refusing to use the filesystem root as the install directory."
}

prepare_workspaces() {
  if [ -z "$WORKSPACES" ]; then
    local default_workspaces="$INSTALL_DIR/workspaces"
    [ "$MODE" = "native" ] && default_workspaces="$INSTALL_DIR/source/workspaces"
    prompt_value "工作区目录" "$default_workspaces"
    WORKSPACES="$REPLY"
  fi
  case "$WORKSPACES" in /*) ;; *) WORKSPACES="$INSTALL_DIR/$WORKSPACES" ;; esac
  mkdir -p -- "$WORKSPACES" 2>/dev/null || as_root mkdir -p -- "$WORKSPACES"
  WORKSPACES="$(as_root realpath -- "$WORKSPACES")"
  [ "$WORKSPACES" != "/" ] || fail "The filesystem root cannot be used as a workspace directory."
  case "$WORKSPACES" in *"'"*|*$'\n'*) fail "Workspace paths cannot contain a single quote or newline." ;; esac
}

choose_install_options() {
  if [ "$ACTION" = "upgrade" ] || [ "$EXISTING_INSTALL" -eq 1 ]; then load_existing_config; fi
  if [ "$MODE" = "native" ] && { [ "$ACTION" = "upgrade" ] || [ "$EXISTING_INSTALL" -eq 1 ]; }; then
    load_native_config
  fi
  if [[ -z "$PUBLIC" && "$EXISTING_INSTALL" == 0 ]]; then
    if [ -n "$DOMAIN" ]; then PUBLIC=true
    else prompt_value "是否开启公网访问？(y/N)" n; if [[ "$REPLY" =~ ^[Yy]$ ]]; then PUBLIC=true; fi
    fi
  fi
  PUBLIC="${PUBLIC:-false}"
  if [[ "$PUBLIC" == true ]]; then
    if [[ -z "$ENTRY_PATH" ]]; then ENTRY_PATH="/$(openssl rand -hex 4)"; fi
    if [[ "$PORT_SET" == 1 ]]; then PUBLIC_PORT="$PORT"; PORT="${STORED_PORT:-3000}"; fi
    if [[ -z "$PUBLIC_PORT" ]]; then
      prompt_value "公网 HTTPS 端口" "$(free_high_port)"; PUBLIC_PORT="$REPLY"
    fi
    valid_port "$PUBLIC_PORT" || fail "Invalid public HTTPS port."
    if [[ "$EXISTING_INSTALL" == 0 ]] && ! port_available "$PUBLIC_PORT"; then fail "Public HTTPS port is occupied."; fi
    if [[ "$PUBLIC_PORT" == "$PORT" ]] || { [[ "$EXISTING_INSTALL" == 0 ]] && ! port_available "$PORT"; }; then PORT="$(free_high_port)"; fi
  elif [ "$PORT_SET" -eq 0 ] && [ "$ACTION" != "upgrade" ] && [ "$EXISTING_INSTALL" -eq 0 ]; then
    prompt_value "访问端口" "3000"
    PORT="$REPLY"
  fi
  if [ "$WORKSPACES_SET" -eq 0 ] && [ -z "$WORKSPACES" ] && [ "$ACTION" != "upgrade" ] && [ "$EXISTING_INSTALL" -eq 0 ]; then
    local default_workspaces="$INSTALL_DIR/workspaces"
    [ "$MODE" = "native" ] && default_workspaces="$INSTALL_DIR/source/workspaces"
    prompt_value "工作区目录" "$default_workspaces"
    WORKSPACES="$REPLY"
  fi
  if [[ "$PUBLIC" == true ]] && [ "$DOMAIN_SET" -eq 0 ] && [ "$ACTION" != "upgrade" ] && [ "$EXISTING_INSTALL" -eq 0 ]; then
    prompt_value "公网域名（留空跳过 HTTPS）" ""
    DOMAIN="$REPLY"
  fi
  if [ "$PLAYWRIGHT_SET" -eq 0 ] && [ "$YES" -eq 0 ] && [ "$ACTION" != "upgrade" ] && [ "$EXISTING_INSTALL" -eq 0 ]; then
    prompt_value "安装完整浏览器验收镜像？(y/N)" "n"
    [[ "$REPLY" =~ ^[Yy]$ ]] && WITH_PLAYWRIGHT=1
  fi
  if [ "$ACTION" != "upgrade" ] || [ "$PORT_SET" -eq 1 ]; then check_port; fi
  validate_domain
  if [[ -n "$DOMAIN" && "$PUBLIC" == false && "$DOMAIN_SET" == 1 ]]; then fail "--domain requires public mode."; fi
  if [[ "$EXISTING_INSTALL" == 0 && -n "$DOMAIN" && "$PUBLIC" == true ]]; then
    if [[ "$MODE" == docker ]] && port_available 80 && port_available 443 && port_available 8080 && port_available 8443; then
      prompt_value "启用 CodexDeck Caddy（需自行转发 80/443 至 8080/8443）？(y/N)" n
      if [[ "$REPLY" =~ ^[Yy]$ ]]; then MANAGED_CADDY=1; fi
    else note "保留现有网站监听。用 cdx proxy 查看独立反代配置。"; fi
  fi
}

resolve_release() {
  if [ -z "$RELEASE" ]; then
    local repo
    repo="$(script_repository)"
    RELEASE="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")"
    RELEASE="${RELEASE##*/}"
  fi
  [[ "$RELEASE" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Could not resolve a release. Supply --version vX.Y.Z."
}

select_image() {
  if [ -z "$IMAGE" ]; then
    local repo
    repo="${CODEXDECK_IMAGE_REPOSITORY:-ghcr.io/waffing/codex-deck}"
    if [ "$WITH_PLAYWRIGHT" -eq 1 ]; then
      IMAGE="$repo:$RELEASE-playwright"
    else
      IMAGE="$repo:$RELEASE"
    fi
  fi
}

docker_install() {
  ensure_host_packages docker
  ensure_docker
  local previous="" running="" profile=()
  if [[ "$MANAGED_CADDY" == 1 && -f "$INSTALL_DIR/Caddyfile" ]] &&
     ! cmp -s "$INSTALL_DIR/Caddyfile" "$INSTALL_DIR/Caddyfile.template"; then
    fail "Custom Caddy configuration detected. Review and preserve the existing routes before upgrading managed Caddy."
  fi
  if [[ -f "$INSTALL_DIR/.env" && -f "$INSTALL_DIR/docker-compose.yml" ]]; then
    running="$(compose ps -q codexdeck)"
    if [[ "$ACTION" == upgrade && -z "$running" ]]; then fail "Cannot upgrade without a running rollback candidate."; fi
  fi
  if [[ -n "$running" ]]; then
    previous="$(mktemp -d "$INSTALL_DIR/.previous-release.XXXXXX")"
    for file in .env docker-compose.yml Caddyfile docker-compose.public.yml docker-compose.playwright.yml chromium-seccomp.json; do
      if [ -f "$INSTALL_DIR/$file" ]; then cp -p -- "$INSTALL_DIR/$file" "$previous/"; fi
    done
    # Pin the rollback to the running image even if a mutable tag was installed previously.
    local digest
    if [ "$DOCKER_SUDO" -eq 1 ]; then digest="$(sudo docker inspect -f '{{.Image}}' "$running")"; else digest="$(docker inspect -f '{{.Image}}' "$running")"; fi
    local recovery_tag="codexdeck-local:rollback-${digest#sha256:}"
    if [ "$DOCKER_SUDO" -eq 1 ]; then sudo docker image tag "$digest" "$recovery_tag"; else docker image tag "$digest" "$recovery_tag"; fi
    if [[ "$(native_setting "$previous/.env" CODEXDECK_EXEC_IMAGE)" == "$(native_setting "$previous/.env" CODEXDECK_IMAGE)" ]]; then
      update_env_key "$previous/.env" CODEXDECK_EXEC_IMAGE "$recovery_tag"
    fi
    update_env_key "$previous/.env" CODEXDECK_IMAGE "$recovery_tag"
  fi
  fetch_deploy_file docker-compose.yml "$INSTALL_DIR/docker-compose.yml"
  fetch_deploy_file docker-compose.public.yml "$INSTALL_DIR/docker-compose.public.yml"
  fetch_deploy_file .env.example "$INSTALL_DIR/.env.example"
  fetch_deploy_file Caddyfile.template "$INSTALL_DIR/Caddyfile.template"
  if [ "$WITH_PLAYWRIGHT" -eq 1 ]; then
    fetch_deploy_file docker-compose.playwright.yml "$INSTALL_DIR/docker-compose.playwright.yml"
    fetch_deploy_file chromium-seccomp.json "$INSTALL_DIR/chromium-seccomp.json"
    mkdir -p "$INSTALL_DIR/licenses"
    fetch_deploy_file licenses/playwright-LICENSE "$INSTALL_DIR/licenses/playwright-LICENSE"
  fi
  fetch_deploy_file install.sh "$INSTALL_DIR/install.sh"
  fetch_deploy_file cdx.sh "$INSTALL_DIR/cdx.sh"
  fetch_deploy_file backup.py "$INSTALL_DIR/backup.py"
  if [ ! -f "$INSTALL_DIR/.env.example" ]; then fail "deploy/.env.example was not installed."; fi
  if [ ! -f "$INSTALL_DIR/docker-compose.yml" ]; then fail "deploy/docker-compose.yml was not installed."; fi
  mkdir -p "$INSTALL_DIR/data"
  chmod 0755 "$INSTALL_DIR/install.sh"
  if [ -z "$WORKSPACES" ]; then WORKSPACES="$INSTALL_DIR/workspaces"; fi
  prepare_workspaces
  if [ -z "$EXPLICIT_IMAGE" ] && { [ "$ACTION" = "upgrade" ] || [ "$PLAYWRIGHT_SET" -eq 1 ]; }; then IMAGE=""; fi
  if [ -z "$IMAGE" ]; then select_image; fi
  [[ "$IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] ||
    fail "CODEXDECK_IMAGE is not a valid registry image reference."
  if [[ -z "$EXEC_IMAGE" && -f "$INSTALL_DIR/.env" ]]; then
    local old_control old_executor
    old_control="$(sed -n 's/^CODEXDECK_IMAGE=//p' "$INSTALL_DIR/.env" | tr -d "\"'")"
    old_executor="$(sed -n 's/^CODEXDECK_EXEC_IMAGE=//p' "$INSTALL_DIR/.env" | tr -d "\"'")"
    if [[ "$old_executor" != "$old_control" ]]; then EXEC_IMAGE="$old_executor"; fi
  fi
  EXEC_IMAGE="${EXEC_IMAGE:-$IMAGE}"
  [[ "$EXEC_IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$ ]] || fail "Invalid CODEXDECK_EXEC_IMAGE."
  local current_uid current_gid
  current_uid="$(id -u)"
  current_gid="$(id -g)"
  if [ "$current_uid" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    current_uid="$(id -u "$SUDO_USER")"
    current_gid="$(id -g "$SUDO_USER")"
  elif [ "$current_uid" -eq 0 ]; then
    current_uid=1000
    current_gid=1000
  fi
  INSTALL_UID="$current_uid" INSTALL_GID="$current_gid" install_environment_file
  if [[ "$PUBLIC" == true ]]; then panel_cert "$INSTALL_DIR/data" "$current_uid" "$current_gid"; fi
  if [[ "$MANAGED_CADDY" == 1 ]]; then
    if ! grep -Eq "^CODEXDECK_MANAGED_PROXY_TOKEN=['\"]?[0-9a-f]{64}['\"]?$" "$INSTALL_DIR/.env"; then
      update_env_key "$INSTALL_DIR/.env" CODEXDECK_MANAGED_PROXY_TOKEN "$(openssl rand -hex 32)"
    fi
    grep -q 'CODEXDECK_DOMAIN' "$INSTALL_DIR/Caddyfile.template" ||
      fail "Caddyfile.template does not support CODEXDECK_DOMAIN."
    cp "$INSTALL_DIR/Caddyfile.template" "$INSTALL_DIR/Caddyfile"
  fi
  chmod 0600 "$INSTALL_DIR/.env"
  if [[ "$MANAGED_CADDY" == 1 && "$PUBLIC" != false ]]; then profile=(--profile https); fi
  # Expand the mapped service UID and GID inside the running container.
  # shellcheck disable=SC2016
  if { [ "$ACTION" != "upgrade" ] || compose "${profile[@]}" pull; } && compose "${profile[@]}" up -d && wait_for_health &&
     compose exec -T codexdeck sh -ec 'exec gosu "$PUID:$PGID" node /app/apps/server/dist/admin-cli.js require-executor' &&
     { [[ "$PUBLIC" != true || "$EXISTING_INSTALL" == 1 ]] || wait_for_public_entry; }; then
    if [ -n "$previous" ]; then rm -f -- "$previous/.env"; fi
    return 0
  fi
  if [ -n "$previous" ]; then
    for file in .env docker-compose.yml Caddyfile docker-compose.public.yml docker-compose.playwright.yml chromium-seccomp.json; do
      if [ -f "$previous/$file" ]; then cp -p -- "$previous/$file" "$INSTALL_DIR/$file"; fi
    done
    # Use persisted settings, including the original port, profile and local image tag.
    PORT_SET=0; DOMAIN_SET=0; PLAYWRIGHT_SET=0; WITH_PLAYWRIGHT=0; load_existing_config
    profile=(); if [[ "$MANAGED_CADDY" == 1 ]]; then profile=(--profile https); fi
    if CODEXDECK_IMAGE="$recovery_tag" compose "${profile[@]}" up -d --pull never && wait_for_health; then
      :
    else
      fail "Rollback requires attention. Retained prior configuration at $previous"
    fi
    rm -f -- "$previous/.env"
    fail "Upgrade failed. The previous image is healthy again."
  fi
  fail "Installation did not pass service and full access checks. Verify that the shipped executor image is available locally and the CodexDeck socket proxy is healthy."
}

wait_for_health() {
  local attempt
  for ((attempt=1; attempt<=45; attempt++)); do
    if compose exec -T codexdeck curl -fsS --max-time 3 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      printf '%s\n' "CodexDeck HTTP health check passed."
      return 0
    fi
    sleep 2
  done
  printf '%s\n' "CodexDeck did not become healthy. Recent container logs:" >&2
  compose logs --tail 50 >&2 || true
  return 1
}

wait_for_public_entry() {
  [[ "$PUBLIC" == true ]] || return 0
  local attempt status url="https://127.0.0.1:$PUBLIC_PORT$ENTRY_PATH"
  for ((attempt=1; attempt<=20; attempt++)); do
    status="$(curl --insecure --silent --show-error --connect-timeout 2 --max-time 4 \
      --output /dev/null --write-out '%{http_code}' "$url" 2>/dev/null || true)"
    if [[ "$status" == 302 ]]; then
      note "Public HTTPS entry check passed at $url."
      return 0
    fi
    sleep 1
  done
  printf 'Public HTTPS entry check failed for %s. Check the selected port and cloud security group.\n' "$url" >&2
  return 1
}

native_build() {
  local user="$1" build_home="$2" source="$3" executable="$4"
  # shellcheck disable=SC2016
  as_root runuser -u "$user" -- env -i HOME="$build_home" PATH="$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin" \
    bash -euc 'cd "$1"; "$2" pnpm install --frozen-lockfile; "$2" pnpm build' bash "$source" "$executable"
}

native_resource_properties() {
  local memory="${CODEXDECK_NATIVE_MEMORY_MAX:-512M}"
  local cpu="${CODEXDECK_NATIVE_CPU_QUOTA:-50%}"
  local tasks="${CODEXDECK_NATIVE_TASKS_MAX:-192}"
  local amount unit

  [[ "$memory" =~ ^([1-9][0-9]*)(M|G)$ ]] || fail "CODEXDECK_NATIVE_MEMORY_MAX must be an integer size such as 2G or 1536M."
  amount="${BASH_REMATCH[1]}"
  unit="${BASH_REMATCH[2]}"
  if [[ "$unit" == M ]]; then
    (( ${#amount} <= 5 && 10#$amount >= 512 && 10#$amount <= 65536 )) ||
      fail "CODEXDECK_NATIVE_MEMORY_MAX must be between 512M and 64G."
  else
    (( ${#amount} <= 2 && 10#$amount >= 1 && 10#$amount <= 64 )) ||
      fail "CODEXDECK_NATIVE_MEMORY_MAX must be between 512M and 64G."
  fi

  [[ "$cpu" =~ ^([1-9][0-9]*)%$ ]] || fail "CODEXDECK_NATIVE_CPU_QUOTA must be an integer percentage such as 200%."
  amount="${BASH_REMATCH[1]}"
  (( ${#amount} <= 4 && 10#$amount >= 10 && 10#$amount <= 6400 )) ||
    fail "CODEXDECK_NATIVE_CPU_QUOTA must be between 10% and 6400%."

  [[ "$tasks" =~ ^([1-9][0-9]*)$ ]] || fail "CODEXDECK_NATIVE_TASKS_MAX must be an integer."
  amount="${BASH_REMATCH[1]}"
  (( ${#amount} <= 5 && 10#$amount >= 64 && 10#$amount <= 65536 )) ||
    fail "CODEXDECK_NATIVE_TASKS_MAX must be between 64 and 65536."

  printf 'MemoryMax=%s\nCPUQuota=%s\nTasksMax=%s\n' "$memory" "$cpu" "$tasks"
}

native_install() {
  [[ "$(uname -s)" == Linux ]] || fail "Native systemd installation is supported on Linux only."
  ensure_host_packages native
  ensure_native_node
  command -v systemctl >/dev/null 2>&1 || fail "Native installation requires systemd."
  local resource_properties
  resource_properties="$(native_resource_properties)"
  command -v node >/dev/null 2>&1 || fail "Native installation requires Node.js 22.13 or newer."
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)' ||
    fail "Native installation requires Node.js 22.13 or newer."
  command -v corepack >/dev/null 2>&1 || fail "Native installation requires Corepack."
  command -v git >/dev/null 2>&1 || fail "Native installation requires Git."
  if [[ ! -x /usr/bin/bwrap ]]; then
    note "Installing bubblewrap for the non-root full access executor."
    if command -v apt-get >/dev/null 2>&1; then
      as_root apt-get update && as_root apt-get install --yes --no-install-recommends bubblewrap
    elif command -v dnf >/dev/null 2>&1; then as_root dnf install -y bubblewrap
    elif command -v yum >/dev/null 2>&1; then as_root yum install -y bubblewrap
    fi
    [[ -x /usr/bin/bwrap ]] || fail "Native full access requires /usr/bin/bwrap. Install bubblewrap or choose the default Docker installer."
  fi
  if [ "$ACTION" != "upgrade" ] || [ "$PORT_SET" -eq 1 ]; then check_port; fi
  validate_domain
  local source data_dir="$INSTALL_DIR/source/data" repo service_user node_bin codex_bin service_file env_dir path_value
  repo="$(script_repository)"
  service_user="codexdeck"
  if ! getent passwd "$service_user" >/dev/null; then
    as_root useradd --system --create-home --home-dir /var/lib/codexdeck --shell /usr/sbin/nologin "$service_user"
  fi
  # Use a fresh build directory so an unsuccessful install cannot modify the running release.
  local build_user=codexdeck-build build_home=/var/lib/codexdeck-build
  if ! getent passwd "$build_user" >/dev/null; then
    as_root useradd --system --create-home --home-dir "$build_home" --shell /usr/sbin/nologin "$build_user"
  fi
  ensure_native_codex "$service_user"
  as_root install -d -m 0755 "$INSTALL_DIR/releases"
  as_root runuser -u "$build_user" -- test -x "$INSTALL_DIR/releases" ||
    fail "The build account cannot enter $INSTALL_DIR/releases. Use a shared service directory such as /opt/codexdeck."
  source="$(as_root mktemp -d "$INSTALL_DIR/releases/$RELEASE.XXXXXX")"
  as_root chown "$build_user:$build_user" "$source"
  as_root chmod 0755 "$source"
  as_root runuser -u "$build_user" -- env HOME="$build_home" git clone --branch "$RELEASE" --depth 1 "https://github.com/$repo.git" "$source"
  if [ -z "$WORKSPACES" ]; then WORKSPACES="$INSTALL_DIR/source/workspaces"; fi
  as_root mkdir -p "$data_dir" "$WORKSPACES" /etc/codexdeck
  WORKSPACES="$(as_root realpath -- "$WORKSPACES")"
  as_root chown -R "$service_user:$service_user" "$data_dir"
  as_root chmod 0750 "$data_dir"
  if [ -z "$(find "$WORKSPACES" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    as_root chown "$service_user:$service_user" "$WORKSPACES"
    as_root chmod 0750 "$WORKSPACES"
  elif [ "$(id -u)" -eq 0 ]; then
    { runuser -u "$service_user" -- test -r "$WORKSPACES" &&
      runuser -u "$service_user" -- test -w "$WORKSPACES" &&
      runuser -u "$service_user" -- test -x "$WORKSPACES"; } ||
      fail "The existing workspace is not accessible to codexdeck. Grant it read/write/execute access first."
  else
    { sudo -u "$service_user" test -r "$WORKSPACES" &&
      sudo -u "$service_user" test -w "$WORKSPACES" &&
      sudo -u "$service_user" test -x "$WORKSPACES"; } ||
      fail "The existing workspace is not accessible to codexdeck. Grant it read/write/execute access first."
  fi
  native_build "$build_user" "$build_home" "$source" "$(command -v corepack)"
  as_root install -m 0644 /dev/null "$source/.codexdeck-installed-release"
  node_bin="$(command -v node)"
  codex_bin="$NATIVE_CODEX_BIN"
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$service_user" -- test -x "$node_bin" ||
      fail "Node.js is not executable by codexdeck. Install Node.js system-wide."
    runuser -u "$service_user" -- test -x "$codex_bin" ||
      fail "The Codex CLI is not executable by codexdeck. Install it system-wide."
  else
    sudo -u "$service_user" test -x "$node_bin" ||
      fail "Node.js is not executable by codexdeck. Install Node.js system-wide."
    sudo -u "$service_user" test -x "$codex_bin" ||
      fail "The Codex CLI is not executable by codexdeck. Install it system-wide."
  fi
  path_value="$(dirname "$node_bin"):$(dirname "$codex_bin"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  if [ "$WITH_PLAYWRIGHT" -eq 1 ]; then
    as_root install -d -o "$service_user" -g "$service_user" -m 0750 /var/lib/codexdeck
    as_root runuser -u "$service_user" -- env HOME=/var/lib/codexdeck PATH="$path_value" \
      "$source/apps/server/node_modules/.bin/playwright-core" install chromium
  fi
  service_file="/etc/systemd/system/codexdeck.service"
  env_dir="/etc/codexdeck"
  local old_unit="" old_env=""
  if as_root test -f "$service_file"; then
    old_unit="$(as_root mktemp /etc/systemd/system/.codexdeck.XXXXXX)"
    as_root cp -p -- "$service_file" "$old_unit"
    if as_root test -f "$env_dir/codexdeck.env"; then
      old_env="$(as_root mktemp "$env_dir/.codexdeck-env.XXXXXX")"
      as_root cp -p -- "$env_dir/codexdeck.env" "$old_env"
    fi
  fi
  if ! as_root test -f "$env_dir/codexdeck.env"; then
    local key
    key="$(openssl rand -hex 32)" || fail "Could not generate a master key. Install openssl."
    as_root install -m 0600 /dev/null "$env_dir/codexdeck.env"
    as_root tee "$env_dir/codexdeck.env" >/dev/null <<EOF
CODEXDECK_MASTER_KEY=$key
CODEXDECK_PORT=$PORT
CODEXDECK_HOST=127.0.0.1
CODEXDECK_DATA_DIR=$(env_quote "$data_dir")
CODEXDECK_WORKSPACES=$(env_quote "$WORKSPACES")
CODEX_BIN=$(env_quote "$codex_bin")
EOF
  else
    update_systemd_env "$env_dir/codexdeck.env" CODEXDECK_PORT "$PORT"
    update_systemd_env "$env_dir/codexdeck.env" CODEXDECK_DATA_DIR "$data_dir"
    update_systemd_env "$env_dir/codexdeck.env" CODEXDECK_WORKSPACES "$WORKSPACES"
    update_systemd_env "$env_dir/codexdeck.env" CODEX_BIN "$codex_bin"
  fi
  as_root chmod 0600 "$env_dir/codexdeck.env"
  update_systemd_env "$env_dir/codexdeck.env" CODEXDECK_INSTALL_MODE "native"
  update_systemd_env "$env_dir/codexdeck.env" CODEXDECK_PUBLIC_ENABLED "$PUBLIC"
  update_systemd_env "$env_dir/codexdeck.env" CODEXDECK_ENTRY_PATH "$ENTRY_PATH"
  update_systemd_env "$env_dir/codexdeck.env" CODEXDECK_PUBLIC_PORT "$PUBLIC_PORT"
  update_systemd_env "$env_dir/codexdeck.env" CODEXDECK_DOMAIN "$DOMAIN"
  if [[ "$PUBLIC" == true ]]; then
    panel_cert "$data_dir" "$service_user" "$service_user"
    update_systemd_env "$env_dir/codexdeck.env" CODEXDECK_TLS_PORT "$PUBLIC_PORT"
  else update_systemd_env "$env_dir/codexdeck.env" CODEXDECK_TLS_PORT ""; fi
  as_root tee "$service_file" >/dev/null <<EOF
[Unit]
Description=CodexDeck local AI workbench
After=network-online.target user@$(id -u "$service_user").service
Wants=network-online.target user@$(id -u "$service_user").service

[Service]
Type=simple
User=$service_user
Group=$service_user
WorkingDirectory=$(systemd_quote "$source")
Environment=NODE_ENV=production
Environment=$(systemd_quote "PATH=$path_value")
Environment=HOME=/var/lib/codexdeck
EnvironmentFile=$env_dir/codexdeck.env
ExecStart=$(systemd_quote "$node_bin") apps/server/dist/index.js
Restart=on-failure
RestartSec=3
$resource_properties
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/codexdeck $(systemd_quote "$data_dir") $(systemd_quote "$WORKSPACES")

[Install]
WantedBy=multi-user.target
EOF
  as_root systemctl daemon-reload
  as_root systemctl enable codexdeck
  if as_root systemctl restart codexdeck && wait_for_native_health &&
     as_root systemd-run --quiet --pipe --wait --collect --uid="$service_user" \
       --property="EnvironmentFile=$env_dir/codexdeck.env" --setenv=NODE_ENV=production \
       "$node_bin" "$source/apps/server/dist/admin-cli.js" require-executor &&
     { [[ "$PUBLIC" != true || "$EXISTING_INSTALL" == 1 ]] || wait_for_public_entry; }; then
    if [ -n "$old_unit" ]; then as_root rm -f -- "$old_unit"; fi
    if [ -n "$old_env" ]; then as_root rm -f -- "$old_env"; fi
    as_root install -m 0755 "$source/deploy/install.sh" "$INSTALL_DIR/install.sh"
    as_root install -m 0644 "$source/deploy/backup.py" "$INSTALL_DIR/backup.py"
    as_root install -m 0755 "$source/deploy/cdx.sh" "$INSTALL_DIR/cdx.sh"
    NATIVE_SOURCE="$source"
  elif [ -n "$old_unit" ]; then
    as_root mv -- "$old_unit" "$service_file"
    if [ -n "$old_env" ]; then
      as_root mv -- "$old_env" "$env_dir/codexdeck.env"
      PORT="$(native_setting "$env_dir/codexdeck.env" CODEXDECK_PORT)"
    fi
    as_root systemctl daemon-reload
    if as_root systemctl restart codexdeck && wait_for_native_health; then
      :
    else
      fail "Previous native release failed its health check."
    fi
    fail "Upgrade failed. The previous native release is healthy again."
  else fail "Native installation did not pass service and full access checks. If this host restricts unprivileged namespaces, use the default Docker installer in a separate directory."; fi
}

update_systemd_env() {
  local file="$1" key="$2" value="$3" temporary
  temporary="$(mktemp)"
  as_root sed "/^$key=/d" "$file" >"$temporary"
  printf "%s=%s\n" "$key" "$(env_quote "$value")" >>"$temporary"
  as_root install -m 0600 "$temporary" "$file"
  rm -f -- "$temporary"
}

env_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

systemd_quote() {
  local value="$1"
  env_quote "${value//%/%%}"
}

wait_for_native_health() {
  local attempt
  for ((attempt=1; attempt<=45; attempt++)); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      printf '%s\n' "CodexDeck HTTP health check passed."
      return 0
    fi
    sleep 2
  done
  printf '%s\n' "CodexDeck did not become healthy. Recent service logs:" >&2
  as_root journalctl -u codexdeck -n 50 --no-pager >&2 || true
  return 1
}

uninstall() {
  prepare_install_directory
  if [ "$MODE" = "native" ]; then load_native_config
  else load_existing_config
  fi
  if [ "$MODE" = "native" ]; then
    as_root systemctl disable --now codexdeck 2>/dev/null || true
    as_root rm -f /etc/systemd/system/codexdeck.service
    as_root systemctl daemon-reload
  elif [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    ensure_docker
    compose --profile https down --remove-orphans
  fi

  local keep="y"
  if [ "$YES" -eq 0 ] && [ -r /dev/tty ]; then
    prompt_value "保留数据与工作区目录？(Y/n)" "y"
    keep="$REPLY"
  fi
  if [[ "$keep" =~ ^[Nn]$ ]]; then
    local data="$INSTALL_DIR/data" target
    if [ "$MODE" = "native" ]; then data="$INSTALL_DIR/source/data"; fi
    if [ -d "$data" ] && [ ! -L "$data" ]; then as_root rm -rf -- "$data"; fi
    if [ -n "$WORKSPACES" ]; then
      if [ -d "$WORKSPACES" ]; then target="$(cd -- "$WORKSPACES" && pwd -P)"
      else target="$WORKSPACES"
      fi
      if [ -d "$target" ] && [[ "$target" == "$INSTALL_DIR/"* ]] && [ ! -L "$WORKSPACES" ]; then
        as_root rm -rf -- "$target"
      elif [ -d "$target" ]; then
        note "Keeping workspace directory outside the install directory: $target"
      fi
    elif [ -d "$INSTALL_DIR/workspaces" ] && [ ! -L "$INSTALL_DIR/workspaces" ]; then
      as_root rm -rf -- "$INSTALL_DIR/workspaces"
    fi
    if [ "$MODE" = "native" ]; then
      local release
      for release in "$INSTALL_DIR"/releases/v*; do
        if [ -d "$release" ] && [ ! -L "$release" ] && [[ "$release" =~ /v[0-9]+\.[0-9]+\.[0-9]+\.[A-Za-z0-9]{6}$ ]] &&
            [ -f "$release/.codexdeck-installed-release" ] && [ ! -L "$INSTALL_DIR/releases" ]; then
          as_root rm -rf -- "$release"
        fi
      done
      as_root rm -f /etc/codexdeck/codexdeck.env
      as_root rmdir /etc/codexdeck "$INSTALL_DIR/releases" "$INSTALL_DIR/source" 2>/dev/null || true
      as_root rm -f -- "$INSTALL_DIR/install.sh" "$INSTALL_DIR/cdx.sh" "$INSTALL_DIR/backup.py"
    else
      as_root rm -f -- "$INSTALL_DIR/.env" "$INSTALL_DIR/.env.example" "$INSTALL_DIR/docker-compose.yml" \
        "$INSTALL_DIR/Caddyfile" "$INSTALL_DIR/Caddyfile.template" "$INSTALL_DIR/install.sh" \
        "$INSTALL_DIR/backup.py" "$INSTALL_DIR/cdx.sh" "$INSTALL_DIR/docker-compose.public.yml"
    fi
  else
    note "Data, workspaces, configuration and the encryption key have been retained for reinstall."
  fi
  local metadata=/etc/codexdeck/host-install link lib=/usr/local/libexec/codexdeck
  if [[ -f "$metadata" && "$(as_root sed -n '2p' "$metadata")" == "$INSTALL_DIR" ]]; then
    for link in /usr/local/bin/cdx /usr/local/bin/codexdeck; do
      if [[ "$(readlink "$link" || true)" == "$lib/cdx.sh" ]]; then as_root rm -- "$link"; fi
    done
    as_root rm -f -- "$metadata" "$lib/cdx.sh" "$lib/backup.py" "$lib/install.sh"
    as_root rmdir "$lib" /etc/codexdeck 2>/dev/null || true
  fi
  note "CodexDeck services have been removed."
}

public_entry_url() {
  local host="$1"
  if [[ "$host" == *:* && "$host" != \[*\] ]]; then host="[$host]"; fi
  printf 'https://%s:%s%s' "$host" "$PUBLIC_PORT" "$ENTRY_PATH"
}

detect_public_ipv4() {
  local address
  address="$(curl -4fsS --connect-timeout 2 --max-time 4 https://api.ipify.org 2>/dev/null || true)"
  if [[ "$address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    printf '%s' "$address"
    return 0
  fi
  return 1
}

print_success() {
  local public_url="" public_host=""
  if [[ "$PUBLIC" == true ]]; then
    if [[ -n "$DOMAIN" ]]; then public_host="$DOMAIN"
    else public_host="$(detect_public_ipv4 || true)"
    fi
    if [[ -n "$public_host" ]]; then public_url="$(public_entry_url "$public_host")"; fi
  fi
  local docker_command="docker"
  if [ "$DOCKER_SUDO" -eq 1 ]; then docker_command="sudo docker"; fi
  local logs="cd \"$INSTALL_DIR\" && $docker_command compose logs -f"
  local upgrade="bash \"$INSTALL_DIR/install.sh\" --upgrade --dir \"$INSTALL_DIR\" --yes"
  local uninstall_command="bash \"$INSTALL_DIR/install.sh\" --uninstall --dir \"$INSTALL_DIR\""
  if [ "$MODE" = "native" ]; then
    logs="sudo journalctl -u codexdeck -f"
    upgrade="sudo bash \"$INSTALL_DIR/install.sh\" --native --upgrade --dir \"$INSTALL_DIR\" --yes"
    uninstall_command="sudo bash \"$INSTALL_DIR/install.sh\" --native --uninstall --dir \"$INSTALL_DIR\""
  fi
  cat <<EOF

  CodexDeck is ready
  ------------------
  Local URL:       http://127.0.0.1:$PORT
  Setup wizard:    http://127.0.0.1:$PORT
  Health check:    curl -fsS http://127.0.0.1:$PORT/api/health
  Logs:            $logs
  Upgrade:         $upgrade
  Uninstall:       $uninstall_command

  Set the first administrator password over SSH with cdx password, then sign in to configure the model and workspace.
EOF
  if [ "$MODE" = "docker" ]; then
    note "Host Ollama: configure a container-reachable URL, e.g. http://host.docker.internal:11434/v1 with Docker host-gateway mapping."
  else note "Setup code (first start): sudo cat '$INSTALL_DIR/source/data/setup-code'"; fi
  if [[ "$PUBLIC" == true ]]; then
    if [[ -n "$public_url" ]]; then
      printf '  HTTPS entry:    %s\n' "$public_url"
    else
      note "Could not detect a public IPv4 address. Use https://<your-public-ip>:$PUBLIC_PORT$ENTRY_PATH"
    fi
    printf '  Required ingress: TCP %s in the cloud security group\n' "$PUBLIC_PORT"
    note "Nginx is installed for host proxy integration. The managed endpoint uses its isolated TLS port and does not claim 80/443."
    note "First login: set the administrator password over SSH with cdx password."
    note "Run cdx status over SSH and compare the certificate SHA-256 fingerprint before trusting the certificate."
  else
    printf '  SSH tunnel: ssh -N -L 127.0.0.1:%s:127.0.0.1:%s user@server\n' "$PORT" "$PORT"
    note "Use cdx public on or cdx temp-link in an SSH session."
  fi
}

install_cdx() {
  local meta=/etc/codexdeck/host-install record previous
  for previous in /usr/local/bin/cdx /usr/local/bin/codexdeck; do
    if [[ -e "$previous" || -L "$previous" ]]; then
      [[ "$(readlink "$previous" || true)" == /usr/local/libexec/codexdeck/cdx.sh ]] || fail "Cannot replace existing command $previous."
    fi
  done
  if as_root test -f "$meta"; then
    [[ "$(as_root sed -n '2p' "$meta")" == "$INSTALL_DIR" ]] || fail "A different installation owns the host cdx command."
  fi
  as_root install -d -m 0755 /etc/codexdeck /usr/local/libexec/codexdeck /usr/local/bin
  as_root install -m 0755 "$INSTALL_DIR/cdx.sh" /usr/local/libexec/codexdeck/cdx.sh
  as_root install -m 0755 "$INSTALL_DIR/install.sh" /usr/local/libexec/codexdeck/install.sh
  as_root install -m 0644 "$INSTALL_DIR/backup.py" /usr/local/libexec/codexdeck/backup.py
  record="$(mktemp)"
  printf '%s\n' "$MODE" "$INSTALL_DIR" "${NATIVE_SOURCE:-}" "$(id -u)" > "$record"
  as_root install -m 0644 "$record" "$meta"; rm -f -- "$record"
  for previous in /usr/local/bin/cdx /usr/local/bin/codexdeck; do
    [[ -L "$previous" ]] || as_root ln -s /usr/local/libexec/codexdeck/cdx.sh "$previous"
  done
}

main() {
  parse_args "$@"
  if [ "$MODE" = "native" ]; then DEFAULT_DIR=/opt/codexdeck; fi
  discover_local_source
  if [ "$DIR_SET" -eq 0 ]; then
    if [ "$ACTION" = "upgrade" ] || [ "$ACTION" = "uninstall" ]; then
      INSTALL_DIR="$DEFAULT_DIR"
    fi
  fi
  prepare_install_directory
  if [ "$ACTION" = "uninstall" ]; then
    uninstall
    return
  fi
  if { [ "$MODE" = "native" ] && [ -f /etc/codexdeck/codexdeck.env ]; } ||
      { [ "$MODE" = "docker" ] && [ -f "$INSTALL_DIR/.env" ]; }; then
    EXISTING_INSTALL=1
  fi
  resolve_release
  choose_install_options
  if [ "$MODE" = "native" ]; then
    native_install
  else
    docker_install
  fi
  install_cdx
  if [[ "$ACCESS_EXPLICIT" == 1 && "$EXISTING_INSTALL" == 1 ]]; then
    if [[ "$PUBLIC" == true ]]; then printf '%s' '{"public_enabled":true,"entry_enabled":true}' | /usr/local/bin/cdx security set >/dev/null
    else
      printf '%s' '{"public_enabled":false}' | /usr/local/bin/cdx security set >/dev/null
      if [[ "$MODE" == docker && "$MANAGED_CADDY" == 1 ]]; then compose --profile https stop caddy; fi
    fi
  fi
  print_success
}

if [[ ${BASH_SOURCE[0]:-} == "$0" || -z ${BASH_SOURCE[0]:-} ]]; then main "$@"; fi

