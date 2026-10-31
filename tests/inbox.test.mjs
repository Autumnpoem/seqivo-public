import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { createInbox } from '../server/inbox.mjs';
import { createCore } from '../server/core.mjs';
import { inboxProjection, taskProjection } from '../server/hub/projection.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'seqivo-inbox-'));
  const path = join(dir, 'board.sqlite');
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = store.project({ name: '项目' });
  const task = store.createTask({ projectId: project.id, title: '交付', criteria: ['真实验收'] });
  return { store, task, inbox: createInbox({ store }), path };
}
const decision = task => ({ expectedRevision: task.revision, requestId: 'question-1', title: '选择方案', summary: '需要明确决定', impact: '影响交付路径', options: [{ id: 'a', label: '方案 A', consequence: '需要额外验收' }] });

test('source sync is durable and does not write unchanged polling state', t => {
  const { store, task, inbox, path } = fixture(t);
  assert.deepEqual(inbox.sync(), inbox.sync());
  const submitted = store.updateTask(task.id, { status: 'submitted' }, task.revision);
  const first = inbox.sync({ executions: { active: [] }, policies: [] });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].kind, 'acceptance');
  const journalCount = () => store.db.prepare('SELECT count(*) count FROM journal_entries').get().count;
  const before = journalCount();
  const again = inbox.sync({ executions: { active: [] }, policies: [] });
  assert.deepEqual(again, first);
  assert.equal(journalCount(), before);
  const reopened = new Store(path);
  assert.deepEqual(createInbox({ store: reopened }).state(), first);
  reopened.close();
  const reviewed = store.addEvidence(task.id, { expectedRevision: submitted.revision, summary: '实际运行', reference: 'report' });
  store.review(task.id, { expectedRevision: reviewed.revision, decision: 'pass', summary: '已核实' });
  const resolved = inbox.sync();
  assert.equal(resolved.items[0].state, 'resolved');
  assert.equal(inbox.sync().items.length, 1);
});

test('automatic continue stop cards are actionable, deduplicated and safe to share', t => {
  const { task, inbox } = fixture(t);
  const expectations = [
    ['retry_stopped', /后续自动重试已停止/, 'retry_failed'],
    ['retry_stopped', /没有记录截止时间/, 'legacy_plan_missing_deadline'],
    ['retry_stopped', /结果尚未确认/, 'attempt_unconfirmed'],
    ['retry_stopped', /任务或执行位置发生了变化/, 'restart_binding_changed'],
    ['retry_stopped', /没有记录获准的目标和下一步/, 'plan_intent_missing'],
    ['retry_stopped', /任务目标或下一步发生了变化/, 'plan_intent_changed'],
    ['retry_stopped', /两次自动尝试后额度仍不可用/, 'repeated_quota_failure'],
    ['budget_exhausted', /截止时间/],
    ['attempts_exhausted', /次数上限/],
  ];
  for (const [status, expected, stopReason] of expectations) {
    const policies = [{ taskId: task.id, enabled: false, status, stopReason,
      startedAt: '2026-10-18T00:00:00.000Z',
      lastError: 'private-diagnostic-marker /private/local/project token=do-not-share' }];
    const first = inbox.sync({ policies });
    const item = first.items.find(value => value.state === 'open' && value.source.type === 'plugin.autocontinue');
    assert.ok(item);
    assert.match(item.summary, expected);
    assert.match(item.impact, /正在运行的任务仍需单独查看或暂停/);
    assert.match(item.recommendedAction, /接入与插件/);
    assert.equal(item.shareWithRemote, true);
    assert.equal(item.contentVersion, task.contentVersion);
    assert.deepEqual(inbox.sync({ policies }), first, 'unchanged polls must not create reminders or writes');
    const projected = inboxProjection(first, [task]);
    assert.match(JSON.stringify(projected), expected);
    assert.doesNotMatch(JSON.stringify(projected), /private-diagnostic-marker|\/private\/local|do-not-share/);
  }
});

