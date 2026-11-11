# Single-player hosting on Cloudflare

The browser runs the entire game. Cloudflare serves the immutable engine/frontend
through Workers Static Assets and gzip game chunks through the `stalker-online-assets`
R2 bucket at `assets.stalker-online.xyz`. Only analytics, its authenticated dashboard,
and the health/status endpoints invoke Worker code.

`stalker-online-analytics` in D1 replaces the gateway's SQLite analytics file. The
schema, event validation and dashboard preserve the existing browser IDs, milestones,
visit inactivity window and weighted performance summaries. D1 writes use atomic
batches; hourly retention removes device/performance samples older than 30 days.
Milestone counts remain all-time. `ANALYTICS_PASSWORD` is a Worker secret, never an
asset or configuration value. Rate limiting bindings protect ingestion and login;
Cloudflare's counters are approximate per location, not globally strict limits.

The production hostname uses a zone route (`stalker-online.xyz/*`) rather than
a Worker custom domain. Keep its root DNS record proxied. The route intercepts
all paths and never falls through to an origin server; static assets/redirects
are handled by the asset service, and the Worker returns 404 for unknown paths.
A reserved placeholder A record (`192.0.2.1`) can replace the former Fly address.
The current Wrangler OAuth login cannot edit zone DNS records.

## Publishing

1. Build and stage the game normally, then run `server/tools/publish-web.py --frontend FRONTEND --pack PACK --output PUBLICATION`
   to create an immutable publication manifest and source index.
2. Run `stage.py --publication PUBLICATION --retain PREVIOUS_PUBLICATION` here.
   It verifies hashes and stages assets into ignored `.assets/`, retaining a previous
   release for open tabs/rollback. The game URL stays `/` through a static internal
   rewrite; release URLs, decoded chunk hashes, OPFS cache keys and saves stay intact.
3. Run `upload-chunks.py --publication PUBLICATION --account ACCOUNT --bucket
   stalker-online-assets --state PRIVATE_PROGRESS_JSON`. It uploads gzip chunks and
   verifies their decoded SHA-256 before recording progress. The default auth uses
   the local Wrangler login or `CLOUDFLARE_API_TOKEN`. An explicitly authorized
   server-to-server migration can instead use `--source-base` for existing gzip
   objects and a temporary private `--token-file`; remove the credential afterward.
   Use `--workers 1` on a 512 MB shared machine; local machines can use four.
4. Apply `schema.sql` to a new D1 database, configure the Worker secret, and apply
   `cors.json` to the bucket. Existing databases need schema migrations rather than
   replacement. Cloudflare account identifiers in `wrangler.jsonc` are not secrets.
5. Deploy with `npx wrangler@4.160.0 deploy --config server/cloudflare/wrangler.jsonc`.
   Do not switch a domain before all referenced R2 chunks are verified.
6. Run `node --test server/cloudflare/worker.test.mjs` and
   `node server/cloudflare/verify-browser.mjs https://DEPLOYED_HOST` (private headless
   Chrome; configurable with `CHROME_BINARY`). Check root/release hashes, CORS/gzip,
   Wasm compilation and SharedArrayBuffer isolation, analytics login, and D1 counts.

Keep COOP/COEP headers and immutable asset headers in `_headers`. Do not enable
`run_worker_first` for static files/chunks: this would consume dynamic Worker quota.
An engine update does not require uploading unchanged game chunks. The static
asset deployment skips unchanged file content through Wrangler's hash-based upload.

## Fly migration and recovery

Before retiring Fly, retain a verified private backup of SQLite analytics and
private configuration and published web releases. The migration backup
excludes reproducible original archives under Zaton resources/levels/patches/
localization/gamedata. Those archives already exist locally and as verified chunks.
Never put configuration credentials or user databases in the public R2 bucket.

Import analytics with idempotent upserts, switch the domain only after staging
verification, then export/import a final delta from Fly. Preserve the original
origin `https://stalker-online.xyz` so browser saves/storage remain accessible.
Validate the backup checksum before removing legacy persistent resources.

## Manual checks

- Fresh browser: startup download progresses, Start becomes available, game opens.
- Existing browser: saves/settings remain, unchanged chunks are reused.
- Load a save and start a new campaign; check analytics milestone counts.
- Inspect the authenticated analytics dashboard and device/FPS summaries.
- Browser address remains `https://stalker-online.xyz/`; no new page redirect.

## Migration verification — 2026-11-11

- All 319 gzip chunks copied server-to-server and verified after decoding against
  their original SHA-256: 3,436,773,983 compressed bytes. Temporary transfer
  credentials removed from both machines after completion.
- Current immutable release: `bd3c53fec7ac979d61c071631d2c5b1fa96bf8b6cf23f74311d3d00dc070a9f1`.
  The previous release remains available to already-open browser tabs.
- Background Chrome verified production and staging: Wasm integrity/compilation,
  16 MiB decoded chunk integrity, cross-origin gzip/CORS and SharedArrayBuffer
  isolation in both document and worker. Root keeps the public URL unchanged.
- Analytics dashboard authentication verified. Final Fly snapshot imported:
  836 browsers, 1,366 milestone rows, 406 device rows and 643 performance rows.
  Subsequent D1 counts include live traffic and meet or exceed these counts.
- Private recovery archive: 449,416,929 bytes; SHA-256
  `7543489dcedaade1f07943f4b20abbe7bf943236b4dd712242ab64f22be356cc`.
  Stored outside Git in `private-deploy/cloudflare-migration/`, together with
  final analytics SQL and legacy configuration. Never publish that directory.
- With explicit deletion approval, retired Tigris bucket `roman-stalker-assets`,
  Fly machine `813e27c9723e48`, and volume `vol_40o7jmp7odd7pmm4`.
  The user changed the proxied root DNS record to a placeholder; the paid Fly
  IPv4 was released. Public DNS resolves to Cloudflare and the site remains live.
- Full interactive gameplay and returning-browser save reuse remain manual checks;
  migration does not change engine code, save origin or content hashes.

## Cumulative playtime

`analytics_playtime` stores the maximum cumulative active-gameplay milliseconds
for each anonymous browser/session pair. Dashboard totals sum these checkpoints
across sessions; they are not deleted with the 30-day device/performance samples.
No historical playtime is backfilled: tracking starts with the updated client.

The client uses engine gameplay telemetry, excluding hidden tabs, loading, menus
and engine pauses. It checkpoints every 30 seconds of reporting and on page hide,
retains failed checkpoints in localStorage and retries them on the next launch.
Duplicate/out-of-order checkpoints cannot add time twice. Concurrent visible game
sessions count separately; this is anonymous browser playtime, not verified human
attention. An abrupt crash can lose the latest uncheckpointed interval.

Before deploying the updated Worker, add the `analytics_playtime` table using the
idempotent CREATE statement in `schema.sql` (do not reimport any old data dump).
Then publish the updated analytics client in a new immutable frontend release.
No engine rebuild is required. The dashboard shows all-time total, average per
playing browser, and the top 200 browser totals with session counts.
