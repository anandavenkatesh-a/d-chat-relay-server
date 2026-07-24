#!/bin/bash
# docker-entrypoint.sh
#
# IMPORTANT: this container starts as root (see Dockerfile — no USER
# directive before this script runs). That's intentional, not an
# oversight: Railway volumes are only attached at RUNTIME, not during
# the Docker build. Setting directory ownership/permissions in the
# Dockerfile's build steps would be silently pointless — a freshly
# mounted volume at container start would just be root-owned again
# regardless of what the image's build layer said. So the actual
# permission setup has to happen here, at runtime, after the volume
# is already mounted — and that requires starting as root.
#
# Once that one-time setup is done, this script drops privileges to
# the unprivileged 'relay' user (via su-exec) before actually running
# Tor or the Node relay — neither long-lived process ever runs as root.

set -e

# Railway sets this automatically to whatever mount path you configured
# in the dashboard. Falls back to /data for local `docker run` testing
# without a real Railway volume attached.
VOLUME_MOUNT_PATH="${RAILWAY_VOLUME_MOUNT_PATH:-/data}"

echo "[entrypoint] Using volume mount path: $VOLUME_MOUNT_PATH"

# ── One-time runtime setup (as root) ──────────────────────────────────────────

# Tor's hidden service key directory. Tor refuses to start a hidden
# service at all if this directory's permissions are too open, so this
# HAS to be exactly 700, set fresh every startup in case the volume
# was just created or the permissions ever drifted.
mkdir -p "$VOLUME_MOUNT_PATH/tor/d-chat-relay"
chmod 700 "$VOLUME_MOUNT_PATH/tor/d-chat-relay"

# Reserved for a future feature: persisting registered device_ids
# (proof-of-ownership registration, discussed but not yet built). Not
# used by anything today — creating it now just means the storage
# layout is already in place when that feature lands, without needing
# another round of volume/permission wiring later.
mkdir -p "$VOLUME_MOUNT_PATH/registry"

# Everything under the volume needs to be owned by the unprivileged
# user that will actually run Tor and Node — otherwise those processes
# (running as 'relay', not root, from here on) can't write to it.
chown -R relay:relay "$VOLUME_MOUNT_PATH"

# Generate the real torrc from the template, substituting the actual
# mount path now that we know it.
VOLUME_MOUNT_PATH="$VOLUME_MOUNT_PATH" envsubst '${VOLUME_MOUNT_PATH}' \
  < /etc/tor/torrc.template > /etc/tor/torrc

# ── Drop privileges and run the actual services ───────────────────────────────

echo "[entrypoint] Starting Tor daemon (as relay user)..."
su-exec relay:relay tor -f /etc/tor/torrc &
TOR_PID=$!

echo "[entrypoint] Waiting for onion address to be generated..."
for i in $(seq 1 30); do
  if [ -f "$VOLUME_MOUNT_PATH/tor/d-chat-relay/hostname" ]; then
    echo "[entrypoint] Onion address: $(cat "$VOLUME_MOUNT_PATH/tor/d-chat-relay/hostname")"
    break
  fi
  sleep 1
done

echo "[entrypoint] Starting relay server (as relay user)..."
su-exec relay:relay node /app/src/server.js &
NODE_PID=$!

# Exit the whole container if EITHER process dies, so Docker/Railway's
# restart policy brings the whole stack back up cleanly rather than
# silently running with only half of it alive.
wait -n "$TOR_PID" "$NODE_PID"
EXIT_CODE=$?
echo "[entrypoint] A process exited (code $EXIT_CODE) — shutting down container."
kill "$TOR_PID" "$NODE_PID" 2>/dev/null || true
exit $EXIT_CODE