test('automatic continue new plans create new reminders without clearing unknown execution', t => {
  const { task, inbox } = fixture(t);
  const policy = { taskId: task.id, enabled: false, status: 'budget_exhausted', startedAt: '2026-10-18T00:00:00.000Z' };
  const unknown = { active: [{ taskId: task.id, commandId: 'original-unknown', status: 'unknown' }] };
  const first = inbox.sync({ policies: [policy], executions: unknown });
  const original = first.items.find(item => item.source.type === 'plugin.autocontinue');
  const next = inbox.sync({ policies: [{ ...policy, startedAt: '2026-10-18T06:00:00.000Z' }] });
  assert.equal(next.items.find(item => item.id === original.id).state, 'resolved');
  assert.equal(next.items.filter(item => item.source.type === 'plugin.autocontinue' && item.state === 'open').length, 1);
  assert.equal(next.items.find(item => item.kind === 'unknown').state, 'open', 'policy budgets are not execution proof');
  const disabled = inbox.sync({ policies: [{ ...policy, status: 'disabled' }] });
  assert.equal(disabled.items.filter(item => item.source.type === 'plugin.autocontinue' && item.state === 'open').length, 0);
  assert.equal(disabled.items.find(item => item.kind === 'unknown').state, 'open');
});

test('decisions are idempotent and private answers stay out of public nextStep', t => {
  const { store, task, inbox } = fixture(t);
  const request = { ...decision(task), shareWithRemote: false };
  const item = inbox.requestDecision(task.id, request, 'mcp');
  assert.deepEqual(inbox.requestDecision(task.id, request, 'mcp'), item);
  assert.throws(() => inbox.requestDecision(task.id, { ...request, summary: 'changed' }, 'mcp'), error => error.status === 409);
  assert.equal(inbox.state().items.length, 1);
  const action = { actionId: 'answer-1', expectedRevision: task.revision, expectedItemRevision: item.itemRevision, action: 'answer', optionId: 'a', answer: 'Private detail' };
  assert.throws(() => inbox.act(item.id, action, 'reporter'), error => error.status === 403);
  const receipt = inbox.act(item.id, action, 'owner');
  assert.deepEqual(inbox.act(item.id, action, 'owner'), receipt);
  assert.throws(() => inbox.act(item.id, action, { role: 'remote-controller', id: { tenantId: 'other', subjectId: 'other' } }), error => error.status === 409);
  assert.throws(() => inbox.act(item.id, { ...action, answer: 'different' }, 'owner'), error => error.status === 409);
  assert.equal(store.getTask(task.id).decisions[0].answer, 'Private detail');
  assert.doesNotMatch(store.getTask(task.id).nextStep, /Private detail/);
  assert.equal(inbox.state().items[0].state, 'resolved');
});

test('blocked supplement keeps cause; acknowledgement does not resolve it; CAS prevents stale actions', t => {
  const { store, task, inbox } = fixture(t);
  store.inbox = inbox;
  const blocked = store.updateTask(task.id, { status: 'blocked', blockedReason: '需要凭据' }, task.revision);
  const item = inbox.sync().items[0];
  const ack = { actionId: 'ack-1', expectedRevision: blocked.revision, expectedItemRevision: item.itemRevision, action: 'acknowledge' };
  inbox.act(item.id, ack);
  assert.equal(inbox.state().items[0].state, 'acknowledged');
  assert.throws(() => inbox.act(item.id, { ...ack, actionId: 'ack-2' }), error => error.status === 409);
  const updated = inbox.state().items[0];
  const supplement = { actionId: 'supplement-1', expectedRevision: blocked.revision, expectedItemRevision: updated.itemRevision, action: 'supplement', answer: '用户已提供背景信息' };
  inbox.act(item.id, supplement);
  assert.equal(inbox.state().items[0].state, 'acknowledged');
  assert.equal(store.getTask(task.id).status, 'blocked');
  assert.equal(store.getTask(task.id).blockedReason, '需要凭据');
  const saved = store.getTask(task.id);
  assert.equal(saved.supplementHistory.length, 1);
  assert.deepEqual(saved.supplementHistory[0], { id: supplement.actionId, itemId: item.id,
    answer: supplement.answer, source: 'human', actor: 'owner', contentVersion: saved.contentVersion,
    createdAt: saved.supplementHistory[0].createdAt });
  assert.doesNotMatch(saved.nextStep, /用户已提供背景信息/);
  assert.doesNotMatch(JSON.stringify(taskProjection(saved)), /用户已提供背景信息|需要凭据/);
  assert.match(store.context(task.projectId), /人工补充.*用户已提供背景信息/);
  assert.deepEqual(inbox.act(item.id, supplement), { taskId: task.id, status: 'completed', itemId: item.id, itemRevision: 3 });
  assert.equal(store.getTask(task.id).supplementHistory.length, 1);
  assert.throws(() => inbox.act(item.id, { ...supplement, actionId: 'stale' }), error => error.status === 409);
});

