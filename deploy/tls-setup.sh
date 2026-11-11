#!/bin/bash
# CalSync TLS setup, two phases:
#   phase A (no args): HTTP-only vhost + tighten .env + restart
#   phase B (arg1 = email): certbot webroot cert + full vhost + verify
# Run with: sudo bash tls-setup.sh [email]
set -euo pipefail
HN=kalsync.koepke.tech
APP=/opt/calsync
SRC=$APP/deploy/nginx-calsync.conf

# --- build vhost variants (stop after the FIRST standalone closing brace; strip CR) ---
awk '{print} /^}$/{exit}' "$SRC" | sed "s/cal\.example\.com/$HN/g" | tr -d '\r' > /tmp/c80.conf
sed "s/cal\.example\.com/$HN/g" "$SRC" | tr -d '\r' > /tmp/cfull.conf

# --- phase A: HTTP-only vhost + env tightening ---
install -m 644 /tmp/c80.conf /etc/nginx/sites-available/calsync
ln -sf /etc/nginx/sites-available/calsync /etc/nginx/sites-enabled/calsync
nginx -t
systemctl reload nginx
echo "PHASE A1 OK (http-only vhost live)"

sed -i "s/^HOST=.*/HOST=127.0.0.1/; s/^SESSION_COOKIE_SECURE=.*/SESSION_COOKIE_SECURE=true/; s/^TRUST_PROXY=.*/TRUST_PROXY=true/" "$APP/.env"
if grep -q '^GOOGLE_REDIRECT_URL=' "$APP/.env"; then
  sed -i "s#^GOOGLE_REDIRECT_URL=.*#GOOGLE_REDIRECT_URL=https://$HN/oauth/callback#" "$APP/.env"
else
  printf 'GOOGLE_REDIRECT_URL=https://%s/oauth/callback\n' "$HN" >> "$APP/.env"
fi
sed -i '/^HHTTPS/d' "$APP/.env" || true
chown calsync:calsync "$APP/.env"
chmod 600 "$APP/.env"
systemctl restart calsync
echo "PHASE A2 OK (env tightened, app restarted on loopback)"

# --- phase B (needs email arg) ---
if [ "${1:-}" != "" ]; then
  certbot certonly --webroot -w /var/www/html -d "$HN" -m "$1" --agree-tos --no-eff-email --non-interactive
  install -m 644 /tmp/cfull.conf /etc/nginx/sites-available/calsync
  nginx -t
  systemctl reload nginx
  sleep 1
  curl -fsS "https://$HN/healthz" && echo " HTTPS-OK"
  echo "PHASE B OK"
fi
rm -f /tmp/c80.conf /tmp/cfull.conf /tmp/tls-setup.sh
echo TLS-SETUP-DONE
