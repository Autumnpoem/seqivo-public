import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHub } from '../server/hub/http.mjs';
import { HubStore } from '../server/hub/store.mjs';
import { createRemoteLink } from '../server/remote-client.mjs';
import { sanitizeSnapshot } from '../server/hub/projection.mjs';

const gateAt = time => ({v:1,bootId:'fixture-core-boot',observedAt:new Date(time).toISOString()});
const ready = {state:'ready',reasonCode:null};
const project = (id,time=Date.now()) => ({ id, name: `Project ${id}`, goal: 'Test', directory: '/secret/local/path', createdAt: new Date().toISOString(),
  conversationStart:{...gateAt(time),...ready} });
const task = (id, projectId, revision = 1,time=Date.now()) => ({ id, projectId, title: id, goal: 'Goal', status: 'blocked', revision, contentVersion: 1, conversationId: 'private-thread', evidence: [{ id: 'e1', summary: 'Done', reference: '/secret/ref' }], blockedReason: '/secret/error',
  executionWrite:{...gateAt(time),taskRevision:revision,contentVersion:1,message:ready,continue:ready} });

test('source conversation group metadata survives projection and rejects malformed values', () => {
  const board = {projects:[project('p1')],tasks:[{...task('t1','p1'),sourceConversationGroup:'a'.repeat(64),sourceConversation:{provider:'private-provider',conversationId:'private-id',label:'private-label'}}]};
  const projected = sanitizeSnapshot(board);
  assert.equal(projected.tasks[0].sourceConversationGroup,'a'.repeat(64));
  assert.equal(JSON.stringify(projected).includes('private-provider'),false);
  assert.deepEqual(sanitizeSnapshot(projected),projected);
  assert.equal(sanitizeSnapshot({projects:board.projects,tasks:[{...task('t1','p1'),sourceConversationGroup:null}]}).tasks[0].sourceConversationGroup,null);
  assert.equal('sourceConversationGroup' in sanitizeSnapshot({projects:board.projects,tasks:[task('t1','p1')]}).tasks[0],false);
  for (const bad of ['', 'private-provider', 'A'.repeat(64), 7, {}, 'a'.repeat(63)]) {
    assert.throws(()=>sanitizeSnapshot({projects:board.projects,tasks:[{...task('t1','p1'),sourceConversationGroup:bad}]}));
  }
});

