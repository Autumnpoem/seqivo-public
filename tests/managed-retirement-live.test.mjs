import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createCore } from '../server/core.mjs';
import { reconnectManagedTmuxSession, verifyManagedTmuxSession } from '../server/terminal/managed-pane-record.mjs';
import { prepareExecutorJob } from '../server/macos-executor-job.mjs';
import { taskJobRecordRoot, verifyTaskJobRetired } from '../plugins/codex-autocontinue/job-transport.mjs';
import { nativeProcessTable } from '../server/codex-process-proof.mjs';

const exec = promisify(execFile);
const pythonPath = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';
const tmuxPath = resolve(process.env.TASKBOARD_TEST_TMUX || '.tools/terminal-build/install/bin/tmux');
const wait = ms => new Promise(done => setTimeout(done, ms));
const sameBirth = (row, expected) => row && expected &&
  ['pid', 'euid', 'ruid', 'startSec', 'startUsec'].every(key => row[key] === expected[key]);
async function noTmuxServer(run) {
  try { await run('list-sessions'); return false; }
  catch (error) {
    if (error.code === 1 && /^no server running on /i.test(String(error.stderr || '').trim())) return true;
    throw error;
  }
}

async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await check()) return; } catch { /* Poll only the isolated fixture. */ }
    await wait(50);
  }
  throw Error('Isolated managed retirement condition timed out');
}

