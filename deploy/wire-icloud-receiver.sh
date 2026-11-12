#!/bin/bash
# CalSync iCloud receiver: reads ICLOUD_APPLE_ID / ICLOUD_APP_PASSWORD pairs
# from stdin (one per line), upserts into /opt/calsync/.env, restarts service,
# verifies the icloud_accounts row seeded from env.
set -euo pipefail
f=/opt/calsync/.env
read -r l1
read -r l2
l1=${l1%$'\r'}
l2=${l2%$'\r'}
case "$l1" in ICLOUD_APPLE_ID=*) ;; *) echo UNEXPECTED-LINE-1; exit 1;; esac
case "$l2" in ICLOUD_APP_PASSWORD=*) ;; *) echo UNEXPECTED-LINE-2; exit 1;; esac
for pair in "$l1" "$l2"; do
  k=${pair%%=*}
  if grep -q "^${k}=" "$f"; then
    sed -i "s|^${k}=.*|${pair}|" "$f"
  else
    printf '%s\n' "$pair" >> "$f"
  fi
done
chown calsync:calsync "$f"
chmod 600 "$f"
systemctl restart calsync
ok=""
for i in $(seq 1 12); do
  curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1 && { ok=1; break; }
  sleep 2
done
[ "$ok" = "1" ] || { echo SERVICE-NOT-BACKYET; exit 1; }
cat > /tmp/icloud-check.cjs <<'EOF'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });
const row = db.prepare('SELECT username, length(app_password) AS pw_len FROM icloud_accounts').get();
console.log('ICLOUD_ROW:', JSON.stringify(row));
EOF
node /tmp/icloud-check.cjs
rm -f /tmp/icloud-check.cjs
echo WIRE-OK
