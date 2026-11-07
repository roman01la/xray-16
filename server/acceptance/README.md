# Local foundation acceptance, 2026-11-07

The JSON records are measured local results, including the failed first soak.
They contain no game assets, credentials or private database contents.

| Gate | Result |
|---|---|
| Persistent scene in two optimized Zaton engines | Shared stable ID, transfer without visibility change, AOI exit/re-entry, unpublish/republish and process restart passed |
| Spread/reconnect load | 200 peers, 120 seconds, 2,040 record writes + 2,040 transfers, no stale network clients |
| Final crowded transfer soak | 200 peers, 600 seconds, 9,600 record writes + 9,600 transfers, no stale network clients |
| Ownership audit | 220 trusted fixtures retained; summed revisions 11,640, matching committed transfers |
| Native/WASM terrain parity | 25 routes, 15,000 ticks, 1,000 checkpoints, zero positional difference |
| Operational recovery | Online backup, restore, process exclusion, credential lifecycle, clean shutdown and forced-restart replay passed |
| Linux container | Non-root server, health, durable commit/replay, clean shutdown and volume-backed restart passed |
| Single-player preservation | Production JS/WASM checksums unchanged |

The first crowded soak failed after a 14.6-second browser stall. Decoder allocation
was reduced and timing diagnostics added; the stall did not recur in the final
crowded run. This is not proof that every cause of the original stall is known.
The final scenario adds ownership transfers and has a 127–202 visible-entity range,
so do not turn the difference in bandwidth/skips into a controlled speedup claim.

Transient owned-view stale markers are expected during fetch/invalidation. The
final test checks complete refresh age (max 17.21 s, gate 45 s), and every transfer
awaits coherent sender/recipient views. Network freshness uses a one-second gate;
the five-second client silence timeout is an additional cleanup safeguard.

These are single-browser transport load tests; two rendered engines were checked
separately. Real WAN, independent machines, extended endurance and dynamic-world
movement are not established by these results. See ../PLAN.md and ../deploy/README.md
for scope, commands and remaining acceptance gates.
