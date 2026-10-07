#!/usr/bin/env bash
# Installer staging satu perintah untuk VPS Ubuntu/Debian baru (jalankan sebagai root):
#   curl -fsSL https://raw.githubusercontent.com/tomydelvos/delvos/claude/law-office-ai-agent-c8ckgb/deploy/install-staging.sh | bash
# atau setelah clone:  sudo bash deploy/install-staging.sh
#
# Yang dilakukan: pasang Docker & firewall, clone repo ke /opt/kantor, menanyakan domain + kredensial,
# membuat rahasia acak & hash sandi penguji, menjalankan stack, lalu smoke test.
# Aman dijalankan ulang: staging.env yang sudah ada tidak ditimpa.
#
# Mode non-interaktif (dipakai GitHub Actions): ENV_SOURCE=/path/ke/staging.env — file itu disalin
# (menimpa) ke deploy/staging.env, lalu tidak ada pertanyaan. Bila berisi STAGING_BASIC_AUTH_PASSWORD
# tanpa STAGING_BASIC_AUTH_HASH, hash dibuat di server dan sandi teks biasa dihapus dari file.
set -euo pipefail

REPO="${REPO:-https://github.com/tomydelvos/delvos.git}"
BRANCH="${BRANCH:-claude/law-office-ai-agent-c8ckgb}"
DIR="${DIR:-/opt/kantor}"
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
ask() { local v; read -r -p "$1${2:+ [$2]}: " v </dev/tty; echo "${v:-${2:-}}"; }
# Single-quote values so docker compose never interpolates "$" or treats "#" as a comment.
q() { case "$1" in *\'*) echo "Nilai tidak boleh mengandung tanda kutip tunggal (')." >&2; exit 1;; esac; printf "'%s'" "$1"; }
ask_secret() { local v; read -r -s -p "$1: " v </dev/tty; echo >&2; echo "$v"; }

[ "$(id -u)" = 0 ] || { echo "Jalankan sebagai root (sudo)."; exit 1; }
# One deploy at a time (SSH deploy, auto-update timer, manual run). auto-update.sh already holds it.
if [ -z "${NO_LOCK:-}" ]; then exec 9>/var/lock/kantor-deploy.lock; flock -w 1800 9 || { echo "Deploy lain masih berjalan."; exit 1; }; fi
# Secrets are printed only to an interactive terminal, never to CI/journal logs.
SHOW_SECRETS=false; [ -t 1 ] && [ -z "${ENV_SOURCE:-}" ] && SHOW_SECRETS=true
val() { grep -E "^$1=" staging.env | head -1 | cut -d= -f2- | sed -e "s/^'//" -e "s/'$//" -e 's/^"//' -e 's/"$//' || true; }

say "1/6 Memasang Docker, git, dan firewall"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
apt-get update -qq && apt-get install -y -qq git curl ufw openssl >/dev/null
# Keep every port sshd listens on open (plus the one we are connected through), even if it is not 22,
# before enabling the firewall — the installer may run from the auto-update timer without an SSH session.
SSH_PORTS="${SSH_PORT:-} $(echo "${SSH_CONNECTION:-}" | awk '{print $4}') $(ss -Htlnp 2>/dev/null | awk '/"sshd"/ {n=split($4,a,":"); print a[n]}' || true) $(sshd -T 2>/dev/null | awk '$1=="port" {print $2}' || true)"
for p in $SSH_PORTS 22; do case "$p" in ''|*[!0-9]*) ;; *) ufw allow "$p/tcp" >/dev/null;; esac; done
ufw allow OpenSSH >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443 >/dev/null && ufw --force enable >/dev/null

say "2/6 Mengambil kode"
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" pull -q --ff-only origin "$BRANCH"
else git clone -q --branch "$BRANCH" "$REPO" "$DIR"; fi
cd "$DIR/deploy"

if [ -n "${ENV_SOURCE:-}" ]; then
  [ -f "$ENV_SOURCE" ] || { echo "ENV_SOURCE tidak ditemukan: $ENV_SOURCE"; exit 1; }
  install -m 600 "$ENV_SOURCE" staging.env && rm -f "$ENV_SOURCE"
fi

