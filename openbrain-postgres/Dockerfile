FROM pgvector/pgvector:pg16

RUN apt-get update && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*

# HAOS persists /data across restarts
ENV PGDATA=/data/pgdata

# Runs only on first start when PGDATA is empty
COPY init.sql /docker-entrypoint-initdb.d/01-init.sql

COPY run.sh /haos-run.sh
RUN chmod +x /haos-run.sh

ENTRYPOINT ["/haos-run.sh"]
