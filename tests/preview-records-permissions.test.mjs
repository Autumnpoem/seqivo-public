import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { createHub } from '../server/hub/http.mjs';

const vite = join(process.cwd(), 'node_modules/vite/bin/vite.js');
const until = async check => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Preview node did not register');
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'preview-permissions-'));
  let hub, core;
  t.after(async () => {
    const errors = [];
    for (const close of [() => core?.close(), () => hub?.close()]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (!errors.length) try { await rm(root, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Preview permission fixture cleanup failed');
  });
  const projectDir = join(root, 'project');
  await mkdir(projectDir);
  await writeFile(join(projectDir, '.gitignore'), 'dist/\n');
  await writeFile(join(projectDir, 'index.html'),
    '<!doctype html><button>Save</button><script type="module" src="./main.js"></script>');
  await writeFile(join(projectDir, 'main.js'), 'document.querySelector("button").onclick=()=>{};');
  for (const args of [['init', '-q'], ['config', 'user.email', 'preview@example.test'],
    ['config', 'user.name', 'Preview Test'], ['add', '.'], ['commit', '-qm', 'Initial']]) {
    execFileSync('git', args, { cwd: projectDir, stdio: 'pipe', timeout: 30000 });
  }
  execFileSync(process.execPath, [vite, 'build', '--base', './'],
    { cwd: projectDir, stdio: 'pipe', timeout: 30000 });
  hub = await createHub({ dataDir: join(root, 'hub'), port: 0 });
  core = await createCore({ dataDir: join(root, 'core'), pluginDir: join(root, 'plugins'), files: false });
  const project = core.store.project({ name: 'Permission fixture', directory: projectDir });
  const task = core.store.createTask({ projectId: project.id, title: 'Save a record' });
  const username = 'record_owner', password = 'LocalTest-password-239';
  const account = await hub.accounts.register({ username, password, source: 'isolated-preview-permissions' });
  const cookie = `hub_session=${account.sessionToken}`;
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(hub.url + path, {
      method, headers: Object.fromEntries(Object.entries({ Cookie: cookie, Origin: hub.url,
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers })
        .filter(([, value]) => value !== undefined)),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  };
  await core.remote.login({ url: hub.url, username, password, projectIds: [project.id] });
  await until(() => hub.store.db.prepare('SELECT received_at FROM snapshots').get()?.received_at);
  const built = await core.request('POST', '/api/preview/builds', { projectId: project.id,
    taskId: task.id, contentVersion: 1, distDir: join(projectDir, 'dist'),
    environment: 'test', dataMode: 'real', apiTarget: 'records-v1' });
  const manifest = built.preview;
  const intent = (await call('POST', `/api/previews/${manifest.previewId}/access-intents`, {})).data.intent;
  const issue = await call('POST', `/api/previews/${manifest.previewId}/access-intents/${intent.id}/issue`, {});
  assert.equal(issue.status, 200, JSON.stringify(issue.data));
  const dataPath = `/api/previews/${manifest.previewId}/data/records`;
  const dataHeaders = { Origin: 'null', Cookie: undefined,
    'X-Seqivo-Preview-Data': issue.data.dataCapability };
  const write = (key, title) => call('POST', dataPath, { clientMutationId: key, title }, dataHeaders);
  const list = () => call('GET', dataPath, undefined, dataHeaders);
  const first = await write('original', 'Original record');
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal((await list()).data.records.length, 1);
  const recovery = `/api/previews/${manifest.previewId}/data/stores/${manifest.dataStoreId}/operations/by-key/original`;
  const nodeId = hub.store.db.prepare('SELECT node_id FROM snapshots').get().node_id;
  const operations = () => hub.store.db.prepare('SELECT count(*) AS n FROM preview_record_operations').get().n;
  return { hub, core, account, cookie, call, manifest, intent, project, nodeId, first, recovery,
    dataPath, dataHeaders, write, list, operations };
}

test('revoked account session disables its issued record capability without crossing account identity', async t => {
  const x = await fixture(t);
  const another = await x.hub.accounts.register({ username: 'record_other',
    password: 'LocalTest-password-239', source: 'isolated-preview-permissions' });
  const otherCookie = `hub_session=${another.sessionToken}`;
  const logout = await x.call('POST', '/api/auth/logout', {});
  assert.equal(logout.status, 200);
  assert.equal((await x.list()).status, 403);
  assert.equal((await x.write('after-logout', 'Denied')).status, 403);
  assert.equal((await x.call('GET', x.recovery)).status, 401);
  assert.equal((await x.call('GET', x.recovery, undefined, { Cookie: otherCookie })).status, 403);
  assert.equal((await x.call('GET',
    `/api/previews/${x.manifest.previewId}/access-intents/${x.intent.id}`,
    undefined, { Cookie: otherCookie })).status, 403);
  assert.equal(x.operations(), 1);
});

test('revoked node project grant fences existing preview reads and writes', async t => {
  const x = await fixture(t);
  const revoked = await x.call('DELETE', `/api/admin/grants/${x.nodeId}/${x.project.id}`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  assert.equal(revoked.data.enabled, false);
  assert.equal((await x.list()).status, 503);
  assert.equal((await x.write('after-grant-revoke', 'Denied')).status, 503);
  assert.equal(x.operations(), 1);
  assert.equal((await x.call('GET', x.recovery)).data.operation.recordId, x.first.data.record.id,
    'same-account confirmed recovery remains readable without dispatching a new write');
});

test('node epoch change fences the original preview even when its project remains granted', async t => {
  const x = await fixture(t);
  const rotated = await x.call('POST', '/api/admin/grants',
    { subjectId: x.nodeId, projectId: x.project.id });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.data));
  assert.equal(rotated.data.enabled, true);
  assert.ok(rotated.data.epoch > 1);
  assert.equal((await x.list()).status, 503);
  assert.equal((await x.write('after-node-change', 'Denied')).status, 503);
  assert.equal(x.operations(), 1);
  assert.equal((await x.call('GET', x.recovery)).data.operation.recordId, x.first.data.record.id);
});
