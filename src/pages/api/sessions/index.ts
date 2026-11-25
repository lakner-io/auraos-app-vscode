import type { APIRoute } from 'astro';
import { startSession } from '../../../session-manager.js';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { appId } = await request.json() as { appId?: string };
    if (!appId) return Response.json({ error: 'appId required' }, { status: 400 });
    const session = await startSession(appId);
    return Response.json({ appId, host: session.host, port: session.port });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
};