test('remote source conversation groups are stable, private, and scoped to node and provider', async () => {
  const x=await fixture();let first, restarted, second;
  try {
    const owner=await x.tokenFor('tenant-source');
    const source={provider:'codex-private-provider',conversationId:'private-conversation-id',label:'private-source-label'};
    const board={projects:[project('p1'),project('p2')],tasks:[
      {...task('t1','p1'),sourceConversation:source},
      {...task('t2','p2'),sourceConversation:{...source,label:'another-private-label'}},
      {...task('t3','p1'),sourceConversation:{...source,provider:'another-private-provider'}},
      task('t4','p2'),
      {...task('t6','p2'),conversationId:'',sourceConversation:source},
    ]};
    const pairing=await x.call('POST','/api/admin/pairings',{role:'node',projectIds:['p1','p2']},owner);
    first=await createRemoteLink({dataDir:join(x.root,'source-node'),getState:()=>board,request:async()=>({})});
    await first.configure({url:x.hub.url,pairingCode:pairing.code,projectIds:['p1','p2']});
    const controller=await x.pair(owner,'controller',['p1','p2','p3']);
    const readGroups=async()=>Object.fromEntries((await x.call('GET','/api/state',undefined,controller.token)).tasks.map(t=>[t.id,t.sourceConversationGroup]));
    const initial=await readGroups();
    assert.match(initial.t1,/^[a-f0-9]{64}$/);
    assert.equal(initial.t1,initial.t2);
    assert.equal(initial.t1,initial.t6);
    assert.notEqual(initial.t1,initial.t3);
    assert.equal(initial.t4,null);
    assert.equal((await x.call('GET','/api/state',undefined,controller.token)).tasks.find(t=>t.id==='t6').hasExecutionBinding,false);
    const savedNode=JSON.parse(await readFile(join(x.root,'source-node','remote-link.json'),'utf8'));
    await x.call('POST','/api/node/snapshot',{epoch:savedNode.epoch,sequence:savedNode.sequence+1,
      projects:[project('p1')],tasks:[{...task('bad','p1'),sourceConversationGroup:'private-provider'}]},savedNode.token,400);
    assert.deepEqual(await readGroups(),initial);
    await first.sync();assert.deepEqual(await readGroups(),initial);
    await first.close();
    restarted=await createRemoteLink({dataDir:join(x.root,'source-node'),getState:()=>board,request:async()=>({})});
    await restarted.sync();assert.deepEqual(await readGroups(),initial);
    const otherBoard={projects:[project('p3')],tasks:[{...task('t5','p3'),sourceConversation:source}]};
    const otherPairing=await x.call('POST','/api/admin/pairings',{role:'node',projectIds:['p3']},owner);
    second=await createRemoteLink({dataDir:join(x.root,'other-node'),getState:()=>otherBoard,request:async()=>({})});
    await second.configure({url:x.hub.url,pairingCode:otherPairing.code,projectIds:['p3']});
    const state=await x.call('GET','/api/state',undefined,controller.token);
    assert.notEqual(state.tasks.find(t=>t.id==='t5').sourceConversationGroup,initial.t1);
    for (const secret of Object.values(source)) assert.equal(JSON.stringify(state).includes(secret),false);
  } finally {await first?.close();await restarted?.close();await second?.close();await x.close();}
});

