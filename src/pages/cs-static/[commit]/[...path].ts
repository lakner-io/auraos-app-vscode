/**
 * Shared, immutable code-server static assets — one URL for every editor
 * iframe, so the browser downloads the multi-MB workbench bundles once.
 *
 * /cs-static/<commit>/<rest>  ≡  stable-<commit>/static/<rest> on any
 * instance, served straight from the shared home (byte-identical across
 * sessions, commit-locked). The webview `pre/` subtree is refused here:
 * its service worker carries per-instance parameters and must stay on the
 * per-app path (see CLAUDE.md).
 */
import type { APIRoute } from 'astro';
import { createReadStream, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { CS_COMMIT, CS_ROOT } from '../../../cs-version.js';

const STATIC_ROOT = resolve(`${CS_ROOT}/lib/vscode`);
const WEBVIEW_PRE = 'out/vs/workbench/contrib/webview/browser/pre/';

const MIME: Record<string, string> = {
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  scm: 'text/plain; charset=utf-8',
  tmLanguage: 'text/plain; charset=utf-8',
};

export const GET: APIRoute = ({ params, request }) => {
  if (!CS_COMMIT || params.commit !== CS_COMMIT) return new Response('unknown build', { status: 404 });
  // Derive from the real URL, not params.path — Astro's catch-all drops
  // page-format extensions (same fix as the /cs proxy route).
  const prefix = `/cs-static/${CS_COMMIT}/`;
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const idx = pathname.indexOf(prefix);
  const rest = idx >= 0 ? pathname.slice(idx + prefix.length) : '';
  if (!rest) return new Response('not found', { status: 404 });
  if (rest.startsWith(WEBVIEW_PRE)) return new Response('per-instance path', { status: 404 });

  const file = resolve(STATIC_ROOT, rest);
  if (file !== STATIC_ROOT && !file.startsWith(STATIC_ROOT + sep)) {
    return new Response('bad path', { status: 404 });
  }

  let st;
  try {
    st = statSync(file);
  } catch {
    return new Response('not found', { status: 404 });
  }
  if (!st.isFile()) return new Response('not found', { status: 404 });

  const ext = file.slice(file.lastIndexOf('.') + 1);
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    status: 200,
    headers: {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
