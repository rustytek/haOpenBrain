#!/bin/bash
# Runs inside the container before Home Assistant snapshots this add-on
# (backup_pre in config.yaml). Produces a consistent logical dump so every HA
# backup contains a restore-anywhere copy, not just raw PGDATA files.
set -e

DB=$(jq -r '.db_name' /data/options.json)
USER=$(jq -r '.db_user' /data/options.json)

mkdir -p /data/backup
gosu postgres pg_dump --username="$USER" --dbname="$DB" \
    --no-owner --clean --if-exists \
    > /data/backup/openbrain.sql
echo "INFO: pg_dump written to /data/backup/openbrain.sql ($(wc -c < /data/backup/openbrain.sql) bytes)"
