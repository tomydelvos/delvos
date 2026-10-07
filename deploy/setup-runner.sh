#!/usr/bin/env bash
# Pasang GitHub Actions self-hosted runner di VPS staging — deploy tanpa perlu membuka port SSH ke internet.
# Runner hanya membuat koneksi KELUAR (HTTPS) ke GitHub, jadi tetap bekerja walau firewall memblokir SSH dari luar.
#
# Jalankan sebagai root di VPS (lewat konsol web penyedia atau SSH dari komputer Anda):
#   curl -fsSL https://raw.githubusercontent.com/tomydelvos/delvos/claude/law-office-ai-agent-c8ckgb/deploy/setup-runner.sh -o setup-runner.sh
#   sudo bash setup-runner.sh <TOKEN>
# <TOKEN>: GitHub → repo → Settings → Actions → Runners → New self-hosted runner → Linux, salin nilai setelah "--token"
#          (berlaku 1 jam; JANGAN kirim token lewat chat).
#
# Pengaman:
# - Runner berjalan sebagai user "kantor-runner" tanpa sudo umum; ia hanya boleh menjalankan
#   /usr/local/sbin/kantor-deploy (deploy/status/logs untuk branch staging).
# - Skrip "job started" menolak job apa pun selain workflow deploy-staging.yml dari push/dispatch di branch staging,
#   sehingga pull request (termasuk dari fork) tidak bisa memakai runner ini.
set -euo pipefail

TOKEN="${1:-${RUNNER_TOKEN:-}}"
REPO_SLUG="${REPO_SLUG:-tomydelvos/delvos}"
BRANCH="${BRANCH:-claude/law-office-ai-agent-c8ckgb}"
LABEL="${LABEL:-kantor-staging}"
RUNNER_USER=kantor-runner
RUNNER_DIR=/opt/actions-runner
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

[ "$(id -u)" = 0 ] || { echo "Jalankan sebagai root (sudo)."; exit 1; }
[ -n "$TOKEN" ] || { echo "Pemakaian: sudo bash setup-runner.sh <TOKEN>  (token dari Settings → Actions → Runners → New self-hosted runner)"; exit 1; }
printf '%s' "$BRANCH" | grep -Eq '^[A-Za-z0-9._/-]+$' || { echo "BRANCH tidak valid."; exit 1; }

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; *) echo "Arsitektur tidak didukung: $(uname -m)"; exit 1;;
esac

say "1/5 Paket dasar"
apt-get update -qq && apt-get install -y -qq curl tar git ca-certificates >/dev/null

say "2/5 User runner"
id "$RUNNER_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$RUNNER_USER"

say "3/5 Perintah deploy terbatas (/usr/local/sbin/kantor-deploy)"
cat > /usr/local/sbin/kantor-deploy <<EOF
#!/usr/bin/env bash
# Satu-satunya perintah root yang boleh dijalankan runner (via sudo). Dibuat oleh deploy/setup-runner.sh.
#   kantor-deploy deploy   < staging.env   ambil branch staging terbaru lalu jalankan installer non-interaktif
#   kantor-deploy status                   revisi yang berjalan + healthz lokal
#   kantor-deploy logs                     60 baris log terakhir app & caddy
set -euo pipefail
REPO="https://github.com/$REPO_SLUG.git"; BRANCH="$BRANCH"; DIR=/opt/kantor
export BRANCH DIR   # read by install-staging.sh
compose() { cd "\$DIR/deploy" && docker compose -f docker-compose.staging.yml --env-file staging.env "\$@"; }
case "\${1:-}" in
  deploy)
    umask 077; envf=\$(mktemp /root/kantor-staging.env.XXXXXX); trap 'rm -f "\$envf"' EXIT
    cat > "\$envf"
    grep -q '^STAGING_DOMAIN=' "\$envf" || { rm -f "\$envf"; echo "STAGING_ENV kosong/tidak valid (STAGING_DOMAIN tidak ada)."; exit 1; }
    if [ -d "\$DIR/.git" ]; then git -C "\$DIR" fetch -q origin "\$BRANCH" && git -C "\$DIR" checkout -q "\$BRANCH" && git -C "\$DIR" reset -q --hard "origin/\$BRANCH"
    else git clone -q --branch "\$BRANCH" "\$REPO" "\$DIR"; fi
    ENV_SOURCE="\$envf" bash "\$DIR/deploy/install-staging.sh" </dev/null
    ;;
  status)
    echo "Revisi: \$(git -C "\$DIR" rev-parse --short HEAD)"
    d=\$(grep -E '^STAGING_DOMAIN=' "\$DIR/deploy/staging.env" | head -1 | cut -d= -f2- | tr -d "'\"")
    curl -fsS --max-time 10 --resolve "\$d:443:127.0.0.1" "https://\$d/healthz"; echo
    ;;
  logs) compose logs --tail=60 app caddy ;;
  *) echo "Pemakaian: kantor-deploy deploy|status|logs"; exit 2 ;;