async function fixture(now = Date.now) {
  const root = await mkdtemp(join(tmpdir(), 'taskboard-hub-'));
  const hub = await createHub({ dataDir: join(root, 'hub'), host: '127.0.0.1', port: 0, now });
  const tokenFor = tenant => {
    const { tokenPath } = hub.store.bootstrap(tenant);
    return readFile(tokenPath, 'utf8').then(value => value.trim());
  };
  async function call(method, path, body, secret, expected = 200) {
    const response = await fetch(`${hub.url}${path}`, { method, redirect: 'error', headers: { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  }
  async function pair(owner, role, projectIds, ttlSeconds = 600) {
    const created = await call('POST', '/api/admin/pairings', { role, projectIds, ttlSeconds }, owner);
    return call('POST', '/api/pairings/redeem', { code: created.code }, undefined);
  }
  return { root, hub, tokenFor, call, pair, close: async () => { await hub.close(); await rm(root, { recursive: true, force: true }); } };
}

test('Hub pairs a node and controller, syncs a redacted snapshot, and executes a fixed callback route', async () => {
  const x = await fixture();
  try {
    const owner = await x.tokenFor('tenant-a');
    const code = await x.call('POST', '/api/admin/pairings', { role: 'node', projectIds: ['p1'] }, owner);
    const board = { projects: [project('p1')], tasks: [task('t1', 'p1')], plugin: { config: { codexPath: '/secret' } } };
    const calls = [];
    const link = await createRemoteLink({
      dataDir: join(x.root, 'node'), getState: () => board,
      request: async (method, path, body) => { calls.push({ method, path, body }); return { status: 'running', taskId: 't1', revision: 2 }; },
    });
    try {
      const connected = await link.configure({ url: x.hub.url, pairingCode: code.code, projectIds: ['p1'] });
      assert.equal(connected.status, 'connected');
      const controller = await x.pair(owner, 'controller', ['p1']);
      const state = await x.call('GET', '/api/state', undefined, controller.token);
      assert.equal(state.projects.length, 1);
      assert.equal(state.tasks.length, 1);
      assert.equal(state.tasks[0].hasExecutionBinding, true);
      assert.equal(JSON.stringify(state).includes('/secret'), false);
      const command = await x.call('POST', '/api/commands', {
        commandId: 'c1', projectId: 'p1', taskId: 't1', action: 'continue', expectedRevision: 1,
        expiresAt: new Date(Date.now() + 60000).toISOString(), body: {},
      }, controller.token);
      assert.equal(command.status, 'queued');
      await link.sync();
      assert.deepEqual(calls.map(item => [item.method, item.path]), [['POST', '/api/tasks/t1/continue']]);
      assert.equal(calls[0].body.commandId, 'c1');
      assert.equal((await x.call('GET', '/api/commands/c1', undefined, controller.token)).status, 'running');
    } finally { await link.close(); }
  } finally { await x.close(); }
});

test('Hub roundtrip preserves a pending verification plan and rejects forged checklist commands', async () => {
  const x = await fixture();
  try {
    const owner = await x.tokenFor('tenant-checks');
    const node = await x.pair(owner, 'node', ['p1']);
    const controller = await x.pair(owner, 'controller', ['p1']);
    const pending = { id: '/private/check-integration', kind: 'test', title: '验证 /private/真实响应', criterionIds: ['criterion-1'],
      steps: ['启动 /private/测试服务', '发送请求'], expectedResult: '返回 /private/成功结果', blockedReason: '等待 /private/凭据' };
    const shared = { id: 'local-check-1', kind: 'implementation', title: '公开实现确认', criterionIds: ['criterion-1'],
      steps: ['阅读公开说明'], expectedResult: '实现已说明', blockedReason: '', shareWithRemote: true };
    const planned = { ...task('t1', 'p1'), criteria: [{ id: 'criterion-1', text: '接口成功', passed: false }],
      verification: { status: 'unverified', summary: '仅计划，未执行', reference: '/secret/local-plan.md',
        criterionIds: [], pendingChecks: [pending, shared], source: 'test', contentVersion: 1, createdAt: new Date().toISOString() } };
    await x.call('POST', '/api/node/snapshot', { epoch: 1, sequence: 1, projects: [project('p1')], tasks: [planned] }, node.token);
    const state = await x.call('GET', '/api/state', undefined, controller.token);
    assert.equal(state.tasks[0].verification.status, 'unverified');
    assert.deepEqual(state.tasks[0].verification.pendingChecks, [
      { id: 'remote-check-1', kind: 'test', title: '验证待办 1（详情仅在桌面）', criterionIds: ['criterion-1'],
        steps: ['请在项目电脑打开任务详情，查看具体操作。'], expectedResult: '请在桌面查看通过标准。',
        blockedReason: '请在桌面查看当前缺少的条件。', shareWithRemote: false, completed: false }, { ...shared, id: 'remote-check-2', completed: false }]);
    assert.equal(JSON.stringify(state).includes('/secret'), false);
    assert.equal(JSON.stringify(state).includes('/private/'), false);
    await x.call('POST', '/api/commands', { commandId: 'forge-check', projectId: 'p1', taskId: 't1',
      action: 'update', expectedRevision: 1, expiresAt: new Date(Date.now() + 60000).toISOString(),
      body: { verification: { status: 'passed', pendingChecks: [] } } }, controller.token, 400);
    const malformed = structuredClone(planned);
    malformed.verification.pendingChecks[0].criterionIds = ['foreign'];
    await x.call('POST', '/api/node/snapshot', { epoch: 1, sequence: 2, projects: [project('p1')], tasks: [malformed] }, node.token, 400);
    assert.deepEqual((await x.call('GET', '/api/state', undefined, controller.token)).tasks[0].verification.pendingChecks,
      state.tasks[0].verification.pendingChecks);
  } finally { await x.close(); }
});

test('pairing is one-use and expiring, grants and snapshots stay within each tenant', async () => {
  let clock = Date.now();
  const x = await fixture(() => clock);
  try {
    const a = await x.tokenFor('tenant-a');
    const b = await x.tokenFor('tenant-b');
    const code = await x.call('POST', '/api/admin/pairings', { role: 'node', projectIds: ['pa'], ttlSeconds: 30 }, a);
    await x.call('POST', '/api/pairings/redeem', { code: code.code, projectIds: ['pb'] }, undefined, 403);
    const node = await x.call('POST', '/api/pairings/redeem', { code: code.code, projectIds: ['pa'] });
    await x.call('POST', '/api/pairings/redeem', { code: code.code }, undefined, 410);
    const expired = await x.call('POST', '/api/admin/pairings', { role: 'viewer', projectIds: ['pa'], ttlSeconds: 30 }, a);
    clock += 31_000;
    await x.call('POST', '/api/pairings/redeem', { code: expired.code }, undefined, 410);
    await x.call('POST', '/api/node/snapshot', { epoch: 1, sequence: 1, projects: [project('pa')], tasks: [task('ta', 'pa')] }, node.token);
    await x.call('POST', '/api/node/snapshot', { epoch: 1, sequence: 2, projects: [project('pb')], tasks: [] }, node.token, 403);
    assert.deepEqual((await x.call('GET', '/api/state', undefined, b)).projects, []);
    const aState = await x.call('GET', '/api/state', undefined, a);
    assert.deepEqual(aState.projects.map(item => item.id), ['pa']);
    assert.equal(JSON.stringify(aState).includes('private-thread'), false);
    assert.equal(JSON.stringify(aState).includes('/secret'), false);
  } finally { await x.close(); }
});

test('continue lease, idempotence, queued pause, and revision checks are transactional', async () => {
  const x = await fixture();
  try {
    const owner = await x.tokenFor('tenant-a');
    const node = await x.pair(owner, 'node', ['p1']);
    const controller = await x.pair(owner, 'controller', ['p1']);
    await x.call('POST', '/api/node/snapshot', { epoch: 1, sequence: 1, projects: [project('p1')], tasks: [task('t1', 'p1')] }, node.token);
    const base = { projectId: 'p1', taskId: 't1', action: 'continue', expectedRevision: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), body: {} };
    const first = await x.call('POST', '/api/commands', { commandId: 'c1', ...base }, controller.token);
    assert.equal(first.status, 'queued');
    assert.equal((await x.call('POST', '/api/commands', { commandId: 'c1', ...base }, controller.token)).status, 'queued');
    await x.call('POST', '/api/commands', { commandId: 'c1', ...base, expectedRevision: 2 }, controller.token, 409);
    await x.call('POST', '/api/commands', { commandId: 'c2', ...base }, controller.token, 409);
    const pause = await x.call('POST', '/api/commands', { commandId: 'p1', ...base, action: 'pause' }, controller.token);
    assert.equal(pause.status, 'queued');
    assert.equal((await x.call('GET', '/api/commands/c1', undefined, controller.token)).status, 'expired');
    assert.equal((await x.call('POST', '/api/commands', { commandId: 'c2', ...base }, controller.token, 409)).code, 'COMMAND_FENCED');
    await x.call('POST', '/api/commands', { commandId: 'c3', ...base, expectedRevision: 2 }, controller.token, 409);
  } finally { await x.close(); }
});

test('offline execution continuation cannot be queued; a fresh online gate admits a later request', async () => {
  let clock = Date.now();
  const x = await fixture(() => clock);
  try {
    const owner = await x.tokenFor('tenant-a');
    const node = await x.pair(owner, 'node', ['p1']);
    const controller = await x.pair(owner, 'controller', ['p1']);
    await x.call('POST', '/api/node/snapshot', { epoch: 1, sequence: 1, projects: [project('p1')], tasks: [task('t1', 'p1')] }, node.token);
    clock += 61_000;
    const base = { projectId: 'p1', taskId: 't1', action: 'continue', expectedRevision: 1, expiresAt: new Date(clock + 90_000).toISOString(), body: {} };
    await x.call('POST', '/api/commands', { commandId: 'c1', ...base }, controller.token, 503);
    assert.equal((await x.call('POST', '/api/commands', { commandId: 'c1', ...base, queueOffline: true }, controller.token,409)).code,'EXECUTION_GATE_UNAVAILABLE');
    assert.equal(x.hub.store.db.prepare('SELECT count(*) AS n FROM commands').get().n,0);
    clock += 91_000;
    await x.call('POST', '/api/node/snapshot', { epoch: 1, sequence: 2, projects: [project('p1',clock)], tasks: [task('t1', 'p1',1,clock)] }, node.token);
    assert.equal((await x.call('POST', '/api/commands', { commandId: 'c2', ...base, expiresAt: new Date(clock + 60_000).toISOString() }, controller.token)).status, 'queued');
  } finally { await x.close(); }
});

test('revoke and epoch change prevent claim and phone access; validation rejects revoked controller', async () => {
  const x = await fixture();
  try {
    const owner = await x.tokenFor('tenant-a');
    const node = await x.pair(owner, 'node', ['p1']);
    const controller = await x.pair(owner, 'controller', ['p1']);
    const viewer = await x.pair(owner, 'viewer', ['p1']);
    await x.call('POST', '/api/node/snapshot', { epoch: 1, sequence: 1, projects: [project('p1')], tasks: [task('t1', 'p1')] }, node.token);
    const base = { projectId: 'p1', taskId: 't1', action: 'continue', expectedRevision: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), body: {} };
    await x.call('POST', '/api/commands', { commandId: 'c1', ...base }, viewer.token, 403);
    await x.call('POST', '/api/commands', { commandId: 'c1', ...base }, controller.token);
    assert.equal((await x.call('POST', '/api/node/commands/c1/claim', {}, node.token)).status, 'received');
    assert.equal((await x.call('POST', '/api/node/commands/c1/sending', {}, node.token)).status, 'sending');
    assert.equal((await x.call('GET', '/api/commands/c1', undefined, controller.token)).status, 'sending');
    assert.equal((await x.call('POST', '/api/node/commands/c1/validate', {}, node.token)).commandId, 'c1');
    await x.call('POST', `/api/admin/subjects/${controller.subjectId}/revoke`, {}, owner);
    await x.call('POST', '/api/node/commands/c1/validate', {}, node.token, 409);
    await x.call('GET', '/api/state', undefined, controller.token, 401);
    await x.call('POST', `/api/admin/subjects/${viewer.subjectId}/revoke`, {}, owner);
    await x.call('GET', '/api/state', undefined, viewer.token, 401);
    const grant = await x.call('POST', '/api/admin/grants', { subjectId: node.subjectId, projectId: 'p2' }, owner);
    assert.equal(grant.epoch, 2);
    await x.call('POST', '/api/node/snapshot', { epoch: 1, sequence: 2, projects: [project('p1')], tasks: [] }, node.token, 409);
    await x.call('POST', `/api/admin/subjects/${node.subjectId}/revoke`, {}, owner);
    await x.call('GET', '/api/node/session', undefined, node.token, 401);
  } finally { await x.close(); }
});

test('unknown local callback is never resent across sync and node restart', async () => {
  const x = await fixture();
  try {
    const owner = await x.tokenFor('tenant-a');
    const code = await x.call('POST', '/api/admin/pairings', { role: 'node', projectIds: ['p1'] }, owner);
    const controller = await x.pair(owner, 'controller', ['p1']);
    const board = { projects: [project('p1')], tasks: [task('t1', 'p1')] };
    let sends = 0;
    const options = { dataDir: join(x.root, 'node'), getState: () => board, request: async () => { sends++; throw new Error('Ambiguous local callback'); } };
    const link = await createRemoteLink(options);
    await link.configure({ url: x.hub.url, pairingCode: code.code, projectIds: ['p1'] });
    const command = { commandId: 'c1', projectId: 'p1', taskId: 't1', action: 'continue', expectedRevision: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), body: {} };
    await x.call('POST', '/api/commands', command, controller.token);
    await link.sync();
    assert.equal(sends, 1);
    assert.equal((await x.call('GET', '/api/commands/c1', undefined, controller.token)).status, 'unknown');
    await link.sync();
    await link.close();
    const restarted = await createRemoteLink(options);
    try { await restarted.sync(); } finally { await restarted.close(); }
    assert.equal(sends, 1);
    await x.call('POST', '/api/commands', { ...command, commandId: 'c2' }, controller.token, 409);
  } finally { await x.close(); }
});

