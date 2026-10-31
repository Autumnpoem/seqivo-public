import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../server/hub/http.mjs';

const IDs = ['p1', 'p2'];
const task = (id, projectId) => ({
  id, projectId, title: `Task ${id}`, status: 'planned', revision: 1, contentVersion: 1,
  updatedAt: new Date().toISOString(),
  executionWrite: {
    v: 1, bootId: 'fixture-boot', observedAt: new Date().toISOString(), taskRevision: 1, contentVersion: 1,
    message: { state: 'ready', reasonCode: null }, continue: { state: 'ready', reasonCode: null },
    start: { state: 'ready', reasonCode: null },
  },
});
const makeCommand = (commandId, action = 'message', taskId = 't1', projectId = 'p1') => ({
  commandId, projectId, taskId, action, expectedRevision: action === 'create_conversation' ? 0 : 1,
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  body: action === 'create_conversation' ? { title: 'New conversation', message: 'Start' }
    : action === 'message' || action === 'start_task' ? { message: 'Continue this task' } : {},
});
const disposition = (commandId, overrides = {}) => ({
  v: 1, dispositionId: `disposition-${commandId}`, projectId: 'p1', taskId: 't1',
  localCommandId: `${commandId}:turn.local`, controlGeneration: 4, returnedGeneration: 5,
  providerOutcome: 'unknown', ...overrides,
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-hub-disposition-'));
  let now = Date.now();
  const hub = await createHub({ dataDir: join(root, 'hub'), host: '127.0.0.1', port: 0, now: () => now, registrationEnabled: false });
  const owner = (await readFile(hub.store.bootstrap('disposition-test').tokenPath, 'utf8')).trim();
  async function call(method, path, body, token = owner, expected = 200) {
    const response = await fetch(`${hub.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (Array.isArray(expected)) assert.ok(expected.includes(response.status), `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
    else assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
    return { status: response.status, body: data };
  }
  async function pair(role, projectIds = IDs) {
    const created = await call('POST', '/api/admin/pairings', { role, projectIds });
    return call('POST', '/api/pairings/redeem', { code: created.body.code }, undefined).then(result => result.body);
  }
  const node = await pair('node');
  const controller = await pair('controller');
  const otherController = await pair('controller');
  const observedAt = new Date(now).toISOString();
  await call('POST', '/api/node/snapshot', {
    epoch: node.epoch, sequence: 1,
    projects: IDs.map(id => ({ id, name: id, conversationStart: { v: 1, bootId: 'fixture-boot', observedAt, state: 'ready', reasonCode: null } })),
    tasks: [task('t1', 'p1'), task('t2', 'p1'), task('t3', 'p2')],
    capabilities: { conversations: true },
  }, node.token);

  async function sendUnknown(commandId, action = 'message', taskId = 't1', projectId = 'p1', status = 'unknown', actor = controller, resultTaskId = taskId) {
    await call('POST', '/api/commands', makeCommand(commandId, action, taskId, projectId), actor.token);
    await call('POST', `/api/node/commands/${commandId}/claim`, {}, node.token);
    await call('POST', `/api/node/commands/${commandId}/sending`, {}, node.token);
    const result = status === 'running' ? { taskId: resultTaskId, status: 'running', revision: 2 } : undefined;
    await call('POST', `/api/node/commands/${commandId}/receipt`, { status, ...(result ? { result } : {}) }, node.token);
  }
  async function dispose(commandId, body = disposition(commandId), token = node.token, expected = 200) {
    return call('POST', `/api/node/commands/${commandId}/dispose-unknown`, body, token, expected);
  }
  return {
    root, hub, owner, node, controller, otherController, call, sendUnknown, dispose,
    close: async () => { await hub.close(); await rm(root, { recursive: true, force: true }); },
  };
}

for (const originalStatus of ['unknown', 'running']) test(`disposition preserves original ${originalStatus} command and permits only a new explicit command`, async () => {
  const x = await fixture();
  try {
    await x.sendUnknown('old-root', 'message', 't1', 'p1', originalStatus);
    const before = (await x.call('GET', '/api/commands/old-root', undefined, x.controller.token)).body;
    const first = await x.dispose('old-root');
    assert.deepEqual(first.body, { commandId: 'old-root', dispositionId: 'disposition-old-root', providerOutcome: 'unknown', disposed: true });
    const repeated = await x.dispose('old-root');
    assert.deepEqual(repeated.body, first.body, 'same disposition retry is idempotent');
    const conflict = await x.dispose('old-root', disposition('old-root', { dispositionId: 'different-receipt' }), nodeToken(x), 409);
    assert.equal(conflict.status, 409);

    const after = (await x.call('GET', '/api/commands/old-root', undefined, x.controller.token)).body;
    assert.equal(after.status, before.status);
    assert.deepEqual(after.result, before.result);
    assert.equal(after.error, before.error);
    assert.equal(x.hub.store.db.prepare('SELECT count(*) AS n FROM command_dispositions WHERE command_id=?').get('old-root').n, 1);
    assert.equal(x.hub.store.db.prepare('SELECT count(*) AS n FROM continue_leases WHERE command_id=?').get('old-root').n, 0);

    const next = await x.call('POST', '/api/commands', makeCommand('new-root', 'message'), x.controller.token);
    assert.equal(next.body.status, 'queued');
    const delivered = (await x.call('GET', '/api/node/commands', undefined, x.node.token)).body.commands;
    assert.equal(delivered.filter(item => item.commandId === 'old-root').length, 0, 'old command must never be redelivered');
    assert.equal(delivered.filter(item => item.commandId === 'new-root').length, 1);
  } finally { await x.close(); }
});

function nodeToken(x) { return x.node.token; }

test('create_conversation unknown command can be disposed without inventing a continue lease', async () => {
  const x = await fixture();
  try {
    await x.sendUnknown('conversation-root', 'create_conversation', 'conversation-root', 'p1', 'running', x.controller, 'created-actual');
    assert.equal(x.hub.store.db.prepare('SELECT count(*) AS n FROM continue_leases WHERE command_id=?').get('conversation-root').n, 0);
    const wrong = await x.dispose('conversation-root', disposition('conversation-root', { taskId: 'created-actual' }), nodeToken(x), 409);
    assert.notEqual(wrong.body.disposed, true, 'actual created task is not the original Hub placeholder ID');
    assert.equal((await x.dispose('conversation-root', disposition('conversation-root', { taskId: 'conversation-root' }))).body.disposed, true);
  } finally { await x.close(); }
});

test('one explicit disposition ID can resolve multiple exact command roots', async () => {
  const x = await fixture();
  try {
    await x.sendUnknown('shared-consent-a', 'message', 't1');
    await x.sendUnknown('shared-consent-b', 'message', 't2');
    const consentId = 'one-user-consent';
    assert.equal((await x.dispose('shared-consent-a', disposition('shared-consent-a', { dispositionId: consentId }))).body.disposed, true);
    assert.equal((await x.dispose('shared-consent-b', disposition('shared-consent-b', { taskId: 't2', dispositionId: consentId }))).body.disposed, true);
    assert.equal(x.hub.store.db.prepare('SELECT count(*) AS n FROM command_dispositions WHERE disposition_id=?').get(consentId).n, 2);
  } finally { await x.close(); }
});

test('only an exact eligible command and matching lease can be disposed', async () => {
  const x = await fixture();
  try {
    await x.sendUnknown('bad-task');
    const wrongTask = await x.dispose('bad-task', disposition('bad-task', { taskId: 't2' }), nodeToken(x), 409);
    assert.notEqual(wrongTask.body.disposed, true);
    const wrongProject = await x.dispose('bad-task', disposition('bad-task', { projectId: 'p2' }), nodeToken(x), 409);
    assert.notEqual(wrongProject.body.disposed, true);
    const wrongLocalId = await x.dispose('bad-task', disposition('bad-task', { localCommandId: 'bad/id' }), nodeToken(x), 400);
    assert.notEqual(wrongLocalId.body.disposed, true);
    const zeroGeneration = await x.dispose('bad-task', disposition('bad-task', { controlGeneration: 0, returnedGeneration: 5 }), nodeToken(x), 400);
    assert.notEqual(zeroGeneration.body.disposed, true);
    const badGeneration = await x.dispose('bad-task', disposition('bad-task', { returnedGeneration: 3 }), nodeToken(x), 400);
    assert.notEqual(badGeneration.body.disposed, true);
    const wrongRoot = await x.dispose('not-the-root', disposition('bad-task'), nodeToken(x), 404);
    assert.notEqual(wrongRoot.body.disposed, true);
    x.hub.store.db.prepare('UPDATE continue_leases SET command_id=? WHERE tenant_id=? AND project_id=? AND task_id=?')
      .run('different-root', x.node.tenantId ?? x.hub.store.db.prepare('SELECT tenant_id FROM subjects WHERE id=?').get(x.node.subjectId).tenant_id, 'p1', 't1');
    const badLease = await x.dispose('bad-task', disposition('bad-task'), nodeToken(x), [409, 403]);
    assert.notEqual(badLease.body.disposed, true);
    assert.equal(x.hub.store.db.prepare('SELECT count(*) AS n FROM command_dispositions WHERE command_id=?').get('bad-task').n, 0);
  } finally { await x.close(); }
});

test('queued command cannot be disposed', async () => {
  const x = await fixture();
  try {
    await x.call('POST', '/api/commands', makeCommand('still-queued'), x.controller.token);
    const result = await x.dispose('still-queued', disposition('still-queued'), nodeToken(x), 409);
    assert.notEqual(result.body.disposed, true);
    assert.equal((await x.call('GET', '/api/commands/still-queued', undefined, x.controller.token)).body.status, 'queued');
    assert.equal(x.hub.store.db.prepare('SELECT count(*) AS n FROM command_dispositions WHERE command_id=?').get('still-queued').n, 0);
  } finally { await x.close(); }
});

test('wrong node, changed node epoch, and revoked original controller cannot dispose', async () => {
  const x = await fixture();
  try {
    await x.sendUnknown('wrong-node');
    const outsider = await (async () => {
      const created = await x.call('POST', '/api/admin/pairings', { role: 'node', projectIds: ['p1'] });
      return (await x.call('POST', '/api/pairings/redeem', { code: created.body.code })).body;
    })();
    assert.notEqual((await x.dispose('wrong-node', disposition('wrong-node'), outsider.token, [403, 404])).status, 200);
    await x.call('DELETE', `/api/admin/grants/${x.node.subjectId}/p1`);
    assert.notEqual((await x.dispose('wrong-node', disposition('wrong-node'), nodeToken(x), [403, 409])).status, 200);

    const revoked = await fixture();
    try {
      await revoked.sendUnknown('revoked-controller', 'message', 't1', 'p1', 'unknown', revoked.controller);
      await revoked.call('POST', `/api/admin/subjects/${revoked.controller.subjectId}/revoke`, {});
      assert.notEqual((await revoked.dispose('revoked-controller', disposition('revoked-controller'), nodeToken(revoked), [403, 409])).status, 200);
      assert.equal(revoked.hub.store.db.prepare('SELECT count(*) AS n FROM command_dispositions WHERE command_id=?').get('revoked-controller').n, 0);
    } finally { await revoked.close(); }
  } finally { await x.close(); }
});

test('one disposed unknown no longer fences its task, while another unknown still fences its task', async () => {
  const x = await fixture();
  try {
    await x.sendUnknown('resolved-root', 'message', 't1');
    await x.sendUnknown('unresolved-root', 'message', 't2');
    await x.dispose('resolved-root');
    assert.equal((await x.call('POST', '/api/commands', makeCommand('new-t1', 'message', 't1'), x.controller.token)).body.status, 'queued');
    const blocked = await x.call('POST', '/api/commands', makeCommand('new-t2', 'message', 't2'), x.controller.token, 409);
    assert.equal(blocked.body.code, 'COMMAND_FENCED');
    assert.equal((await x.call('GET', '/api/commands/unresolved-root', undefined, x.controller.token)).body.status, 'unknown');
  } finally { await x.close(); }
});
