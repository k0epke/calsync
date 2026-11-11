#!/bin/bash
# Stopgap: throttle CalSync per-event push rate to 600ms (Google 429 mitigation).
set -euo pipefail
f=/opt/calsync/.env
if grep -q '^PUSH_DELAY_MS=' "$f"; then sed -i 's/^PUSH_DELAY_MS=.*/PUSH_DELAY_MS=600/' "$f"; else printf 'PUSH_DELAY_MS=600\n' >> "$f"; fi
chown calsync:calsync "$f"
chmod 600 "$f"
systemctl restart calsync
ok=""
for i in $(seq 1 12); do curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1 && { ok=1; break; }; sleep 2; done
[ "$ok" = "1" ] || { echo SERVICE-NOT-BACK; exit 1; }
curl -fsS http://127.0.0.1:8787/healthz
echo
echo PUSH-DELAY-SET