test('local revision mismatch is a confirmed non-send and releases the continue lease', async () => {
  const x = await fixture();
  try {
    const owner = await x.tokenFor('tenant-a');
    const code = await x.call('POST', '/api/admin/pairings', { role: 'node', projectIds: ['p1'] }, owner);
    const controller = await x.pair(owner, 'controller', ['p1']);
    const board = { projects: [project('p1')], tasks: [task('t1', 'p1')] };
    let sends = 0;
    const link = await createRemoteLink({ dataDir: join(x.root, 'node'), getState: () => board, request: async () => { sends++; return { status: 'running' }; } });
    try {
      await link.configure({ url: x.hub.url, pairingCode: code.code, projectIds: ['p1'] });
      const base = { projectId: 'p1', taskId: 't1', action: 'continue', expectedRevision: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), body: {} };
      await x.call('POST', '/api/commands', { commandId: 'c1', ...base }, controller.token);
      board.tasks[0].revision = 2;
      board.tasks[0].executionWrite.taskRevision = 2;
      await link.sync();
      assert.equal(sends, 0);
      assert.equal((await x.call('GET', '/api/commands/c1', undefined, controller.token)).status, 'failed');
      assert.equal((await x.call('POST', '/api/commands', { commandId: 'c2', ...base, expectedRevision: 2 }, controller.token)).status, 'queued');
    } finally { await link.close(); }
  } finally { await x.close(); }
});

