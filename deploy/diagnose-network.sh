#!/usr/bin/env bash
# Network diagnosis from a GitHub-hosted runner (or any Linux box) towards the staging VPS.
# Usage: diagnose-network.sh <host> [ssh-port] [staging-domain] [known_hosts-file]
# Prints findings without echoing the host itself (it is a masked secret in Actions logs) and,
# when GITHUB_OUTPUT is set, writes ssh_reachable=true|false.
set -uo pipefail
HOST="${1:-}"; PORT="${2:-22}"; DOMAIN="${3:-}"; KNOWN="${4:-}"
PORT="${PORT:-22}"
out() { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1" >> "$GITHUB_OUTPUT"; return 0; }
say() { printf '%s\n' "$*"; }
problems=()

is_ipv4() { printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; }
private_ipv4() {
  local a b; IFS=. read -r a b _ _ <<<"$1"
  [ "$a" = 10 ] || [ "$a" = 127 ] || [ "$a" = 0 ] || { [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ]; } ||
    { [ "$a" = 192 ] && [ "$b" = 168 ]; } || { [ "$a" = 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ]; } ||
    { [ "$a" = 169 ] && [ "$b" = 254 ]; }
}
resolve() { getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u; }

# open | closed | filtered — via bash /dev/tcp so no extra packages are needed.
probe() {
  local err rc
  err=$(timeout 6 bash -c "exec 3<>/dev/tcp/$1/$2" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then echo open
  elif [ $rc -eq 124 ]; then echo filtered
  elif printf '%s' "$err" | grep -qi refused; then echo closed
  else echo filtered; fi
}
banner() { timeout 6 bash -c "exec 3<>/dev/tcp/$1/$2; head -c 40 <&3" 2>/dev/null | tr -d '\r\n' | grep -Eo '^SSH-[0-9.]+' || true; }

say "── Diagnosis jaringan GitHub Actions → VPS ──"
if [ -z "$HOST" ]; then say "STAGING_SSH_HOST kosong."; out ssh_reachable=false; exit 0; fi

if is_ipv4 "$HOST"; then
  IPS="$HOST"; say "• Host berupa alamat IPv4."
else
  IPS=$(resolve "$HOST")
  if [ -z "$IPS" ]; then
    say "• Host berupa nama domain tetapi TIDAK dapat di-resolve dari internet."
    problems+=("STAGING_SSH_HOST tidak dikenal DNS. Isi dengan IP publik VPS.")
    IPS=""
  else
    say "• Host berupa nama domain, ter-resolve ke $(echo "$IPS" | wc -l | tr -d ' ') alamat."
  fi
fi
IP=$(echo "$IPS" | head -1)

if [ -n "$IP" ] && private_ipv4 "$IP"; then
  say "• Alamat tersebut adalah IP PRIVAT/INTERNAL (10.x, 172.16-31.x, 192.168.x, 100.64-127.x, …)."
  problems+=("STAGING_SSH_HOST berisi IP privat yang tidak bisa dijangkau dari internet. Gunakan IP PUBLIK VPS (lihat dashboard penyedia: 'Public IP' / 'IPv4').")
fi

if [ -n "$KNOWN" ] && [ -s "$KNOWN" ] && command -v ssh-keygen >/dev/null; then
  key="$HOST"; [ "$PORT" != 22 ] && key="[$HOST]:$PORT"
  if ssh-keygen -F "$key" -f "$KNOWN" >/dev/null 2>&1; then say "• STAGING_SSH_KNOWN_HOSTS cocok dengan host & port ini."
  else
    say "• STAGING_SSH_KNOWN_HOSTS TIDAK memuat host/port ini (mungkin dibuat untuk IP/port lain, atau dari dalam VPS dengan localhost)."
    problems+=("Isi STAGING_SSH_KNOWN_HOSTS tidak cocok dengan STAGING_SSH_HOST/PORT. Hapus secret itu atau buat ulang dengan: ssh-keyscan -p $PORT <IP_PUBLIK_VPS>")
  fi
fi

if [ -n "$DOMAIN" ] && [ -n "$IP" ]; then
  DIPS=$(resolve "$DOMAIN")
  if [ -z "$DIPS" ]; then say "• Domain staging belum mengarah ke mana pun (record A belum ada/menyebar)."
    problems+=("Record A untuk domain staging belum ada. Arahkan ke IP publik VPS (HTTPS & webhook butuh ini).")
  elif echo "$DIPS" | grep -qxF "$IP"; then say "• Domain staging mengarah ke IP yang sama dengan STAGING_SSH_HOST."
  else say "• Domain staging mengarah ke IP yang BERBEDA dari STAGING_SSH_HOST."
    problems+=("Domain staging dan STAGING_SSH_HOST menunjuk server berbeda. Pastikan keduanya IP publik VPS yang sama (kecuali domain sengaja lewat proxy/CDN).")
  fi
fi

if [ -n "$IP" ]; then
  if curl -sI -m 8 "http://$IP/" 2>/dev/null | grep -qi '^server: *cloudflare'; then
    say "• Alamat tersebut milik Cloudflare (proxy oranye), bukan VPS."
    problems+=("STAGING_SSH_HOST mengarah ke proxy Cloudflare yang tidak meneruskan SSH. Gunakan IP asli VPS.")
  fi
  declare -A st
  ports="$PORT"; [ "$PORT" != 22 ] && ports="$ports 22"; ports="$ports 80 443"
  for p in $ports; do st[$p]=$(probe "$IP" "$p"); say "• Port $p: ${st[$p]}"; done
  ssh_state="${st[$PORT]}"
  if [ "$ssh_state" = open ]; then
    b=$(banner "$IP" "$PORT")
    if [ -n "$b" ]; then say "• Port $PORT menjawab sebagai server SSH ($b)."; out ssh_reachable=true
    else say "• Port $PORT terbuka tetapi tidak menjawab seperti SSH."; problems+=("Port $PORT terbuka tetapi bukan SSH. Periksa STAGING_SSH_PORT."); out ssh_reachable=false; fi
  else
    out ssh_reachable=false
    web_up=false; { [ "${st[80]}" = open ] || [ "${st[443]}" = open ]; } && web_up=true
    if [ "$ssh_state" = closed ]; then
      problems+=("Port $PORT ditolak (refused): server hidup tetapi SSH tidak berjalan di port itu. Cek di konsol VPS: sudo ss -tlnp | grep ssh — lalu isi STAGING_SSH_PORT sesuai port yang tampil.")
    elif $web_up; then
      problems+=("Server terjangkau (port web terbuka) tetapi port SSH $PORT diblokir untuk IP luar. Penyebab umum: firewall/security group di dashboard penyedia hanya mengizinkan IP Anda, atau fail2ban. Buka TCP $PORT dari 0.0.0.0/0 — atau gunakan mode runner (lihat deploy/DEPLOY-STAGING.md, tanpa perlu membuka SSH).")
    else
      problems+=("Tidak ada port yang menjawab (SSH, 80, 443 semuanya timeout). Penyebab umum: IP salah, VPS mati, atau firewall penyedia memblokir semua akses dari luar. Cocokkan IP dengan dashboard dan buka TCP $PORT, 80, 443.")
    fi
  fi
else
  out ssh_reachable=false
fi

if [ ${#problems[@]} -eq 0 ]; then say "Tidak ditemukan masalah jaringan."
else
  say ""; say "Temuan:"
  for p in "${problems[@]}"; do say "  ✗ $p"; [ -n "${GITHUB_ACTIONS:-}" ] && echo "::warning::$p"; done
fi
exit 0
