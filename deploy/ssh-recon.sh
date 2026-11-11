#!/bin/bash
# Read-only SSH reconnaisance before tightening root login policy.
set -uo pipefail
echo "--- users"
getent passwd root | cut -d: -f1,3,6,7 || true
getent passwd n0e || echo "NO-USER-n0e"
getent passwd clawed || echo "NO-USER-clawed"
echo "--- per-user authorized_keys"
for u in root n0e clawed; do
  h=$(getent passwd "$u" | cut -d: -f6)
  if [ -n "$h" ] && [ -f "$h/.ssh/authorized_keys" ]; then
    echo "$u: $(wc -l < "$h/.ssh/authorized_keys") line(s) in authorized_keys"
  else
    echo "$u: no authorized_keys file"
  fi
done
echo "--- sshd config files"
grep -n 'Include' /etc/ssh/sshd_config || echo NO-INCLUDE
ls -1 /etc/ssh/sshd_config.d/ 2>/dev/null || true
echo "--- raw directives"
grep -RniE 'PermitRootLogin|PasswordAuthentication|KbdInteractiveAuthentication' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null || true
echo "--- effective (sshd -T)"
sshd -T 2>/dev/null | grep -iE '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication) ' || true
echo RECON-DONE