test('shared blocked supplement may appear remotely while private supplement stays local', t => {
  const { store, task, inbox } = fixture(t);
  store.inbox = inbox;
  let current = store.updateTask(task.id, { status: 'submitted' }, task.revision);
  current = store.review(task.id, { expectedRevision: current.revision, decision: 'fail', summary: '需要补充信息' });
  const item = inbox.sync().items.find(value => value.source.type === 'task.issue');
  assert.equal(item.shareWithRemote, true);
  inbox.act(item.id, { actionId: 'shared-supplement', expectedRevision: current.revision, expectedItemRevision: item.itemRevision, action: 'supplement', answer: '可以公开的补充' });
  assert.match(taskProjection(store.getTask(task.id)).nextStep, /可以公开的补充/);
  assert.match(store.context(task.projectId), /人工补充.*可以公开的补充/);
});

test('a second blocked transition with the same reason creates a new occurrence', t => {
  const { store, task, inbox } = fixture(t);
  let current = store.updateTask(task.id, { status: 'blocked', blockedReason: '同一原因' }, task.revision);
  const first = inbox.sync().items.find(item => item.kind === 'blocked');
  current = store.updateTask(task.id, { status: 'planned' }, current.revision);
  current = store.updateTask(task.id, { status: 'blocked', blockedReason: '同一原因' }, current.revision);
  const items = inbox.sync().items.filter(item => item.kind === 'blocked');
  assert.equal(items.length, 2);
  assert.equal(items.find(item => item.id === first.id).state, 'resolved');
  assert.equal(items.find(item => item.state === 'open').sourceRevision, current.revision);
});

test('unknown execution remains read only and is resolved only after source clears', t => {
  const { task, inbox } = fixture(t);
  const source = { executions: { active: [{ taskId: task.id, commandId: 'command-1', status: 'unknown' }] }, policies: [] };
  const item = inbox.sync(source).items[0];
  assert.equal(item.kind, 'unknown');
  assert.throws(() => inbox.act(item.id, { actionId: 'manual-ack', expectedRevision: task.revision, expectedItemRevision: item.itemRevision, action: 'acknowledge' }), error => error.status === 409 && error.code === 'INBOX_UNKNOWN_READ_ONLY');
  assert.equal(inbox.state().items[0].state, 'open');
  assert.throws(() => inbox.act(item.id, { actionId: 'manual-resolve', expectedRevision: task.revision, expectedItemRevision: item.itemRevision, action: 'answer', answer: 'done' }), error => error.status === 409);
  assert.equal(inbox.sync(source).items[0].state, 'open');
  assert.equal(inbox.sync({ executions: { active: [] }, policies: [] }).items[0].state, 'open');
  assert.equal(inbox.sync({ executions: { active: [], recent: [{ taskId: task.id, commandId: 'command-1', status: 'completed' }] }, policies: [] }).items[0].state, 'resolved');
  assert.equal(inbox.sync(source).items.length, 1);
});

test('confirmed stale result closes only its policy unknown card, not an unrelated execution unknown', t => {
  const { task, inbox } = fixture(t);
  const execution = { active: [{ taskId: task.id, commandId: 'other-command', status: 'unknown' }] };
  const first = inbox.sync({ executions: execution,
    policies: [{ taskId: task.id, status: 'unknown', enabled: false }] });
  const policyCard = first.items.find(item => item.source.type === 'plugin.policy');
  const executionCard = first.items.find(item => item.source.type === 'execution.command');
  assert.equal(policyCard?.state, 'open');
  assert.equal(executionCard?.state, 'open');
  const unproved = inbox.sync({ executions: execution, policies: [] });
  assert.equal(unproved.items.find(item => item.id === policyCard.id)?.state, 'open',
    'absence of a policy is not a retirement proof');
  const verified = inbox.sync({ executions: execution,
    policies: [{ taskId: task.id, status: 'stale_result', enabled: false }] });
  assert.equal(verified.items.find(item => item.id === policyCard.id)?.state, 'resolved');
  assert.equal(verified.items.find(item => item.id === executionCard.id)?.state, 'open');
});

