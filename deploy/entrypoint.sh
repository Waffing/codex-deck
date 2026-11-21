#!/bin/sh
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

case "$PUID:$PGID" in
  *[!0-9:]*|:*|*:) printf '%s\n' 'PUID and PGID must be positive integers.' >&2; exit 2 ;;
esac
if ! [ "$PUID" -gt 0 ] || ! [ "$PGID" -gt 0 ]; then
  printf '%s\n' 'PUID and PGID must be positive integers.' >&2
  exit 2
fi

mkdir -p /data /workspaces /data/caches/npm /data/caches/pip /data/caches/uv /data/home
chown -R --no-dereference "$PUID:$PGID" /data /workspaces

export PUID PGID
export HOME=/data/home
export NPM_CONFIG_CACHE=/data/caches/npm
export PIP_CACHE_DIR=/data/caches/pip
export UV_CACHE_DIR=/data/caches/uv
if [ "${CODEXDECK_LOOPBACK_PUBLISHED:-}" = true ]; then
  CODEXDECK_LOCAL_PEER="$(ip -4 route show default | awk 'NR==1 {print $3}')"
  export CODEXDECK_LOCAL_PEER
fi

exec gosu "$PUID:$PGID" "$@"
