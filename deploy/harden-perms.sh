#!/bin/bash
# Perf hardening A: lock down CalSync data dir + DB from other local users.
set -euo pipefail
chmod 750 /opt/calsync/data
chmod 640 /opt/calsync/data/calsync.db /opt/calsync/data/calsync.db-shm /opt/calsync/data/calsync.db-wal 2>/dev/null || true
stat -c '%a %U %G %n' /opt/calsync/data /opt/calsync/data/calsync.db /opt/calsync/data/calsync.db-wal /opt/calsync/data/calsync.db-shm 2>/dev/null || true
echo PERMS-HARDENED
