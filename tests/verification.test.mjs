import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createCore } from '../server/core.mjs';
import { sanitizeSnapshot } from '../server/hub/projection.mjs';

async function fixture(t, criteria = ['接口测试', '回归测试']) {
  const root = await mkdtemp(join(tmpdir(), 'taskboard-verification-'));
  const store = new Store(join(root, 'board.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const project = store.project({ name: '验证项目', directory: root });
  const task = store.createTask({ projectId: project.id, title: '验证任务', criteria });
  return { root, store, project, task };
}

const payload = (task, status, criterionIds = []) => ({ expectedRevision: task.revision, status,
  summary: '实际执行了隔离的自动化测试', reference: 'reports/test-run.txt', criterionIds });
const check = task => ({ id: 'integration-check', kind: 'test', title: '在真实服务中重放请求',
  criterionIds: [task.criteria[0].id], steps: ['启动隔离服务', '发送请求并检查响应'],
  expectedResult: '返回 200 且保存结果', blockedReason: '等待测试凭据', shareWithRemote: false, completed: false });

test('unverified plan records explicit pending work without claiming test coverage', async t => {
  const { store, project, task } = await fixture(t);
  const planned = store.verify(task.id, { ...payload(task, 'unverified'), summary: '测试计划，尚未执行',
    reference: 'plans/verification.md', pendingChecks: [check(task)] });
  assert.equal(planned.verification.status, 'unverified');
  assert.deepEqual(planned.verification.criterionIds, []);
  assert.deepEqual(planned.verification.pendingChecks, [check(task)]);
  assert.equal(planned.contentVersion, task.contentVersion);
  assert.equal(planned.acceptance, 'unverified');
  const context = store.context(project.id);
  for (const phrase of ['验证计划，未执行', '在真实服务中重放请求', '发送请求并检查响应', '返回 200 且保存结果', '等待测试凭据', '记录版本 1，当前版本']) assert.match(context, new RegExp(phrase));
  assert.throws(() => store.verify(task.id, { ...payload(planned, 'unverified', [task.criteria[0].id]), pendingChecks: [check(task)] }), /不能标记已覆盖/);
  assert.equal(store.getTask(task.id).revision, planned.revision);
});

test('pending checks are bounded, tied to current criteria, and incompatible with passed', async t => {
  const { store, task } = await fixture(t);
  const base = { ...payload(task, 'partial'), pendingChecks: [check(task)] };
  const invalid = [
    { pendingChecks: 'not a list' }, { pendingChecks: Array(51).fill(check(task)) },
    { pendingChecks: [check(task), check(task)] },
    { pendingChecks: [{ ...check(task), id: 'x'.repeat(101) }] },
    { pendingChecks: [{ ...check(task), kind: 'human' }] },
    { pendingChecks: [{ ...check(task), title: ' ' }] },
    { pendingChecks: [{ ...check(task), criterionIds: [] }] },
    { pendingChecks: [{ ...check(task), criterionIds: ['other'] }] },
    { pendingChecks: [{ ...check(task), criterionIds: [task.criteria[0].id, task.criteria[0].id] }] },
    { pendingChecks: [{ ...check(task), steps: [] }] },
    { pendingChecks: [{ ...check(task), steps: [' '] }] },
    { pendingChecks: [{ ...check(task), steps: Array(11).fill('run') }] },
    { pendingChecks: [{ ...check(task), expectedResult: '' }] },
    { pendingChecks: [{ ...check(task), blockedReason: 'x'.repeat(4001) }] },
    { pendingChecks: [{ ...check(task), shareWithRemote: 'yes' }] },
    { pendingChecks: [{ ...check(task), completed: 'yes' }] },
    { pendingChecks: [{ ...check(task), extra: 'untrusted' }] },
  ];
  for (const override of invalid) assert.throws(() => store.verify(task.id, { ...base, ...override }), /待验证清单/);
  let current = store.updateTask(task.id, { status: 'submitted' }, task.revision);
  assert.throws(() => store.verify(task.id, { ...payload(current, 'passed', current.criteria.map(item => item.id)), pendingChecks: [check(current)] }), /待验证事项/);
  assert.equal(store.getTask(task.id).revision, current.revision);
  current = store.verify(task.id, { ...payload(current, 'partial'), pendingChecks: [{ ...check(current), blockedReason: undefined }] });
  assert.equal(current.verification.pendingChecks[0].blockedReason, '');
});

test('omitted checklist retains current work and requires explicit review after content changes', async t => {
  const { store, project, task } = await fixture(t);
  let current = store.verify(task.id, { ...payload(task, 'partial'), pendingChecks: [check(task)] });
  current = store.verify(task.id, payload(current, 'partial'));
  assert.deepEqual(current.verification.pendingChecks, [check(task)]);
  current = store.updateTask(task.id, { status: 'submitted' }, current.revision);
  assert.throws(() => store.verify(task.id, payload(current, 'passed', current.criteria.map(item => item.id))), /待验证事项/);
  assert.deepEqual(store.getTask(task.id).verification.pendingChecks, [check(task)]);
  current = store.verify(task.id, { ...payload(current, 'passed', current.criteria.map(item => item.id)), pendingChecks: [] });
  assert.equal(current.verification.status, 'passed');
  assert.deepEqual(current.verification.pendingChecks, []);

  let another = store.createTask({ projectId: project.id, title: '旧版清单', criteria: ['旧标准'] });
  another = store.verify(another.id, { ...payload(another, 'unverified'), pendingChecks: [check(another)] });
  another = store.updateTask(another.id, { criteria: ['新标准'] }, another.revision);
  assert.throws(() => store.verify(another.id, payload(another, 'partial')), /请重新确认当前版本的待办清单/);
  assert.equal(store.getTask(another.id).revision, another.revision);
  const reviewed = store.verify(another.id, { ...payload(another, 'partial'), pendingChecks: [] });
  assert.deepEqual(reviewed.verification.pendingChecks, []);
});

test('partial and failed test records retain human acceptance and do not alter content', async t => {
  const { store, task } = await fixture(t);
  const first = store.verify(task.id, payload(task, 'partial', [task.criteria[0].id]));
  assert.equal(first.verification.status, 'partial');
  assert.equal(first.verification.source, 'test');
  assert.equal(first.verification.contentVersion, task.contentVersion);
  assert.equal(first.revision, task.revision + 1);
  assert.equal(first.contentVersion, task.contentVersion);
  assert.equal(first.status, 'planned');
  assert.equal(first.acceptance, 'unverified');
  assert.equal(first.review, undefined);
  assert.ok(first.criteria.every(item => item.passed === false));
  assert.equal(store.history({ taskId: task.id }).events.at(-1).type, 'task.verified');
  const second = store.verify(task.id, payload(first, 'failed'));
  assert.equal(second.verification.status, 'failed');
  assert.deepEqual(second.verification.criterionIds, []);
  assert.equal(second.contentVersion, task.contentVersion);
  assert.throws(() => store.updateTask(task.id, { verification: { status: 'passed' } }, second.revision), /不允许直接修改/);
});

test('checklist completion toggles repeatedly without changing verification or acceptance', async t => {
  const { store, task, project } = await fixture(t);
  let current = store.updateTask(task.id, { status: 'submitted' }, task.revision);
  current = store.addEvidence(task.id, { expectedRevision: current.revision, summary: '验收依据', reference: 'artifact.txt' });
  current = store.review(task.id, { expectedRevision: current.revision, decision: 'pass', summary: '人工确认原定目标' });
  current = store.verify(task.id, { ...payload(current, 'partial'), pendingChecks: [check(task), { ...check(task), id: 'second' }] });
  const original = structuredClone(current);
  const sibling = store.createTask({ projectId: project.id, title: '不受影响的任务', criteria: ['另一标准'] });
  for (const completed of [true, false, true, false]) {
    const previousRevision = current.revision;
    current = store.setVerificationCheck(task.id, 'integration-check', { expectedRevision: current.revision, completed });
    assert.equal(current.verification.pendingChecks[0].completed, completed);
    assert.equal(current.verification.pendingChecks[1].completed, false);
    assert.equal(current.revision, previousRevision + 1);
    for (const key of ['status', 'acceptance', 'review', 'criteria', 'evidence', 'contentVersion']) assert.deepEqual(current[key], original[key]);
    for (const key of ['status', 'summary', 'reference', 'criterionIds', 'createdAt', 'contentVersion']) assert.deepEqual(current.verification[key], original.verification[key]);
    const event = store.history({ taskId: task.id }).events.at(-1);
    assert.equal(event.type, 'verification.check.updated');
    assert.match(store.context(project.id), completed ? /已办结（人工标记） 1/ : /未验证 1/);
  }
  assert.deepEqual(store.getTask(sibling.id), sibling);
  assert.deepEqual(store.setVerificationCheck(task.id, 'integration-check', { expectedRevision: current.revision, completed: false }), current, 'setting the same state is a no-op');
});

test('checklist writes reject invalid bodies, conflicts, unknown checks, and stale plans', async t => {
  const { store, task } = await fixture(t);
  let current = store.verify(task.id, { ...payload(task, 'unverified'), pendingChecks: [check(task)] });
  for (const extra of [{ completed: 'true' }, { completed: null }, { completed: 1 }, { source: 'test' }, { status: 'passed' }]) {
    assert.throws(() => store.setVerificationCheck(task.id, 'integration-check', { expectedRevision: current.revision, completed: true, ...extra }), /格式/);
  }
  assert.throws(() => store.setVerificationCheck(task.id, 'integration-check', { expectedRevision: task.revision, completed: true }), error => error.status === 409);
  assert.throws(() => store.setVerificationCheck(task.id, 'missing', { expectedRevision: current.revision, completed: true }), error => error.status === 404);
  assert.deepEqual(store.getTask(task.id), current);
  current = store.updateTask(task.id, { goal: 'Changed requirement' }, current.revision);
  assert.throws(() => store.setVerificationCheck(task.id, 'integration-check', { expectedRevision: current.revision, completed: true }), error => error.code === 'VERIFICATION_STALE');
  assert.deepEqual(store.getTask(task.id), current);
});

test('only owner can change checklist state through the core route', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-check-owner-'));
  const core = await createCore({ dataDir: root, pluginDir: join(root, 'none'), files: false });
  t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
  const project = core.store.project({ name: 'Permissions' });
  let task = core.store.createTask({ projectId: project.id, title: 'Checklist', criteria: ['Check'] });
  task = core.store.verify(task.id, { ...payload(task, 'unverified'), pendingChecks: [check(task)] });
  const path = `/api/tasks/${task.id}/verification-checks/integration-check`;
  const body = { expectedRevision: task.revision, completed: true };
  for (const role of ['viewer', 'reporter', 'remote-controller']) await assert.rejects(core.request('POST', path, body, role), error => error.status === 403);
  assert.deepEqual(core.store.getTask(task.id), task);
  const result = await core.request('POST', path, body, 'owner');
  assert.equal(result.verification.pendingChecks[0].completed, true);
  assert.equal(result.verification.status, 'unverified');
  assert.equal(result.acceptance, 'unverified');
  assert.deepEqual(result.verification.criterionIds, []);
});

test('completion persists across reopening, journal replay, backups, and private remote projection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-check-persistence-'));
  let store = new Store(join(root, 'board.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const project = store.project({ name: 'Persistence' });
  let task = store.createTask({ projectId: project.id, title: 'Checklist', criteria: ['Check'] });
  const legacyCheck = check(task); delete legacyCheck.completed;
  task = store.verify(task.id, { ...payload(task, 'unverified'), pendingChecks: [legacyCheck] });
  assert.equal(task.verification.pendingChecks[0].completed, false);
  task = store.setVerificationCheck(task.id, 'integration-check', { expectedRevision: task.revision, completed: true });
  const archive = store.exportArchive();
  store.close(); store = new Store(join(root, 'board.sqlite'));
  assert.deepEqual(store.getTask(task.id), task);
  assert.equal(store.replay().status, 'rebuilt');
  assert.deepEqual(store.getTask(task.id), task);
  const projected = sanitizeSnapshot({ projects: [project], tasks: [task] });
  assert.equal(projected.tasks[0].verification.pendingChecks[0].completed, true);
  assert.equal(projected.tasks[0].verification.pendingChecks[0].title, '验证待办 1（详情仅在桌面）');
  assert.deepEqual(sanitizeSnapshot(projected), projected);
  assert.equal(store.restoreArchive(archive).status, 'restored');
  const restored = store.getTask(task.id);
  assert.equal(restored.verification.pendingChecks[0].completed, true);
  assert.ok(restored.verification.contentVersion < restored.contentVersion);
  assert.throws(() => store.setVerificationCheck(task.id, 'integration-check', { expectedRevision: restored.revision, completed: false }), error => error.code === 'VERIFICATION_STALE');
});

