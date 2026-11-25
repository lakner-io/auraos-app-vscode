/**
 * Per-app code-server sessions.
 *
 * A session is a code-server process started via `docker exec -d` INSIDE the
 * target app's own container (the capability puts the shim on the sandbox
 * PATH at /aura/my-tools/code-server; the real tree lives in the shared home
 * /home/aura/.aura/code-server, mounted into every sandbox).
 *
 * Sessions bind CS_PORT inside the target's own network namespace, so a fixed
 * port cannot collide across apps. No disk persistence: an exec'd process
 * outlives orchestrator restarts, so reconcile() re-adopts live editors by
 * probing /healthz, and drops sessions whose target container restarted.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CAP_NAME, OS_API, osJson, capInstalled } from './capability.js';
import { seedSettings } from './theme-sync.js';
import { CS_COMMIT } from './cs-version.js';

const exec = promisify(execFile);

export const CS_PORT = Number(process.env['CS_PORT'] ?? 8321);
const CS_HOME = '/home/aura/.aura/code-server';

export interface Session {
  appId: string;
  instanceId: string;
  host: string;      // aura-<sanitized instanceId> on aura-net
  port: number;
  startedAt: number;
}

interface InstanceInfo { instanceId: string; state: string; inPool?: boolean; sandbox?: string }
interface ProvideEntry { name: string; kind: string; address: string; version?: string; description?: string }
interface AppEntry {
  manifest: {
    id: string; name: string; icon?: string; sandbox?: string; tools?: string[]; componentType?: string;
    provides?: ProvideEntry[];
    // Free-form, app-defined manifest metadata (OS stores/returns it verbatim).
    metadata?: Record<string, unknown>;
  };
  enabled: boolean;
  instances: InstanceInfo[];
}

// An app that opens a folder OTHER than its own source declares it in manifest
// metadata under this key: `metadata['dev-workspace'].folder`. Read straight
// from /api/apps — no per-app API call, and never keyed off the app id/name, so
// it survives the provider being renamed or reinstalled under a different id.
const DEV_WORKSPACE_KEY = 'dev-workspace';
const DEV_WORKSPACE_FOLDER = '/data/workspace'; // convention fallback

/** The dev-workspace provide on this app's manifest, if any (id-independent). */
function devWorkspaceProvide(app: AppEntry): ProvideEntry | undefined {
  return (app.manifest.provides ?? []).find(
    (p) => p.name === DEV_WORKSPACE_KEY && (p.kind === 'rest' || p.kind === 'http'),
  );
}

/**
 * The workspace folder this app wants the editor to open, or null for a normal
 * app (which opens its own /workspace/apps/<id> source). Preference order:
 *   1. manifest.metadata['dev-workspace'].folder — the app declares it itself.
 *   2. presence of the dev-workspace `provides` capability → conventional path.
 * Both are read from the manifest (already in /api/apps); no API call.
 */
function devWorkspaceFolder(app: AppEntry): string | null {
  const meta = app.manifest.metadata?.[DEV_WORKSPACE_KEY] as { folder?: string } | undefined;
  if (meta && typeof meta.folder === 'string' && meta.folder) return meta.folder;
  if (devWorkspaceProvide(app)) return DEV_WORKSPACE_FOLDER;
  return null;
}

// Vite's SSR module graph can instantiate this module more than once (page
// routes vs ssrLoadModule from the WS hook) — pin state on globalThis.
const g = globalThis as unknown as { __csSessions?: Map<string, Session> };
export const sessions: Map<string, Session> = (g.__csSessions ??= new Map());

