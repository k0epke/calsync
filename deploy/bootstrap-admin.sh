#!/bin/bash
# CalSync bootstrap for the existing 'clawed' admin user (idempotent).
# Installs the deploy key, then enables passwordless sudo for automation.
set -u
PUBKEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPk7InjUQnTM0Jc0zKxypFE1MGyfV/HlE+pud4rELl15 calsync-deploy'
mkdir -p /home/clawed/.ssh
chmod 700 /home/clawed/.ssh
grep -qxF "$PUBKEY" /home/clawed/.ssh/authorized_keys 2>/dev/null || echo "$PUBKEY" >> /home/clawed/.ssh/authorized_keys
chmod 600 /home/clawed/.ssh/authorized_keys
echo KEY-INSTALLED
if sudo -n true 2>/dev/null; then
  echo SUDO-ALREADY-PWLESS
elif sudo -v; then
  printf 'clawed ALL=(ALL) NOPASSWD:ALL\n' | sudo tee /etc/sudoers.d/clawed > /dev/null
  sudo chmod 440 /etc/sudoers.d/clawed
  echo SUDO-READY
else
  echo SUDO-NOT-GRANTED
fi