test('verification validates revision, evidence fields, and current criterion IDs', async t => {
  const { store, task } = await fixture(t);
  const id = task.criteria[0].id;
  for (const input of [
    { ...payload(task, 'partial', [id, id]) },
    { ...payload(task, 'partial', ['foreign']) },
    { ...payload(task, 'partial', [id]), summary: ' ' },
    { ...payload(task, 'partial', [id]), reference: '' },
    { ...payload(task, 'partial', [id]), source: 'human' },
  ]) assert.throws(() => store.verify(task.id, input));
  assert.throws(() => store.verify(task.id, { ...payload(task, 'partial'), expectedRevision: 0 }), error => error.status === 409);
  assert.equal(store.getTask(task.id).revision, task.revision);
});

test('passed needs submitted task, all criteria, and no open discrepancy; later content makes it stale', async t => {
  const { store, project, task } = await fixture(t);
  const all = task.criteria.map(item => item.id);
  assert.throws(() => store.verify(task.id, payload(task, 'passed', all)), /提交/);
  let current = store.updateTask(task.id, { status: 'submitted' }, task.revision);
  assert.throws(() => store.verify(task.id, payload(current, 'passed', [all[0]])), /全部/);
  current = store.verify(task.id, payload(current, 'passed', all));
  assert.equal(current.verification.status, 'passed');
  assert.equal(current.acceptance, 'unverified');
  assert.equal(current.criteria.some(item => item.passed), false);
  assert.match(store.context(project.id), /测试验证：passed（当前内容）/);
  assert.match(store.context(project.id), /测试验证不等于人工验收/);
  const stopped = store.updateTask(task.id, { status: 'paused' }, current.revision);
  assert.ok(stopped.verification.contentVersion < stopped.contentVersion);
  current = store.updateTask(task.id, { status: 'submitted' }, stopped.revision);
  current = store.verify(task.id, payload(current, 'passed', current.criteria.map(item => item.id)));
  const changed = store.updateTask(task.id, { goal: '新目标' }, current.revision);
  assert.equal(changed.verification.status, 'passed');
  assert.ok(changed.verification.contentVersion < changed.contentVersion);
  assert.match(store.context(project.id), /旧版，已过期/);
  const reopened = store.updateTask(task.id, { status: 'submitted' }, changed.revision);
  const failed = store.review(task.id, { expectedRevision: reopened.revision, decision: 'fail', summary: '存在未解决偏差' });
  assert.match(store.context(project.id), /测试验证：passed（旧版，已过期）/);
  assert.throws(() => store.verify(task.id, payload(failed, 'passed', failed.criteria.map(item => item.id))), /偏差/);
  const empty = store.createTask({ projectId: project.id, title: '无标准任务' });
  const submitted = store.updateTask(empty.id, { status: 'submitted' }, empty.revision);
  assert.throws(() => store.verify(empty.id, payload(submitted, 'passed')), /全部/);
});

