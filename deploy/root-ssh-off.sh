#!/bin/bash
# Disable root SSH login entirely; leave clawed/n0e access untouched.
set -euo pipefail
printf 'PermitRootLogin no\n' > /etc/ssh/sshd_config.d/00-permit-root-login-off.conf
chmod 644 /etc/ssh/sshd_config.d/00-permit-root-login-off.conf
sshd -t
echo CONFIG-OK
echo -n "EFFECTIVE NOW: "; sshd -T 2>/dev/null | grep -i '^permitrootlogin '
systemctl restart ssh 2>/dev/null || systemctl restart sshd
sleep 1
echo -n "EFFECTIVE POST-RESTART: "; sshd -T 2>/dev/null | grep -i '^permitrootlogin '
echo ROOT-LOGIN-DISABLED
