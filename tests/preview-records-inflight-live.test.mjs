import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from '@playwright/test';
import { createCore } from '../server/core.mjs';
import { createHub } from '../server/hub/http.mjs';

const vite = join(process.cwd(), 'node_modules/vite/bin/vite.js');
const waitFor = async (check, label) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(label);
};

test('revoking a browser session while a real preview record write is dispatched withholds its reply and fences the old capability', async t => {
  const qaRoot = join(process.cwd(), '.runtime', 'preview248');
  await mkdir(qaRoot, { recursive: true });
  const root = await mkdtemp(join(qaRoot, 'fixture-'));
  let core, hub, browser, release;
  t.after(async () => {
    release?.();
    const errors = [];
    for (const close of [() => browser?.close(), () => core?.close(), () => hub?.close()]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (!errors.length) try { await rm(root, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Preview in-flight cleanup failed');
  });
  const projectDir = join(root, 'project');
  await mkdir(projectDir);
  await writeFile(join(projectDir, '.gitignore'), 'dist/\n');
  await writeFile(join(projectDir, 'index.html'),
    '<!doctype html><button id="save">Save</button><script type="module" src="./main.js"></script>');
  await writeFile(join(projectDir, 'main.js'), 'document.querySelector("#save").onclick=()=>{};');
  for (const args of [['init', '-q'], ['config', 'user.email', 'preview@example.test'],
    ['config', 'user.name', 'Preview Test'], ['add', '.'], ['commit', '-qm', 'Initial']]) {
    execFileSync('git', args, { cwd: projectDir, stdio: 'pipe', timeout: 30000 });
  }
  execFileSync(process.execPath, [vite, 'build', '--base', './'],
    { cwd: projectDir, stdio: 'pipe', timeout: 30000 });
  hub = await createHub({ dataDir: join(root, 'hub'), port: 0 });
  core = await createCore({ dataDir: join(root, 'core'), pluginDir: join(root, 'plugins'), files: false });
  const project = core.store.project({ name: 'In-flight permission fixture', directory: projectDir });
  const task = core.store.createTask({ projectId: project.id, title: 'Save record' });
  const username = 'preview_inflight', password = 'LocalTest-password-239';
  const account = await hub.accounts.register({ username, password, source: 'isolated-preview-inflight' });
  const cookie = `hub_session=${account.sessionToken}`;
  const call = async (method, path, body, requestCookie = cookie) => {
    const response = await fetch(hub.url + path, { method,
      headers: { Cookie: requestCookie, Origin: hub.url,
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  await core.remote.login({ url: hub.url, username, password, projectIds: [project.id] });
  await waitFor(() => hub.store.db.prepare('SELECT received_at FROM snapshots').get()?.received_at,
    'Real Core snapshot missing');
  const registered = await core.request('POST', '/api/preview/builds', {
    projectId: project.id, taskId: task.id, contentVersion: 1,
    distDir: join(projectDir, 'dist'), environment: 'isolated', dataMode: 'real', apiTarget: 'records-v1',
  });
  const manifest = registered.preview, previewId = manifest.previewId;
  const intent = await call('POST', `/api/previews/${previewId}/access-intents`, {});
  assert.equal(intent.status, 200);
  const issued = await call('POST', `/api/previews/${previewId}/access-intents/${intent.data.intent.id}/issue`, {});
  assert.equal(issued.status, 200);
  const dataPath = `/api/previews/${previewId}/data/records`;
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addCookies([{ name: 'hub_session', value: account.sessionToken, url: hub.url,
    httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  await page.goto(hub.url + issued.data.launchUrl);
  await page.locator('#save').waitFor();

  // Test-only gate: hold the real node's registry lookup after Hub has persisted
  // and dispatched the operation; no preview HTTP/WS response is mocked.
  const originalGet = core.previewRegistry.get;
  let entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  core.previewRegistry.get = async id => {
    if (id === previewId) { entered = true; await gate; }
    return originalGet(id);
  };
  const attempted = page.evaluate(async ({ path, capability }) => {
    try {
      const response = await fetch(path, { method: 'POST', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', 'X-Seqivo-Preview-Data': capability },
        body: JSON.stringify({ clientMutationId: 'inflight-save', title: 'Original in-flight record' }) });
      return { status: response.status, accepted: response.ok };
    } catch { return { status: null, accepted: false }; }
  }, { path: dataPath, capability: issued.data.dataCapability });
  try {
    await waitFor(() => entered && hub.store.db.prepare(`SELECT status FROM preview_record_operations
      WHERE preview_id=? AND client_mutation_id='inflight-save'`).get(previewId)?.status === 'dispatched',
    'Real record operation was not dispatched before revocation');
    const logout = await call('POST', '/api/auth/logout', {});
    assert.equal(logout.status, 200);
  } finally {
    release(); release = null;
    core.previewRegistry.get = originalGet;
  }
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Browser write reply timed out')), 10000);
  });
  let browserResult;
  try { browserResult = await Promise.race([attempted, deadline]); }
  finally { clearTimeout(timeout); }
  assert.equal(browserResult.accepted, false, 'revoked page must not receive a successful write reply');
  const original = hub.store.db.prepare(`SELECT status,operation_id FROM preview_record_operations
    WHERE preview_id=? AND client_mutation_id='inflight-save'`).get(previewId);
  assert.ok(original, 'dispatched original ID remains auditable even if the browser lost its reply');
  assert.equal(original.status, 'confirmed', 'this controlled Core fixture completes the original write');
  assert.equal(hub.store.db.prepare('SELECT count(*) AS n FROM preview_record_operations WHERE preview_id=?')
    .get(previewId).n, 1, 'no second operation may be inserted');

  const oldDataHeaders = { Origin: 'null',
    'X-Seqivo-Preview-Data': issued.data.dataCapability };
  const oldRead = await fetch(hub.url + dataPath, { headers: oldDataHeaders });
  assert.equal(oldRead.status, 403);
  const oldWrite = await fetch(hub.url + dataPath, { method: 'POST',
    headers: { ...oldDataHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientMutationId: 'after-logout', title: 'Must not write' }) });
  assert.equal(oldWrite.status, 403);
  const recovery = `/api/previews/${previewId}/data/stores/${manifest.dataStoreId}/operations/by-key/inflight-save`;
  assert.equal((await call('GET', recovery)).status, 401);
  const other = await hub.accounts.register({ username: 'preview_other', password,
    source: 'isolated-preview-inflight' });
  assert.equal((await call('GET', recovery, undefined, `hub_session=${other.sessionToken}`)).status, 403);
  const fresh = await hub.accounts.login({ username, password, source: 'isolated-preview-inflight' });
  const known = await call('GET', recovery, undefined, `hub_session=${fresh.sessionToken}`);
  assert.equal(known.status, 200);
  assert.equal(known.data.operation.state, 'confirmed');
  assert.equal(known.data.operation.clientMutationId, 'inflight-save');
  const coreDb = new DatabaseSync(join(root, 'core', 'preview-records', 'records.sqlite'), { readOnly: true });
  let records, coreOperation;
  try {
    records = coreDb.prepare(`SELECT record_id,title,client_mutation_id FROM preview_records
      WHERE preview_id=?`).all(previewId);
    coreOperation = coreDb.prepare(`SELECT operation_id,client_mutation_id,status,record_id
      FROM preview_record_operations WHERE preview_id=?`).all(previewId);
  } finally { coreDb.close(); }
  assert.equal(records.length, 1, 'Core must persist exactly the original record');
  assert.equal(coreOperation.length, 1);
  assert.equal(coreOperation[0].client_mutation_id, 'inflight-save');
  assert.equal(coreOperation[0].operation_id, original.operation_id);
  assert.equal(coreOperation[0].status, 'confirmed');
  assert.equal(coreOperation[0].record_id, records[0].record_id);
  assert.equal(records[0].title, 'Original in-flight record');
  assert.equal(records[0].record_id, known.data.operation.recordId,
    'account recovery must identify the same Core record');
  assert.equal(hub.store.db.prepare('SELECT count(*) AS n FROM preview_record_operations WHERE preview_id=?')
    .get(previewId).n, 1);
  console.log(JSON.stringify({ browserAccepted: browserResult.accepted,
    browserStatus: browserResult.status, originalStatus: original.status,
    recoveryState: known.data.operation.state, operationCount: 1, coreRecordCount: records.length }));
});
