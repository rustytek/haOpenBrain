FROM pgvector/pgvector:pg16

RUN apt-get update && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*

# HAOS persists /data across restarts
ENV PGDATA=/data/pgdata

# Runs only on first start when PGDATA is empty; 02-migrations.sh then applies
# all migrations so fresh installs converge to the same schema as upgrades.
COPY init.sql /docker-entrypoint-initdb.d/01-init.sql
COPY 02-migrations.sh /docker-entrypoint-initdb.d/02-migrations.sh

COPY migrations/ /migrations/
COPY apply_migrations.sh /usr/local/bin/apply_migrations.sh
COPY backup_pre.sh /usr/local/bin/backup_pre.sh

COPY run.sh /haos-run.sh
RUN chmod +x /haos-run.sh /usr/local/bin/apply_migrations.sh \
    /usr/local/bin/backup_pre.sh /docker-entrypoint-initdb.d/02-migrations.sh

ENTRYPOINT ["/haos-run.sh"]
