# Fly.io public game deployment

Public URL is **https://stalker-online.xyz/**. One authoritative Rust server
runs in Frankfurt (`fra`), with a Node 24 HTTP gateway serving the browser build
and the game pack, with verified bulk chunks served from Tigris.
The volume stages uploads; verified bulk chunks are removed after CDN cutover. The user explicitly approved
public access and confirmed permission to distribute the game assets.

## Topology and access

- App `roman-stalker-wan`, Machine `813e27c9723e48`, dedicated IPv4 `77.83.143.60`.
- Fly HTTPS terminates at gateway port 8080. Rust HTTP listens only on
  `127.0.0.1:8082`; WebRTC UDP uses `fly-global-services:50000` and advertises
  `77.83.143.60:50000`. The ICE receive path reverses the ingress destination
  translation for that single logical public endpoint.
- Public routes include the released files and player identity/signaling APIs.
  The gateway injects the internal token server-side; it is never shipped to
  browsers. Per-browser player credentials remain required by the Rust APIs.
  Foreign Origin/cross-site API requests are rejected; registration/signaling
  and general API calls have bounded per-IP rate limits and body limits.
- `/metrics` and `/_deploy/*` require the private `ZONE_DEV_TOKEN` bearer token.
  No database, collision directory, filesystem browsing, or test pages are served.
- Every asset response has COOP/COEP/CORP headers for the threaded WASM engine.
  Content-versioned URLs have immutable caching and SHA-256 ETags. The root
  serves a no-store page that loads the active release in a full-window frame,
  keeping the public URL in the address bar.
- This build uses browser-held portable save keys. Copy save key and Open save
  allow another browser to resume the same identity. Keep a copy before clearing
  browser storage. Each public campaign map runs a stock native A-Life host.

## Persistent data

Volume `vol_40o7jmp7odd7pmm4` (`zone_data`) is 10 GB and encrypted. The entrypoint
initializes owned directories then drops to uid/gid 10001. The gateway supervises
Rust and X-Ray and forwards SIGTERM. Fly allows 25 seconds for shutdown.

- `/data/zone/zone.sqlite`: durable player records and ownership (plus SQLite WAL).
- `/data/collision`: private collision manifests and hash-named files.
  `/data/collision/campaign` also holds the five-map configuration and approved routes.
- `/data/alife`: stock archives shared from Zaton and separate native app data for
  each map. Keep each native save, world fence and outbox together.
- `/data/web/blobs`: immutable decoded file bytes keyed by SHA-256.
- `/data/web/manifests`: release history; `/data/web/active.json` is atomically
  replaced only after every referenced blob has been verified as present.

The unified browser release uses one campaign asset pack. Its level archives
contain Zaton, Jupiter, Pripyat, Jupiter Underground and Lab X8. The private
`ZONE_CAMPAIGN_CONFIG` points to the geometry and travel settings Rust uses for
all five maps. Players enter at `zaton-static-v1`. The approved crossings lead
through Jupiter and Jupiter Underground to Pripyat. The Lab X8 lift keeps its
power and access-card checks. Regular multiplayer acquisition of the card remains
open.

The initial game payload is approximately 4.44 GiB, including the engine and
all pack chunks. The browser installs the full pack at startup before opening
the game. It downloads only new content hashes on subsequent starts. The
release service worker also reuses verified engine and frontend files by hash.
Engine overrides retain their existing per-file checks.
Old release URL mappings remain available to running clients. Blob garbage
collection is deliberately not automatic; check capacity before many updates.

The campaign configuration uses eight shared CPUs and 12 GiB of memory.
Capacity testing at 200 players remains open. Dedicated IPv4 is $2/month plus Machine, volume
and applicable bandwidth charges. Daily volume snapshots retain five days;
application backup scheduling and target-host restore drills remain plan items.

## Deploy server/gateway code

Keep `ZONE_DEV_TOKEN` in Fly secrets and in a private local mode-0600 file for
publishing. Never put it in a URL, source file, browser module, or command argument.
Use the existing authenticated Fly CLI. From the repository root:

```sh
flyctl deploy --config server/deploy/fly.toml --image "$campaign_image" \
  --app roman-stalker-wan --ha=false --no-public-ips --yes
```

Use the verified campaign image containing Rust, the gateway and the native Linux
runtime under `/opt/zone-native`. The staging script can construct the Rust and
gateway source context when building a replacement. Only one Machine may own
the campaign database and native checkpoints.

