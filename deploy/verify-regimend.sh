#!/bin/bash
# regimen.d rebrand verification (server-side, fresh view).
echo "== public tree =="
ls /opt/calsync/public/ | head -12
echo "== login page =="
L=$(curl -sS http://127.0.0.1:8787/login)
echo "regimen.d mentions: $(echo "$L" | grep -c regimen.d)"
echo "kalsynk remnants: $(echo "$L" | grep -c kalsynk)"
echo "login lockup src: $(echo "$L" | grep -o 'src="/assets/brand/[^"]*"' | head -1)"
echo "== assets over https (server-side) =="
curl -sS -o /dev/null -w 'favicon.svg %{http_code} %{size_download}\n' https://regimend.app/assets/favicon.svg
curl -sS -o /dev/null -w 'lockup-on-dark %{http_code} %{size_download}\n' https://regimend.app/assets/brand/lockup-on-dark.svg
echo "== healthz =="
curl -fsS http://127.0.0.1:8787/healthz
