import { createActivityDestroyHandler } from '@aura/app-sdk';

// No teardown on window close: code-server sessions stay warm (backgroundService
// keeps the backend alive) so reopening an editor is instant.
export const POST = createActivityDestroyHandler(async () => {});
