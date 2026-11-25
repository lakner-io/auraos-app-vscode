import type { APIRoute } from 'astro';
import { grantCap } from '../../capability.js';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { appId, revoke } = await request.json() as { appId?: string; revoke?: boolean };
    if (!appId) return Response.json({ error: 'appId required' }, { status: 400 });
    return Response.json(await grantCap(appId, Boolean(revoke)));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
};
