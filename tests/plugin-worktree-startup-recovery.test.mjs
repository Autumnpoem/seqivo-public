import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlugin } from '../plugins/codex-autocontinue/host.mjs';

// Emulates the durable state left when job.start fails after the marker write
// and before createSession can save a created session. No provider or job runs.
async function fixture(t, { retirement = 'unknown', session = null, worktreeId = 'wt-original' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'taskboard-worktree-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'state');
  const projectDir = join(dir, 'repo');
  const worktree = join(dir, 'worktree');
  const recordRoot = join(dataDir, 'executor-jobs');
  await Promise.all([mkdir(recordRoot, { recursive: true }), mkdir(projectDir), mkdir(worktree)]);
  const task = { id: 't1', projectId: 'p1', conversationId: session?.threadId || '',
    status: 'planned', revision: 1, contentVersion: 1 };
  const project = { id: 'p1', directory: projectDir };
  const workspace = worktreeId ? worktree : projectDir;
  const marker = { kind: 'macos-job', status: 'startup_unknown', startupFailure: true,
    taskId: 't1', projectId: 'p1', worktreeId, workspace,
    canonicalWorkspace: await realpath(workspace), recordRoot, recordId: 'a'.repeat(32),
    startupId: 'startup-original', captureComplete: true, knownIdentities: [] };
  const statePath = join(dataDir, 'codex-autocontinue.json');
  await writeFile(statePath, JSON.stringify({ enabled: false, commands: {},
    sessions: session ? { original: { taskId: 't1', status: 'created', ...session } } : {},
    executors: { 'task:t1': marker }, policies: [] }));
  let binding = { directory: worktree, worktreeId };
  let root = recordRoot;
  let retired = retirement === 'verified';
  let recoverCalls = 0;
  let retireCalls = 0;
  let resolverCalls = 0;
  const backend = {
    taskJobRecordRoot: async () => root,
    auditTaskJobIndex: async () => {},
    verifyTaskJobMarker: async () => ({ verified: true }),
    recoverTaskJob: async () => {
      recoverCalls++;
      return { verified: true, job: { recordId: marker.recordId, dispose: async () => {} } };
    },
    verifyTaskJobRetired: async input => {
      assert.equal(input.job.recordId, marker.recordId);
      assert.equal(input.workspace, marker.workspace);
      assert.equal(input.retirementBinding.taskId, task.id);
      assert.equal(input.retirementBinding.worktreeId, marker.worktreeId);
      return retired
        ? { verified: true, retired: true, scope: 'fixture-original-job' }
        : { verified: false, retired: false, reason: 'fixture_retirement_unknown' };
    },
  };
  const makePlugin = () => createPlugin({ dataDir, taskJobBackend: backend,
    getTask: async id => id === task.id ? task : null,
    getProject: async id => id === project.id ? project : null,
    resolveWorkspace: async ({ taskId, worktreeId }) => {
      resolverCalls++;
      assert.equal(taskId, task.id);
      assert.equal(worktreeId, marker.worktreeId);
      return binding;
    },
    retireExecutorStartup: async identity => {
      assert.equal(identity.taskId, task.id);
      assert.equal(identity.startupId, marker.startupId);
      assert.equal(identity.recordId, marker.recordId);
      retireCalls++;
    },
    updateTask: async () => { throw Error('fixture task must not change'); },
  });
  return { dir, statePath, marker, makePlugin,
    setBinding: value => { binding = value; }, setRoot: value => { root = value; },
    setRetired: value => { retired = value; },
    recoverCalls: () => recoverCalls, retireCalls: () => retireCalls,
    resolverCalls: () => resolverCalls };
}

test('failed worktree start remains fenced until original job retirement is verified, including restart',
  { skip: process.platform !== 'darwin' }, async t => {
    const x = await fixture(t);
    const first = x.makePlugin();
    assert.equal((await first.getSessionBinding({ taskId: 't1' })).status, 'unbound');
    await assert.rejects(first.close(), /fixture_retirement_unknown/);
    assert.ok(x.recoverCalls() > 0, 'unchanged pre-session worktree reaches original job recovery');
    assert.equal((await readFile(x.statePath, 'utf8')).includes(x.marker.recordId), true);
    assert.equal(x.retireCalls(), 0);

    // A new host must audit the same pre-session binding, then retain the
    // original retirement gate. Only the controlled proof permits clearing.
    const restarted = x.makePlugin();
    assert.equal((await restarted.getSessionBinding({ taskId: 't1' })).status, 'unbound');
    await assert.rejects(restarted.close(), /fixture_retirement_unknown/);
    x.setRetired(true);
    await restarted.close();
    assert.equal(JSON.parse(await readFile(x.statePath, 'utf8')).executors['task:t1'], undefined);
    assert.equal(x.retireCalls(), 1);
  });

for (const mode of ['worktree-id', 'worktree-path', 'record-root']) {
  test(`failed worktree start rejects changed ${mode} and keeps marker`,
    { skip: process.platform !== 'darwin' }, async t => {
      const x = await fixture(t, { retirement: 'verified' });
      if (mode === 'worktree-id') x.setBinding({ directory: x.marker.workspace, worktreeId: 'wt-other' });
      if (mode === 'worktree-path') x.setBinding({ directory: x.dir, worktreeId: x.marker.worktreeId });
      if (mode === 'record-root') x.setRoot(join(x.dir, 'other-record-root'));
      const plugin = x.makePlugin();
      await assert.rejects(plugin.getSessionBinding({ taskId: 't1' }), /binding changed|record root changed/i);
      assert.equal(x.recoverCalls(), 0);
      assert.equal(x.retireCalls(), 0);
      assert.ok(JSON.parse(await readFile(x.statePath, 'utf8')).executors['task:t1']);
    });
}

test('created session with a different worktree cannot borrow the pre-session marker',
  { skip: process.platform !== 'darwin' }, async t => {
    const x = await fixture(t, { retirement: 'verified',
      session: { threadId: 'thread-1', worktreeId: 'wt-other', workspace: 'unrelated' } });
    await assert.rejects(x.makePlugin().getSessionBinding({ taskId: 't1' }), /session binding changed/);
    assert.equal(x.recoverCalls(), 0);
    assert.ok(JSON.parse(await readFile(x.statePath, 'utf8')).executors['task:t1']);
  });

test('matching created worktree session still retires through the original job authority',
  { skip: process.platform !== 'darwin' }, async t => {
    const x = await fixture(t, { retirement: 'verified',
      session: { threadId: 'thread-1', worktreeId: 'wt-original', workspace: null } });
    const image = JSON.parse(await readFile(x.statePath, 'utf8'));
    image.sessions.original.workspace = x.marker.workspace;
    await writeFile(x.statePath, JSON.stringify(image));
    const plugin = x.makePlugin();
    assert.equal((await plugin.getExecution({ taskId: 't1', commandId: 'none' })).status, 'not_started');
    await plugin.close();
    assert.ok(x.resolverCalls() > 0);
    assert.equal(x.recoverCalls(), 1);
    assert.equal(x.retireCalls(), 1, 'startup reservation must be retired');
    assert.equal(JSON.parse(await readFile(x.statePath, 'utf8')).executors['task:t1'], undefined);
  });

test('null-worktree project job retains its original retirement path',
  { skip: process.platform !== 'darwin' }, async t => {
    const x = await fixture(t, { retirement: 'verified', worktreeId: null });
    const plugin = x.makePlugin();
    assert.equal((await plugin.getExecution({ taskId: 't1', commandId: 'none' })).status, 'not_started');
    await plugin.close();
    assert.equal(x.resolverCalls(), 0, 'project-root job does not borrow a worktree binding');
    assert.equal(x.recoverCalls(), 1);
    assert.equal(x.retireCalls(), 1, 'startup reservation must be retired');
    assert.equal(JSON.parse(await readFile(x.statePath, 'utf8')).executors['task:t1'], undefined);
  });
