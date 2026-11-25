import type { APIRoute } from 'astro';
import { stopSession } from '../../../session-manager.js';

export const DELETE: APIRoute = async ({ params }) => {
  try {
    await stopSession(params.app!);
    return Response.json({ stopped: params.app });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
};
