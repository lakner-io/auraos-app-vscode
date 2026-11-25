# io.lakner.vscode — code-server orchestrator

Central control for per-app VS Code editors. `code-server` is an AuraOS
**capability** (see `capabilities.code-server` in `/workspace/.aura/capabilities.yaml`):
a shim on the toolchain PATH that execs the standalone release living in the
shared home `/home/aura/.aura/code-server/` (mounted into every sandbox).
This app grants that capability to other apps and runs one code-server per
granted app **inside that app's own container** via `docker exec`.

## Architecture

- `src/capability.ts` — `CODE_SERVER_ENTRY` (MUST stay in sync with the YAML
  registry entry; `/api/admin/cap` needs the parsed entry in the POST body) +
  shell-API helpers (install cap, grant/revoke via `/api/admin/manifest-edit`).
- `src/session-manager.ts` — per-app sessions. Fixed port 8321 bound inside
  each target's own netns. Start: auto-start target app if stopped → verify
  the shim at `/aura/my-tools/code-server` → seed theme settings →
  `docker exec -d` → poll `/healthz`. No disk persistence: `listState()`
  reconciles by probing (adopts editors after orchestrator restart, drops
  them when the target container restarted).
- `src/cs-proxy.ts` — raw WS upgrade pipe for `/cs/<appId>/…` (wired in
  `astro.config.mjs`); also boots the theme-sync loop.
- `src/pages/cs/[app]/[...path].ts` — HTTP reverse proxy via `proxyFetch`.
- `src/theme-sync.ts` — polls OS `colorMode` (KV `os/theme`), writes VS Code
  user settings into every session data dir (plain fs — shared home), and
  reloads this window via the shell-daemon MCP on change (open workbenches
  only read settings at page load).
- `src/pages/index.astro` — sidebar UI (grant/install/open/stop) + one
  cached iframe per open editor.

## Shared asset cache

All sessions run the same build, so the multi-MB workbench bundles are
byte-identical. `src/pages/cs-static/[commit]/[...path].ts` serves
`lib/vscode/**` from the shared home under ONE commit-keyed URL with
`immutable` 1-year caching; the `/cs/<app>/` proxy rewrites the workbench
HTML's `stable-<commit>/static` prefix to the RELATIVE `../../cs-static/<commit>`
(resolves under any /api/proxy id form — requires the iframe URL's trailing
slash, which the UI always supplies). The UI prefetches workbench.js/css +
nls.messages.js on load. **Webview `pre/**` stays per-app**: its service
worker registers with per-instance params; a shared scope would make
concurrent editors overwrite each other's registration (cs-static 404s that
subtree on purpose). Fail-open: if a future build changes URL shapes, the
rewrite misses and editors fall back to uncached per-app paths.

## Sharp edges

- Manifest uses `proxy.rewriteHtml: "absolute"`: no `<base>` injection, so
  code-server's *relative* URLs resolve under `/api/proxy/<id>/cs/<app>/…`.
  Client JS must prefix every URL with `window.AURA_APP_BASE_PATH`.
- The editor iframe opens `?folder=/workspace/apps/<appId>` — the in-container
  source path for every container app regardless of scope.
- Proot-sandboxed apps are unsupported (no container to exec into).
- Never `docker restart` this app; use `POST /api/apps/io.lakner.vscode/start`.
