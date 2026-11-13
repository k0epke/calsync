#!/bin/bash
# Diagnose: is Set-Cookie present on login 303? Is secure-cookie/trust-proxy the cause?
set -u
echo "== .env session flags =="
sudo grep -E 'SESSION_COOKIE_SECURE|SESSION_SECRET' /opt/calsync/.env | sed -E 's/(SECRET=).*/\1<redacted present>/'
echo "== config.js sessionCookieSecure logic =="
grep -n "sessionCookieSecure" /opt/calsync/lib/config.js | head -5
echo "== trust proxy in server.js =="
grep -n "trust proxy" /opt/calsync/server.js
echo "== login POST response headers =="
rm -f /tmp/lx2.jar
PASS=$(sudo grep '^ADMIN_PASSWORD=' /opt/calsync/.env | cut -d= -f2-)
curl -sS -D - -c /tmp/lx2.jar -o /dev/null --data-urlencode 'username=admin' --data-urlencode "password=$PASS" https://regimend.app/login | grep -iE '^(HTTP|set-cookie|location)' | head -6
echo "== dashboard request with cookie (verbose headers) =="
curl -sS -b /tmp/lx2.jar -D - -o /dev/null https://regimend.app/ | head -6
rm -f /tmp/lx2.jar