Before deploying the survival configuration, take and verify an online SQLite
backup. Install the stock-derived item catalog, authored stash export and
approved loose-loot export under the private `/data/zone/game` directory. Use the
filenames in `fly.toml` for those files and the reload timings, ladders,
continuous fields and artefact sites. Make the files readable by uid 10001
and verify their hashes after transfer. These inputs stay off the public CDN
and outside the source-only build context. [Export commands](../MECHANICS.md)

Upload the matching browser files before switching the server image. After the
new gateway and Rust process pass health checks, activate the prepared frontend
manifest. Use the manual test plan for the hosted campaign and isolated recovery
checks. [Manual test plan](../MECHANICS_TEST_PLAN.md)

## Native A-Life

For single-map Zaton, set `ZONE_NATIVE_ALIFE_ROOT=/data/alife/zaton`,
`ZONE_NATIVE_ALIFE_BIN=/data/alife/bin/xr_3da`, and
`ZONE_ALIFE_INTEREST_SOCKET=/run/zone-alife/zaton`. Stage the Linux x86-64 release
runtime on the private volume. Populate the game directory with `fsgame.ltx`,
engine overrides and stock archives restored from the published pack. Verify
archive chunks by hash and create `archives-ready` in the game directory after
verification. The gateway runs the native process under the same unprivileged
user as Rust and retries it independently if it exits.

For a campaign deployment, point `ZONE_NATIVE_ALIFE_ROOT` at the parent
directory containing one game directory per level. The regions with
`alifeSocket` in `ZONE_CAMPAIGN_CONFIG` each launch a host. Use separate
`_appdata_` and private sockets for every host. The game directories can
share the immutable archives through symlinks. Preserve the existing
Zaton app data when adding campaign maps so its native checkpoint lineage
matches the Rust database. Verify admission and checkpoint advancement for
each map before opening the campaign.

## Publish frontend/assets

Build the optimized engine and refresh its data before staging.
[Unified web build commands](../../misc/web/README.md)

```sh
node misc/web/multiplayer/stage-game.mjs \
  build/web-multiplayer-release/artifacts ../multiplayer-preview \
  ../streaming-preview/pack-v2
python3 server/tools/publish-web.py \
  --unified \
  --frontend ../multiplayer-preview/engine-preview \
  --pack ../streaming-preview/pack-v2 \
  --output ../public-web-release \
  --url https://roman-stalker-wan.fly.dev \
  --token-file /absolute/path/to/private-token --publish
```

This hashes files, generates versioned release/pack paths, skips already uploaded
blobs, and uploads eight files at a time. Gzip level 3 is used when it saves at least
3%; otherwise original bytes are sent. The gateway decompresses in a bounded
stream, verifies the original SHA-256 and atomically installs each blob. Both
compressed and decoded sizes are bounded to 64 MiB per file. Temporary upload
files are removed on handled failure. Interrupted uploads can safely be retried.

Without `--publish`, files upload without switching the homepage. Publishing is
an authenticated manifest operation that refuses missing blobs or mutations to
existing immutable URLs. Local `sources.json` contains workstation paths and
must not be published. Assets stay outside git and Docker images. A rollback can
republish a retained manifest via the same protected endpoint, preserving newer
URL mappings for active clients; it must not roll back the database.

## Copy published volume assets to Tigris

Bucket `roman-stalker-assets` is public, with origin
`https://roman-stalker-assets.t3.tigrisfiles.io`. Upload to the Fly volume first;
do not upload the game again from the workstation. Once publication succeeds,
run the migration on the Machine:

```sh
flyctl ssh console --app roman-stalker-wan \
  -C 'python3 /app/tools/migrate-cdn.py'
```

The script reads private mode-0600 credentials from `/data/private/tigris.json`.
It verifies each source chunk's SHA-256, uploads the original decoded bytes with
Content-MD5, and checks the stored size and hash metadata. Existing verified
objects are skipped, making reruns safe. CORS allows GET/HEAD from the game origin.
The bucket receives only game chunks, never player databases or credentials.

Only after every object succeeds does the script atomically write
`/data/web/cdn-ready.json`. With `ZONE_ASSET_ORIGIN` configured, the gateway checks
this registry every five seconds and redirects verified chunks to Tigris.
Uncopied chunks continue to use the volume, including during subsequent releases.
HTML, JavaScript, WebAssembly and pack descriptors remain on the game origin.
Objects keep their original Content-Length and SHA-256, so the browser's existing
integrity checks and persistent chunk cache work unchanged.

