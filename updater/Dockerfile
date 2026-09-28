# Mediary Scout updater — the only container with Docker access.
# DOCKER_MIRROR is the same registry prefix as the web image (see the root Dockerfile).
ARG DOCKER_MIRROR
FROM ${DOCKER_MIRROR:+${DOCKER_MIRROR}/library/}docker:27-cli
RUN apk add --no-cache git nodejs su-exec
WORKDIR /updater
COPY server.mjs run-update.sh ./
RUN chmod +x run-update.sh && git config --system --add safe.directory /repo
CMD ["node", "server.mjs"]