esac
EOF
chmod 755 /usr/local/sbin/kantor-deploy
echo "$RUNNER_USER ALL=(root) NOPASSWD: /usr/local/sbin/kantor-deploy" > /etc/sudoers.d/kantor-runner
chmod 440 /etc/sudoers.d/kantor-runner
visudo -cf /etc/sudoers.d/kantor-runner >/dev/null

# Root-owned so jobs cannot rewrite it.
mkdir -p /etc/kantor-runner
cat > /etc/kantor-runner/job-guard.sh <<EOF
#!/usr/bin/env bash
# Runs before every job (ACTIONS_RUNNER_HOOK_JOB_STARTED); a non-zero exit fails the job before any step runs.
want_ref="refs/heads/$BRANCH"
want_wf="$REPO_SLUG/.github/workflows/deploy-staging.yml@\$want_ref"
deny() { echo "Runner kantor-staging menolak job ini: \$1"; exit 1; }
[ "\${GITHUB_REPOSITORY:-}" = "$REPO_SLUG" ] || deny "repositori \${GITHUB_REPOSITORY:-?}"
case "\${GITHUB_EVENT_NAME:-}" in push|workflow_dispatch) ;; *) deny "event \${GITHUB_EVENT_NAME:-?}";; esac
[ "\${GITHUB_REF:-}" = "\$want_ref" ] || deny "ref \${GITHUB_REF:-?}"
[ "\${GITHUB_WORKFLOW_REF:-}" = "\$want_wf" ] || deny "workflow \${GITHUB_WORKFLOW_REF:-?}"
echo "Job diizinkan: \$GITHUB_EVENT_NAME \$GITHUB_REF"
EOF
chmod 755 /etc/kantor-runner/job-guard.sh

say "4/5 Mengunduh GitHub Actions runner"
VER=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | grep -m1 '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
[ -n "$VER" ] || { echo "Gagal membaca versi runner terbaru."; exit 1; }
if [ -f "$RUNNER_DIR/svc.sh" ]; then (cd "$RUNNER_DIR" && ./svc.sh stop >/dev/null 2>&1 && ./svc.sh uninstall >/dev/null 2>&1) || true; fi
mkdir -p "$RUNNER_DIR"
curl -fsSL "https://github.com/actions/runner/releases/download/v$VER/actions-runner-linux-$ARCH-$VER.tar.gz" | tar xz -C "$RUNNER_DIR"
"$RUNNER_DIR/bin/installdependencies.sh" >/dev/null
chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_DIR"

say "5/5 Mendaftarkan runner ke $REPO_SLUG (label: $LABEL)"
cd "$RUNNER_DIR"
sudo -u "$RUNNER_USER" ./config.sh --unattended --replace \
  --url "https://github.com/$REPO_SLUG" --token "$TOKEN" \
  --name "kantor-staging-$(hostname -s)" --labels "$LABEL" --work _work
grep -q '^ACTIONS_RUNNER_HOOK_JOB_STARTED=' .env 2>/dev/null || echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=/etc/kantor-runner/job-guard.sh" >> .env
# Root-owned: the runner only needs to read it, and jobs must not be able to drop the guard hook.
chown root:root .env && chmod 644 .env
./svc.sh install "$RUNNER_USER" >/dev/null
./svc.sh start >/dev/null

cat <<EOF

────────────────────────────────────────────────────────
 Runner terpasang dan berjalan sebagai layanan: $(./svc.sh status 2>/dev/null | grep -m1 -Eo 'active \(running\)|inactive|failed' || echo "lihat: cd $RUNNER_DIR && ./svc.sh status")
 Nama/label : kantor-staging-$(hostname -s) / $LABEL
 Cek di     : GitHub → Settings → Actions → Runners (status "Idle")
 Langkah berikut: kabari Claude "runner sudah terpasang" — deploy akan berjalan lewat runner ini.
 Untuk mencabut: cd $RUNNER_DIR && ./svc.sh stop && ./svc.sh uninstall && sudo -u $RUNNER_USER ./config.sh remove --token <TOKEN-BARU>
────────────────────────────────────────────────────────
EOF
