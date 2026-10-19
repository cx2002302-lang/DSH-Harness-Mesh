# DSH Harness Mesh v1.1 — Release Notes

**Date:** 2026-10-19 · **License:** MIT · **Base:** v1.0

## Highlights

- **Model bridge** — models pinned on mesh nodes auto-register into the LLM provider catalog (volatile hot-sync via `ctx.settings.mutate`; edit the node table and the model dropdown follows, zero restart). Foreign (hand-configured) providers are never overwritten.
- **Full test campaign** — 286 `node:test` unit tests (8 new suites: stores / tools / mesh / hot / http / acp-stdio / acp-plug / harness-tools) + the e2e trio (dispatch / permission / cancel) all green on real links.

## Bug fixes (found by the campaign)

1. **acp-stdio**: a child process whose `initialize` fails was never killed → process leak. Now SIGTERM'd in place.
2. **acp-plug**: a socket whose `hello` fails was never destroyed → connection leak. Now closed on the spot.
3. **nodes-store**: one invalid entry in `nodes.json` silently dropped every entry after it → per-entry validation, bad entries are skipped and named in the log.
4. **task-store**: `create()` without `task_id` produced ghost records (in-memory `undefined` key, lost on restart) → rejected at the door.
5. **http**: removed the dead route `GET /api/harness-mesh/models` (registered since v1.0, never implemented).
6. **wb-gateway-adapter**: `session/prompt` blocked the read loop so `session/cancel` could never be read (cancel degraded to a master-side kill) → turn moved to a background thread with a stdout write lock; graceful cancel verified end-to-end.

## Hardening / de-identification

- wb-ui node is discovered by `plugId=workbuddy-ui` / name match instead of a hardcoded host name.
- The client "open DSB" button composes the URL from the current host + page token (override via `localStorage["hm.dsbUrl"]`); no internal IP/token in source.
- `guardian.py` ships with no default join code / server (must come from `bootstrap.env`).
- `harnessd.py` LAN-address probe uses the RFC 5737 documentation range.
- Test fixtures and README examples genericized.

## Verify

```bash
cd src/<flavor>/server/harness-mesh   # workbuddy | zcode | kimicode | opencode
npm test                              # 286/286 green
```
