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

## Device and performance analytics

The protected analytics dashboard now shows 30-day device/performance cohorts.
Device data includes browser/OS, optional UA client hints (CPU architecture,
bitness and model), logical cores, coarse memory, display/DPR, touch input,
connection category, actual WebGPU adapter identity/features and selected limits.
Unavailable browser information stays unknown; no permissions or fingerprinting
probes are requested. Browser identity remains the existing random local ID.

Gameplay summaries are sent about once per minute, or on hide/exit if at least
five seconds have accumulated. They use engine frame intervals only while a
level is active, not paused/pre-caching/loading, and the tab is visible. Hidden
and paused intervals are excluded. Abrupt process kills may lose the last batch.
FPS is frame-count/time weighted. Histogram percentiles have 1 ms bins and a
1000 ms overflow bucket; actual maximum and >50/>100 ms stall counts are retained.
The dashboard labels its mean window P95 explicitly. Resolution and pacing
changes split windows. CPU-render/GPU timestamps and detailed profiling are not
required for collection. Full graphics preset/individual quality settings are
not captured yet; render size, viewport, VSync and FPS cap are captured.

Tables analytics_devices and analytics_performance share the existing separate
analytics.sqlite database. Writes stay in its worker. Telemetry rows expire
after 30 days on writes; milestone totals stay all-time. No save contents,
IP addresses, usernames or precise location are stored by this collection.
HTTP ingestion validates fields, ranges and payload size. The dashboard keeps
its existing authentication and escapes all device-supplied text.
