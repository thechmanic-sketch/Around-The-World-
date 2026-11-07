#!/usr/bin/env bash
# TalentTrade: one-command setup for a cloud server (Ubuntu 22.04 or 24.04),
# so people anywhere can sign up, log in and host meetings.
#
# Before running, you need:
#   - a cloud server (about 8 CPU cores, 16 GB memory, 1 Gbps for ~250-person calls)
#   - a domain, with two DNS "A" records pointing at the server's public IP:
#       talenttrade.co.za       -> the website and accounts
#       meet.talenttrade.co.za  -> the video server
#   - the cloud provider's firewall letting in: 22/tcp, 80/tcp, 443/tcp, 10000/udp
#
# Run it on the server, from the TalentTrade project folder, as a normal sudo user:
#     bash server/setup-cloud.sh talenttrade.co.za meet.talenttrade.co.za you@example.com
#
# Optional email for sign-up confirmations and password resets (strongly recommended
# for a public site); set these before running, or add them to the settings file later:
#     export TT_SMTP_HOST=smtp.gmail.com TT_SMTP_PORT=587 TT_SMTP_USER=... TT_SMTP_PASS=... TT_SMTP_FROM='TalentTrade <...>'
#
# Safe to run again: keeps the secret, accounts, certificates and email settings.
set -euo pipefail

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mXX  %s\033[0m\n' "$*" >&2; exit 1; }

SITE="${1:-}"; MEET="${2:-}"; EMAIL="${3:-}"
[ -n "$SITE" ] && [ -n "$MEET" ] && [ -n "$EMAIL" ] \
  || die "Usage: bash server/setup-cloud.sh <site-domain> <meet-domain> <your-email>
   e.g. bash server/setup-cloud.sh talenttrade.co.za meet.talenttrade.co.za you@example.com"
valid_name() { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; }
valid_name "$SITE" || die "'$SITE' doesn't look like a domain name."
valid_name "$MEET" || die "'$MEET' doesn't look like a domain name."
[ "$SITE" != "$MEET" ] || die "The website and the video server need two different names (e.g. talenttrade.co.za and meet.talenttrade.co.za)."
[[ "$EMAIL" == *@*.* ]] || die "'$EMAIL' doesn't look like an email address (Let's Encrypt uses it for certificate notices)."

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JITSI_DIR="${JITSI_DIR:-$HOME/talenttrade-jitsi}"
CFG_DIR="$HOME/.config/talenttrade"
ENV_FILE="$CFG_DIR/server.env"
APP_ID="talenttrade"
SITE_PORT=8090      # account server, only reachable through nginx
JITSI_LOCAL=8000    # Jitsi web, only reachable through nginx

# ---------------------------------------------------------------- checks
[ -f "$PROJECT/index.html" ] && [ -f "$PROJECT/server/talenttrade_server.py" ] \
  || die "Run this from the TalentTrade project folder (it should contain index.html)."
[ "$(id -u)" -ne 0 ] || die "Run it as a normal user with sudo rights (e.g. 'ubuntu'), not as root."
command -v apt-get >/dev/null || die "This script is for Ubuntu (it needs apt)."
. /etc/os-release
say "Setting up TalentTrade on ${PRETTY_NAME:-this server}"
command -v python3 >/dev/null || sudo apt-get install -y -qq python3

CPUS="$(nproc)"; MEM_GB="$(awk '/MemTotal/ {printf "%d", $2/1024/1024 + 0.5}' /proc/meminfo)"
echo "Server size: $CPUS CPU cores, ${MEM_GB} GB memory"
if [ "$CPUS" -lt 8 ] || [ "$MEM_GB" -lt 15 ]; then
  warn "That's smaller than the suggested 8 cores / 16 GB for ~250-person calls. Fine for testing and smaller meetings."
fi

say "Checking the domain names point at this server"
sudo apt-get update -qq
sudo apt-get install -y -qq curl dnsutils >/dev/null
PUBLIC_IP="${TT_PUBLIC_IP:-$(curl -4fs https://api.ipify.org || curl -4fs https://ifconfig.me || true)}"
[ -n "$PUBLIC_IP" ] || die "Couldn't find this server's public IP. Run again with: TT_PUBLIC_IP=x.x.x.x bash server/setup-cloud.sh ..."
echo "This server's public IP: $PUBLIC_IP"
for name in "$SITE" "$MEET"; do
  got="$(dig +short A "$name" @1.1.1.1 | tail -1)"
  if [ "$got" != "$PUBLIC_IP" ]; then
    die "$name points to '${got:-nothing}', not $PUBLIC_IP. Add/fix its DNS A record, wait a few minutes, then run this again."
  fi
  echo "  $name -> $got  OK"
done

# ---------------------------------------------------------------- 1. software
say "1/6 Installing Docker, nginx, Let's Encrypt and tools"
if ! sudo apt-get install -y -qq docker.io docker-compose-v2 git openssl nginx certbot python3-certbot-nginx ufw >/dev/null 2>&1; then
  warn "The 'docker-compose-v2' package wasn't found; installing the rest."
  sudo apt-get install -y -qq docker.io git openssl nginx certbot python3-certbot-nginx ufw
fi
sudo systemctl enable --now docker nginx >/dev/null 2>&1 || true
sudo docker compose version >/dev/null 2>&1 \
  || die "Docker Compose isn't available. Install Docker from Docker's website, then run this again."

# ---------------------------------------------------------------- 2. firewall
say "2/6 Firewall: allowing SSH, web (80/443) and video (10000/udp) only"
sudo ufw allow OpenSSH >/dev/null
sudo ufw allow 80/tcp >/dev/null
sudo ufw allow 443/tcp >/dev/null
sudo ufw allow 10000/udp >/dev/null
sudo ufw --force enable >/dev/null
echo "Also open the same ports in your cloud provider's firewall / security group."

# ---------------------------------------------------------------- 3. secret
say "3/6 Creating the secret that links the account server and the video server"
mkdir -p "$CFG_DIR"; chmod 700 "$CFG_DIR"
if [ -f "$ENV_FILE" ] && grep -q '^TT_JITSI_APP_SECRET=' "$ENV_FILE"; then
  SECRET="$(grep '^TT_JITSI_APP_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
  echo "Keeping the existing secret."
else
  SECRET="$(openssl rand -hex 32)"
fi

# ---------------------------------------------------------------- 4. Jitsi
say "4/6 Setting up the Jitsi video server for https://$MEET"
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
set_env() {
  local key="$1" val="$2"
  if grep -qE "^#?[[:space:]]*${key}=" .env; then
    sed -i -E "s|^#?[[:space:]]*${key}=.*|${key}=${val}|" .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}
# Jitsi's web page only listens on this server; nginx in front does HTTPS for the world.
set_env HTTP_PORT "127.0.0.1:$JITSI_LOCAL"
set_env HTTPS_PORT "127.0.0.1:8443"
set_env DISABLE_HTTPS 1
set_env ENABLE_HTTP_REDIRECT 0
set_env ENABLE_LETSENCRYPT 0
set_env PUBLIC_URL "https://$MEET"
set_env JVB_ADVERTISE_IPS "$PUBLIC_IP"
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

# ---------------------------------------------------------------- 5. account server
say "5/6 Setting up the TalentTrade website and account server for https://$SITE"
[ -f "$ENV_FILE" ] && cp "$ENV_FILE" "$ENV_FILE.bak" && chmod 600 "$ENV_FILE.bak"
umask 077
cat > "$ENV_FILE" <<EOF
# TalentTrade account server settings (private: contains the meeting-pass secret)
TT_HOST=127.0.0.1
TT_PORT=$SITE_PORT
TT_PUBLIC_URL=https://$SITE
TT_TRUST_PROXY=1
TT_DB=$CFG_DIR/talenttrade.db
TT_REQUIRE_LOGIN_TO_HOST=1
TT_JITSI_DOMAIN=$MEET
TT_JITSI_APP_ID=$APP_ID
TT_JITSI_APP_SECRET=$SECRET
EOF
# email: from this run's environment, else keep what was there before
for v in TT_SMTP_HOST TT_SMTP_PORT TT_SMTP_USER TT_SMTP_PASS TT_SMTP_FROM; do
  if [ -n "${!v:-}" ]; then printf '%s=%s\n' "$v" "${!v}" >> "$ENV_FILE"
  elif [ -f "$ENV_FILE.bak" ]; then grep "^$v=" "$ENV_FILE.bak" >> "$ENV_FILE" || true; fi
done
umask 022
grep -q '^TT_SMTP_HOST=' "$ENV_FILE" && EMAIL_ON=1 || EMAIL_ON=0

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
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now talenttrade >/dev/null
sudo systemctl restart talenttrade

# ---------------------------------------------------------------- 6. nginx + certificates
say "6/6 Web server and free HTTPS certificates (Let's Encrypt)"
sudo tee /etc/nginx/sites-available/talenttrade >/dev/null <<EOF
# TalentTrade: written by server/setup-cloud.sh (certbot adds the HTTPS parts)
map \$http_upgrade \$tt_connection_upgrade { default upgrade; '' close; }

server {
    listen 80;
    server_name $SITE;
    client_max_body_size 1m;
    location / {
        proxy_pass http://127.0.0.1:$SITE_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}

server {
    listen 80;
    server_name $MEET;
    location / {
        proxy_pass http://127.0.0.1:$JITSI_LOCAL;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$tt_connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 900s;
        tcp_nodelay on;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/talenttrade /etc/nginx/sites-enabled/talenttrade
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx --non-interactive --agree-tos --redirect -m "$EMAIL" -d "$SITE" -d "$MEET" --keep-until-expiring
sudo systemctl reload nginx

# ---------------------------------------------------------------- check
say "Checking everything from the internet side"
ok=1
for i in $(seq 1 30); do curl -fs "https://$SITE/api/config" >/dev/null && break; sleep 2; done
if curl -fs "https://$SITE/api/config" | grep -q '"jitsiTokens": true'; then echo "Website and accounts: https://$SITE  OK"; else warn "https://$SITE isn't answering. See: journalctl -u talenttrade -n 50"; ok=0; fi
for i in $(seq 1 60); do curl -fs "https://$MEET/external_api.js" -o /dev/null && break; sleep 2; done
if curl -fs "https://$MEET/external_api.js" -o /dev/null; then echo "Video server:         https://$MEET  OK"; else warn "https://$MEET isn't answering. See: cd $JITSI_DIR && sudo docker compose logs --tail 50"; ok=0; fi

cat <<EOF

$( [ $ok = 1 ] && echo "All set! TalentTrade is on the internet." || echo "Almost there: see the warnings above." )

  Website:       https://$SITE      (sign up, log in, start meetings)
  Video server:  https://$MEET     (used automatically by the website)

  Email for confirmations and password resets: $( [ $EMAIL_ON = 1 ] && echo "ON" || echo "OFF. New accounts work straight away; add TT_SMTP_* to $ENV_FILE and run: sudo systemctl restart talenttrade" )

Useful:
  Website status / restart:   systemctl status talenttrade   |   sudo systemctl restart talenttrade
  Website messages:           journalctl -u talenttrade -f
  Video server:               cd $JITSI_DIR && sudo docker compose ps   (or: logs -f)
  Update the website:         cd $PROJECT && git pull && sudo systemctl restart talenttrade
  Settings (private):         $ENV_FILE
  Accounts database:          $CFG_DIR/talenttrade.db   (back it up!)
Certificates renew automatically (certbot timer).
EOF
