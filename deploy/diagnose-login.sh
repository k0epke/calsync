#!/bin/bash
# Login failure diagnosis: correct credential extraction + real POST + auth code walk.
set -u
echo "== ADMIN_PASSWORD extraction =="
PASS=$(sudo grep '^ADMIN_PASSWORD=' /opt/calsync/.env | cut -d= -f2-)
HIDDEN=$(printf '%s' "$PASS" | sed -E 's/./x/g')
echo "extracted length: ${#PASS} mask: ${HIDDEN:0:3}..."
echo "== real login POST =="
rm -f /tmp/lx.jar
CODE=$(curl -sS -c /tmp/lx.jar -o /dev/null -w '%{http_code}' --data-urlencode 'username=admin' --data-urlencode "password=$PASS" https://regimend.app/login)
echo "login POST: $CODE"
if [ "$CODE" = "303" ]; then
  echo "dashboard: $(curl -sS -b /tmp/lx.jar -o /dev/null -w '%{http_code}' https://regimend.app/)"
fi
rm -f /tmp/lx.jar

echo "== auth.js credential path =="
grep -n "verifyCredentials\|ensureAdminUser\|password_hash\|scrypt\|argon\|bcrypt" /opt/calsync/lib/auth.js | head -8
echo "== users table =="
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('/opt/calsync/data/calsync.db',{readOnly:true}); const u=db.prepare('SELECT id, username FROM users').all(); console.log(JSON.stringify(u));" 2>&1 | head -3
echo "== recent login journal =="
sudo journalctl -u calsync --since '-20 min' --no-pager | grep -iE "login|Invalid" | tail -6
