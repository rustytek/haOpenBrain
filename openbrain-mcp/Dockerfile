FROM denoland/deno:2.3.3

RUN apt-get update && apt-get install -y --no-install-recommends curl jq \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY deno.json ./
RUN deno install

COPY src/ ./src/
RUN deno cache src/index.ts

COPY run.sh /haos-run.sh
RUN chmod +x /haos-run.sh

EXPOSE 8000

ENTRYPOINT ["/haos-run.sh"]
