import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from '../server/core.mjs';

test('native Core startup stores private phase diagnostics without sending a model turn', {
  skip: process.platform !== 'darwin' || process.env.SEQIVO_TEST_NATIVE_STARTUP_DIAGNOSTICS !== '1'
}, async t => {
  const pythonPath = process.env.TASKBOARD_TEST_PYTHON;
  assert.match(pythonPath || '', /^\//, 'Use the isolated absolute Python path');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-startup-diag-native-')));
  const dataDir = join(root, 'data'), workspace = join(root, 'project');
  await mkdir(dataDir, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  const fake = join(root, 'fake-codex.py');
  const source = await readFile(new URL('plugin-fake-codex.py', import.meta.url), 'utf8');
  await writeFile(fake, `#!${pythonPath}\n${source.split('\n').slice(1).join('\n')}`, { mode: 0o700 });
  await chmod(fake, 0o700);
  const environment = { TASKBOARD_FAKE_SCENARIO: join(root, 'scenario.json'),
    TASKBOARD_FAKE_LOG: join(root, 'requests.jsonl'), TASKBOARD_FAKE_PID: join(root, 'provider.pid') };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  await writeFile(environment.TASKBOARD_FAKE_SCENARIO, '{}', { mode: 0o600 });
  await writeFile(environment.TASKBOARD_FAKE_LOG, '', { mode: 0o600 });
  Object.assign(process.env, environment);
  let core;
  t.after(async () => {
    const failures = [];
    try {
      if (core) {
        try { await core.plugin.disable(); }
        catch (error) { failures.push(new Error('Plugin retirement unconfirmed', { cause: error })); }
        try { assert.equal(core.leases.state().active.length, 0, 'Original startup lease must retire'); }
        catch (error) { failures.push(error); }
        // Always attempt the normal close, even if disable or lease proof failed.
        try { await core.close(); }
        catch (error) { failures.push(new Error('Core shutdown unconfirmed', { cause: error })); }
      } else failures.push(new Error('Core initialization did not yield a confirmed cleanup handle'));
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      if (!failures.length) await rm(root, { recursive: true, force: true });
      else t.diagnostic(`Retained isolated startup diagnostic fixture: ${root}`);
    }
    if (failures.length) throw new AggregateError(failures, 'Native diagnostic fixture cleanup unconfirmed');
  });
  core = await createCore({ dataDir, files: false,
    pluginDir: fileURLToPath(new URL('../plugins/', import.meta.url)), managedPythonPath: pythonPath });
  const project = core.store.project({ name: 'Disposable startup diagnostic', directory: workspace });
  const task = core.store.createTask({ projectId: project.id, title: 'Create a protocol fixture session',
    executionProvider: 'codex-autocontinue' });
  await core.plugin.configure({ pythonPath, codexPath: fake, pollSeconds: 86400 });
  const session = await core.request('POST', `/api/tasks/${task.id}/session`, {
    expectedRevision: task.revision, commandId: 'native-diag-session-once', workspaceWrite: false
  });
  const raw = await readFile(join(dataDir, 'diagnostics', 'executor-startup.jsonl'), 'utf8');
  const rows = raw.trim().split('\n').map(JSON.parse);
  assert.ok(rows.length >= 1, 'The actual Core must record its observer phase');
  t.diagnostic(JSON.stringify({ sessionStatus: session.status,
    phases: rows.map(({ phase, verified, stage, detail, helperReason }) => ({ phase, verified, stage, detail, helperReason })) }));
  assert.doesNotMatch(raw, new RegExp(task.id));
  assert.ok(!raw.includes(root) && !raw.includes(pythonPath));
  const requests = (await readFile(environment.TASKBOARD_FAKE_LOG, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(requests.filter(row => row.method === 'turn/start').length, 0);
  assert.equal(session.status, 'created', 'Native fake-provider startup must be admitted');
  assert.equal(requests.filter(row => row.method === 'thread/start').length, 1);
  for (const phase of ['confirm.first', 'confirm.second', 'revalidate.first', 'revalidate.second'])
    assert.ok(rows.some(row => row.phase === phase && row.verified), `Missing ${phase} observation`);
  assert.equal(core.store.getTask(task.id).conversationId, session.threadId);
});