test('remote review uses authenticated controller actor and strips turn identity from receipts', async () => {
  const x = await fixture();
  try {
    const owner = await x.tokenFor('tenant-a');
    const code = await x.call('POST', '/api/admin/pairings', { role: 'node', projectIds: ['p1'] }, owner);
    const controller = await x.pair(owner, 'controller', ['p1']);
    const board = { projects: [project('p1')], tasks: [task('t1', 'p1')] };
    const calls = [];
    const link = await createRemoteLink({ dataDir: join(x.root, 'node'), getState: () => board, request: async (method, path, body) => { calls.push({ method, path, body }); return { status: 'submitted', taskId: 't1', revision: 2, turnId: 'private-turn' }; } });
    try {
      await link.configure({ url: x.hub.url, pairingCode: code.code, projectIds: ['p1'] });
      await x.call('POST', '/api/commands', { commandId: 'r1', projectId: 'p1', taskId: 't1', action: 'review', expectedRevision: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), body: { decision: 'pass', summary: 'Accepted' } }, controller.token);
      await link.sync();
      assert.deepEqual(calls[0].body.remoteActor, { tenantId: 'tenant-a', subjectId: controller.subjectId, role: 'controller' });
      assert.equal(JSON.stringify(await x.call('GET', '/api/commands/r1', undefined, controller.token)).includes('private-turn'), false);
    } finally { await link.close(); }
  } finally { await x.close(); }
});

