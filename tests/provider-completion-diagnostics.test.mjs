import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlugin } from '../plugins/codex-autocontinue/host.mjs';
import { providerFailure, finalThreadCheck, publicCompletionDiagnostic } from
  '../plugins/codex-autocontinue/completion-diagnostics.mjs';

const fixture = fileURLToPath(new URL('./plugin-fake-codex.py', import.meta.url));
const pluginDir = fileURLToPath(new URL('../plugins/codex-autocontinue/', import.meta.url));
const envNames = ['TASKBOARD_FAKE_SCENARIO', 'TASKBOARD_FAKE_LOG', 'TASKBOARD_FAKE_PID',
  'TASKBOARD_FAKE_CWD', 'TASKBOARD_FAKE_CHILD_PID', 'TASKBOARD_FAKE_LATE_WRITE',
  'TASKBOARD_FAKE_CHILD_SCRIPT'];

test('completion diagnostic labels never copy provider text or thread content', () => {
  const secret = 'https://private.example/token=secret';
  assert.deepEqual(providerFailure({ codex_error_info: 'server_overloaded', message: `at capacity ${secret}` }),
    { category: 'busy', summary: '服务当前繁忙，请稍后由用户决定是否重试' });
  assert.equal(providerFailure({ message: `quota exhausted ${secret}` }).category, 'quota');
  assert.equal(providerFailure({ code: 'unauthorized', message: secret }).category, 'auth');
  assert.equal(providerFailure({ message: secret }).category, 'unknown');
  const observed = finalThreadCheck({ status: { type: 'active', activeFlags: ['private flag'] },
    turns: [{ id: 'other-turn', status: 'inProgress', error: secret, items: [{ text: secret }] }] }, 'owned-turn');
  assert.deepEqual(observed, { threadStatus: 'active', finalTurnPresent: true,
    finalTurnMatches: false, finalTurnStatus: 'inProgress', activeFlagsCount: 1 });
  assert.ok(!JSON.stringify(publicCompletionDiagnostic({ providerFailure: { category: 'unknown', summary: secret },
    stopProof: { finalThreadCheck: { ...observed, text: secret } } })).includes(secret));
});

