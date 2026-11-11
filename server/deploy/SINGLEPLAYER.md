# Active public deployment

The public single-player game is hosted on Cloudflare at https://stalker-online.xyz.
Workers Static Assets serves the engine/frontend; R2 serves gzip game chunks at
assets.stalker-online.xyz. A small Worker handles analytics and its authenticated
dashboard, backed by D1. See [Cloudflare deployment](../cloudflare/README.md) for
publishing and recovery instructions.

Rust gameplay and native A-Life hosts are not part of the public deployment.
Multiplayer endpoints return 503; /health reports singleplayer mode. The legacy
Fly configurations are retained for recovery and a future multiplayer release;
do not deploy them as part of a single-player website update.

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

Tables analytics_devices and analytics_performance live in the separate D1
analytics database. Telemetry rows expire after 30 days through an hourly
retention task; milestone totals stay all-time. No save contents,
IP addresses, usernames or precise location are stored by this collection.
HTTP ingestion validates fields, ranges and payload size. The dashboard keeps
its existing authentication and escapes all device-supplied text.
