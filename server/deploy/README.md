# Deployment and recovery baseline

The server is a development foundation. Account login/recovery and final game
rules are not included. Keep the preview and admin tools private.

Build from the repository root with `cargo +1.93.1 build --locked --release
--manifest-path server/Cargo.toml`. Run the release binary with the variables in
`server.env.example`. The systemd unit assumes a dedicated `zone` user, binary at
`/opt/zone/zone-server`, private environment file `/etc/zone/server.env` (0600), and
writable `/var/lib/zone` owned by that user. Install the unit only on the target
Linux host. `SIGTERM` drains HTTP handlers, disconnects peers and flushes accepted
persistence work. A failed drain exits with an error. Monitor process restarts.

Alternatively, build the image from the repository root:

```
docker build -f server/deploy/Dockerfile -t zone-server .
```

Mount a persistent local volume at `/data`, owned by uid 10001. Supply
`ZONE_DEV_TOKEN`, `ZONE_ORIGIN` and the externally reachable UDP address in
`ZONE_PUBLIC_ADDR`. Publish the configured UDP port. Do not advertise a wildcard
address. Put signaling behind HTTPS with rate limits and restricted access;
serve the browser entry over HTTPS with COOP/COEP headers. The local Node preview
server is not a production reverse proxy. Preserve the Authorization header on
proxy requests and never put tokens in URLs. A remote browser needs a reachable
UDP endpoint; TURN-only/restrictive-network coverage remains a separate gate.
Private collision data must be mounted explicitly; it is not in the image.

`/health` returns 503 when persistence polling is unhealthy. Restrict `/metrics`
to operators; it reports tick/replication timings, freshness-related counters,
persistent scene count, worker queue depth, attempted peak queue depth, rejected
jobs, completed jobs and end-to-end persistence latency. The worker queue holds
at most 32 jobs. An attempted enqueue can briefly make peak depth exceed 32.
A single server owns each canonical database path via an OS file lock. Use local
storage with working SQLite locks; do not use NFS or hard-link database aliases.
Do not delete a lock file while a server is running. Admin tools are separate
trusted local database writers, not extra simulation owners.

## Backup and restore

```
python3 server/tools/admin.py /var/lib/zone/zone.sqlite backup /backups/zone-001.sqlite
python3 server/tools/admin.py /backups/zone-001.sqlite restore /var/lib/zone/restored.sqlite
```

Online backups use SQLite's backup API and integrity check, then sync the new
file and destination directory. Destinations must not exist. Restore creates a
new database path; stop the service, point `ZONE_DATABASE` at the restored path,
and restart. Verify health, ownership and scene count before admitting clients.
Never copy only a live `.sqlite` file and omit its WAL. Test restoration regularly.
Protect backups like credentials: they include identity hashes and replay
outcomes. Restoring an older backup also restores its credential/revocation state;
reapply later revocations before reopening access. Recovery loses writes after
the backup point, so keep clients offline until reconciliation is complete.

## Development identity lifecycle and trusted fixtures

`admin.py DATABASE status` prints counts and integrity without credentials.
`revoke PRINCIPAL` blocks subsequent authentication; `rotate PRINCIPAL` preserves
the principal and prints a new credential once. Deliver that secret privately.
Browser account recovery UX is intentionally not implemented. Revocation or
rotation increments a durable auth epoch; within the one-second poll interval
all persistent sessions disconnect conservatively and must authenticate again.
The global development access token is changed through environment and restart.

`provision OWNER --value '{"fixture":true}'` creates an immutable owned test
record. `publish ENTITY zaton-static-v1 X Z` attaches a trusted scene descriptor;
`unpublish ENTITY` removes presentation without destroying ownership. Only the
fixed stalker model is supported. The server computes ground height and bounds
scene capacity at 1024. These are noninteractive integration fixtures, not loot
or NPC gameplay. Invalid descriptor/placement data fails closed.

Scene transfers require a simulation-issued principal/session/world context with
maximum age two seconds, plus the transactional ownership/revision checks.
That context authorizes at issuance; an accepted operation may finish after a
subsequent disconnect. A transient missing context records no terminal result,
so the same durable command can retry after reconnect. Previously committed
commands replay before this policy check. Live presentation follows committed
scene descriptors; ownership does not grant visibility or create actors.

## Acceptance commands

```
cargo +1.93.1 test --locked --manifest-path server/Cargo.toml
node --test misc/web/multiplayer/*.test.mjs
python3 server/tools/foundation-smoke.py
python3 server/tools/ownership-smoke.py
```

The smoke tests start isolated loopback servers and disposable databases.
`load-test.html?players=200&seconds=600&layout=crowded` runs moving peers and,
when persistence is enabled, durable outbox writes and owned-state audits.
Use `layout=spread` for dispersal. Keep the tab foreground; report browser stalls
and actual tick/freshness results, not merely successful connections. This is
one browser's WebRTC transport load, not 200 independently rendered clients.
Remote deployment, WAN coverage and lengthy production soak require a target host.

For transfer/invalidation load, first run record mode to enroll the load slots.
On a disposable acceptance database only, run
`python3 server/tools/seed-load-fixtures.py DATABASE --allow-test-fixtures`.
Then add `&ownership=1` to the load page. Each selected peer commits a record and
an ownership transfer through its durable outbox, and validates both sender and
recipient owned views. The fixture seeder preserves existing load-owned records.
`access-test.html` separately checks that admin revocation closes a real WebRTC
session and blocks credential resume. It creates a new isolated test principal.

The browser closes a session after five seconds without a complete authoritative
snapshot, even if ICE has not yet reported failure. This clears snapshot history,
owned state and engine presentation after server loss or revocation. Revocation
is enforced on the server at the next poll; client-side display cleanup may take
up to the snapshot-silence timeout. A new connection is required afterward.

To validate the container locally after building it with tag
`zone-server:foundation-test`, run `python3 server/tools/container-smoke.py`.
It creates and removes only its own temporary container and volume, binds test
ports to loopback, and verifies durable commit/replay across graceful restart.


For the remote engine preview, the current development entry expects the private
access gateway to authenticate the browser and supply the configured server
bearer token upstream. Do not inject it on an otherwise public unauthenticated
proxy. The standalone harness and client API also support an explicit token;
production account login is a separate implementation.

Exact local container acceptance build:

```
docker build -f server/deploy/Dockerfile -t zone-server:foundation-test .
python3 server/tools/container-smoke.py
```
