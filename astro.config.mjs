import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { auraAppIntegration } from '@aura/app-sdk/integration';

// The bundled (OCI) app-sdk has no resolveAppPort export — read the env
// directly; the OS always sets APP_PORT before `astro dev`.
const port = Number(process.env.APP_PORT ?? 4001);

/**
 * WebSocket upgrades for /cs/<appId>/... are piped raw to that app's
 * code-server session (src/cs-proxy.ts). The shell's wsProxyPlugin strips
 * /api/proxy/<id> and dials this server, so upgrades arrive here already
 * prefix-free. Loading the module here also boots the theme-sync loop.
 */
function csWsIntegration() {
  return {
    name: 'aura-cs-ws',
    hooks: {
      'astro:server:setup': async ({ server }) => {
        const mod = await server.ssrLoadModule('/src/cs-proxy.ts');
        server.httpServer?.on('upgrade', (req, socket, head) => {
          if ((req.url ?? '').startsWith('/cs/')) mod.handleCsUpgrade(req, socket, head);
        });
        console.log('[vscode] code-server WS proxy attached on /cs/*');
      },
    },
  };
}

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: { checkOrigin: false },
  server: { port, host: true },
  integrations: [auraAppIntegration(), csWsIntegration()],
  devToolbar: { enabled: false },
  vite: {
    // Iframe-hosted: HMR's WebSocket can't reach the dev port. Reload instead.
    server: { hmr: false },
  },
});
