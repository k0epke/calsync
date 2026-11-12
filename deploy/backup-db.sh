#!/bin/bash
# Consistent DB backup around a brief stop, then local tar copy + restart.
set -euo pipefail
STAMP=$(date +%Y%m%d-%H%M%S)
B=/opt/calsync/data/backup-pre-two-way-$STAMP
mkdir -p "$B"
systemctl stop calsync
cp -a /opt/calsync/data/calsync.db "$B/" 2>/dev/null || true
cp -a /opt/calsync/data/calsync.db-wal "$B/" 2>/dev/null || true
cp -a /opt/calsync/data/calsync.db-shm "$B/" 2>/dev/null || true
tar -czf /tmp/calsync-backup-$STAMP.tar.gz -C "$B" .
chown clawed:clawed /tmp/calsync-backup-$STAMP.tar.gz
chmod 644 /tmp/calsync-backup-$STAMP.tar.gz
chown -R calsync:calsync "$B"
chmod 700 "$B"
systemctl start calsync
echo "BACKUP-DIR: $B"
ls -la "$B"
echo "TARBALL: /tmp/calsync-backup-$STAMP.tar.gz"
echo BACKUP-DONE
