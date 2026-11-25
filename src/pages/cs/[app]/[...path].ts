/**
 * HTTP reverse proxy: /cs/<appId>/<path> → that app's code-server session.
 * WebSocket upgrades on the same prefix are handled by src/cs-proxy.ts
 * (wired in astro.config.mjs).
 */
import type { APIRoute } from 'astro';
import { proxyFetch } from '@aura/app-sdk';
import { getOrAdoptSession, CS_PORT } from '../../../session-manager.js';
import { CS_COMMIT } from '../../../cs-version.js';

const notRunning = (appId: string) => new Response(
  `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/api/os/theme.css">
<style>html,body{margin:0;height:100%;background:var(--aura-color-bg,#111);color:var(--aura-color-text,#ddd);font-family:var(--aura-font-mono,monospace);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;text-align:center;padding:24px}h1{color:var(--aura-color-primary,#7cf)}p{color:var(--aura-color-text-dim,#888)}</style>
</head><body><h1>${appId}</h1><p>No editor session running for this app — start it from the VSCode sidebar.</p></body></html>`,
  { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
);

export const ALL: APIRoute = async ({ params, request }) => {
  const appId = params.app!;
  const session = await getOrAdoptSession(appId);
  if (!session) return notRunning(appId);

  // Derive the forward path from the real URL, not params.path — Astro's
  // catch-all drops a trailing page-format extension (same fix as the shell
  // proxy). Everything after "/cs/<appId>/" goes upstream verbatim.
  const url = new URL(request.url);
  const prefix = `/cs/${appId}`;
  let fwd = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '/';
  if (!fwd.startsWith('/')) fwd = '/' + fwd;

  const upstream = `http://${session.host}:${CS_PORT}${fwd}${url.search}`;

  // Workbench HTML: point the big static tree at the SHARED cache path so
  // every editor iframe hits the same browser-cached URLs. Relative form
  // ("../../cs-static/…") so it resolves under whatever /api/proxy/<id>
  // prefix the browser used. The webview endpoint is put back on the
  // per-app path afterwards — its service worker carries per-instance
  // params and must not share a scope across editors.
  if (CS_COMMIT && (fwd === '/' || fwd === '/vscode')) {
    const { upstream: res, headers } = await proxyFetch.raw(upstream, request);
    const type = res.headers.get('content-type') ?? '';
    if (res.ok && type.includes('text/html')) {
      const sharedPrefix = `../../cs-static/${CS_COMMIT}`;
      const html = (await res.text())
        .replaceAll(`stable-${CS_COMMIT}/static`, sharedPrefix)
        .replaceAll(
          `${sharedPrefix}/out/vs/workbench/contrib/webview/browser/pre`,
          `stable-${CS_COMMIT}/static/out/vs/workbench/contrib/webview/browser/pre`,
        );
      return new Response(html, { status: res.status, headers });
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  return proxyFetch(upstream, request);
};
