#!/usr/bin/env bash
# Cek cepat setelah deploy.  Pemakaian: ./smoke-test.sh https://staging.kantorbhaga.id penguji 'sandi-penguji' [verify-token]
set -euo pipefail
URL="${1:?URL staging}"; USER="${2:?user basic auth}"; PASS="${3:?sandi basic auth}"; VERIFY="${4:-}"
# SMOKE_INSECURE=1 hanya untuk uji lokal dengan sertifikat internal Caddy (domain localhost).
curl() { if [ "${SMOKE_INSECURE:-}" = "1" ]; then command curl -k "$@"; else command curl "$@"; fi; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

echo "Smoke test $URL"
curl -fsS "$URL/healthz" | grep -q '"env":"staging"' && ok "healthz terbuka & APP_ENV=staging" || fail "healthz"
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/")
[ "$code" = "401" ] && ok "situs dilindungi basic auth" || fail "situs tidak dilindungi (HTTP $code)"
curl -fsS -u "$USER:$PASS" "$URL/api/public/config" | grep -q '"environment":"staging"' && ok "API publik dapat diakses dengan sandi penguji" || fail "API publik"
code=$(curl -s -o /dev/null -w '%{http_code}' -u "$USER:$PASS" "$URL/api/admin/dashboard")
[ "$code" = "401" ] && ok "API admin wajib login" || fail "API admin terbuka (HTTP $code)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$URL/webhooks/whatsapp")
[ "$code" = "401" ] && ok "webhook menolak permintaan tanpa tanda tangan" || fail "webhook (HTTP $code)"
if [ -n "$VERIFY" ]; then
  [ "$(curl -fsS "$URL/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=$VERIFY&hub.challenge=ok123")" = "ok123" ] && ok "verifikasi webhook Meta" || fail "verify token webhook"
fi
curl -fsSI "$URL/healthz" | grep -qi 'strict-transport-security' && ok "HSTS aktif" || echo "  - HSTS tidak terdeteksi (periksa NODE_ENV=production)"
echo "Selesai."
