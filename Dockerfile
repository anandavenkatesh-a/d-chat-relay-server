FROM node:20-alpine

# tor         - the hidden service daemon
# bash        - entrypoint needs `wait -n` for dual-process supervision
# gettext     - provides envsubst, used to generate the real torrc from
#               torrc.template once the actual volume path is known
# su-exec     - lightweight privilege-drop tool (Alpine's gosu
#               equivalent) — lets the entrypoint do root-only setup
#               (volume permissions) then run Tor/Node as non-root
RUN apk add --no-cache tor bash gettext su-exec

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

# Tor hidden service config TEMPLATE (not the final torrc — see
# docker-entrypoint.sh, which generates the real one at container
# startup once the actual volume mount path is known).
COPY torrc.template /etc/tor/torrc.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Non-root user Tor and Node will actually run as. Created here, but
# NOT chowning any volume-backed directories at build time — Railway
# volumes aren't attached until runtime, so any ownership set now
# would just be silently overwritten the moment the real volume
# mounts. That ownership work happens in docker-entrypoint.sh instead,
# after the volume is actually present.
RUN addgroup -S relay && adduser -S relay -G relay

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Deliberately NOT setting `USER relay` here — the container needs to
# start as root so docker-entrypoint.sh can fix up volume permissions
# at runtime. It drops to the 'relay' user itself before actually
# running Tor or Node — neither long-lived process ends up running as
# root, this is just a one-time root step at container start.
ENTRYPOINT ["/docker-entrypoint.sh"]