test('human review failure invalidates a same-version passed test in project context', async t => {
  const { store, project, task } = await fixture(t);
  let current = store.updateTask(task.id, { status: 'submitted' }, task.revision);
  current = store.verify(task.id, payload(current, 'passed', current.criteria.map(item => item.id)));
  assert.match(store.context(project.id), /测试验证：passed（当前内容）/);
  const reviewed = store.review(task.id, { expectedRevision: current.revision, decision: 'fail', summary: '人工发现偏差' });
  assert.equal(reviewed.verification.contentVersion, reviewed.contentVersion);
  assert.match(store.context(project.id), /测试验证：passed（当前条件已失效）/);
  assert.doesNotMatch(store.context(project.id), /测试验证：passed（当前内容）/);
  assert.equal(reviewed.acceptance, 'failed');
});

test('blocked reason and next step changes expire a current passed test record', async t => {
  const { store, project } = await fixture(t);
  for (const patch of [{ blockedReason: '等待权限' }, { nextStep: '重新运行集成测试' }]) {
    let task = store.createTask({ projectId: project.id, title: `变化 ${Object.keys(patch)[0]}`, criteria: ['功能通过'] });
    task = store.updateTask(task.id, { status: 'submitted' }, task.revision);
    task = store.verify(task.id, payload(task, 'passed', task.criteria.map(item => item.id)));
    const changed = store.updateTask(task.id, patch, task.revision);
    assert.ok(changed.contentVersion > task.contentVersion);
    assert.ok(changed.verification.contentVersion < changed.contentVersion);
    const section = store.context(project.id).split('### ').find(part => part.startsWith(`${changed.id} ·`));
    assert.match(section, /测试验证：passed（旧版，已过期）/);
  }
});

