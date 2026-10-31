import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { createCore } from '../server/core.mjs';
import { createHub } from '../server/hub/http.mjs';

const vite = join(process.cwd(), 'node_modules/vite/bin/vite.js');
const bounded = async (work, label, ms = 10000) => {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
  } finally { clearTimeout(timer); }
};
const until = async (check, label) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const found = await check();
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
};

test('revoking the exact node project grant after durable dispatch fences result bytes and new admissions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'preview-grant-inflight-'));
  let hub, core, releaseGate, originalGet, originalRequest, completed = false;
  t.after(async () => {
    releaseGate?.();
    if (core && originalGet) core.previewRegistry.get = originalGet;
    const errors = [];
    if (originalRequest) try { await bounded(originalRequest, 'original request cleanup'); }
    catch (error) { errors.push(error); }
    for (const close of [() => core?.close(), () => hub?.close()]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (completed && !errors.length) try { await rm(root, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
    if (!completed || errors.length) {
      // A failed assertion or uncertain close keeps the disposable DB and receipts intact.
      console.error('Preview grant fixture retained:', root);
    }
    if (errors.length) throw new AggregateError(errors, 'Preview grant fixture cleanup failed');
  });

  const projectDir = join(root, 'project');
  await mkdir(projectDir);
  await writeFile(join(projectDir, '.gitignore'), 'dist/\n');
  await writeFile(join(projectDir, 'index.html'),
    '<!doctype html><button>Save</button><script type="module" src="./main.js"></script>');
  await writeFile(join(projectDir, 'main.js'), 'document.querySelector("button").onclick=()=>{};');
  for (const args of [['init', '-q'], ['config', 'user.email', 'preview@example.test'],
    ['config', 'user.name', 'Preview Grant Test'], ['add', '.'], ['commit', '-qm', 'Initial']]) {
    execFileSync('git', args, { cwd: projectDir, stdio: 'pipe', timeout: 30000 });
  }
  execFileSync(process.execPath, [vite, 'build', '--base', './'],
    { cwd: projectDir, stdio: 'pipe', timeout: 30000 });

  hub = await createHub({ dataDir: join(root, 'hub'), port: 0 });
  core = await createCore({ dataDir: join(root, 'core'), pluginDir: join(root, 'plugins'), files: false });
  const project = core.store.project({ name: 'Grant in-flight fixture', directory: projectDir });
  const task = core.store.createTask({ projectId: project.id, title: 'Save a record' });
  const username = 'grant_owner', password = 'LocalTest-password-697';
  const owner = await hub.accounts.register({ username, password, source: 'isolated-preview-grant' });
  const ownerCookie = `hub_session=${owner.sessionToken}`;
  const other = await hub.accounts.register({ username: 'grant_other', password,
    source: 'isolated-preview-grant' });
  const otherCookie = `hub_session=${other.sessionToken}`;
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(hub.url + path, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: Object.fromEntries(Object.entries({ Cookie: ownerCookie, Origin: hub.url,
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers })
        .filter(([, value]) => value !== undefined)),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await response.text();
    return { status: response.status, raw, data: raw ? JSON.parse(raw) : null };
  };
  await core.remote.login({ url: hub.url, username, password, projectIds: [project.id] });
  await until(() => hub.store.db.prepare('SELECT received_at FROM snapshots').get()?.received_at,
    'node snapshot');
  const built = await core.request('POST', '/api/preview/builds', {
    projectId: project.id, taskId: task.id, contentVersion: 1, distDir: join(projectDir, 'dist'),
    environment: 'test', dataMode: 'real', apiTarget: 'records-v1',
  });
  const manifest = built.preview, id = manifest.previewId;
  assert.equal(manifest.apiTarget, 'records-v1');
  const nodeId = hub.store.db.prepare('SELECT node_id FROM snapshots').get().node_id;
  const intent = (await request('POST', `/api/previews/${id}/access-intents`, {})).data.intent;
  const issue = await request('POST', `/api/previews/${id}/access-intents/${intent.id}/issue`, {});
  assert.equal(issue.status, 200);
  const dataPath = `/api/previews/${id}/data/records`;
  const dataHeaders = { Origin: 'null', Cookie: undefined,
    'X-Seqivo-Preview-Data': issue.data.dataCapability };
  const key = 'grant-inflight-697', title = 'Admitted before project grant revocation';
  const readOperation = () => hub.store.db.prepare(`SELECT * FROM preview_record_operations
    WHERE preview_id=? AND client_mutation_id=?`).get(id, key);

  let entered;
  let admitted;
  const enteredGate = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { releaseGate = resolve; });
  originalGet = core.previewRegistry.get;
  let gated = false;
  core.previewRegistry.get = async previewId => {
    if (previewId === id && !gated) {
      gated = true;
      entered();
      await gate;
    }
    return originalGet(previewId);
  };
  try {
    originalRequest = request('POST', dataPath, { clientMutationId: key, title }, dataHeaders);
    await bounded(enteredGate, 'Core registry get entry');
    admitted = await until(() => readOperation()?.status === 'dispatched' && readOperation(),
      'durable Hub dispatch');
    assert.equal(admitted.client_mutation_id, key);
    assert.equal(admitted.preview_id, id);
    assert.equal(admitted.node_id, nodeId);
    assert.equal(admitted.status, 'dispatched');

    const revoked = await request('DELETE', `/api/admin/grants/${nodeId}/${project.id}`);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.enabled, false);
    assert.ok(revoked.data.epoch > admitted.node_epoch);
  } finally {
    releaseGate();
    releaseGate = null;
    core.previewRegistry.get = originalGet;
    originalGet = null;
  }

  const original = await bounded(originalRequest, 'original write outcome');
  assert.equal(original.status, 503, 'revoked node grant must prevent success bytes');
  assert.ok(['NODE_OFFLINE', 'PREVIEW_RECORD_UNKNOWN'].includes(original.data?.code),
    'the denial must describe unavailable authority or an uncertain original receipt');
  assert.equal(Object.hasOwn(original.data, 'record'), false);
  assert.equal(original.raw.includes(title), false, 'record title must not leak in a denied response');
  assert.equal(original.raw.includes('"operationId"'), false);

  const oldRead = await request('GET', dataPath, undefined, dataHeaders);
  const oldWrite = await request('POST', dataPath,
    { clientMutationId: 'grant-after-revoke', title: 'Must not be admitted' }, dataHeaders);
  assert.equal(oldRead.status, 503);
  assert.equal(oldWrite.status, 503);
  for (const denied of [oldRead, oldWrite]) {
    assert.equal(Object.hasOwn(denied.data, 'record'), false);
    assert.equal(Object.hasOwn(denied.data, 'records'), false);
    assert.equal(denied.raw.includes(title), false);
    assert.equal(denied.raw.includes('Must not be admitted'), false);
  }

  const hubOperations = hub.store.db.prepare('SELECT * FROM preview_record_operations WHERE preview_id=?').all(id);
  assert.equal(hubOperations.length, 1, 'revocation must not admit a second mutation');
  assert.equal(hubOperations[0].operation_id, admitted.operation_id);
  assert.equal(hubOperations[0].client_mutation_id, key);
  assert.ok(['dispatched', 'confirmed'].includes(hubOperations[0].status),
    'an earlier admission may commit, but must not silently disappear or become not_applied');
  const recovery = `/api/previews/${id}/data/stores/${manifest.dataStoreId}/operations/by-key/${key}`;
  const sameAccount = await request('GET', recovery);
  assert.equal(sameAccount.status, 200);
  assert.ok(['unknown', 'confirmed'].includes(sameAccount.data.operation.state),
    'historical recovery may be unknown or confirmed, never a false non-execution claim');
  const crossAccount = await request('GET', recovery, undefined, { Cookie: otherCookie });
  assert.equal(crossAccount.status, 403);
  assert.equal(crossAccount.raw.includes(title), false);
  assert.equal(crossAccount.raw.includes(admitted.operation_id), false);
  assert.equal(Object.hasOwn(crossAccount.data, 'operation'), false);

  const coreDb = new DatabaseSync(join(root, 'core', 'preview-records', 'records.sqlite'), { readOnly: true });
  let coreRecords, coreOperations;
  try {
    coreRecords = coreDb.prepare('SELECT record_id,title FROM preview_records WHERE preview_id=?').all(id);
    coreOperations = coreDb.prepare('SELECT operation_id,status FROM preview_record_operations WHERE preview_id=?').all(id);
  } finally { coreDb.close(); }
  assert.ok(coreRecords.length <= 1 && coreOperations.length <= 1,
    'Core cannot create a second record or operation from the denied new mutation');
  assert.equal(coreRecords.length, coreOperations.length,
    'Core inserts a record and its original operation receipt in one transaction');
  if (coreRecords.length) {
    assert.equal(coreRecords[0].title, title);
    assert.equal(coreOperations[0].operation_id, admitted.operation_id);
    assert.equal(coreOperations[0].status, 'confirmed');
  }
  if (hubOperations[0].status === 'confirmed' || sameAccount.data.operation.state === 'confirmed') {
    assert.equal(hubOperations[0].status, 'confirmed');
    assert.equal(coreRecords.length, 1, 'Hub cannot confirm without the original Core record');
    assert.equal(sameAccount.data.operation.recordId, coreRecords[0].record_id);
    assert.equal(JSON.parse(hubOperations[0].record_json).id, coreRecords[0].record_id);
  } else if (coreRecords.length === 0) {
    assert.equal(hubOperations[0].status, 'dispatched');
    assert.equal(sameAccount.data.operation.state, 'unknown');
  }
  console.log(JSON.stringify({ admittedBeforeRevoke: true, originalStatus: original.status,
    historicalRecovery: sameAccount.data.operation.state, hubOperations: hubOperations.length,
    coreOperations: coreOperations.length, coreRecords: coreRecords.length, newAdmissionDenied: true }));
  completed = true;
});

