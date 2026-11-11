#!/bin/bash
set -euo pipefail
echo "=== calsync setup on $(hostname) ==="
. /etc/os-release
echo "OS: $PRETTY_NAME ($(uname -m))"
nproc
free -m | awk 'NR==2{print "RAM_MB:"$2}'
df -BG / | awk 'NR==2{print "DISK_AVAIL_GB:"$4}'
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl nginx python3-certbot-nginx ca-certificates openssl
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
echo "NODE: $(node -v) npm: $(npm -v)"
id -u calsync &>/dev/null || useradd --system --create-home --home-dir /opt/calsync --shell /usr/sbin/nologin calsync
mkdir -p /opt/calsync
tar -xzf /tmp/calsync.tar.gz -C /opt/calsync --strip-components=1
mkdir -p /opt/calsync/data
ADMIN_PASSWORD="$(openssl rand -hex 12)"
SESSION_SECRET="$(openssl rand -hex 48)"
cat > /opt/calsync/.env <<ENVEOF
HOST=0.0.0.0
PORT=8787
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${ADMIN_PASSWORD}
SESSION_SECRET=${SESSION_SECRET}
SESSION_COOKIE_SECURE=false
TRUST_PROXY=false
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URL=
CALSYNC_TZ=America/Chicago
ENVEOF
chmod 600 /opt/calsync/.env
cd /opt/calsync
npm ci --omit=dev >/dev/null && echo "NPM-CI-OK (prod deps only)"
sudo -u calsync node bin/inspect.js test/fixtures/sample.ics | head -8
chown -R calsync:calsync /opt/calsync
cp deploy/calsync.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now calsync
sleep 2
systemctl is-active calsync && echo "SERVICE-ACTIVE"
echo -n "LOCAL-HEALTHZ: "; curl -fsS http://127.0.0.1:8787/healthz
echo
echo -n "UFW: "; ufw status 2>/dev/null | head -1 || echo "(inactive or not installed)"
echo "DASHBOARD: http://170.39.225.163:8787  user=admin  pass=${ADMIN_PASSWORD}"
echo "SETUP-DONE"