test('only the local owner route can write verification', async t => {
  const root = await mkdtemp(join(tmpdir(), 'taskboard-verification-core-'));
  const core = await createCore({ dataDir: root, pluginDir: join(root, 'empty-plugins'), files: false });
  t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
  const project = core.store.project({ name: '权限项目' });
  const task = core.store.createTask({ projectId: project.id, title: '权限任务', criteria: ['测试'] });
  const path = `/api/tasks/${task.id}/verify`;
  for (const role of ['viewer', 'reporter', 'remote-controller']) {
    await assert.rejects(core.request('POST', path, { ...payload(task, 'unverified'), pendingChecks: [check(task)] }, role), error => error.status === 403);
  }
  await assert.rejects(core.request('POST', '/api/events/ingest', { eventId: 'forged-check', type: 'task.update', taskId: task.id,
    expectedRevision: task.revision, payload: { verification: { status: 'passed', pendingChecks: [] } } }, 'reporter'), error => error.status === 403);
  const result = await core.request('POST', path, { ...payload(task, 'unverified'), pendingChecks: [check(task)] }, 'owner');
  assert.equal(result.verification.status, 'unverified');
  assert.equal(result.revision, task.revision + 1);
});

test('journal replay preserves test record while archive restore invalidates its version', async t => {
  const { store, task } = await fixture(t);
  let current = store.updateTask(task.id, { status: 'submitted' }, task.revision);
  current = store.verify(task.id, payload(current, 'passed', current.criteria.map(item => item.id)));
  const archive = store.exportArchive();
  const expected = structuredClone(current.verification);
  store.journal.enabled = false;
  store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify({ ...current, verification: null }), task.id);
  store.journal.enabled = true;
  assert.equal(store.replay().status, 'rebuilt');
  assert.deepEqual(store.getTask(task.id).verification, expected);
  assert.equal(store.restoreArchive(archive).status, 'restored');
  const restored = store.getTask(task.id);
  assert.deepEqual(restored.verification, expected);
  assert.ok(restored.verification.contentVersion < restored.contentVersion);
  assert.equal(restored.acceptance, 'unverified');
});

