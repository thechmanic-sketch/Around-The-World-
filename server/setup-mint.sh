#!/usr/bin/env bash
# TalentTrade: one-command setup for a Linux Mint (or Ubuntu) laptop.
#
# Sets up, on this computer:
#   1. Docker
#   2. Your own Jitsi video server (in Docker), locked so only TalentTrade account
#      holders can START meetings; guests with the link can still join
#   3. The TalentTrade account server, which also serves the website,
#      started automatically whenever the laptop starts
#
# Run it from the TalentTrade project folder (the one with index.html):
#     bash server/setup-mint.sh
# It asks for your password (sudo) to install software. Safe to run again: it keeps
# your existing secret and accounts.
#
# Afterwards, on this laptop or any phone/computer on the same Wi-Fi:
#     1. open https://<laptop-ip>:8443 once and accept the security warning
#     2. open https://<laptop-ip>:8090, accept the warning, and use TalentTrade
set -euo pipefail

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mXX  %s\033[0m\n' "$*" >&2; exit 1; }

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JITSI_DIR="${JITSI_DIR:-$HOME/talenttrade-jitsi}"
CFG_DIR="$HOME/.config/talenttrade"
ENV_FILE="$CFG_DIR/server.env"
APP_ID="talenttrade"
JITSI_HTTPS_PORT=8443
SITE_PORT=8090

# ---------------------------------------------------------------- checks
[ -f "$PROJECT/index.html" ] && [ -f "$PROJECT/server/talenttrade_server.py" ] \
  || die "Run this from the TalentTrade project folder (it should contain index.html)."
[ "$(id -u)" -ne 0 ] || die "Run it as your normal user, not with sudo. It will ask for your password when needed."
command -v apt-get >/dev/null || die "This script is for Linux Mint / Ubuntu (it needs apt)."
. /etc/os-release
say "Setting up TalentTrade on ${PRETTY_NAME:-this computer}"
command -v python3 >/dev/null || die "python3 is missing. Install it with: sudo apt install python3"

IP="${TT_IP:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
[ -n "$IP" ] || die "Couldn't find this laptop's Wi-Fi address. Connect to Wi-Fi, or run: TT_IP=192.168.x.x bash server/setup-mint.sh"
echo "Laptop address on your network: $IP"

# ---------------------------------------------------------------- 1. software
say "1/5 Installing Docker, git and tools (asks for your password)"
sudo apt-get update -qq
if ! sudo apt-get install -y -qq docker.io docker-compose-v2 git curl openssl rsync >/dev/null 2>&1; then
  warn "The 'docker-compose-v2' package wasn't found. Installing the rest; see server/README.md for Docker's own installer."
  sudo apt-get install -y -qq docker.io git curl openssl rsync
fi
sudo systemctl enable --now docker >/dev/null 2>&1 || true
sudo docker compose version >/dev/null 2>&1 \
  || die "Docker Compose isn't available. Install Docker from Docker's website (use \$UBUNTU_CODENAME=${UBUNTU_CODENAME:-?} where their steps say \$(lsb_release -cs)), then run this again."
sudo usermod -aG docker "$USER" || true

# ---------------------------------------------------------------- 2. shared secret
say "2/5 Creating the secret that links the account server and the video server"
mkdir -p "$CFG_DIR"; chmod 700 "$CFG_DIR"
if [ -f "$ENV_FILE" ] && grep -q '^TT_JITSI_APP_SECRET=' "$ENV_FILE"; then
  SECRET="$(grep '^TT_JITSI_APP_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
  echo "Keeping the existing secret in $ENV_FILE"
else
  SECRET="$(openssl rand -hex 32)"
fi

# ---------------------------------------------------------------- 3. Jitsi
say "3/5 Setting up the Jitsi video server in $JITSI_DIR"
if [ ! -d "$JITSI_DIR/.git" ]; then
  git clone -q https://github.com/jitsi/docker-jitsi-meet "$JITSI_DIR"
fi
cd "$JITSI_DIR"
git fetch -q --tags
LATEST="$(git describe --tags "$(git rev-list --tags --max-count=1)")"
git -c advice.detachedHead=false checkout -q "$LATEST"
echo "Using Jitsi release $LATEST"
if [ ! -f .env ]; then
  cp env.example .env
  ./gen-passwords.sh
fi

# set KEY=VALUE in .env: replaces the line (even if commented out) or adds it
set_env() {
  local key="$1" val="$2"
  if grep -qE "^#?[[:space:]]*${key}=" .env; then
    sed -i -E "s|^#?[[:space:]]*${key}=.*|${key}=${val}|" .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}
set_env HTTPS_PORT "$JITSI_HTTPS_PORT"
set_env PUBLIC_URL "https://$IP:$JITSI_HTTPS_PORT"
set_env JVB_ADVERTISE_IPS "$IP"
set_env TZ "Africa/Johannesburg"
set_env ENABLE_AUTH 1
set_env AUTH_TYPE jwt
set_env JWT_APP_ID "$APP_ID"
set_env JWT_APP_SECRET "$SECRET"
set_env ENABLE_GUESTS 1
chmod 600 .env

CONFIG_DIR="$(grep -E '^CONFIG=' .env | cut -d= -f2- || true)"
CONFIG_DIR="${CONFIG_DIR:-~/.jitsi-meet-cfg}"
CONFIG_DIR="${CONFIG_DIR/#\~/$HOME}"
mkdir -p "$CONFIG_DIR"/{web,transcripts,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb,jigasi,jibri}

echo "Starting Jitsi (the first time downloads a few hundred MB)..."
sudo docker compose up -d

# ---------------------------------------------------------------- 4. account server
say "4/5 Setting up the TalentTrade account server"
# Browsers only allow cameras on secure (https) pages, so the website needs HTTPS too.
# Make a certificate for this laptop's address (browsers will ask you to accept it once).
CERT="$CFG_DIR/site-cert.pem"; KEY="$CFG_DIR/site-key.pem"
if [ ! -f "$CERT" ] || ! openssl x509 -in "$CERT" -noout -text 2>/dev/null | grep -q "IP Address:$IP"; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout "$KEY" -out "$CERT" \
    -subj "/CN=TalentTrade ($IP)" -addext "subjectAltName=IP:$IP,DNS:localhost,IP:127.0.0.1" 2>/dev/null
  chmod 600 "$KEY"
fi
[ -f "$ENV_FILE" ] && cp "$ENV_FILE" "$ENV_FILE.bak" && chmod 600 "$ENV_FILE.bak"
umask 077
cat > "$ENV_FILE" <<EOF
# TalentTrade account server settings (private: contains the meeting-pass secret)
TT_HOST=0.0.0.0
TT_PORT=$SITE_PORT
TT_PUBLIC_URL=https://$IP:$SITE_PORT
TT_TLS_CERT=$CERT
TT_TLS_KEY=$KEY
TT_DB=$CFG_DIR/talenttrade.db
TT_REQUIRE_LOGIN_TO_HOST=1
TT_JITSI_DOMAIN=$IP:$JITSI_HTTPS_PORT
TT_JITSI_APP_ID=$APP_ID
TT_JITSI_APP_SECRET=$SECRET
# Email (optional): fill these in, then run: sudo systemctl restart talenttrade
# TT_SMTP_HOST=smtp.gmail.com
# TT_SMTP_PORT=587
# TT_SMTP_USER=you@gmail.com
# TT_SMTP_PASS=your-app-password
# TT_SMTP_FROM=TalentTrade <you@gmail.com>
EOF
umask 022
# keep email settings you added on an earlier run
if [ -f "$ENV_FILE.bak" ]; then grep '^TT_SMTP_' "$ENV_FILE.bak" >> "$ENV_FILE" || true; fi

sudo tee /etc/systemd/system/talenttrade.service >/dev/null <<EOF
[Unit]
Description=TalentTrade website and account server
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$PROJECT
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/python3 $PROJECT/server/talenttrade_server.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now talenttrade >/dev/null
sudo systemctl restart talenttrade

# Mint's firewall is off by default; if it's on, let the Wi-Fi network in.
if command -v ufw >/dev/null && sudo ufw status | grep -q "Status: active"; then
  say "Opening the firewall for the website and the video server"
  sudo ufw allow "$SITE_PORT"/tcp >/dev/null
  sudo ufw allow "$JITSI_HTTPS_PORT"/tcp >/dev/null
  sudo ufw allow 10000/udp >/dev/null
fi

# ---------------------------------------------------------------- 5. check
say "5/5 Checking everything is running"
ok=1
for i in $(seq 1 30); do curl -kfs "https://127.0.0.1:$SITE_PORT/api/config" >/dev/null && break; sleep 1; done
if curl -kfs "https://127.0.0.1:$SITE_PORT/api/config" | grep -q '"jitsiTokens": true'; then echo "Account server: running"; else warn "Account server isn't answering. See: journalctl -u talenttrade -n 50"; ok=0; fi
for i in $(seq 1 60); do curl -kfs "https://127.0.0.1:$JITSI_HTTPS_PORT/external_api.js" -o /dev/null && break; sleep 2; done
if curl -kfs "https://127.0.0.1:$JITSI_HTTPS_PORT/external_api.js" -o /dev/null; then echo "Video server: running"; else warn "Video server isn't answering yet. See: cd $JITSI_DIR && sudo docker compose logs --tail 50"; ok=0; fi

cat <<EOF

$( [ $ok = 1 ] && echo "All set!" || echo "Almost there: see the warnings above." )

On this laptop, or any phone/computer on the same Wi-Fi:
  1. Open  https://$IP:$JITSI_HTTPS_PORT   and accept the security warning
     (Advanced > Proceed / Accept the Risk). This is the video server.
  2. Open  https://$IP:$SITE_PORT   and accept the warning again. This is TalentTrade.
     Do both once on each phone or computer. (The warnings appear because the
     certificates are home-made; a real web address with Let's Encrypt removes them.)
  3. Sign up, then Start a meeting. Guests join from your invite link without an account.

Useful:
  Status / restart website:   systemctl status talenttrade   |   sudo systemctl restart talenttrade
  Website messages:           journalctl -u talenttrade -f
  Video server:               cd $JITSI_DIR && sudo docker compose ps   (or: logs -f)
  Settings and secret:        $ENV_FILE   (keep private)
  Accounts database:          $CFG_DIR/talenttrade.db
  Site certificate:           $CERT

This works on your own Wi-Fi. To let people join from anywhere, see
server/README.md, "Putting it on the internet".
EOF
