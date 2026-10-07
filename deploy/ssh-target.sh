# shellcheck shell=bash
# Sourced by the deploy workflow. Normalizes HOST / PORT / SSH_USER taken from secrets, tolerating
# copy-paste artefacts: surrounding whitespace/newlines, "ssh://", "user@host", "host:port", "host port".
# Exits with an ::error:: annotation when the result is still not a usable host/port.
_trim() { printf '%s' "$1" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d' | head -n1; }
HOST=$(_trim "${HOST:-}"); PORT=$(_trim "${PORT:-}"); SSH_USER=$(_trim "${SSH_USER:-}")
HOST="${HOST#ssh://}"; HOST="${HOST%/}"
case "$HOST" in *[[:space:]]*)
  _second=$(printf '%s' "$HOST" | awk '{print $2}'); HOST=$(printf '%s' "$HOST" | awk '{print $1}')
  printf '%s' "$_second" | grep -Eq '^[0-9]+$' && PORT="${PORT:-$_second}";;
esac
case "$HOST" in *@*) SSH_USER="${HOST%@*}"; HOST="${HOST#*@}";; esac
case "$HOST" in *:*:*) ;; *:*) PORT="${PORT:-${HOST##*:}}"; HOST="${HOST%:*}";; esac
SSH_USER="${SSH_USER:-root}"; PORT="${PORT:-22}"
if [ -n "$HOST" ] && ! printf '%s' "$HOST" | grep -Eq '^[A-Za-z0-9.:-]+$'; then
  echo "::error::STAGING_SSH_HOST tidak valid. Isi hanya IP publik atau hostname VPS (tanpa spasi), mis. 203.0.113.10"; exit 1
fi
if ! printf '%s' "$PORT" | grep -Eq '^[0-9]+$'; then
  echo "::error::STAGING_SSH_PORT harus berupa angka."; exit 1
fi