test('restart after persisted sending marker reports unknown without a local resend', async () => {
  const x = await fixture();
  try {
    const owner = await x.tokenFor('tenant-a');
    const code = await x.call('POST', '/api/admin/pairings', { role: 'node', projectIds: ['p1'] }, owner);
    const controller = await x.pair(owner, 'controller', ['p1']);
    const board = { projects: [project('p1')], tasks: [task('t1', 'p1')] };
    const nodeDir = join(x.root, 'node');
    const initial = await createRemoteLink({ dataDir: nodeDir, getState: () => board, request: async () => { throw new Error('Should not send'); } });
    await initial.configure({ url: x.hub.url, pairingCode: code.code, projectIds: ['p1'] });
    await initial.close();
    const statePath = join(nodeDir, 'remote-link.json');
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    await x.call('POST', '/api/commands', { commandId: 'c1', projectId: 'p1', taskId: 't1', action: 'continue', expectedRevision: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), body: {} }, controller.token);
    await x.call('POST', '/api/node/commands/c1/claim', {}, saved.token);
    await x.call('POST', '/api/node/commands/c1/sending', {}, saved.token);
    saved.receipts.c1 = { phase: 'sending', status: null, reported: false };
    await writeFile(statePath, JSON.stringify(saved), { mode: 0o600 });
    let sends = 0;
    const restarted = await createRemoteLink({ dataDir: nodeDir, getState: () => board, request: async () => { sends++; return { status: 'running' }; } });
    try { await restarted.sync(); } finally { await restarted.close(); }
    assert.equal(sends, 0);
    assert.equal((await x.call('GET', '/api/commands/c1', undefined, controller.token)).status, 'unknown');
  } finally { await x.close(); }
});

