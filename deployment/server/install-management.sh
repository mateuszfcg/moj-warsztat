#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo "Uruchom przez sudo: sudo bash deployment/server/install-management.sh" >&2; exit 1; }
apt-get update
apt-get install -y rsync curl
SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir -p /etc/moj-warsztat /var/lib/moj-warsztat /var/backups/moj-warsztat
install -m 0755 "$SOURCE_DIR/moj-warsztat-update" /usr/local/sbin/moj-warsztat-update
install -m 0755 "$SOURCE_DIR/moj-warsztat-rollback" /usr/local/sbin/moj-warsztat-rollback
install -m 0755 "$SOURCE_DIR/moj-warsztat-version" /usr/local/sbin/moj-warsztat-version
install -m 0755 "$SOURCE_DIR/moj-warsztat-backup" /usr/local/sbin/moj-warsztat-backup
install -m 0755 "$SOURCE_DIR/moj-warsztat-backup-check" /usr/local/sbin/moj-warsztat-backup-check
install -m 0755 "$SOURCE_DIR/moj-warsztat-restore-local" /usr/local/sbin/moj-warsztat-restore-local
[[ -f /etc/moj-warsztat/deploy.env ]] || install -m 0600 "$SOURCE_DIR/deploy.env.example" /etc/moj-warsztat/deploy.env
[[ -f /etc/moj-warsztat/backup.env ]] || install -m 0600 "$SOURCE_DIR/backup.env.example" /etc/moj-warsztat/backup.env
install -m 0644 "$SOURCE_DIR/moj-warsztat-backup.service" /etc/systemd/system/moj-warsztat-backup.service
install -m 0644 "$SOURCE_DIR/moj-warsztat-backup.timer" /etc/systemd/system/moj-warsztat-backup.timer
install -m 0644 "$SOURCE_DIR/moj-warsztat-backup-check.service" /etc/systemd/system/moj-warsztat-backup-check.service
install -m 0644 "$SOURCE_DIR/moj-warsztat-backup-check.timer" /etc/systemd/system/moj-warsztat-backup-check.timer
systemctl daemon-reload
systemctl enable --now moj-warsztat-backup.timer
systemctl enable --now moj-warsztat-backup-check.timer
echo "Zainstalowano narzędzia. Uzupełnij /etc/moj-warsztat/deploy.env i /etc/moj-warsztat/backup.env"