async function fixture(t) {
  if (process.platform !== 'darwin') { t.skip('macOS native job identity required'); return null; }
  try { await access(pythonPath, constants.X_OK); await access(tmuxPath, constants.X_OK); }
  catch { t.skip('Isolated Python/tmux runtime unavailable'); return null; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-managed-retirement-live-')));
  const dataDir = join(root, 'data'), workspace = join(root, 'workspace');
  const pluginDir = join(root, 'plugins'), extension = join(pluginDir, 'codex-autocontinue');
  await mkdir(dataDir); await mkdir(workspace); await mkdir(extension, { recursive: true });
  await writeFile(join(extension, 'plugin.json'), JSON.stringify({ id: 'codex-autocontinue',
    name: 'Isolated callback probe', version: '1', apiVersion: 1, entry: 'host.mjs',
    permissions: ['tasks.read', 'task.resume', 'task.pause'], capabilities: ['task.resume'] }));
  await writeFile(join(extension, 'host.mjs'), `export function createPlugin(context) {
    let retirement = null;
    const state = () => ({ enabled: true, available: true, status: 'ready' });
    return { state, enable: state, disable: state, check: state,
      configure: input => input.verify ? context.verifyRetirementWorkspace(input.verify)
        : (retirement = input.remember, state()),
      quiesce: async () => retirement ? context.verifyRetirementWorkspace(retirement)
        : { verified: true, quiescent: true, unknown: false, livePids: [], scope: 'isolated-no-job-yet' },
      close: async () => { if (retirement) await context.verifyRetirementWorkspace(retirement); } };
  }`);
  const serverName = `seqivo_retire_${randomBytes(6).toString('hex')}`;
  const run = (...args) => exec(tmuxPath, ['-L', serverName, ...args], { timeout: 5000 });
  const closeChecks = [];
  let closeProbe;
  let core;
  core = await createCore({ dataDir, pluginDir, files: false, managedPythonPath: pythonPath,
    onShutdown: ({ stage, status }) => {
      if (stage === 'plugins' && status === 'started' && closeProbe)
        closeChecks.push(Promise.resolve().then(closeProbe).then(() => false, () => true));
    } });
  const project = core.store.project({ name: 'Managed retirement job', directory: workspace });
  await core.request('POST', '/api/terminal/profiles', { id: 'managed', label: 'Isolated managed',
    projectId: project.id, enabled: true, shell: '/bin/sh', serverName,
    allowSharedServer: true, tmuxExecutable: tmuxPath });
  const jobs = [];
  t.after(async () => {
    const failures = [];
    try { await core.close(); }
    catch (error) { failures.push(new Error('Core shutdown unconfirmed', { cause: error })); }
    for (const job of jobs) {
      try {
        const stopped = await job.stop();
        if (!stopped.retired && !(await job.recheck()).retired) throw Error('job_retirement_unknown');
        await job.dispose();
      } catch (error) { failures.push(new Error('Fixture job retirement unconfirmed', { cause: error })); }
    }
    const recordsRoot = join(dataDir, 'terminal-managed-records');
    const { readdir } = await import('node:fs/promises');
    const directories = await readdir(recordsRoot).catch(error => {
      failures.push(new Error('Managed record index unreadable', { cause: error })); return [];
    });
    if (directories.length !== 1) failures.push(Error('Expected exactly one isolated managed record'));
    for (const directory of directories) {
      let pane;
      try {
        const recordPath = join(recordsRoot, directory, 'record.json');
        const verified = await verifyManagedTmuxSession({ recordRoot: recordsRoot, recordPath });
        const original = verified.identities;
        const subject = await reconnectManagedTmuxSession({ recordRoot: recordsRoot, recordPath });
        pane = subject.pane;
        const state = await pane.status();
        if (state.state !== 'exited') {
          if (state.state === 'stopped' || state.inputFrozen) await pane.resume();
          await run('send-keys', '-t', verified.relayPaneId, 'exit', 'Enter');
          await until(async () => (await pane.status()).state === 'exited', 3000);
        }
        await pane.shutdown();
        await until(async () => {
          const rows = await nativeProcessTable(pythonPath, 15000);
          return [original.supervisor, original.shell, original.relay]
            .every(identity => !sameBirth(rows.get(identity.pid), identity));
        }, 6000);
        await until(async () => {
          try { await run('has-session', '-t', verified.sessionRef.sessionId); return false; }
          catch { return true; }
        }, 3000);
        const record = JSON.parse(await readFile(recordPath, 'utf8'));
        await rm(record.pane.directory, { recursive: true, force: true });
      } catch (error) {
        failures.push(new Error('Fixture pane retirement unconfirmed', { cause: error }));
      } finally { pane?.close(); }
    }
    if (!failures.length) {
      try { await run('kill-server'); }
      catch (error) {
        try { if (!(await noTmuxServer(run))) throw error; }
        catch (unconfirmed) { failures.push(new Error('Isolated tmux server shutdown unconfirmed', { cause: unconfirmed })); }
      }
      try {
        if (!(await noTmuxServer(run))) throw Error('Isolated tmux server remains live');
      } catch (error) { failures.push(new Error('Isolated tmux server absence unconfirmed', { cause: error })); }
    }
    if (failures.length) {
      t.diagnostic(`Retained isolated fixture: ${root}`);
      throw new AggregateError(failures, 'Isolated managed-retirement cleanup unconfirmed');
    }
    await rm(root, { recursive: true, force: true });
  });
  const frames = [], ctx = { local: true, profileId: 'managed', connectionId: 'original-owner' };
  const send = frame => frames.push(frame);
  return { core, dataDir, workspace, project, run, frames, ctx, send, jobs, closeChecks,
    setCloseProbe: action => { closeProbe = action; } };
}

async function parkedFixture(f) {
  const { core, ctx, send, frames } = f;
  await core.terminal.frame(ctx, { v: 1, type: 'open', mode: 'tmux', cols: 80, rows: 24 }, send);
  await core.terminal.frame(ctx, { v: 1, type: 'takeover' }, send);
  await core.terminal.frame(ctx, { v: 1, type: 'create', epoch: 0, name: 'original' }, send);
  const ready = frames.filter(frame => frame.type === 'ready').at(-1);
  assert.ok(ready?.sessionRef);
  await core.terminal.frame(ctx, { v: 1, type: 'return' }, send);
  const returned = frames.filter(frame => frame.type === 'control').at(-1);
  assert.equal(returned.phase, 'ai_ready', returned.reason);
  const task = core.store.createTask({ projectId: f.project.id, title: 'Original actual Mac job',
    executionProvider: 'codex-autocontinue', conversationId: 'isolated-thread' });
  const generation = returned.generation;
  assert.ok(Number.isSafeInteger(generation) && generation > 0);
  const jobDataDir = join(f.dataDir, 'plugins', 'codex-autocontinue');
  await mkdir(jobDataDir, { recursive: true, mode: 0o700 });
  const recordRoot = await taskJobRecordRoot(jobDataDir);
  const job = await prepareExecutorJob({ taskId: task.id, command: '/bin/cat',
    cwd: f.workspace, pythonPath, recordRoot });
  f.jobs.push(job);
  await job.spawn();
  const binding = { taskId: task.id, recordId: job.recordId, workspace: f.workspace,
    worktreeId: null, expectedHandoffGeneration: generation };
  return { task, job, binding, ready };
}

test('actual parked pane and task-owned Mac job retire through the built-in Core callback', async t => {
  const f = await fixture(t); if (!f) return;
  const { job, binding } = await parkedFixture(f);
  const verify = input => f.core.plugin.configure({ verify: input });
  await assert.rejects(verify({ ...binding, expectedHandoffGeneration: binding.expectedHandoffGeneration + 1 }),
    error => error.code === 'CONTROL_STALE');
  const stopped = await verifyTaskJobRetired({ job, workspace: f.workspace, pythonPath,
    knownIdentities: [job.identity], retirementBinding: binding,
    verifyRetirementWorkspace: verify });
  assert.equal(stopped.verified, true, stopped.reason);
  assert.equal(stopped.retired, true);
  assert.equal(stopped.scope, 'macos-original-task-job-coalition-known-descendants-and-managed-handoff');
  await assert.rejects(verify({ ...binding, recordId: '0'.repeat(32) }),
    error => ['MANAGED_PANE_UNKNOWN', 'PROCESS_PROOF_UNAVAILABLE'].includes(error.code));
  await assert.rejects(verify({ ...binding, worktreeId: 'wrong-worktree' }),
    error => ['EXECUTION_BINDING_CHANGED', 'MANAGED_PANE_UNKNOWN'].includes(error.code));
  await f.core.plugin.configure({ remember: binding });
  f.setCloseProbe(() => f.core.terminal.frame(
    { local: true, profileId: 'managed', connectionId: 'during-close' },
    { v: 1, type: 'open', mode: 'tmux', cols: 80, rows: 24 }, () => {}));
  await f.core.close();
  assert.deepEqual(await Promise.all(f.closeChecks), [true],
    'plugin close observes the terminal after its input seal');
});

test('a separate workspace writer blocks real task retirement until that exact test process exits', async t => {
  const f = await fixture(t); if (!f) return;
  const { job, binding } = await parkedFixture(f);
  const writer = spawn('/bin/sleep', ['30'], { cwd: f.workspace, stdio: 'ignore' });
  await new Promise((resolve, reject) => { writer.once('spawn', resolve); writer.once('error', reject); });
  try {
    const blocked = await verifyTaskJobRetired({ job, workspace: f.workspace, pythonPath,
      knownIdentities: [job.identity], retirementBinding: binding,
      verifyRetirementWorkspace: input => f.core.plugin.configure({ verify: input }) });
    assert.equal(blocked.verified, false);
    assert.equal(blocked.unknown, true);
  } finally {
    const exited = new Promise(resolve => writer.once('exit', resolve));
    writer.kill('SIGTERM');
    await exited;
  }
  const proven = await verifyTaskJobRetired({ job, workspace: f.workspace, pythonPath,
    knownIdentities: [job.identity], retirementBinding: binding,
    verifyRetirementWorkspace: input => f.core.plugin.configure({ verify: input }) });
  assert.equal(proven.verified, true, proven.reason);
});

test('real parked lineage remains valid during stopping and closes only after the terminal input seal', async t => {
  const f = await fixture(t); if (!f) return;
  const { job, binding, ready } = await parkedFixture(f);
  const stopped = await verifyTaskJobRetired({ job, workspace: f.workspace, pythonPath,
    knownIdentities: [job.identity], retirementBinding: binding,
    verifyRetirementWorkspace: input => f.core.plugin.configure({ verify: input }) });
  assert.equal(stopped.verified, true, stopped.reason);
  await f.core.plugin.configure({ remember: binding });
  const nextFrames = [], nextCtx = { local: true, profileId: 'managed', connectionId: 'second-owner' };
  const send = frame => nextFrames.push(frame);
  await f.core.terminal.frame(nextCtx, { v: 1, type: 'open', mode: 'tmux', cols: 80, rows: 24 }, send);
  await f.core.terminal.frame(nextCtx, { v: 1, type: 'takeover' }, send);
  assert.equal(nextFrames.filter(frame => frame.type === 'control').at(-1).phase, 'human');
  await assert.rejects(f.core.plugin.configure({ verify: binding }),
    error => ['CONTROL_STALE', 'EXECUTION_BINDING_CHANGED'].includes(error.code));
  await f.core.plugin.configure({ remember: null });
  await f.core.terminal.frame(nextCtx, { v: 1, type: 'select', epoch: 0,
    sessionRef: ready.sessionRef }, send);
  const selected = nextFrames.filter(frame => frame.type === 'ready').at(-1);
  assert.ok(selected?.epoch > 0);
  const marker = join(f.workspace, 'late-close-input');
  f.setCloseProbe(() => f.core.terminal.frame(nextCtx, { v: 1, type: 'input',
    epoch: selected.epoch, seq: 1,
    data: Buffer.from(`printf LATE > '${marker}'\n`).toString('base64') }, send));
  await f.core.close();
  assert.deepEqual(await Promise.all(f.closeChecks), [true]);
  await assert.rejects(access(marker), { code: 'ENOENT' });
  assert.ok(ready.sessionRef);
});
