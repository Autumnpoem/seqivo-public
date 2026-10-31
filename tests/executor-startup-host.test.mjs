import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlugin } from '../plugins/codex-autocontinue/host.mjs';

const pluginDir = fileURLToPath(new URL('../plugins/codex-autocontinue/', import.meta.url));
const pythonPath = process.env.TASKBOARD_TEST_PYTHON;

async function fixture(t, hooks = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-startup-host-')));
  const recordRoot = join(root, 'records');
  await mkdir(recordRoot);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const task = { id: 'task', projectId: 'project', conversationId: 'thread',
    status: 'blocked', revision: 1, contentVersion: 1, title: 'Fixture' };
  const project = { id: 'project', directory: root, handoff: null };
  const seen = { reserve: 0, prepare: 0, provider: 0 };
  const taskJobBackend = {
    taskJobRecordRoot: async () => recordRoot,
    auditTaskJobIndex: async () => {},
    prepareTaskJob: async () => {
      seen.prepare++;
      await hooks.prepare?.(recordRoot);
      throw new Error('fixture_prepare_after_intent');
    },
  };
  const plugin = createPlugin({ dataDir: join(root, 'state'), pluginDir,
    taskJobBackend,
    processProof: { captureExecutorBaseline: async () =>
      ({ verified: true, baseline: Object.freeze({ fixture: true }) }) },
    getTask: async () => task, getProject: async () => project,
    updateTask: async () => { throw new Error('No task update expected'); },
    reserveExecutorStartup: async input => {
      seen.reserve++;
      assert.equal(input.taskId, task.id);
      assert.equal(input.workspace, root);
      if (hooks.rejectReserve) throw new Error('fixture_reserve_denied');
      return { status: 'startup' };
    },
    bindExecutorStartup: async () => { throw new Error('No prepared job was returned'); },
    confirmExecutorStartup: async () => { throw new Error('No job was started'); },
    verifyExecutorStartup: async () => { throw new Error('No job was started'); },
  });
  await plugin.configure({ pythonPath, codexPath: '/bin/true', pollSeconds: 86400 });
  const statePath = join(root, 'state', 'codex-autocontinue.json');
  return { root, recordRoot, statePath, plugin, seen };
}

test('rejected startup reservation after durable marker creates no job and clears only that marker',
  { skip: process.platform !== 'darwin' }, async t => {
    assert.ok(pythonPath?.startsWith('/'), 'Set absolute TASKBOARD_TEST_PYTHON');
    const x = await fixture(t, { rejectReserve: true });
    try {
      await assert.rejects(x.plugin.resume({ taskId: 'task', expectedRevision: 1,
        commandId: 'reserve-denied' }), /fixture_reserve_denied/);
      const saved = JSON.parse(await readFile(x.statePath, 'utf8'));
      assert.equal(saved.executors['task:task'], undefined);
      assert.notEqual(saved.policies.find(policy => policy.taskId === 'task')?.status, 'unknown',
        'a rejected reservation with no attempted job is not an unknown executor');
      assert.equal(x.seen.reserve, 1);
      assert.equal(x.seen.prepare, 0);
      assert.equal(x.seen.provider, 0);
    } finally { await x.plugin.close(); }
  });

test('a prepare failure after private intent retains an unknown marker and never retries the provider',
  { skip: process.platform !== 'darwin' }, async t => {
    assert.ok(pythonPath?.startsWith('/'), 'Set absolute TASKBOARD_TEST_PYTHON');
    const x = await fixture(t, { prepare: async root =>
      writeFile(join(root, 'intent-created-before-error'), 'fixture', { flag: 'wx' }) });
    await assert.rejects(x.plugin.resume({ taskId: 'task', expectedRevision: 1,
      commandId: 'prepare-failed' }), /fixture_prepare_after_intent/);
    const saved = JSON.parse(await readFile(x.statePath, 'utf8'));
    assert.match(saved.executors['task:task']?.status || '', /^(startup_unknown|retirement_unknown)$/);
    assert.equal(saved.policies.find(policy => policy.taskId === 'task')?.status, 'unknown');
    const reopened = createPlugin({ dataDir: join(x.root, 'state'), pluginDir,
      getTask: async () => null, getProject: async () => null,
      updateTask: async () => { throw new Error('No update expected'); } });
    assert.equal(reopened.state().policies.find(policy => policy.taskId === 'task')?.status, 'unknown',
      'a reopened host must still publish the original startup fence');
    assert.equal((await readFile(join(x.recordRoot, 'intent-created-before-error'), 'utf8')), 'fixture');
    assert.equal(x.seen.reserve, 1);
    assert.equal(x.seen.prepare, 1);
    await assert.rejects(x.plugin.resume({ taskId: 'task', expectedRevision: 1,
      commandId: 'retry-must-not-launch' }), /unconfirmed|unknown/i);
    assert.equal(x.seen.prepare, 1);
    await assert.rejects(x.plugin.close(), /unconfirmed|unknown|record/i);
  });
