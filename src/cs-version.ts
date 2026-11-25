/**
 * Identity of the installed code-server build, read once from the shared home.
 * The commit keys the shared static-asset cache (/cs-static/<commit>/…):
 * `stable-<commit>/static/**` is byte-identical for a given build, so one
 * browser download serves every editor iframe.
 */
import { readFileSync } from 'node:fs';

export const CS_ROOT = '/home/aura/.aura/code-server/current';

function readIdentity(): { commit: string | null; version: string | null } {
  try {
    const product = JSON.parse(readFileSync(`${CS_ROOT}/lib/vscode/product.json`, 'utf8'));
    return { commit: product.commit ?? null, version: product.version ?? null };
  } catch {
    return { commit: null, version: null };
  }
}

const g = globalThis as unknown as { __csIdentity?: ReturnType<typeof readIdentity> };
const identity = (g.__csIdentity ??= readIdentity());

export const CS_COMMIT = identity.commit;
export const CS_VSCODE_VERSION = identity.version;
