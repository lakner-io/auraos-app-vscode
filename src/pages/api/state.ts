import type { APIRoute } from 'astro';
import { listState } from '../../session-manager.js';

export const GET: APIRoute = async () => {
  try {
    return Response.json(await listState());
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
};
