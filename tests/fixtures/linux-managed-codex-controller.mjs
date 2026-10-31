import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm, writeFile, cp, chmod, symlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from '../../server/core.mjs';
import { createTmuxAdapter } from '../../server/terminal/tmux.mjs';
import { connectManagedPane } from '../../server/terminal/managed-pane.mjs';
import { nativeProcessTable } from '../../server/codex-process-proof.mjs';
import { inspectWorkspaceWriters } from '../../server/terminal/process-inspection.mjs';

const execAsync = promisify(execFile);
const [root, dataDir, workspace] = process.argv.slice(2);
const pythonPath = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const tmuxPath = process.env.TASKBOARD_TEST_TMUX || join(repo, '.tools/terminal-build/install/bin/tmux');
const sourcePlugin = join(repo, 'plugins/codex-autocontinue');
const pluginRoot = join(root, 'plugins');
const serverName = `seqivo_linux_codex_${process.pid}`;
const runTmux = (...args) => execAsync(tmuxPath, ['-L', serverName, ...args], { timeout: 5000 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, reason, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(40); }
  throw new Error(reason);
}
async function procExists(pid) {
  try { await access(`/proc/${pid}`); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function procState(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(')');
  if (end < 0) throw new Error('Malformed Linux process identity');
  return stat.slice(end + 1).trim().split(/\s+/)[0];
}
async function procPpid(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return null;
    const ppid = Number(stat.slice(end + 1).trim().split(/\s+/)[1]);
    return Number.isSafeInteger(ppid) && ppid >= 0 ? ppid : null;
  } catch { return null; }
}
async function openOwner(core, id, frames) {
  const ctx = { local: true, profileId: 'managed', connectionId: id };
  const send = frame => frames.push(frame);
  await core.terminal.frame(ctx, { v: 1, type: 'open', mode: 'tmux', cols: 80, rows: 24 }, send);
  return { ctx, send };
}

await mkdir(root, { recursive: true });
await mkdir(dataDir, { recursive: true });
await mkdir(workspace, { recursive: true });
await symlink(join(repo, 'server'), join(root, 'server'), 'dir');
await cp(sourcePlugin, join(pluginRoot, 'codex-autocontinue'), { recursive: true });
const codexPath = join(workspace, 'fake-codex.py');
await cp(join(repo, 'tests/plugin-fake-codex.py'), codexPath);
await chmod(codexPath, 0o700);
const scenarioPath = join(root, 'fake-scenario.json');
const logPath = join(root, 'fake-appserver.jsonl');
const appPidPath = join(root, 'fake-appserver.pid');
await writeFile(scenarioPath, JSON.stringify({ notifyInterrupted: true }));
process.env.TASKBOARD_FAKE_SCENARIO = scenarioPath;
process.env.TASKBOARD_FAKE_LOG = logPath;
process.env.TASKBOARD_FAKE_PID = appPidPath;
process.env.TASKBOARD_FAKE_CWD = workspace;
process.env.CODEX_CLI_PATH = relative(workspace, codexPath);
let core;
let cleanupUnknown = false;
let primaryError;

try {
  core = await createCore({ dataDir, pluginDir: pluginRoot, files: false, managedPythonPath: pythonPath });
  const project = core.store.project({ name: 'Linux Core and managed pane', directory: workspace });
  await core.request('POST', '/api/terminal/profiles', { id: 'managed', label: 'Linux managed fixture',
    projectId: project.id, enabled: true, shell: '/bin/sh', serverName,
    allowSharedServer: true, tmuxExecutable: tmuxPath });
  const relativePythonPath = relative(workspace, pythonPath);
  const relativeCodexPath = relative(workspace, codexPath);
  await core.request('PATCH', '/api/plugins/codex-autocontinue/config',
    { pythonPath: relativePythonPath, codexPath: relativeCodexPath, pollSeconds: 86400 });
  const pluginStatePath = join(dataDir, 'plugins', 'codex-autocontinue', 'codex-autocontinue.json');
  const configured = JSON.parse(await readFile(pluginStatePath, 'utf8'));
  assert.equal(configured.config.pythonPath, relativePythonPath,
    'relative Python configuration remains persisted relative to the Core workspace');
  assert.equal(configured.config.codexPath, relativeCodexPath,
    'relative Codex configuration remains persisted relative to the Core workspace');
  const quota = await core.request('POST', '/api/plugin/check');
  assert.equal(quota.available, true, quota.lastError);
  await core.request('PATCH', '/api/plugins/codex-autocontinue/config', { codexPath: '' });
  const envQuota = await core.request('POST', '/api/plugin/check');
  assert.equal(envQuota.available, true, envQuota.lastError);
  await core.request('PATCH', '/api/plugins/codex-autocontinue/config', { codexPath: relativeCodexPath });
  const task = core.store.createTask({ projectId: project.id, title: 'Disposable Linux fake Codex turn',
    executionProvider: 'codex-autocontinue' });

  const frames = [], owner = await openOwner(core, 'linux-codex-owner', frames);
  await core.terminal.frame(owner.ctx, { v: 1, type: 'takeover' }, owner.send);
  const initialControl = frames.filter(frame => frame.type === 'control').at(-1);
  const safeReason = String(initialControl?.reason).replaceAll(root, '<fixture>').slice(0, 600);
  if (initialControl?.phase !== 'human') {
    const observed = await inspectWorkspaceWriters({ workspace });
    const writerRows = observed.writers || [];
    const writers = await Promise.all(writerRows.slice(0, 64).map(async writer => {
      const ppid = await procPpid(writer.pid);
      const path = writer.path === root ? '.' : relative(root, writer.path);
      return { pid: writer.pid, command: String(writer.command || '').replace(/[\r\n]/g, '').slice(0, 80),
        reason: writer.reason, path: !path || path === '.' ? '.' : isAbsolute(path) || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
          ? '<outside-fixture>' : path, ppid, isCoreChild: ppid === process.pid };
    }));
    process.stderr.write(JSON.stringify({ writerSnapshot: { verified: observed.verified,
      unknown: observed.unknown, quiescent: observed.quiescent, writerCount: writerRows.length, writers } }) + '\n');
  }
  assert.equal(initialControl?.phase, 'human',
    `initial takeover phase=${initialControl?.phase || 'missing'} reason=${safeReason}`);
  assert.equal(initialControl?.owned, true,
    `initial takeover ownership was not granted; phase=${initialControl?.phase || 'missing'} reason=${safeReason}`);
  try {
    await core.terminal.frame(owner.ctx, { v: 1, type: 'create', epoch: 0, name: 'human-before-codex' }, owner.send);
  } catch (error) {
    const observed = await inspectWorkspaceWriters({ workspace });
    process.stderr.write(JSON.stringify({ createWriterSnapshot: { verified: observed.verified,
      unknown: observed.unknown, reason: observed.reason, writers: (observed.writers || []).map(writer =>
        ({ pid: writer.pid, command: writer.command, reason: writer.reason, path: relative(root, writer.path) })) } }) + '\n');
    throw error;
  }
  const originalReady = frames.filter(frame => frame.type === 'ready').at(-1);
  assert.ok(originalReady?.sessionRef, 'managed shell session should start');
  const index = JSON.parse(core.store.db.prepare('SELECT value FROM metadata WHERE key=?')
    .get('terminal.managed-panes.v1').value);
  const record = JSON.parse(await readFile(join(dataDir, 'terminal-managed-records',
    index.entries[0].directory, 'record.json'), 'utf8'));
  const shellPid = record.identities.shell.pid;
  const beforeEdit = join(workspace, 'human-before.txt');
  await core.terminal.frame(owner.ctx, { v: 1, type: 'input', epoch: originalReady.epoch, seq: 1,
    data: Buffer.from(`printf BEFORE > '${beforeEdit}'\n`).toString('base64') }, owner.send);
  await until(async () => (await readFile(beforeEdit, 'utf8').catch(() => '')) === 'BEFORE',
    'human shell edit was not observed');

  await core.terminal.frame(owner.ctx, { v: 1, type: 'return', notes: 'Human edit complete' }, owner.send);
  const review = frames.filter(frame => frame.type === 'control').at(-1);
  assert.equal(review.phase, 'return_review', review.reason);
  assert.equal(core.leases.available({ taskId: task.id }), false);
  await core.terminal.frame(owner.ctx, { v: 1, type: 'return-confirm', reviewId: review.returnReview.reviewId,
    expectedGeneration: review.generation }, owner.send);
  assert.equal(frames.filter(frame => frame.type === 'control').at(-1).phase, 'ai_ready');
  assert.equal(core.leases.available({ taskId: task.id }), true);

  const session = await core.request('POST', `/api/tasks/${task.id}/session`, { expectedRevision: task.revision,
    commandId: 'linux-managed-codex-session', workspaceWrite: true });
  assert.equal(session.status, 'created', session.error);
  const boundTask = core.store.getTask(task.id);
  assert.ok(boundTask.conversationId);
  const turn = await core.request('POST', `/api/tasks/${task.id}/continue`, { expectedRevision: boundTask.revision,
    commandId: 'linux-managed-codex-turn' });
  assert.equal(turn.status, 'running', turn.error);
  await until(async () => (await readFile(logPath, 'utf8').catch(() => '')).includes('"method": "turn/start"'),
    'fake Codex turn did not start');
  const requests = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const threadStart = requests.find(row => row.method === 'thread/start');
  assert.equal(threadStart?.params?.cwd, workspace,
    'Codex thread startup receives the fixture workspace; this controller/Core process runs with that cwd');
  const persisted = JSON.parse(await readFile(pluginStatePath, 'utf8'));
  const bridgePid = persisted.executors?.[`task:${task.id}`]?.pid;
  assert.ok(Number.isSafeInteger(bridgePid) && bridgePid > 1, 'task-specific bridge PID is persisted');
  const nativeRows = await nativeProcessTable(pythonPath, 15000, { allVisible: true });
  const directChildren = [...nativeRows.values()].filter(row => row.ppid === bridgePid);
  assert.equal(directChildren.length, 1, 'the task bridge has exactly one observed app-server child');
  const appServerPid = directChildren[0].pid;
  assert.notEqual(appServerPid, bridgePid);
  assert.equal(await procExists(appServerPid), true, 'fake app-server must be live before quiesce');
  assert.match(await procState(shellPid), /^[Tt]$/, 'the exact original managed shell remains parked during Codex execution');

  const recovered = [], nextOwner = await openOwner(core, 'linux-codex-reacquire', recovered);
  await core.terminal.frame(nextOwner.ctx, { v: 1, type: 'takeover' }, nextOwner.send);
  const human = recovered.filter(frame => frame.type === 'control').at(-1);
  assert.equal(human.phase, 'human', human.reason);
  const stoppedState = JSON.parse(await readFile(pluginStatePath, 'utf8'));
  assert.equal(stoppedState.executors?.[`task:${task.id}`], undefined,
    'a final interrupted turn retires its original Linux job without an unknown marker');
  const stoppedCommand = stoppedState.commands[`${task.id}:linux-managed-codex-turn`];
  assert.equal(stoppedCommand.status, 'interrupted');
  assert.equal(stoppedCommand.stopProof?.status, 'verified');
  assert.equal(stoppedCommand.stopProof?.scope, 'linux-original-task-job-and-managed-handoff');
  await until(async () => !(await procExists(bridgePid)), 'task bridge exit was not confirmed');
  await until(async () => !(await procExists(appServerPid)), 'Codex app-server exit was not confirmed');
  assert.match(await procState(shellPid), /^[Tt]$/, 'the original shell stays parked until explicitly selected');
  await core.terminal.frame(nextOwner.ctx, { v: 1, type: 'select', epoch: 0, sessionRef: originalReady.sessionRef }, nextOwner.send);
  assert.doesNotMatch(await procState(shellPid), /^[Tt]$/, 'select resumes the original shell after Codex exits');
  const ready = recovered.filter(frame => frame.type === 'ready').at(-1);
  assert.deepEqual(ready.sessionRef, originalReady.sessionRef);
  const afterEdit = join(workspace, 'human-after.txt');
  await core.terminal.frame(nextOwner.ctx, { v: 1, type: 'input', epoch: ready.epoch, seq: 1,
    data: Buffer.from(`printf AFTER > '${afterEdit}'\n`).toString('base64') }, nextOwner.send);
  await until(async () => (await readFile(afterEdit, 'utf8').catch(() => '')) === 'AFTER',
    'the same managed shell did not accept human input after Codex quiesce');
  const afterRecord = JSON.parse(await readFile(join(dataDir, 'terminal-managed-records',
    index.entries[0].directory, 'record.json'), 'utf8'));
  assert.deepEqual({ kind: afterRecord.identities.shell.kind, pid: afterRecord.identities.shell.pid,
    bootId: afterRecord.identities.shell.bootId, startTicks: afterRecord.identities.shell.startTicks },
  { kind: record.identities.shell.kind, pid: record.identities.shell.pid,
    bootId: record.identities.shell.bootId, startTicks: record.identities.shell.startTicks },
  'human takeover resumes the exact original Linux shell birth identity');
  process.stdout.write(JSON.stringify({ phase: human.phase, taskId: task.id,
    sessionRef: ready.sessionRef, bridgePid, appServerPid, shellPid }) + '\n');
} catch (error) {
  primaryError = error;
  process.stderr.write(`Core fixture assertion: ${error.stack}\n`);
} finally {
  try { await core?.close(); } catch (error) {
    cleanupUnknown = true;
    process.stderr.write(`Core fixture cleanup unconfirmed: ${String(error.message).replaceAll(root, '<fixture>').slice(0, 600)}\n`);
    const state = JSON.parse(await readFile(join(dataDir, 'plugins', 'codex-autocontinue', 'codex-autocontinue.json'), 'utf8'));
    process.stderr.write(JSON.stringify({ recoveryDiagnostic: { commands: state.commands,
      taskMarkers: Object.fromEntries(Object.entries(state.executors || {}).filter(([key]) => key.startsWith('task:'))) } })+'\n');
  }
  const recordsRoot = join(dataDir, 'terminal-managed-records');
  for (const entry of await readdir(recordsRoot).catch(() => [])) {
    let pane;
    try {
      const record = JSON.parse(await readFile(join(recordsRoot, entry, 'record.json'), 'utf8'));
      pane = await connectManagedPane({ socketPath: record.pane.socketPath, capability: record.pane.capability });
      let state = await pane.status();
      if (state.state !== 'exited') {
        if (state.state === 'stopped' || state.inputFrozen) await pane.resume();
        await runTmux('send-keys', '-t', record.tmux.relayPaneId, 'exit', 'Enter');
        await until(async () => (await pane.status()).state === 'exited', 'managed pane exit was not confirmed', 4000);
      }
      await pane.shutdown();
      await rm(record.pane.directory, { recursive: true, force: true });
    } catch (error) {
      cleanupUnknown = true;
      process.stderr.write(`Managed fixture cleanup unconfirmed (${error.code || 'unknown'}); retained ${root}\n`);
    } finally { pane?.close(); }
  }
  try {
    const adapter = createTmuxAdapter({ executable: tmuxPath, serverName });
    await until(async () => (await adapter.list()).sessions.length === 0,
      'fixture tmux session did not exit after its relay', 5000);
  } catch (error) {
    cleanupUnknown = true;
    process.stderr.write(`Tmux fixture cleanup unconfirmed (${error.code || 'unknown'})\n`);
  }
}
if (primaryError) throw primaryError;
if (cleanupUnknown) throw new Error('Linux managed Codex fixture cleanup was not confirmed; retain fixture for inspection');
