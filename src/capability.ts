/**
 * The code-server capability entry + shell-API helpers.
 *
 * CODE_SERVER_ENTRY duplicates the `capabilities.code-server` entry in
 * /workspace/.aura/capabilities.yaml (and registry-defaults.yaml): the
 * `POST /api/admin/cap` endpoint requires the parsed entry in the request
 * body, and this sandbox cannot read the YAML. Keep them in sync.
 */

export const OS_API = process.env['AURA_OS_API'] ?? 'http://aura-shell:3000';

export const CAP_NAME = 'code-server';

export const CODE_SERVER_ENTRY = {
  source: 'curl',
  install_cmd: [
    'set -e',
    'VERSION=4.137.0',
    'DEST=/home/aura/.aura/code-server',
    'if [ ! -x "$DEST/$VERSION/bin/code-server" ]; then',
    '  rm -rf "$DEST/$VERSION"; mkdir -p "$DEST/$VERSION"',
    '  curl -fsSL "https://github.com/coder/code-server/releases/download/v$VERSION/code-server-$VERSION-linux-amd64.tar.gz" | tar -xz -C "$DEST/$VERSION" --strip-components=1',
    'fi',
    'ln -sfn "$DEST/$VERSION" "$DEST/current"',
    'mkdir -p "$DEST/data" "$DEST/extensions" "$DEST/run"',
    'chmod -R a+rX "$DEST/$VERSION"',
    'printf \'#!/bin/sh\\nexec /home/aura/.aura/code-server/current/bin/code-server "$@"\\n\' > /usr/local/bin/code-server',
    'chmod 755 /usr/local/bin/code-server',
  ].join('\n'),
  binary_path: '/usr/local/bin/code-server',
  binary: 'code-server',
  description: 'VS Code in the browser — standalone release in the shared home; shim lands on PATH in granted sandboxes',
};

export async function osJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${OS_API}${path}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function capInstalled(): Promise<boolean> {
  try {
    const data = await osJson<{ state?: { capabilities?: Record<string, { installed?: boolean }> } }>('/api/admin/cap');
    return data.state?.capabilities?.[CAP_NAME]?.installed === true;
  } catch {
    return false;
  }
}

export async function installCap(): Promise<unknown> {
  return osJson('/api/admin/cap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: CAP_NAME, action: 'install', entry: CODE_SERVER_ENTRY }),
  });
}

export async function grantCap(appId: string, revoke = false): Promise<unknown> {
  return osJson('/api/admin/manifest-edit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, action: revoke ? 'remove-tool' : 'add-tool', tool: CAP_NAME }),
  });
}
