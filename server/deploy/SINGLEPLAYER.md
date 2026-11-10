# Active public deployment

The public app runs only the Node single-player gateway and SQLite analytics,
on one shared CPU and 512 MB RAM. Rust gameplay and all native A-Life hosts are
stopped. The existing encrypted volume, multiplayer database, checkpoints and
assets are retained. Multiplayer endpoints return 503; /health reports the
singleplayer mode. Bulk assets continue to use Tigris.

fly.toml is the active small-machine configuration. fly.multiplayer.toml retains
the previous campaign configuration for an explicit future multiplayer release;
do not deploy it accidentally. ZONE_SINGLEPLAYER=1 selects the gateway-only
entrypoint on future image deployments.

The immediate machine update uses the existing image with a single injected
/app/web/singleplayer-gateway.mjs file and a setpriv entrypoint override. This
keeps unrelated pending Rust/native changes out of production. When replacing
the image, use the source entrypoint and active fly.toml configuration.