test('a project grant revoked after the Core commit cannot deliver the original record receipt',
  { concurrency: false }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'preview-grant-after-commit-'));
    let hub, core, originalRequest, releaseResult, restoreSend, completed = false;
    t.after(async () => {
      restoreSend?.();
      releaseResult?.();
      const errors = [];
      if (originalRequest) try { await bounded(originalRequest, 'post-commit original cleanup'); }
      catch (error) { errors.push(error); }
      for (const close of [() => core?.close(), () => hub?.close()]) {
        try { await close(); } catch (error) { errors.push(error); }
      }
      if (completed && !errors.length) try { await rm(root, { recursive: true, force: true }); }
      catch (error) { errors.push(error); }
      if (!completed || errors.length) console.error('Post-commit grant fixture retained:', root);
      if (errors.length) throw new AggregateError(errors, 'Post-commit grant fixture cleanup failed');
    });

    const projectDir = join(root, 'project');
    await mkdir(projectDir);
    await writeFile(join(projectDir, '.gitignore'), 'dist/\n');
    await writeFile(join(projectDir, 'index.html'),
      '<!doctype html><button>Save</button><script type="module" src="./main.js"></script>');
    await writeFile(join(projectDir, 'main.js'), 'document.querySelector("button").onclick=()=>{};');
    for (const args of [['init', '-q'], ['config', 'user.email', 'preview@example.test'],
      ['config', 'user.name', 'Post-commit Grant Test'], ['add', '.'], ['commit', '-qm', 'Initial']]) {
      execFileSync('git', args, { cwd: projectDir, stdio: 'pipe', timeout: 30000 });
    }
    execFileSync(process.execPath, [vite, 'build', '--base', './'],
      { cwd: projectDir, stdio: 'pipe', timeout: 30000 });

    hub = await createHub({ dataDir: join(root, 'hub'), port: 0 });
    core = await createCore({ dataDir: join(root, 'core'), pluginDir: join(root, 'plugins'), files: false });
    const project = core.store.project({ name: 'Post-commit grant fixture', directory: projectDir });
    const task = core.store.createTask({ projectId: project.id, title: 'Save one record' });
    const password = 'LocalTest-password-697';
    const owner = await hub.accounts.register({ username: 'post_commit_owner', password,
      source: 'isolated-preview-grant' });
    const other = await hub.accounts.register({ username: 'post_commit_other', password,
      source: 'isolated-preview-grant' });
    const ownerCookie = `hub_session=${owner.sessionToken}`;
    const otherCookie = `hub_session=${other.sessionToken}`;
    const request = async (method, path, body, headers = {}) => {
      const response = await fetch(hub.url + path, {
        method, signal: AbortSignal.timeout(10000),
        headers: Object.fromEntries(Object.entries({ Cookie: ownerCookie, Origin: hub.url,
          ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers })
          .filter(([, value]) => value !== undefined)),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const raw = await response.text();
      return { status: response.status, raw, data: raw ? JSON.parse(raw) : null };
    };
    await core.remote.login({ url: hub.url, username: 'post_commit_owner', password,
      projectIds: [project.id] });
    await until(() => hub.store.db.prepare('SELECT received_at FROM snapshots').get()?.received_at,
      'post-commit node snapshot');
    const built = await core.request('POST', '/api/preview/builds', {
      projectId: project.id, taskId: task.id, contentVersion: 1, distDir: join(projectDir, 'dist'),
      environment: 'test', dataMode: 'real', apiTarget: 'records-v1',
    });
    const manifest = built.preview, id = manifest.previewId;
    assert.equal(manifest.apiTarget, 'records-v1');
    const nodeId = hub.store.db.prepare('SELECT node_id FROM snapshots').get().node_id;
    const intent = (await request('POST', `/api/previews/${id}/access-intents`, {})).data.intent;
    const issue = await request('POST', `/api/previews/${id}/access-intents/${intent.id}/issue`, {});
    assert.equal(issue.status, 200);
    const dataPath = `/api/previews/${id}/data/records`;
    const dataHeaders = { Origin: 'null', Cookie: undefined,
      'X-Seqivo-Preview-Data': issue.data.dataCapability };
    const key = 'after-commit-943', title = 'Committed before grant revocation';
    const readHubOperation = () => hub.store.db.prepare(`SELECT * FROM preview_record_operations
      WHERE preview_id=? AND client_mutation_id=?`).get(id, key);
    const coreDbPath = join(root, 'core', 'preview-records', 'records.sqlite');
    const readCore = () => {
      const db = new DatabaseSync(coreDbPath, { readOnly: true });
      try {
        return {
          records: db.prepare('SELECT record_id,title FROM preview_records WHERE preview_id=?').all(id),
          operations: db.prepare(`SELECT operation_id,status,record_id FROM preview_record_operations
            WHERE preview_id=?`).all(id),
        };
      } finally { db.close(); }
    };

    // This one test-local transport gate runs after createOperation's COMMIT and
    // before Hub can receive its original result. Every other frame is untouched.
    let entered, held = null, settled = false;
    const resultEntered = new Promise(resolve => { entered = resolve; });
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data, ...args) {
      if (!held && typeof data === 'string') {
        let frame;
        try { frame = JSON.parse(data); } catch { /* unrelated frame */ }
        if (frame?.v === 2 && frame.type === 'records-result' &&
          frame.result?.operation?.status === 'confirmed') {
          held = { socket: this, data, args, frame };
          entered();
          return;
        }
      }
      return originalSend.call(this, data, ...args);
    };
    restoreSend = () => { WebSocket.prototype.send = originalSend; restoreSend = null; };
    releaseResult = () => {
      if (held?.socket.readyState === WebSocket.OPEN) originalSend.call(held.socket, held.data, ...held.args);
      held = null;
      releaseResult = null;
    };
    try {
      originalRequest = request('POST', dataPath, { clientMutationId: key, title }, dataHeaders);
      void originalRequest.then(() => { settled = true; }, () => { settled = true; });
      await bounded(resultEntered, 'Core committed result frame');
      const admitted = readHubOperation();
      const committed = readCore();
      assert.equal(settled, false, 'client must still be waiting for its original receipt');
      assert.equal(admitted?.status, 'dispatched');
      assert.equal(admitted.client_mutation_id, key);
      assert.equal(committed.records.length, 1);
      assert.equal(committed.operations.length, 1);
      assert.equal(committed.records[0].title, title);
      assert.equal(committed.operations[0].status, 'confirmed');
      assert.equal(committed.operations[0].operation_id, admitted.operation_id);
      assert.equal(committed.operations[0].record_id, committed.records[0].record_id);
      assert.equal(held.frame.result.operation.id, admitted.operation_id);

      const revoked = await request('DELETE', `/api/admin/grants/${nodeId}/${project.id}`);
      assert.equal(revoked.status, 200);
      assert.equal(revoked.data.enabled, false);
      assert.ok(revoked.data.epoch > admitted.node_epoch);
    } finally {
      restoreSend?.();
      releaseResult?.();
    }

    const original = await bounded(originalRequest, 'post-commit original response');
    assert.ok([403, 503].includes(original.status), 'revoked grant cannot deliver success bytes');
    for (const text of [title, '"operationId"', '"record"', issue.data.dataCapability])
      assert.equal(original.raw.includes(text), false);
    const oldRead = await request('GET', dataPath, undefined, dataHeaders);
    const sameKey = await request('POST', dataPath, { clientMutationId: key, title }, dataHeaders);
    const newKey = await request('POST', dataPath,
      { clientMutationId: 'after-revoke-943', title: 'Must not be admitted' }, dataHeaders);
    for (const denied of [oldRead, sameKey, newKey]) {
      assert.ok([403, 503].includes(denied.status));
      assert.equal(denied.raw.includes(title), false);
      assert.equal(denied.raw.includes('Must not be admitted'), false);
    }

    const hubOperations = hub.store.db.prepare('SELECT * FROM preview_record_operations WHERE preview_id=?').all(id);
    const coreRows = readCore();
    assert.equal(hubOperations.length, 1, 'revocation and retries must not admit another mutation');
    assert.equal(hubOperations[0].operation_id, coreRows.operations[0].operation_id);
    assert.ok(['dispatched', 'confirmed'].includes(hubOperations[0].status));
    assert.equal(coreRows.records.length, 1);
    assert.equal(coreRows.operations.length, 1);
    assert.equal(coreRows.operations[0].operation_id, hubOperations[0].operation_id);
    const recovery = `/api/previews/${id}/data/stores/${manifest.dataStoreId}/operations/by-key/${key}`;
    const ownerHistory = await request('GET', recovery);
    assert.equal(ownerHistory.status, 200);
    assert.equal(ownerHistory.data.operation.id, hubOperations[0].operation_id);
    assert.ok(['unknown', 'confirmed'].includes(ownerHistory.data.operation.state));
    if (ownerHistory.data.operation.state === 'confirmed')
      assert.equal(ownerHistory.data.operation.recordId, coreRows.records[0].record_id);
    const otherHistory = await request('GET', recovery, undefined, { Cookie: otherCookie });
    assert.equal(otherHistory.status, 403);
    assert.equal(otherHistory.raw.includes(title), false);
    assert.equal(otherHistory.raw.includes(hubOperations[0].operation_id), false);
    assert.equal(Object.hasOwn(otherHistory.data, 'operation'), false);
    completed = true;
  });