test('a changed task version supersedes old inbox work and keeps old decisions visible', t => {
  const { store, task, inbox } = fixture(t);
  const original = inbox.requestDecision(task.id, decision(task));
  const changed = store.updateTask(task.id, { goal: '新的交付目标' }, task.revision);
  assert.equal(inbox.sync().items.find(item => item.id === original.id).state, 'superseded');
  assert.throws(() => inbox.act(original.id, { actionId: 'old-answer', expectedRevision: changed.revision, expectedItemRevision: 2, action: 'answer', answer: '继续旧计划' }), error => error.status === 409);
  const blocked = store.updateTask(task.id, { status: 'blocked', blockedReason: '等待资料' }, changed.revision);
  const first = inbox.sync().items.find(item => item.kind === 'blocked');
  const updated = store.updateTask(task.id, { goal: '再次修订' }, blocked.revision);
  const items = inbox.sync().items.filter(item => item.kind === 'blocked');
  assert.equal(items.find(item => item.id === first.id).state, 'superseded');
  assert.equal(items.filter(item => item.state === 'open').length, 1);
  assert.equal(items.find(item => item.state === 'open').contentVersion, updated.contentVersion);
});

test('long non-ASCII local source IDs produce valid bounded remote projections', t => {
  const { task, inbox } = fixture(t);
  const requestId = '需决定/'.repeat(45);
  inbox.requestDecision(task.id, { ...decision(task), requestId, shareWithRemote: true });
  const commandId = '未知命令/'.repeat(45);
  const local = inbox.sync({ executions: { active: [{ taskId: task.id, commandId, status: 'unknown' }] }, policies: [] });
  const remote = inboxProjection(local, [task]);
  assert.equal(remote.items.length, 2);
  assert.ok(remote.items.every(item => /^[a-f0-9]{64}$/.test(item.source.id)));
  assert.ok(remote.items.every(item => !JSON.stringify(item).includes(requestId) && !JSON.stringify(item).includes(commandId)));
});

test('private blocked sources hide details and generated titles fit remote limits', t => {
  const { store, task, inbox } = fixture(t);
  const longTitle = '任'.repeat(240);
  let current = store.updateTask(task.id, { title: longTitle, status: 'blocked', blockedReason: '/private/credential' }, task.revision);
  const blocked = inbox.sync().items.find(item => item.source.type === 'task.blocked');
  assert.equal(blocked.shareWithRemote, false);
  assert.ok(blocked.title.length <= 240);
  const projection = inboxProjection(inbox.state(), [current]);
  assert.doesNotMatch(JSON.stringify(projection), /private\/credential/);
  current = store.updateTask(task.id, { status: 'submitted' }, current.revision);
  current = store.verify(task.id, { expectedRevision: current.revision, status: 'partial', summary: '部分验证', reference: 'local', criterionIds: [],
    pendingChecks: [{ id: '/private/check', kind: 'test', title: longTitle, criterionIds: [current.criteria[0].id], steps: ['执行'], expectedResult: '成功', blockedReason: '保密原因' }] });
  const check = inbox.sync().items.find(item => item.source.type === 'verification.check');
  assert.equal(check.shareWithRemote, false);
  assert.match(check.source.id, /^[a-f0-9]{64}$/);
  const remote = inboxProjection(inbox.state(), [current]);
  assert.doesNotMatch(JSON.stringify(remote), /private\/check|保密原因/);
});

test('long blocked reason fits projection and polling does not rewrite it', t => {
  const { store, task, inbox } = fixture(t);
  const current = store.updateTask(task.id, { status: 'blocked', blockedReason: '长'.repeat(7000) }, task.revision);
  const first = inbox.sync();
  assert.ok(first.items[0].summary.length <= 5000);
  assert.equal(inboxProjection(first, [current]).items.length, 1);
  const count = store.db.prepare('SELECT count(*) count FROM journal_entries').get().count;
  assert.deepEqual(inbox.sync(), first);
  assert.equal(store.db.prepare('SELECT count(*) count FROM journal_entries').get().count, count);
});

test('legacy issue IDs and oversized source text still form valid inbox projections', t => {
  const { store, task, inbox } = fixture(t);
  const legacy = { ...task, title: '旧'.repeat(300), status: 'blocked', blockedReason: 42,
    issues: [{ id: '/private/legacy/issue', open: true, summary: '错'.repeat(7000) }] };
  store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(legacy), task.id);
  const local = inbox.sync();
  assert.equal(local.items.length, 2);
  assert.ok(local.items.every(item => item.title.length <= 240 && item.summary.length <= 5000 && /^[a-f0-9]{64}$/.test(item.source.id)));
  assert.equal(inboxProjection(local, [legacy]).items.length, 2);
});

test('damaged inbox metadata fails with a controlled corruption error', t => {
  const { store, inbox } = fixture(t);
  store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('inbox.v1', JSON.stringify({ version: 1, items: [{ kind: 'unknown' }], receipts: [], updatedAt: new Date().toISOString() }));
  assert.throws(() => inbox.state(), error => error.status === 500 && error.code === 'INBOX_CORRUPT');
});

