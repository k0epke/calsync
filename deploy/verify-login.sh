#!/bin/bash
# Reproduce the user's login failure and capture server logs.
echo "== login POST to https://regimend.app/login =="
rm -f /tmp/lx.jar
CODE=$(curl -sS -c /tmp/lx.jar -o /tmp/lx-body.html -w '%{http_code}' --data-urlencode 'username=admin' --data-urlencode 'password=***' https://regimend.app/login)
echo "login POST: $CODE"
grep -o 'Invalid username[^<]*\|Too many login attempts[^<]*\|Sign in to manage' /tmp/lx-body.html | head -2
DASH=$(curl -sS -b /tmp/lx.jar -o /dev/null -w '%{http_code}' https://regimend.app/)
echo "dashboard after login: $DASH"
rm -f /tmp/lx.jar /tmp/lx-body.html
echo "== journal: login-related lines (last 15 min) =="
sudo journalctl -u calsync --since "-15 min" --no-pager | grep -iE "login|Invalid|rate limit|session|ERROR" | tail -12
