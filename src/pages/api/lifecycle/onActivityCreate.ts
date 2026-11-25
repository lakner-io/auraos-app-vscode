import { createActivityCreateHandler } from '@aura/app-sdk';

// Each orchestrator window is an activity on the single shared backend instance.
// Open every window at the orchestrator root; per-window UI state lives in the
// browser (its own iframe/JS realm), the code-server sessions are shared.
export const POST = createActivityCreateHandler(async () => ({ path: '/', title: 'VSCode' }));
