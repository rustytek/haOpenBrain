#!/bin/bash
# Fresh-init hook: docker-entrypoint runs this after 01-init.sql while the
# temporary initdb server is listening on the unix socket. Applies all
# migrations so a brand-new database converges to the same schema as an
# upgraded one, and records them in schema_migrations.
set -e
/usr/local/bin/apply_migrations.sh
