/**
 * Raw WebSocket upgrade passthrough for /cs/<appId>/... → that app's
 * code-server session. Loaded from astro.config.mjs via ssrLoadModule;
 * the pipe mirrors @aura/app-sdk sidecars' createServer() upgrade handler.
 */
import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { getSession } from './session-manager.js';
import { startThemeSync } from './theme-sync.js';

// The WS hook module is the one guaranteed to load at server start — kick
// the theme loop from here.
startThemeSync();

export function handleCsUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const m = (req.url ?? '').match(/^\/cs\/([^/?]+)([^?]*)(\?.*)?$/);
  if (!m) { socket.destroy(); return; }
  const session = getSession(m[1]!);
  if (!session) { socket.destroy(); return; }

  const path = (m[2] || '/') + (m[3] ?? '');
  const headers = { ...req.headers, host: `${session.host}:${session.port}` };
  const lines = [`${req.method} ${path} HTTP/1.1`];
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
    else if (v !== undefined) lines.push(`${k}: ${v}`);
  }

  const up = net.connect(session.port, session.host, () => {
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const bail = () => {
    try { socket.destroy(); } catch { /* noop */ }
    try { up.destroy(); } catch { /* noop */ }
  };
  up.on('error', bail);
  socket.on('error', bail);
}