# Fill in derived values: basic-auth hash from a plain password, random session secret.
finalize_env() {
  local pw hash
  pw=$(grep -E '^STAGING_BASIC_AUTH_PASSWORD=' staging.env | head -1 | cut -d= -f2- | sed -e "s/^'//" -e "s/'$//" -e 's/^"//' -e 's/"$//' || true)
  if [ -n "$pw" ] && ! grep -qE "^STAGING_BASIC_AUTH_HASH=.+" staging.env; then
    hash=$(docker run --rm caddy:2 caddy hash-password --plaintext "$pw")
    sed -i '/^STAGING_BASIC_AUTH_HASH=/d' staging.env
    echo "STAGING_BASIC_AUTH_HASH='$hash'" >> staging.env
  fi
  sed -i '/^STAGING_BASIC_AUTH_PASSWORD=/d' staging.env
  if ! grep -qE "^SESSION_SECRET=.+" staging.env; then
    sed -i '/^SESSION_SECRET=/d' staging.env
    echo "SESSION_SECRET='$(openssl rand -base64 32)'" >> staging.env
  fi
  chmod 600 staging.env
}

PASTED=""
if [ ! -f staging.env ] && [ -z "${ENV_SOURCE:-}" ] && [ "$(ask "Sudah punya isi STAGING_ENV (yang juga diisi di GitHub Secrets) untuk ditempel? (y/n)" n)" = y ]; then
  echo "Tempel isinya, lalu ketik END di baris tersendiri dan tekan Enter:"
  # Read into a temp file so an interrupted paste never leaves a partial staging.env behind.
  exec 8</dev/tty; umask 077; tmp=$(mktemp staging.env.XXXXXX); trap 'rm -f "$tmp"' EXIT
  while IFS= read -r line <&8; do [ "$line" = END ] && break; printf '%s\n' "$line" >> "$tmp"; done
  umask 022; exec 8<&-
  grep -q '^STAGING_DOMAIN=' "$tmp" || { echo "STAGING_DOMAIN tidak ditemukan pada isi yang ditempel."; exit 1; }
  mv "$tmp" staging.env
  PASTED=1
fi

if [ ! -f staging.env ]; then
  say "3/6 Konfigurasi (kosongkan bila belum punya — kanal itu akan berjalan simulasi)"
  DOMAIN=$(ask "Domain staging (sudah diarahkan ke IP server ini)" "staging.kantoranda.id")
  ACME=$(ask "Email untuk sertifikat HTTPS")
  TESTER=$(ask "Username penguji (pelindung situs)" "penguji")
  TESTER_PW=$(ask_secret "Sandi penguji (pelindung situs)")
  ALLOW=$(ask "Penerima yang diizinkan (email/@domain/nomor WA, pisah koma)")
  GMAIL=$(ask "Gmail staging (kosongkan = simulasi)")
  GMAIL_PW=""; [ -n "$GMAIL" ] && GMAIL_PW=$(ask_secret "App Password Gmail")
  WA_TOKEN=$(ask_secret "WhatsApp Cloud token (kosongkan = simulasi)")
  WA_PID=""; WA_SECRET=""; [ -n "$WA_TOKEN" ] && { WA_PID=$(ask "WhatsApp Phone number ID"); WA_SECRET=$(ask_secret "Meta App Secret"); }
  TG_TOKEN=$(ask_secret "Telegram bot token (kosongkan = simulasi)")
  TG_CHAT=""; [ -n "$TG_TOKEN" ] && TG_CHAT=$(ask "Telegram chat id grup (-100...)")
  AI_KEY=$(ask_secret "Anthropic API key (kosongkan = AI nonaktif)")

  HASH=$(docker run --rm caddy:2 caddy hash-password --plaintext "$TESTER_PW")
  ADMIN_PW=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)
  VERIFY=$(openssl rand -hex 16)

  umask 077
  cat > staging.env <<EOF
