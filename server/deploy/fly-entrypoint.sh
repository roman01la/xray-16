#!/bin/sh
set -eu
: "${ZONE_PUBLIC_ADDR:?Set the dedicated public IPv4 and UDP port}"
: "${ZONE_DEV_TOKEN:?Set the private development access token}"
# Fly mounts a fresh root-owned volume. Change only its root and our DB directory;
# the server itself always runs unprivileged and owns newly created DB files.
chown 10001:10001 /data
install -d -m 0700 -o 10001 -g 10001 /data/zone
install -d -m 0700 -o 10001 -g 10001 /data/web
if [ -n "${ZONE_NATIVE_ALIFE_ROOT:-}" ]; then
    install -d -m 0700 -o 10001 -g 10001 /run/zone-alife
fi
exec setpriv --reuid=10001 --regid=10001 --init-groups node /app/web/gateway.mjs
