#!/bin/bash
# Definitive cookie diagnosis: full headers, jar contents, and round-trip.
set -u
rm -f /tmp/cf.jar
PASS=$(sudo grep '^ADMIN_PASSWORD=' /opt/calsync/.env | cut -d= -f2-)
echo "== login response: ALL headers =="
curl -sS -D /tmp/cf-hdr.txt -o /dev/null -c /tmp/cf.jar --data-urlencode 'username=admin' --data-urlencode "password=$PASS" https://regimend.app/login
cat /tmp/cf-hdr.txt
echo "== jar contents =="
cat /tmp/cf.jar
echo "== dashboard request: Cookie header + result =="
curl -sS -b /tmp/cf.jar -D - -o /dev/null https://regimend.app/ 2>/dev/null | grep -iE 'cookie|HTTP' 
echo "dashboard: $(curl -sS -b /tmp/cf.jar -o /dev/null -w '%{http_code}' https://regimend.app/)"
echo "== same flow on localhost (bypass nginx) =="
rm -f /tmp/cf2.jar
C2=$(curl -sS -D /tmp/cf2-hdr.txt -o /dev/null -c /tmp/cf2.jar --data-urlencode 'username=admin' --data-urlencode "password=$PASS" http://127.0.0.1:8787/login)
grep -iE 'set-cookie|^HTTP' /tmp/cf2-hdr.txt
echo "localhost dashboard (with cookie, plain http): $(curl -sS -b /tmp/cf2.jar -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/)"
rm -f /tmp/cf.jar /tmp/cf2.jar /tmp/cf-hdr.txt /tmp/cf2-hdr.txt