STAGING_DOMAIN=$DOMAIN
ACME_EMAIL=$(q "$ACME")
STAGING_BASIC_AUTH_USER=$TESTER
STAGING_BASIC_AUTH_HASH='$HASH'
PUBLIC_URL=https://$DOMAIN
TZ_OFFICE=Asia/Jakarta
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$ADMIN_PW
SESSION_SECRET=$(q "$(openssl rand -base64 32)")
STAGING_ALLOWED_RECIPIENTS=$(q "$ALLOW")
EMAIL_PROVIDER=gmail
GMAIL_USER=$(q "$GMAIL")
GMAIL_APP_PASSWORD=$(q "$GMAIL_PW")
MAIL_FROM="Kantor Hukum (STAGING) <$GMAIL>"
OFFICE_DOMAIN=${GMAIL#*@}
WA_PROVIDER=$([ -n "$WA_TOKEN" ] && echo meta || echo log)
WA_META_TOKEN=$(q "$WA_TOKEN")
WA_META_PHONE_NUMBER_ID=$(q "$WA_PID")
WA_META_MODE=auto
WA_META_TEMPLATE_NAME=notifikasi_kantor
WA_META_TEMPLATE_LANG=id
WA_META_VERIFY_TOKEN=$VERIFY
WA_META_APP_SECRET=$(q "$WA_SECRET")
WA_NOTIFY_CLIENT=true
TELEGRAM_BOT_TOKEN=$(q "$TG_TOKEN")
TELEGRAM_CHAT_IDS=$(q "$TG_CHAT")
AI_ENABLED=true
ANTHROPIC_API_KEY=$(q "$AI_KEY")
AI_MODEL=claude-opus-5-5
EOF
  umask 022
else
  say "3/6 staging.env sudah ada — dipakai apa adanya"
  ADMIN_PW="(lihat ADMIN_PASSWORD di staging.env, atau sandi yang sudah Anda ganti)"
  TESTER_PW=""; [ -n "$PASTED" ] && TESTER_PW=$(val STAGING_BASIC_AUTH_PASSWORD)
  DOMAIN=$(val STAGING_DOMAIN); TESTER=$(val STAGING_BASIC_AUTH_USER); VERIFY=$(val WA_META_VERIFY_TOKEN)
fi
$SHOW_SECRETS || { ADMIN_PW="(lihat ADMIN_PASSWORD di staging.env)"; }

finalize_env

say "4/6 Membangun & menjalankan (beberapa menit pada kali pertama)"
# Baked into the image and reported by /healthz so a deploy can be verified from outside.
export GIT_SHA; GIT_SHA=$(git -C "$DIR" rev-parse --short HEAD)
docker compose -f docker-compose.staging.yml --env-file staging.env up -d --build

say "5/6 Menunggu aplikasi & sertifikat HTTPS"
for i in $(seq 1 30); do curl -fsS "https://$DOMAIN/healthz" >/dev/null 2>&1 && break; sleep 5; done

say "6/6 Smoke test"
if [ -n "$TESTER_PW" ]; then ./smoke-test.sh "https://$DOMAIN" "$TESTER" "$TESTER_PW" "$VERIFY" || true
else echo "Jalankan: ./smoke-test.sh https://$DOMAIN $TESTER '<sandi-penguji>' <WA_META_VERIFY_TOKEN>"; fi

# An empty crontab makes grep -v exit 1; tolerate it so the backup job is still installed.
# Pull-based auto-update: redeploy whenever the branch moves (no inbound SSH needed). AUTO_UPDATE=0 to skip.
if [ -z "${AUTO_UPDATE_RUN:-}" ] && [ "${AUTO_UPDATE:-1}" != 0 ]; then
  cat > /etc/systemd/system/kantor-auto-update.service <<UNIT
[Unit]
Description=Kantor staging: deploy commit baru dari GitHub
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=DIR=$DIR
ExecStart=/bin/bash $DIR/deploy/auto-update.sh
TimeoutStartSec=45min
UNIT
  cat > /etc/systemd/system/kantor-auto-update.timer <<UNIT
[Unit]
Description=Kantor staging: cek commit baru tiap 2 menit

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload && systemctl enable --now kantor-auto-update.timer >/dev/null 2>&1 || echo "Peringatan: timer auto-update gagal dipasang."
fi
mkdir -p /var/lib/kantor && git -C "$DIR" rev-parse HEAD > /var/lib/kantor/deployed

( { crontab -l 2>/dev/null | grep -v 'scripts/backup.js'; } || true; echo "30 1 * * * cd $DIR/deploy && docker compose -f docker-compose.staging.yml --env-file staging.env exec -T app node scripts/backup.js >/dev/null 2>&1" ) | crontab -

cat <<EOF

────────────────────────────────────────────────────────
 Staging berjalan:  https://$DOMAIN
 Panel admin     :  https://$DOMAIN/admin/
 Login situs     :  $TESTER / (sandi penguji Anda)
 Login admin     :  admin / $ADMIN_PW   ← segera ganti di "Akun Saya"
 Webhook WhatsApp:  https://$DOMAIN/webhooks/whatsapp
 Verify token    :  $($SHOW_SECRETS && echo "$VERIFY" || echo "(lihat WA_META_VERIFY_TOKEN di staging.env)")
 Auto-update     :  tiap 2 menit dari branch $BRANCH (journalctl -u kantor-auto-update)
 Cadangan harian :  01.30 (cron)
 Konfigurasi     :  $DIR/deploy/staging.env
────────────────────────────────────────────────────────
Langkah berikut: ikuti daftar uji di deploy/DEPLOY-STAGING.md (bagian 6).
EOF