test('same project and command IDs in two tenants remain isolated through revocation', async () => {
  const x = await fixture();
  try {
    const a = await x.tokenFor('tenant-a');
    const b = await x.tokenFor('tenant-b');
    const nodeA = await x.pair(a, 'node', ['p1']);
    const nodeB = await x.pair(b, 'node', ['p1']);
    const controllerA = await x.pair(a, 'controller', ['p1']);
    const controllerB = await x.pair(b, 'controller', ['p1']);
    for (const node of [nodeA, nodeB]) await x.call('POST', '/api/node/snapshot', { epoch: 1, sequence: 1, projects: [project('p1')], tasks: [task('t1', 'p1')] }, node.token);
    const base = { commandId: 'shared', projectId: 'p1', taskId: 't1', action: 'continue', expectedRevision: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), body: {} };
    await x.call('POST', '/api/commands', base, controllerA.token);
    await x.call('POST', '/api/commands', base, controllerB.token);
    await x.call('POST', `/api/admin/subjects/${controllerA.subjectId}/revoke`, {}, a);
    assert.equal((await x.call('GET', '/api/commands/shared', undefined, controllerB.token)).status, 'queued');
    assert.equal((await x.call('GET', '/api/node/commands', undefined, nodeB.token)).commands.length, 1);
    await x.call('POST', '/api/commands', { ...base, commandId: 'other' }, controllerB.token, 409);
  } finally { await x.close(); }
});

test('owner can audit-reconcile an unknown lease only after the old node is revoked', async () => {
  const x = await fixture();
  try {
    const owner = await x.tokenFor('tenant-a');
    const oldNode = await x.pair(owner, 'node', ['p1']);
    const controller = await x.pair(owner, 'controller', ['p1']);
    await x.call('POST', '/api/node/snapshot', { epoch: 1, sequence: 1, projects: [project('p1')], tasks: [task('t1', 'p1')] }, oldNode.token);
    const base = { projectId: 'p1', taskId: 't1', action: 'continue', expectedRevision: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), body: {} };
    await x.call('POST', '/api/commands', { commandId: 'old', ...base }, controller.token);
    await x.call('POST', '/api/node/commands/old/claim', {}, oldNode.token);
    await x.call('POST', `/api/admin/subjects/${oldNode.subjectId}/revoke`, {}, owner);
    const newNode = await x.pair(owner, 'node', ['p1']);
    await x.call('POST', '/api/node/snapshot', { epoch: 1, sequence: 1, projects: [project('p1')], tasks: [task('t1', 'p1')] }, newNode.token);
    await x.call('POST', '/api/commands', { commandId: 'new', ...base }, controller.token, 409);
    await x.call('POST', '/api/admin/leases/reconcile', { projectId: 'p1', taskId: 't1', confirmStopped: true, reason: 'Verified old process stopped' }, controller.token, 403);
    await x.call('POST', '/api/admin/leases/reconcile', { projectId: 'p1', taskId: 't1', reason: 'Verified old process stopped' }, owner, 400);
    assert.equal((await x.call('POST', '/api/admin/leases/reconcile', { projectId: 'p1', taskId: 't1', confirmStopped: true, reason: 'Verified old process stopped' }, owner)).reconciled, true);
    assert.equal(x.hub.store.db.prepare('SELECT count(*) AS n FROM lease_reconciliations').get().n, 1);
    // Manual lease release is an audit action, not evidence that the old write did not happen.
    assert.equal((await x.call('POST', '/api/commands', { commandId: 'new', ...base }, controller.token, 409)).code, 'COMMAND_FENCED');
  } finally { await x.close(); }
});