test('journal replay and restore retain pending checks and mark their version stale', async t => {
  const { store, task, project } = await fixture(t);
  const recorded = store.verify(task.id, { ...payload(task, 'unverified'), pendingChecks: [check(task)] });
  const archive = store.exportArchive();
  store.journal.enabled = false;
  store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify({ ...recorded, verification: null }), task.id);
  store.journal.enabled = true;
  assert.equal(store.replay().status, 'rebuilt');
  assert.deepEqual(store.getTask(task.id).verification.pendingChecks, [check(task)]);
  assert.equal(store.restoreArchive(archive).status, 'restored');
  const restored = store.getTask(task.id);
  assert.deepEqual(restored.verification.pendingChecks, [check(task)]);
  assert.ok(restored.verification.contentVersion < restored.contentVersion);
  assert.match(store.context(project.id), /记录版本 1，已过期/);
});

test('remote projection shows sanitized test status and accepts legacy tasks without it', async t => {
  const { store, project, task } = await fixture(t);
  const verified = store.verify(task.id, { ...payload(task, 'partial', [task.criteria[0].id]), pendingChecks: [check(task)] });
  verified.conversationId = 'private-thread';
  const snapshot = sanitizeSnapshot({ projects: [project], tasks: [verified] });
  const privateCheck = { id: 'remote-check-1', kind: 'test', title: '验证待办 1（详情仅在桌面）',
    criterionIds: [task.criteria[0].id], steps: ['请在项目电脑打开任务详情，查看具体操作。'],
    expectedResult: '请在桌面查看通过标准。', blockedReason: '请在桌面查看当前缺少的条件。', shareWithRemote: false, completed: false };
  assert.deepEqual(snapshot.tasks[0].verification, { ...verified.verification, pendingChecks: [privateCheck], reference: '请在桌面端查看本地验证证据' });
  assert.equal(snapshot.tasks[0].verification.contentVersion, snapshot.tasks[0].contentVersion);
  assert.equal(JSON.stringify(snapshot).includes('private-thread'), false);
  assert.equal(JSON.stringify(snapshot).includes('reports/test-run.txt'), false);
  assert.deepEqual(sanitizeSnapshot(snapshot).tasks[0].verification, snapshot.tasks[0].verification);
  assert.deepEqual(snapshot.tasks[0].verification.pendingChecks, [privateCheck]);
  const legacy = { ...verified };
  delete legacy.verification;
  assert.equal(sanitizeSnapshot({ projects: [project], tasks: [legacy] }).tasks[0].verification, null);
  const legacyRecord = { ...verified, verification: { ...verified.verification } };
  delete legacyRecord.verification.pendingChecks;
  assert.deepEqual(sanitizeSnapshot({ projects: [project], tasks: [legacyRecord] }).tasks[0].verification.pendingChecks, []);
  const changed = store.updateTask(task.id, { criteria: ['新标准'] }, verified.revision);
  assert.deepEqual(sanitizeSnapshot({ projects: [project], tasks: [changed] }).tasks[0].verification.pendingChecks, [privateCheck]);
  assert.throws(() => sanitizeSnapshot({ projects: [project], tasks: [{ ...verified, verification: { ...verified.verification, source: 'human' } }] }), /verification/);
  assert.throws(() => sanitizeSnapshot({ projects: [project], tasks: [{ ...verified, verification: { ...verified.verification, pendingChecks: [{ ...check(task), criterionIds: ['foreign'] }] } }] }), /待验证清单/);
});

