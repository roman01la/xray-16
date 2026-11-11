# Single-player web hosting

The game engine, simulation, and saves run in the browser. Cloudflare Workers
Static Assets serves the engine/frontend, R2 serves compressed game chunks, and
D1 stores browser analytics. There is no custom gameplay server.

- [Build the browser game](../misc/web/README.md)
- [Publish and operate Cloudflare hosting](cloudflare/README.md)
- `web/`: startup UI, OPFS storage, compatibility checks, analytics collection/dashboard.
- `tools/`: original game configuration reader and immutable release manifest builder.
- `cloudflare/`: production Worker, D1 adapter, asset staging and verification.

Upstream X-Ray game/network code is retained where shared with its original engine.