test('AI decision.request is explicit; review history backfills only known prior review', t => {
  const { store, task, inbox } = fixture(t);
  store.inbox = inbox;
  store.requestDecision = (taskId, input, source) => inbox.requestDecision(taskId, input, source);
  const event = { eventId: 'event-1', type: 'decision.request', taskId: task.id, expectedRevision: task.revision, payload: { ...decision(task) } };
  const receipt = store.applyEvent(event, 'mcp');
  assert.equal(receipt.itemId, inbox.state().items[0].id);
  assert.match(store.context(task.projectId), /待答复.*选择方案/);
  assert.match(store.context(task.projectId), /方案 A.*需要额外验收/);
  assert.deepEqual(store.applyEvent(event, 'mcp'), receipt);
  assert.throws(() => store.applyEvent({ ...event, eventId: 'event-2', type: 'task.review' }, 'mcp'), error => error.status === 403);
  let current = store.updateTask(task.id, { status: 'submitted' }, task.revision);
  current = store.addEvidence(task.id, { expectedRevision: current.revision, summary: '证据', reference: 'report' });
  current = store.review(task.id, { expectedRevision: current.revision, decision: 'pass', summary: '通过' });
  assert.equal(current.reviewHistory.length, 1);
  current = store.review(task.id, { expectedRevision: current.revision, decision: 'pass', summary: '再次确认' });
  assert.equal(current.reviewHistory.length, 2);
});

test('local project context carries human answer and removes resolved question', t => {
  const { store, task, inbox } = fixture(t);
  store.inbox = inbox;
  const item = inbox.requestDecision(task.id, decision(task));
  inbox.act(item.id, { actionId: 'context-answer', expectedRevision: task.revision, expectedItemRevision: item.itemRevision, action: 'answer', answer: '先做方案 A' });
  const context = store.context(task.projectId);
  assert.match(context, /已答复.*先做方案 A/);
  assert.doesNotMatch(context, /待答复.*选择方案/);
});

test('opening a legacy store backfills its one known review without inventing older reviews', t => {
  const { store, task, path } = fixture(t);
  let current = store.updateTask(task.id, { status: 'submitted' }, task.revision);
  current = store.addEvidence(task.id, { expectedRevision: current.revision, summary: '证据', reference: 'report' });
  current = store.review(task.id, { expectedRevision: current.revision, decision: 'pass', summary: '通过' });
  delete current.reviewHistory;
  store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(current), task.id);
  const reader = new Store(path);
  assert.deepEqual(reader.getTask(task.id).reviewHistory, [current.review]);
  const count = reader.db.prepare('SELECT count(*) count FROM journal_entries').get().count;
  reader.close();
  const again = new Store(path);
  assert.equal(again.db.prepare('SELECT count(*) count FROM journal_entries').get().count, count);
  again.close();
});

test('core inbox routes enforce task ownership and remote privacy without an HTTP listener', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'seqivo-inbox-core-'));
  const core = await createCore({ dataDir: dir, pluginDir: resolve('plugins'), files: false });
  t.after(async () => { await core.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = await core.request('POST', '/api/projects', { name: '项目' });
  const task = await core.request('POST', '/api/tasks', { projectId: project.id, title: '任务' });
  const other = await core.request('POST', '/api/tasks', { projectId: project.id, title: '其他任务' });
  const item = await core.request('POST', `/api/tasks/${task.id}/decisions`, { ...decision(task), shareWithRemote: false }, 'reporter');
  assert.equal((await core.request('GET', '/api/state', {}, 'viewer')).capabilities.inbox, true);
  assert.equal((await core.request('GET', '/api/inbox', {}, 'viewer')).items[0].id, item.id);
  const action = { actionId: 'action-1', expectedRevision: task.revision, expectedItemRevision: item.itemRevision, action: 'answer', optionId: 'a' };
  await assert.rejects(core.request('POST', `/api/tasks/${other.id}/inbox/${item.id}/actions`, action), error => error.status === 404);
  await assert.rejects(core.request('POST', `/api/tasks/${task.id}/inbox/${item.id}/actions`, action, 'reporter'), error => error.status === 403);
  await assert.rejects(core.request('POST', `/api/tasks/${task.id}/inbox/${item.id}/actions`, action, 'remote-controller'), error => error.code === 'INBOX_PRIVATE');
  const result = await core.request('POST', `/api/tasks/${task.id}/inbox/${item.id}/actions`, action, 'owner');
  assert.equal(result.status, 'completed');
});
