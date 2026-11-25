import type { APIRoute } from 'astro';
import { installCap } from '../../capability.js';

export const POST: APIRoute = async () => {
  try {
    return Response.json(await installCap());
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
};