test('online disconnect revokes old node token and re-pairing does not retain old authority', async () => {
  const x = await fixture();
  try {
    const owner = await x.tokenFor('tenant-a');
    const firstCode = await x.call('POST', '/api/admin/pairings', { role: 'node', projectIds: ['p1'] }, owner);
    const board = { projects: [project('p1')], tasks: [task('t1', 'p1')] };
    const nodeDir = join(x.root, 'node');
    const link = await createRemoteLink({ dataDir: nodeDir, getState: () => board, request: async () => ({ status: 'running' }) });
    try {
      await link.configure({ url: x.hub.url, pairingCode: firstCode.code, projectIds: ['p1'] });
      const oldToken = JSON.parse(await readFile(join(nodeDir, 'remote-link.json'), 'utf8')).token;
      assert.equal((await link.disconnect()).status, 'disconnected');
      await x.call('GET', '/api/node/session', undefined, oldToken, 401);
      const secondCode = await x.call('POST', '/api/admin/pairings', { role: 'node', projectIds: ['p1'] }, owner);
      assert.equal((await link.configure({ url: x.hub.url, pairingCode: secondCode.code, projectIds: ['p1'] })).status, 'connected');
      await x.call('GET', '/api/node/session', undefined, oldToken, 401);
    } finally { await link.close(); }
  } finally { await x.close(); }
});

test('offline disconnect retains the old credential and reports that owner revocation is needed', async () => {
  const x = await fixture();
  try {
    const owner = await x.tokenFor('tenant-a');
    const code = await x.call('POST', '/api/admin/pairings', { role: 'node', projectIds: ['p1'] }, owner);
    const board = { projects: [project('p1')], tasks: [task('t1', 'p1')] };
    const nodeDir = join(x.root, 'node');
    const link = await createRemoteLink({ dataDir: nodeDir, getState: () => board, request: async () => ({ status: 'running' }) });
    try {
      await link.configure({ url: x.hub.url, pairingCode: code.code, projectIds: ['p1'] });
      const oldToken = JSON.parse(await readFile(join(nodeDir, 'remote-link.json'), 'utf8')).token;
      await new Promise(resolve => x.hub.server.close(resolve));
      const outcome = await link.disconnect();
      assert.equal(outcome.status, 'offline');
      assert.match(outcome.lastError, /Hub owner/);
      assert.equal(JSON.parse(await readFile(join(nodeDir, 'remote-link.json'), 'utf8')).token, oldToken);
    } finally { await link.close(); }
  } finally { await x.close(); }
});

test('remote client bounds streamed Hub responses before JSON parsing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskboard-response-'));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ padding: 'x'.repeat(2_100_100) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const link = await createRemoteLink({ dataDir: join(root, 'node'), getState: () => ({ projects: [], tasks: [] }), request: async () => ({}) });
  try {
    await assert.rejects(link.configure({ url: `http://127.0.0.1:${server.address().port}`, pairingCode: 'x'.repeat(32), projectIds: ['p1'] }), /Hub response too large/);
  } finally {
    await link.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