test('remote checklist details require explicit per-item sharing', async t => {
  const { store, project, task } = await fixture(t);
  const secret = '/private/local-result-and-error';
  const hidden = { ...check(task), id: `hidden-${secret}`, title: `title ${secret}`,
    steps: [`step ${secret}`], expectedResult: `expected ${secret}`, blockedReason: `blocked ${secret}` };
  const shared = { ...check(task), id: 'local-check-1', title: '公开检查', shareWithRemote: true };
  const recorded = store.verify(task.id, { ...payload(task, 'partial'), pendingChecks: [hidden, shared] });
  assert.deepEqual(recorded.verification.pendingChecks, [hidden, shared]);
  assert.match(store.context(project.id), /private\/local-result-and-error/);
  const projection = sanitizeSnapshot({ projects: [project], tasks: [recorded] });
  const remote = projection.tasks[0].verification.pendingChecks;
  assert.equal(JSON.stringify(remote).includes(secret), false);
  assert.deepEqual(remote[0], { id: 'remote-check-1', kind: hidden.kind, title: '验证待办 1（详情仅在桌面）',
    criterionIds: hidden.criterionIds, steps: ['请在项目电脑打开任务详情，查看具体操作。'],
    expectedResult: '请在桌面查看通过标准。', blockedReason: '请在桌面查看当前缺少的条件。', shareWithRemote: false, completed: false });
  assert.deepEqual(remote[1], { ...shared, id: 'remote-check-2' });
  assert.equal(new Set(remote.map(item => item.id)).size, remote.length);
  assert.deepEqual(sanitizeSnapshot(projection), projection);
  assert.throws(() => sanitizeSnapshot({ projects: [project], tasks: [{ ...recorded, verification: {
    ...recorded.verification, pendingChecks: [{ ...check(task), shareWithRemote: 'yes' }] } }] }), /待验证清单/);
});
