#!/bin/bash
# CalSync alert receiver: ALERT_TELEGRAM_TOKEN from stdin, CHAT_ID baked,
# restart, verify service, then send a probe alert via the app's own sender.
set -euo pipefail
read -r l1
l1=${l1%$'\r'}
case "$l1" in ALERT_TELEGRAM_TOKEN=*) ;; *) echo UNEXPECTED-LINE; exit 1;; esac
f=/opt/calsync/.env
if grep -q '^ALERT_TELEGRAM_TOKEN=' "$f"; then sed -i "s|^ALERT_TELEGRAM_TOKEN=.*|${l1}|" "$f"; else printf '%s\n' "$l1" >> "$f"; fi
grep -q '^ALERT_TELEGRAM_CHAT_ID=' "$f" || printf 'ALERT_TELEGRAM_CHAT_ID=8885089083\n' >> "$f"
grep -q '^ALERT_DIGEST_HOUR=' "$f" || printf 'ALERT_DIGEST_HOUR=8\n' >> "$f"
grep -q '^CALDAV_ALLOW_ANY_HOST=' "$f" || printf 'CALDAV_ALLOW_ANY_HOST=false\n' >> "$f"
chown calsync:calsync "$f"
chmod 600 "$f"
systemctl restart calsync
ok=""
for i in $(seq 1 12); do
  curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1 && { ok=1; break; }
  sleep 2
done
[ "$ok" = "1" ] || { echo SERVICE-NOT-BACKYET; exit 1; }
cat > /tmp/probe-alert.cjs <<'EOF'
(async () => {
  const config = await import('/opt/calsync/lib/config.js');
  await config.loadEnvFile('/opt/calsync/.env');
  const cfg = config.loadConfig();
  const alerts = await import('/opt/calsync/lib/alerts.js');
  await alerts.sendTelegramAlert(cfg, 'CalSync alert channel live - failure alerts + 08:00 digest are now active');
  console.log('PROBE-SENT');
  process.exit(0);
})().catch(e => { console.error('PROBE-FAILED:', e && e.message ? e.message : e); process.exit(1); });
EOF
env NODE_PATH=/opt/calsync/node_modules node /tmp/probe-alert.cjs
rm -f /tmp/probe-alert.cjs
echo WIRE-OK
