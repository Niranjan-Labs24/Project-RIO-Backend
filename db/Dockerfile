# Postgres with TLS enabled (RIO-NFR-001 — encryption in transit to the DB).
# Bakes a self-signed server cert into the image so `docker compose up --build`
# yields an SSL-capable database with no host bind-mount permission issues.
# The cert lives in /certs (NOT /var/lib/postgresql, which the base image
# declares as a VOLUME — writes there during build are discarded).
# A real deployment supplies a CA-signed cert (mount over these paths).
# Pinned to a reviewed digest (Task 9, container hardening) rather than the
# floating `postgres:18` tag, so a rebuild can't silently pull a different
# image. Re-pin deliberately (docker pull postgres:18 && docker inspect ...)
# when a genuine upgrade is wanted — never widen this back to a bare tag.
FROM postgres:18@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a
RUN set -eux; \
    mkdir -p /certs; \
    openssl req -new -x509 -days 3650 -nodes -text \
      -out /certs/server.crt -keyout /certs/server.key -subj "/CN=cnap-db"; \
    chmod 600 /certs/server.key; \
    chown -R postgres:postgres /certs
# ssl is turned on via the `command:` in docker-compose.yml (points at /certs).
