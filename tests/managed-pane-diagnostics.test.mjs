import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createManagedPaneRegistry } from '../server/terminal/managed-pane-registry.mjs';
import { createTerminalManager } from '../server/terminal/manager.mjs';
import { nativeProcessTable } from '../server/codex-process-proof.mjs';
import { createCore } from '../server/core.mjs';
import { startHttp } from '../server/http.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'seqivo-pane-diag-'));
  const recordRoot = join(root, 'records');
  mkdirSync(recordRoot, { mode: 0o700 });
  const store = new Store(join(root, 'board.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, recordRoot, store };
}

test('damaged managed index latches a bounded, non-authorizing first cause', t => {
  if (process.platform !== 'darwin') return t.skip('managed recovery is macOS only');
  const { recordRoot, store } = fixture(t);
  store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)')
    .run('terminal.managed-panes.v1', '{private-capability-canary');
  const registry = createManagedPaneRegistry({ store, recordRoot });
  const first = registry.diagnostics();
  assert.equal(registry.hasUnresolved('any-project'), true);
  assert.equal(first.supported, true);
  assert.equal(first.inventoryUnknown, true);
  assert.deepEqual(first.items, []);
  assert.equal(first.firstInventoryFailure.phase, 'index_read');
  assert.equal(first.firstInventoryFailure.category, 'index_invalid');
  assert.match(first.firstInventoryFailure.at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(registry.diagnostics(), first);
  assert.equal(JSON.stringify(first).includes('private-capability-canary'), false);
});

test('missing private record stays unavailable and keeps the first sanitized failure', async t => {
  if (process.platform !== 'darwin') return t.skip('managed recovery is macOS only');
  const { root, recordRoot, store } = fixture(t);
  const profile = { id: 'managed', projectId: 'project-1', cwd: root,
    serverName: 'seqivo_diag', shell: '/bin/sh', tmuxExecutable: null };
  const recordId = 'private-record-id-canary';
  const directory = 'seqivo-pane-record-ABC123';
  mkdirSync(join(recordRoot, directory), { mode: 0o700 });
  const binding = createHash('sha256').update(JSON.stringify([profile.id, profile.projectId,
    profile.cwd, profile.serverName, profile.shell, profile.tmuxExecutable])).digest('hex');
  const item = { recordId, directory, profileId: profile.id, projectId: profile.projectId,
    actorId: 'owner', generation: 1, binding, status: 'started', parked: false,
    sessionRef: { serverName: profile.serverName, instanceId: 'a'.repeat(64), sessionId: '$1' } };
  store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)')
    .run('terminal.managed-panes.v1', JSON.stringify({ version: 1, entries: [item] }));
  const registry = createManagedPaneRegistry({ store, recordRoot });
  await registry.initialize([profile]);
  const first = registry.diagnostics();
  assert.equal(first.inventoryUnknown, false);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].status, 'started');
  assert.equal(first.items[0].firstCause.phase, 'ensure_reconnect');
  assert.equal(first.items[0].firstCause.category, 'unconfirmed');
  assert.match(first.items[0].recordDigest, /^[a-f0-9]{16}$/);
  assert.equal(registry.hasUnresolved(profile.projectId), true);
  await registry.initialize([profile]);
  assert.deepEqual(registry.diagnostics(), first);
  assert.equal(JSON.stringify(first).includes(recordId), false);
  assert.equal(JSON.stringify(first).includes(root), false);
});

test('owner diagnostics request reports unsupported mode without a managed registry', async t => {
  const { store } = fixture(t);
  const manager = createTerminalManager({ store });
  const result = await manager.request('GET', '/api/terminal/diagnostics');
  assert.equal(result.supported, false);
  assert.deepEqual(result.items, []);
  assert.equal(result.firstInventoryFailure, null);
});

test('native snapshot failure carries only a whitelisted, private reason', async t => {
  const { root } = fixture(t);
  for (const [reason, expected] of [['pid_info_incomplete', 'pid_info_incomplete'],
    ['private_secret_canary', undefined]]) {
    const executable = join(root, `snapshot-${reason}`);
    const output = JSON.stringify({ schemaVersion: 1, uid: process.geteuid(), verified: false,
      reason, rows: [] });
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit 2\n`, { mode: 0o700 });
    await assert.rejects(nativeProcessTable(executable, 3000), error => {
      assert.equal(error.snapshotDiagnostic, expected);
      assert.equal(Object.keys(error).includes('snapshotDiagnostic'), false);
      return true;
    });
  }
});

test('diagnostics HTTP entry requires the local owner and rejects untrusted origins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seqivo-diag-auth-'));
  let core, http;
  try {
    const dataDir = join(root, 'core');
    core = await createCore({ dataDir, pluginDir: join(root, 'empty-plugins'), files: false });
    http = await startHttp({ core, dataDir, distDir: root, port: 0 });
    const origin = `http://127.0.0.1:${http.port}`;
    const call = (role, requestOrigin = origin) => fetch(`${origin}/api/terminal/diagnostics`, {
      headers: { Origin: requestOrigin, ...(role ? { Authorization: `Bearer ${http.tokens[role]}` } : {}) }
    });
    const owner = await call('owner');
    assert.equal(owner.status, 200);
    const detail = await owner.json();
    assert.equal(detail.scope, 'current-process-observation-not-authorization');
    assert.deepEqual(detail.items, []);
    assert.equal(JSON.stringify(detail).includes(root), false);
    for (const role of ['viewer', 'reporter']) {
      const denied = await call(role);
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).code, 'TERMINAL_FORBIDDEN');
    }
    const anonymous = await call(null);
    assert.equal(anonymous.status, 401);
    await anonymous.arrayBuffer();
    const foreignOrigin = await call('owner', 'https://untrusted.example');
    assert.equal(foreignOrigin.status, 403);
    await foreignOrigin.arrayBuffer();
  } finally {
    await http?.close();
    await core?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