`/data/web/cdn-migration.json` records the completed copy. After verifying live CDN
routing, run `python3 /app/tools/migrate-cdn.py --prune-volume` on the Machine.
It rechecks CDN objects, then removes volume blobs referenced exclusively by
bulk chunk URLs. Frontend files, manifests, collision data and player state stay
on the volume. The deployment HEAD/publish endpoints recognize verified offloaded
chunks, so later releases reuse them without uploading again. Once pruned, bulk
assets depend on Tigris; disabling CDN routing requires restoring those blobs. The first deployment's migration completed through a server-side watcher; its
log is `/data/private/cdn-migration.log`. All 319 bulk chunks were verified and
pruned from the volume. Future publishes should rerun migration after activation
and prune only after checking CDN delivery. Avoid restarting during an upload or
active migration.

## Database restore drill

`server/tools/restore-drill.py DATABASE PRIVATE_DIRECTORY` uses the existing
online backup API and restores into a new file. It compares full SQL contents,
checks integrity and foreign keys, retains the backup, and removes the disposable
restore. It never replaces the live database. Both this script and `admin.py`
must be in the same private directory on the host.

The first Fly drill passed with 28 identities and no owned/scene entities; see
`../acceptance/fly-backup-restore.json`. This does not close the populated-world
server boot/recovery gate or configure scheduled backups.

## Verification and operations

```sh
node --test server/web/gateway.test.mjs
flyctl status --app roman-stalker-wan
flyctl checks list --app roman-stalker-wan
curl -f https://roman-stalker-wan.fly.dev/health
```

Unauthenticated metrics and deployment requests must return 403. Test the public
root in a fresh browser origin, verify WebGPU rendering and active prediction,
and check persistence across reload. Refer to `../PLAN.md` and `../acceptance/`
for measured capacity/latency and explicit limitations. The original local
single-player files and saves are independent of this deployment.

References: [Fly UDP requirements](https://docs.fly.io/networking/udp-and-tcp),
[volume management](https://docs.fly.io/volumes/volume-manage),
[proxy request headers](https://docs.fly.io/networking/request-headers),
[Tigris object storage](https://docs.fly.io/tigris).


## Unified browser game

The root website `/` opens the original game menu and the unified engine release.
The retired `/singleplayer/` and `/multiplayer/` routes return 404. New Game and Load Game use single player;
the network-game menu item connects to the Rust/WebRTC server. Switching modes
restarts the same engine with different runtime flags; cached game assets remain
shared. Multiplayer's controls menu offers Main menu to return. The canvas fits
the browser viewport at the aspect ratio of the render resolution selected
in the game's video settings.

Stage the unified artifact without overwriting the old local SP distribution:

```sh
node misc/web/multiplayer/stage-game.mjs \
  build/web-multiplayer-release/artifacts ../unified-preview \
  ../streaming-preview/pack-v2
```

Publish the unified frontend to the root entry:

```sh
python3 server/tools/publish-web.py --unified --mode multiplayer \
  --frontend ../unified-preview/engine-preview \
  --pack ../streaming-preview/pack-v2 --output ../public-unified-release \
  --url https://roman-stalker-wan.fly.dev \
  --token-file /absolute/path/to/private-token --publish
```

Single-player saves stay in the existing `stream-cop/_appdata_/savedgames`.
Multiplayer keeps its isolated app-data directory and existing portable save key.
Fresh single-player and multiplayer profiles use the middle graphics preset,
called Default in X-Ray, and render at 1920×1080. Existing graphics settings
stay in the player's configuration.
Loading feedback reports files prepared, bytes downloaded/read from cache, and
current-transfer progress, then yields to the rendered game.

## Custom domain cutover — 2026-11-08

Requested domain: `stalker-online.xyz`, managed through Cloudflare DNS after a
Namecheap nameserver change. Fly has an issued, verified RSA/ECDSA certificate.
Required records: apex A `77.83.143.60`, and `_fly-ownership` TXT `app-3q6ogwz`.

`ZONE_ORIGIN=https://stalker-online.xyz` is set in the Fly config and running
Machine. The Machine update retained the existing deployed image; mechanics work
was not deployed. After the DNS update, the local resolver returned Cloudflare
proxy addresses over IPv4 and IPv6. HTTPS through Cloudflare followed the root
redirect to the unified release with HTTP 200 and COOP/COEP headers. Direct Fly
was also verified during cutover.
Health is green; the new origin reaches identity validation (400 for an invalid
credential), while the old Fly origin is rejected (403).
Retired mode URLs must continue returning 404. Browser-local saves and cached
assets belong to their original origin; changing domains does not migrate them.

Tigris CORS is prepared for both `https://stalker-online.xyz` and the existing
Fly origin. Actual chunk HEAD responses were verified to return the requested
`Access-Control-Allow-Origin` for each. Keep both during the cutover.
