#!/bin/bash
# CalSync OAuth receiver: reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET pairs
# from stdin (one per line), upserts into /opt/calsync/.env, restarts service.
set -euo pipefail
f=/opt/calsync/.env
read -r l1
read -r l2
l1=${l1%$'\r'}
l2=${l2%$'\r'}
case "$l1" in GOOGLE_CLIENT_ID=*) ;; *) echo "UNEXPECTED-LINE-1"; exit 1;; esac
case "$l2" in GOOGLE_CLIENT_SECRET=*) ;; *) echo "UNEXPECTED-LINE-2"; exit 1;; esac
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
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ "$ok" != "1" ]; then echo "SERVICE-NOT-BACKYET"; exit 1; fi
curl -fsS http://127.0.0.1:8787/healthz
echo
echo WIRE-OK