/** Same sanitization ContainerRunner applies for docker --name. */
export function containerName(instanceId: string): string {
  return 'aura-' + instanceId.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export function getSession(appId: string): Session | undefined {
  return sessions.get(appId);
}

/**
 * Lazy adoption: after an orchestrator restart the map is empty until the
 * first reconcile. If a still-running editor exists in the target container,
 * adopt it on first contact instead of 503ing.
 */
export async function getOrAdoptSession(appId: string): Promise<Session | undefined> {
  const existing = sessions.get(appId);
  if (existing) return existing;
  try {
    const apps = await listApps();
    const app = apps.find((a) => a.manifest.id === appId);
    if (!app || !(app.manifest.tools ?? []).includes(CAP_NAME)) return undefined;
    const inst = liveInstance(app);
    if (!inst || inst.sandbox !== 'container') return undefined;
    const host = containerName(inst.instanceId);
    if (!(await probe(host))) return undefined;
    const session: Session = { appId, instanceId: inst.instanceId, host, port: CS_PORT, startedAt: Date.now() };
    sessions.set(appId, session);
    return session;
  } catch {
    return undefined;
  }
}

async function listApps(): Promise<AppEntry[]> {
  return osJson<AppEntry[]>('/api/apps');
}

function liveInstance(app: AppEntry): InstanceInfo | undefined {
  return app.instances.find((i) => !i.inPool && (i.state === 'resumed' || i.state === 'paused'));
}

async function probe(host: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${CS_PORT}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start the target app if it has no live instance; wait until it does. */
async function ensureAppRunning(appId: string): Promise<InstanceInfo> {
  const find = async () => {
    const apps = await listApps();
    const app = apps.find((a) => a.manifest.id === appId);
    if (!app) throw new Error(`unknown app ${appId}`);
    return { app, inst: liveInstance(app) };
  };
  let { inst } = await find();
  if (!inst) {
    await osJson(`/api/apps/${appId}/start`, { method: 'POST' });
    const deadline = Date.now() + 45_000;
    while (!inst && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      ({ inst } = await find());
    }
    if (!inst) throw new Error(`app ${appId} did not reach a running state`);
  }
  if (inst.sandbox !== 'container') throw new Error(`app ${appId} runs in a ${inst.sandbox} sandbox — only container apps are supported`);
  return inst;
}

export async function startSession(appId: string): Promise<Session> {
  const existing = sessions.get(appId);
  if (existing && (await probe(existing.host))) return existing;
  sessions.delete(appId);

  if (!(await capInstalled())) throw new Error('code-server capability is not installed');

  const apps = await listApps();
  const app = apps.find((a) => a.manifest.id === appId);
  if (!app) throw new Error(`unknown app ${appId}`);
  if (!(app.manifest.tools ?? []).includes(CAP_NAME)) {
    throw new Error(`app ${appId} does not have the ${CAP_NAME} capability`);
  }

  const inst = await ensureAppRunning(appId);
  const ctr = containerName(inst.instanceId);
  const host = ctr;

  // Grants refresh live, but give the provisioner a moment on freshly
  // started instances: verify the shim is actually present in the sandbox.
  try {
    await exec('docker', ['exec', ctr, 'test', '-x', '/aura/my-tools/code-server']);
  } catch {
    throw new Error(`code-server tool not provisioned in ${appId}'s sandbox yet — is the capability granted?`);
  }

  await seedSettings(appId);

  // echo $$ then exec → the pidfile holds code-server's in-container pid.
  // Absolute tool path: docker exec does not get the entrypoint's PATH prepend.
  const dataDir = `${CS_HOME}/data/${appId}`;
  // Ensure the workspace folder exists before code-server opens it. A freshly
  // cloned dev-workspace app (e.g. a DevBox copy) may not have created its
  // /data/workspace yet, which makes code-server error "Workspace does not
  // exist". Only accept a safe absolute path (from the app's own manifest).
  const wf = devWorkspaceFolder(app);
  const wfMk = (wf && /^\/[\w./-]+$/.test(wf)) ? ` '${wf}'` : '';
  await exec('docker', ['exec', '-d', ctr, 'sh', '-c',
    `mkdir -p ${CS_HOME}/run ${dataDir}${wfMk} && echo $$ > ${CS_HOME}/run/${appId}.pid && ` +
    `exec /aura/my-tools/code-server --auth none --bind-addr 0.0.0.0:${CS_PORT} ` +
    `--disable-telemetry --disable-update-check ` +
    `--user-data-dir ${dataDir} --extensions-dir ${CS_HOME}/extensions`]);

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await probe(host)) {
      const session: Session = { appId, instanceId: inst.instanceId, host, port: CS_PORT, startedAt: Date.now() };
      sessions.set(appId, session);
      return session;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`code-server for ${appId} did not become healthy in 25s`);
}

export async function stopSession(appId: string): Promise<void> {
  const s = sessions.get(appId);
  sessions.delete(appId);
  const ctr = s ? containerName(s.instanceId) : null;
  if (!ctr) return;
  try {
    await exec('docker', ['exec', ctr, 'sh', '-c',
      `kill "$(cat ${CS_HOME}/run/${appId}.pid 2>/dev/null)" 2>/dev/null; rm -f ${CS_HOME}/run/${appId}.pid`]);
  } catch { /* container already gone — nothing to kill */ }
}

/**
 * Aggregate state for the UI. Also reconciles the session map against
 * reality: adopts editors that survived an orchestrator restart, drops
 * editors whose target container restarted.
 */
export async function listState() {
  const [installed, apps] = await Promise.all([capInstalled(), listApps()]);

  const rows = await Promise.all(apps.map(async (a) => {
    const m = a.manifest;
    const inst = liveInstance(a);
    const hasCap = (m.tools ?? []).includes(CAP_NAME);
    const supported = (m.sandbox ?? 'proot') === 'container' && m.componentType !== 'service';
    let session = sessions.get(m.id) ?? null;

    if (hasCap && inst && supported) {
      const host = containerName(inst.instanceId);
      const alive = await probe(host, 1200);
      if (alive && !session) {
        session = { appId: m.id, instanceId: inst.instanceId, host, port: CS_PORT, startedAt: Date.now() };
        sessions.set(m.id, session); // adopted (orchestrator restarted)
      } else if (!alive && session) {
        sessions.delete(m.id);       // target restarted → exec'd process died
        session = null;
      }
    } else if (session) {
      sessions.delete(m.id);
      session = null;
    }

    // Manifest-declared workspace folder (id-independent, no API call). Only
    // apps declaring dev-workspace metadata get a non-default folder; every
    // other app stays null and opens its own source dir.
    const workspaceFolder = devWorkspaceFolder(a);

    return {
      id: m.id,
      name: m.name,
      icon: m.icon ?? m.name.slice(0, 2).toUpperCase(),
      running: Boolean(inst),
      hasCap,
      supported,
      sandbox: m.sandbox ?? 'proot',
      workspaceFolder,
      session: session ? { host: session.host, port: session.port, startedAt: session.startedAt } : null,
    };
  }));

  rows.sort((x, y) => Number(y.hasCap) - Number(x.hasCap) || x.id.localeCompare(y.id));
  return { capInstalled: installed, osApi: OS_API, csCommit: CS_COMMIT, apps: rows };
}
