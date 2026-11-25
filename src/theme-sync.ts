/**
 * OS theme → VS Code theme sync, generalized over all editor sessions.
 *
 * The shared home (/home/aura) is mounted in this container too, so the
 * per-app user-data dirs are plain local filesystem — no docker exec needed.
 * An open workbench only reads user settings at page load, so a mode change
 * also reloads the orchestrator window (which reloads every editor iframe)
 * via the shell daemon's MCP.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { OS_API } from './capability.js';

const CS_DATA = '/home/aura/.aura/code-server/data';
const SHELL_MCP = 'http://aura-com.aura.aurashelld:4002/api/mcp/shell';
const WINDOW_NAME = 'VSCode';

const g = globalThis as unknown as { __csThemeSync?: { lastMode: string | null; started: boolean } };
const state = (g.__csThemeSync ??= { lastMode: null, started: false });

type Mode = 'light' | 'dark' | 'auto';

function settingsPatchFor(mode: Mode): Record<string, unknown> {
  if (mode === 'light') {
    return { 'workbench.colorTheme': 'Default Light Modern', 'window.autoDetectColorScheme': false };
  }
  if (mode === 'dark') {
    return { 'workbench.colorTheme': 'Default Dark Modern', 'window.autoDetectColorScheme': false };
  }
  return {
    'window.autoDetectColorScheme': true,
    'workbench.preferredDarkColorTheme': 'Default Dark Modern',
    'workbench.preferredLightColorTheme': 'Default Light Modern',
  };
}

function applyPatchToDir(appDataDir: string, patch: Record<string, unknown>): void {
  const userDir = `${appDataDir}/User`;
  const file = `${userDir}/settings.json`;
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(file, 'utf8'));
  } catch { /* absent or JSONC — start from the patch alone */ }
  const merged = { ...current, ...patch };
  if (JSON.stringify(merged) === JSON.stringify(current)) return;
  mkdirSync(userDir, { recursive: true });
  writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

async function fetchMode(): Promise<Mode> {
  const res = await fetch(`${OS_API}/api/kv/os/theme`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`kv os/theme → ${res.status}`);
  const body = await res.json() as { value?: { colorMode?: Mode } };
  return body.value?.colorMode ?? 'auto';
}

async function reloadOwnWindow(): Promise<void> {
  try {
    await fetch(SHELL_MCP, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'reload_window', arguments: { window: WINDOW_NAME } },
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* no open window / daemon down — theme applies on next load */ }
}

/** Seed a session's user-data dir with the last-known mode before first start. */
export async function seedSettings(appId: string): Promise<void> {
  const mode = state.lastMode ?? await fetchMode().catch(() => null);
  if (mode) applyPatchToDir(`${CS_DATA}/${appId}`, settingsPatchFor(mode as Mode));
}

async function syncOnce(): Promise<void> {
  const mode = await fetchMode();
  if (mode === state.lastMode) return;
  const firstApply = state.lastMode === null;
  const patch = settingsPatchFor(mode);
  if (existsSync(CS_DATA)) {
    for (const entry of readdirSync(CS_DATA)) applyPatchToDir(`${CS_DATA}/${entry}`, patch);
  }
  state.lastMode = mode;
  console.log(`[theme-sync] OS colorMode '${mode}' applied to all editor sessions`);
  if (!firstApply) await reloadOwnWindow();
}

export function startThemeSync(): void {
  if (state.started) return;
  state.started = true;
  const loop = () => {
    syncOnce().catch((err: Error) => {
      if (state.lastMode === null) console.log(`[theme-sync] pending: ${err.message}`);
    });
    setTimeout(loop, 5000);
  };
  loop();
}
