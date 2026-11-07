# Fly.io network test deployment

This is one authoritative Rust server with a persistent SQLite volume. The browser
engine and licensed assets stay local. HTTPS signaling is forwarded by the local
preview gateway; browser WebRTC data channels connect directly to Fly's UDP port.
The development access token stays in the gateway process, outside browser code.

Current test app: `roman-stalker-wan`, Frankfurt (`fra`), dedicated IPv4
`77.83.143.60`, UDP port `50000`, HTTPS
`https://roman-stalker-wan.fly.dev`. `/health` is public; signaling, identity and
metrics require the development token. This URL serves the backend, not a game
launcher. Two shared CPUs / 1 GiB is connectivity-test sizing, not a 200-player
capacity guarantee. The dedicated IPv4 costs $2/month, plus Machine and volume
usage. The app stays running; there is no automatic stop/start.

## Deploy

Authenticate with `flyctl auth login`. For a new app, change the app/origin/address
in `fly.toml`, create a dedicated IPv4 and a `zone_data` volume in the same region.
Set `ZONE_DEV_TOKEN` through `flyctl secrets import` using private stdin, never
through checked-in files or browser JavaScript. Keep a matching local token file
with mode 0600 for the preview gateway.

Always stage a physically isolated source context. The main checkout contains
large private game files and build products; do not upload it as the build context.
From the repository root:

```sh
build_context=$(python3 server/tools/stage-fly.py)
flyctl deploy "$build_context" --config "$build_context/fly.toml" \
  --app roman-stalker-wan --remote-only --ha=false --no-public-ips --yes
```

Only one Machine may own this world/database. The entrypoint initializes the
volume directory then drops to uid/gid 10001. Database files live under
`/data/zone`. The server resolves `fly-global-services:50000` to the special Fly
IPv4 interface; using a wildcard bind for UDP is not equivalent on Fly. Received
datagrams are presented to ICE with the advertised public destination, reversing
the ingress destination translation for this single-endpoint socket.

The current app uses Zaton static collision, uploaded with explicit user approval.
`ZONE_COLLISION_MANIFEST=/data/collision/zaton.json` selects the manifest and its
hash-named cform/gamemtl files. For a new private deployment, upload exactly those
three files over Fly SSH/SFTP and verify their SHA-256 hashes. Do not recursively
upload the export directory: it can also contain unrelated test reports. A gzip
tar archive streamed into `flyctl ssh console` is faster than per-block SFTP here.
Keep the files readable by uid 10001; startup has a 60-second health grace period
for constructing the collision acceleration structure. These files must not enter
the image, git, or a public asset route. Omit the manifest setting for a synthetic
world when collision files are unavailable.

## Local browser against remote server

Stage the browser build as usual, then run:

```sh
ZONE_PREVIEW_PORT=8090 \
ZONE_SERVER_URL=https://roman-stalker-wan.fly.dev \
ZONE_SERVER_TOKEN_FILE=/absolute/path/to/private-token \
node misc/web/multiplayer/serve-preview.mjs ../multiplayer-preview
```

Use a fresh local origin/port for a new server database; saved browser identities
from another database cannot authenticate here. The gateway enforces local
Host/Origin and preserves identity pagination query parameters.

Open `http://localhost:8090/engine-preview/load-test.html?players=2&seconds=30`
for a real-network smoke test without rendered clients. To include one engine,
open `http://localhost:8090/engine-preview/?stream=/pack/pack.json&map=zaton&slot=wan-a`,
then use `load-test.html?players=24&existing=1&seconds=60`. Tests report topology separately:
multiple peers in one local browser are not independent client networks, and
synthetic-world results are not rendered Zaton acceptance.

Inspect `flyctl status --app roman-stalker-wan`, `flyctl checks list --app
roman-stalker-wan`, and server metrics. Preserve the volume when updating or
stopping the Machine. Use the existing persistence backup/recovery runbook before
any destructive database or volume operation.

References: [Fly UDP requirements](https://docs.fly.io/networking/udp-and-tcp),
[Fly configuration](https://docs.fly.io/reference/configuration).

## Verified deployment (2026-11-07)

Release image: `registry.fly.io/roman-stalker-wan:deployment-01M6VD0E7YRT3CCCWDVZFHKW86`.
Machine: `813e27c9723e48`; volume: `vol_40o7jmp7odd7pmm4`.
Initial synthetic 2/25-peer runs and graceful restart recovery passed. The real
Zaton engine passed actor lifecycle and the integration combat/recovery cycle.
See `../PLAN.md` and `../acceptance/fly-*` for measured results and their limits.

Keep the development token private. Access policy is still development-only;
production player accounts are not implemented. No browser frontend or licensed
visual assets are published by this deployment. The local gateway is required.