for (const finalThreadUnknown of [false, true]) test(
  finalThreadUnknown
    ? 'bound fake-provider failed turn keeps unknown and a bounded final-thread predicate when final read changes'
    : 'bound fake-provider failure persists only a category and exposes it without changing failure status',
  { concurrency: false }, async () => {
    const pythonPath = process.env.TASKBOARD_TEST_PYTHON;
    assert.ok(pythonPath && isAbsolute(pythonPath), 'an absolute fixture Python is required');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-completion-diag-')));
    const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
    const executable = join(root, 'fake-codex.py');
    const stateDir = join(root, 'state');
    const pidPath = join(root, 'appserver.pid');
    const secret = 'https://private.example/token=must-not-persist';
    let plugin, bodyError, cleanupError;
    try {
      await copyFile(fixture, executable); await chmod(executable, 0o700);
      await mkdir(stateDir);
      await writeFile(join(root, 'scenario.json'), JSON.stringify({ completeStatus: 'failed',
        shortCommandMs: 300, turnError: { codex_error_info: 'server_overloaded', message: `Selected model is at capacity ${secret}` },
        ...(finalThreadUnknown ? { threadStatusAfterCompletion: { type: 'active', activeFlags: ['waitingOnApproval'] } } : {}) }));
      await writeFile(join(root, 'appserver.log'), '');
      await writeFile(join(root, 'late-child.py'), '');
      Object.assign(process.env, {
        TASKBOARD_FAKE_SCENARIO: join(root, 'scenario.json'), TASKBOARD_FAKE_LOG: join(root, 'appserver.log'),
        TASKBOARD_FAKE_PID: pidPath, TASKBOARD_FAKE_CWD: root,
        TASKBOARD_FAKE_CHILD_PID: join(root, 'late-child.pid'), TASKBOARD_FAKE_LATE_WRITE: join(root, 'late-write.txt'),
        TASKBOARD_FAKE_CHILD_SCRIPT: join(root, 'late-child.py'),
      });
      let task = { id: 't1', projectId: 'p1', title: 'Fixture', goal: 'Finish', criteria: [],
        conversationId: 'thread-1', status: 'blocked', blockedReason: 'Codex quota exhausted',
        acceptance: 'unverified', revision: 1, contentVersion: 1 };
      plugin = createPlugin({ dataDir: stateDir, pluginDir, taskJobBackend: null,
        processProof: {
          captureExecutorBaseline: async () => ({ verified: true, baseline: { fixture: true } }),
          captureTaskExecutorTree: async ({ bridgePid, appServerPid }) => ({ verified: true,
            capture: { bridgePid, appServerPid, scope: 'fixture' }, identities: [] }),
          verifyTaskExecutorRetired: async () => ({ verified: true, retired: true }),
        },
        getTask: async id => id === task.id ? task : null,
        getProject: async id => id === 'p1' ? { id, directory: root } : null,
        updateTask: async (id, patch, revision) => {
          assert.equal(id, task.id); assert.equal(revision, task.revision);
          task = { ...task, ...patch, revision: revision + 1 }; return task;
        },
      });
      await plugin.configure({ pythonPath, codexPath: executable, pollSeconds: 86400 });
      const started = await plugin.resume({ taskId: 't1', expectedRevision: 1, commandId: 'failed1' });
      assert.equal(started.status, 'running');
      let saved, execution;
      for (let attempt = 0; attempt < 100; attempt++) {
        saved = JSON.parse(await readFile(join(stateDir, 'codex-autocontinue.json'), 'utf8'));
        execution = await plugin.getExecution({ taskId: 't1', commandId: 'failed1' });
        if (finalThreadUnknown
          ? saved.commands['t1:failed1']?.stopProof?.finalThreadCheck && execution.status === 'unknown'
          : saved.commands['t1:failed1']?.stopProof?.status === 'verified' && execution.status === 'failed') break;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.equal(saved.commands['t1:failed1'].stopProof.status, finalThreadUnknown ? 'unverified' : 'verified');
      assert.equal(execution.status, finalThreadUnknown ? 'unknown' : 'failed');
      assert.equal(execution.diagnostic.providerFailure.category, 'busy');
      assert.deepEqual(saved.commands['t1:failed1'].providerFailure, execution.diagnostic.providerFailure);
      if (finalThreadUnknown) {
        assert.deepEqual(saved.commands['t1:failed1'].stopProof.finalThreadCheck,
          { threadStatus: 'active', finalTurnPresent: true, finalTurnMatches: true,
            finalTurnStatus: 'failed', activeFlagsCount: 1 });
        assert.deepEqual(execution.diagnostic.finalThreadCheck,
          saved.commands['t1:failed1'].stopProof.finalThreadCheck);
        assert.notEqual(task.status, 'submitted', 'unverified final read cannot submit the task');
        const sends = (await readFile(join(root, 'appserver.log'), 'utf8')).trim().split('\n')
          .filter(Boolean).map(JSON.parse).filter(row => row.method === 'turn/start');
        assert.equal(sends.length, 1, 'diagnostic reconciliation must not resend the turn');
      } else assert.equal(task.status, 'failed');
      assert.ok(!JSON.stringify(saved).includes(secret), 'provider error text must not enter the persistent host state');
      assert.ok(!task.blockedReason.includes(secret), 'the public task error must be bounded too');
    } catch (error) { bodyError = error; }
    try {
      if (plugin) await plugin.close();
      let pid;
      try { pid = Number(await readFile(pidPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (pid) {
        for (let attempt = 0; attempt < 40; attempt++) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === 'ESRCH') { pid = null; break; } throw error; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(pid, null, 'fixture app-server remains alive');
      }
      await rm(root, { recursive: true, force: true });
    } catch (error) { cleanupError = error; }
    finally { for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    } }
    if (bodyError || cleanupError) throw new AggregateError([bodyError, cleanupError].filter(Boolean),
      'Completion diagnostic body or cleanup failed');
  });
