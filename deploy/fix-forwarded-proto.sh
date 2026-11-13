#!/bin/bash
# Fix X-Forwarded-Proto in the regimend.app HTTPS block, reload, verify login.
set -u
echo "== current forwarded-proto lines in the vhost =="
sudo grep -n "X-Forwarded-Proto" /etc/nginx/sites-enabled/regimend.app
echo "== apply fix: https.proto only (sed both, then verify) =="
sudo sed -i 's/proxy_set_header X-Forwarded-Proto .*/proxy_set_header X-Forwarded-Proto https;/' /etc/nginx/sites-enabled/regimend.app
sudo nginx -t 2>&1 | tail -1
sudo systemctl reload nginx
echo "== login test after fix =="
rm -f /tmp/lx3.jar
PASS=$(sudo grep '^ADMIN_PASSWORD=' /opt/calsync/.env | cut -d= -f2-)
curl -sS -D - -o /dev/null -c /tmp/lx3.jar --data-urlencode 'username=admin' --data-urlencode "password=$PASS" https://regimend.app/login | grep -iE '^(HTTP|set-cookie|location)' | head -4
echo "dashboard: $(curl -sS -b /tmp/lx3.jar -o /dev/null -w '%{http_code}' https://regimend.app/)"
rm -f /tmp/lx3.jar
