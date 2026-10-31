// Explicit opt-in, disposable real Codex acceptance. Never run as a routine test.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createCore } from '../server/core.mjs';
import { startHttp } from '../server/http.mjs';
import { connectManagedPane } from '../server/terminal/managed-pane.mjs';
import { verifyManagedTmuxSession } from '../server/terminal/managed-pane-record.mjs';
import { createTmuxAdapter } from '../server/terminal/tmux.mjs';
import { nativeProcessTable } from '../server/codex-process-proof.mjs';

if (process.env.SEQIVO_REAL_MANAGED_HANDOFF100 !== '1')
  throw new Error('Set SEQIVO_REAL_MANAGED_HANDOFF100=1 only after isolated real pause acceptance');
if (process.platform !== 'darwin') throw new Error('Exact managed-pane proof requires macOS');
const codexPath = process.env.SEQIVO_TEST_CODEX;
const pythonPath = process.env.SEQIVO_TEST_PYTHON;
const tmuxPath = process.env.SEQIVO_TEST_TMUX;
const pauseResultPath = process.env.SEQIVO_REAL_PAUSE_RESULT;
if (![codexPath, pythonPath, tmuxPath].every(value => typeof value === 'string' && value.startsWith('/')))
  throw new Error('Provide absolute Codex, Python and tmux executable paths; never credentials');
if (typeof pauseResultPath !== 'string' || !isAbsolute(pauseResultPath))
  throw new Error('Provide the absolute result.json path from a passing isolated real pause run');
for (const executable of [codexPath, pythonPath, tmuxPath]) {
  try { await access(executable, constants.X_OK); }
  catch { throw new Error('A required executable is unavailable'); }
}

const execAsync = promisify(execFile);
const repoRoot=fileURLToPath(new URL('../',import.meta.url));
const qaBase = resolve(process.env.QA_DIR || join(repoRoot,'.runtime/qa-real-managed-handoff'));
await mkdir(qaBase, { recursive: true, mode: 0o700 });
const qaInfo = await lstat(qaBase);
if (!qaInfo.isDirectory() || qaInfo.isSymbolicLink() || qaInfo.uid !== process.geteuid() ||
  (qaInfo.mode & 0o077) !== 0 || await realpath(qaBase) !== qaBase)
  throw new Error('Private QA directory ownership or permissions are unconfirmed');
const qa = await mkdtemp(join(qaBase, 'run-'));
await chmod(qa, 0o700);
const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-real-managed-handoff-')));
const dataDir = join(root, 'data'), workspace = join(root, 'project');
await mkdir(workspace, { mode: 0o700 });
const serverName = `seqivo_handoff_${randomBytes(8).toString('hex')}`;
const sessionName = `handoff_${randomBytes(6).toString('hex')}`;
const recordRoot = join(dataDir, 'terminal-managed-records');
const marker = `human-${randomBytes(6).toString('hex')}`;
const file = join(workspace, 'state.txt');
const evidence = { schemaVersion: 1, startedAt: new Date().toISOString(), passed: false,
  realProvider: true, managedTmux: true, physicalPhone: false, stages: [],
  scope: 'isolated real Codex conversation and one exact managed tmux pane' };
let core, http, ws, taskId, conversationId, commandId, record, recordPath, originalProof;
let firstReady, secondReady, functionalPassed = false, retired = false, pane;
let phase = 'startup';
let lastControl = null, lastTerminalError = null;
const shutdown = [], shutdownState = { http: 'not-attempted', core: 'not-attempted' };
const privateWrite = (name, value) => writeFile(join(qa, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const safeCode = error => typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'UNCLASSIFIED';
const safeMessage = value => String(value ?? '')
  .replaceAll(root, '[fixture]').replaceAll(qa, '[qa]')
  .replace(/https?:\/\/[^\s'"<>]+/gi, '[url]')
  .replace(/(?:\/Users\/|\/private\/|\/tmp\/|\/var\/)[^\s'"<>]+/g, '[path]')
  .replace(/\b[a-fA-F0-9]{32,}\b/g, '[opaque]')
  .replace(/\b[A-Za-z0-9_-]{43,}\b/g, '[opaque]')
  .replace(/[\x00-\x1f\x7f]/g, ' ')
  .slice(0, 300);
const pause = ms => new Promise(done => setTimeout(done, ms));
async function closeOnce(name, close) {
  if (shutdownState[name] !== 'not-attempted') throw new Error(`${name} close was already attempted`);
  shutdownState[name] = 'attempted';
  try { await close(); shutdownState[name] = 'closed'; }
  catch (error) {
    shutdownState[name] = 'failed';
    shutdown.push({ name, code: safeCode(error), message: safeMessage(error?.message) });
    throw error;
  }
}
async function stage(name, details = {}) {
  phase = name;
  evidence.stages.push({ name, at: new Date().toISOString(), ...details });
  await privateWrite('progress.json', { phase, stages: evidence.stages });
  console.log(JSON.stringify({ phase, ...details }));
}
async function until(predicate, label, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await predicate()) return; await pause(100); }
  throw Object.assign(new Error(label), { code: 'QA_TIMEOUT' });
}
function sameRef(a, b) {
  return a?.serverName === b?.serverName && a?.instanceId === b?.instanceId && a?.sessionId === b?.sessionId;
}
async function onlyFileLines(expected) {
  const text = await readFile(file, 'utf8');
  assert.equal(text, `${expected.join('\n')}\n`);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual((await readdir(workspace)).sort(), ['state.txt']);
}
async function waitSubmitted(expectedCommandId, label) {
  await until(async () => {
    const task = core.store.getTask(taskId);
    if (['blocked', 'failed', 'cancelled'].includes(task.status))
      throw Object.assign(new Error(label), { code: 'TASK_NOT_SUBMITTED' });
    return task.status === 'submitted';
  }, label, 240_000);
  await until(() => core.leases.state().active.length === 0, 'EXECUTION_LEASE_ACTIVE', 30_000);
  const execution = await core.plugin.getExecution({ taskId, commandId: expectedCommandId });
  if (execution?.status !== 'completed')
    throw Object.assign(new Error(label), { code: 'EXECUTION_UNCONFIRMED' });
  return execution;
}
const frames = [];
function send(frame) {
  if (ws?.readyState !== WebSocket.OPEN) throw new Error('Terminal socket is not open');
  ws.send(JSON.stringify({ v: 1, ...frame }));
}
async function nextFrame(predicate, label, timeoutMs = 15_000) {
  await until(() => frames.some(predicate) || frames.some(item => item.type === 'error' && item.code !== 'CONTROL_REQUIRED'),
    label, timeoutMs);
  const index = frames.findIndex(predicate);
  const errorIndex = frames.findIndex(item => item.type === 'error' && item.code !== 'CONTROL_REQUIRED');
  if (errorIndex >= 0 && (index < 0 || errorIndex < index))
    throw Object.assign(new Error(label), { code: frames[errorIndex].code || 'TERMINAL_ERROR' });
  return frames.splice(0, index + 1).at(-1);
}
const sameBirth = (a,b) => Boolean(a&&b&&a.pid===b.pid&&a.pgid===b.pgid&&
  a.euid===b.euid&&a.ruid===b.ruid&&a.startSec===b.startSec&&a.startUsec===b.startUsec);
async function originalRecord() {
  const row = core.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.managed-panes.v1');
  const index = row && JSON.parse(row.value);
  if (index?.entries?.length !== 1 || index.entries[0].status !== 'started' ||
    !/^seqivo-pane-record-[A-Za-z0-9]+$/.test(index.entries[0].directory))
    throw Object.assign(new Error('One original managed record required'), { code: 'RECORD_UNKNOWN' });
  recordPath = join(recordRoot, index.entries[0].directory, 'record.json');
  const loaded = JSON.parse(await readFile(recordPath, 'utf8'));
  if (!sameRef(loaded.tmux?.sessionRef, firstReady?.sessionRef) ||
    loaded.config?.serverName !== serverName || loaded.config?.name !== sessionName ||
    loaded.config?.cwd !== workspace || basename(loaded.pane?.directory || '') === '' ||
    loaded.status !== 'started')
    throw Object.assign(new Error('Original managed record does not match the isolated pane'), { code: 'RECORD_UNKNOWN' });
  return loaded;
}
async function verifyOriginal() {
  const proof = await verifyManagedTmuxSession({ recordRoot, recordPath });
  if (!sameRef(proof.sessionRef, firstReady.sessionRef) || proof.recordId !== record.id ||
    proof.identities.shell.pid !== originalProof.identities.shell.pid ||
    proof.identities.shell.startSec !== originalProof.identities.shell.startSec ||
    proof.identities.shell.startUsec !== originalProof.identities.shell.startUsec)
    throw Object.assign(new Error('Original managed identity changed'), { code: 'IDENTITY_CHANGED' });
  return proof;
}
async function shellStopped() {
  await verifyOriginal();
  // The supervisor accepts only one controller. Core's managed registry owns
  // that connection; this runs its authenticated status and writer checks.
  await core.terminal.verifyManagedForExecution(core.store.getTask(taskId).projectId);
  const observed = await execAsync('/bin/ps', ['-p', String(originalProof.identities.shell.pid), '-o', 'stat='],
    { timeout: 5000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  await verifyOriginal();
  if (!/^[Tt]/.test(observed.stdout.trim()))
    throw Object.assign(new Error('Managed shell park is not confirmed'), { code: 'PARK_UNCONFIRMED' });
}

const sourcePaths = [
  'scripts/verify-real-managed-handoff.mjs', 'server/core.mjs', 'server/terminal/control.mjs',
  'server/execution-leases.mjs', 'server/plugin-loader.mjs',
  'server/plugin-process.mjs', 'server/plugin-worker.mjs',
  'server/terminal/manager.mjs', 'server/terminal/managed-pane-registry.mjs',
  'server/terminal/managed-pane-record.mjs', 'server/terminal/managed-pane.mjs',
  'server/terminal/managed-pane-supervisor.py', 'server/terminal/managed-pane-relay.py',
  'server/codex-process-proof.mjs', 'server/executor-process-proof.mjs',
  'server/macos-executor-job.mjs', 'server/macos-executor-job-record.mjs',
  'plugins/codex-autocontinue/executor_job.py', 'plugins/codex-autocontinue/process_snapshot.py',
  'plugins/codex-autocontinue/host.mjs', 'plugins/codex-autocontinue/auto-policy.mjs',
  'plugins/codex-autocontinue/bridge.py',
  'plugins/codex-autocontinue/job-transport.mjs',
];
try {
  evidence.sourceHashes = {};
  for (const source of sourcePaths)
    evidence.sourceHashes[source] = createHash('sha256').update(await readFile(join(repoRoot,source))).digest('hex');
  const pauseResult=JSON.parse(await readFile(pauseResultPath,'utf8'));
  if(pauseResult.passed!==true||pauseResult.cleanShutdown!==true||
    pauseResult.actualProcessExited!==true||pauseResult.delayedWriteExists!==false||
    pauseResult.otherProjectProcessAlive!==true||!pauseResult.sourceHashes||
    typeof pauseResult.sourceHashes!=='object'||
    !['server/core.mjs','plugins/codex-autocontinue/host.mjs','plugins/codex-autocontinue/auto-policy.mjs','scripts/verify-real-pause.mjs']
      .every(source=>Object.hasOwn(pauseResult.sourceHashes,source)))
    throw Object.assign(new Error('Real pause prerequisite is absent or from different source'),{code:'PAUSE_PREREQUISITE_UNCONFIRMED'});
  for(const [source,digest] of Object.entries(pauseResult.sourceHashes)){
    if(!/^[A-Za-z0-9_.\/-]+$/.test(source)||isAbsolute(source)||source.includes('..')||
      typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)||
      createHash('sha256').update(await readFile(join(repoRoot,source))).digest('hex')!==digest)
      throw Object.assign(new Error('Real pause source changed since acceptance'),{code:'PAUSE_PREREQUISITE_STALE'});
  }
  await stage('pause-prerequisite-confirmed',{immediatePauseConfirmed:pauseResult.immediatePauseConfirmed===true,
    originalRecordRechecked:pauseResult.recheckExercised===true});
  await stage('core-starting');
  core = await createCore({ dataDir, pluginDir: join(repoRoot,'plugins'), files: false,
    managedPythonPath: pythonPath });
  // Paths are configured only in this disposable Core. Model, provider endpoint,
  // login and account settings remain the user's existing runtime choices.
  await core.plugin.configure({ codexPath, pythonPath });
  http = await startHttp({ core, dataDir, distDir: join(repoRoot,'dist'), port: 0 });
  const project = core.store.project({ name: 'Disposable real managed handoff', directory: workspace });
  commandId = randomUUID();
  await stage('first-turn-starting');
  const first = await core.request('POST', '/api/conversations', { projectId: project.id,
    title: 'Disposable before human after handoff', commandId,
    message: 'Isolated acceptance only. In this project create only state.txt containing exactly one line before. Do not change other files, use network, change configuration or delegate agents. Reply HANDOFF_FIRST_OK.' });
  taskId = first.taskId;
  evidence.firstStart = { status: typeof first.status === 'string' && /^[a-z_]{1,32}$/.test(first.status)
    ? first.status : 'unknown' };
  if (!taskId || !['running', 'completed', 'submitted'].includes(first.status))
    throw Object.assign(new Error('First real command did not start'),
      { code: first.status === 'waiting_quota' ? 'QUOTA_WAIT' : 'FIRST_TURN_UNCONFIRMED' });
  const firstExecution = await waitSubmitted(`${commandId}:turn`, 'FIRST_TURN_UNCONFIRMED');
  await onlyFileLines(['before']);
  conversationId = core.store.getTask(taskId).conversationId;
  assert.ok(conversationId, 'First real conversation was not bound');
  await stage('first-turn-complete', { taskStatus: 'submitted', conversationBound: true,
    modelMetadataObserved: Boolean(firstExecution.actualModel) });

  await core.request('POST', '/api/terminal/profiles', { id: 'managed', label: 'Disposable managed tmux',
    projectId: project.id, enabled: true, shell: '/bin/sh', tmuxExecutable: tmuxPath,
    serverName, allowSharedServer: true });
  const ticket = await core.request('POST', '/api/terminal/tickets', { profileId: 'managed' });
  ws = new WebSocket(ticket.wsUrl, { headers: { Origin: `http://127.0.0.1:${http.port}` } });
  ws.on('message', bytes => {
    try { const value = JSON.parse(bytes.toString());
      if (['authenticated', 'control', 'ready', 'error', 'exit'].includes(value?.type)) {
        if (value.type === 'control') lastControl = {
          phase: typeof value.phase === 'string' && /^[a-z_]{1,32}$/.test(value.phase) ? value.phase : 'unknown',
          reason: safeMessage(value.reason),
        };
        if (value.type === 'error') lastTerminalError = {
          code: safeCode(value), message: safeMessage(value.message),
        };
        frames.push(value); if (frames.length > 256) frames.shift();
      }
    } catch { /* nextFrame times out without accepting a malformed frame. */ }
  });
  await new Promise((done, fail) => { ws.once('open', done); ws.once('error', fail); });
  send({ type: 'auth', ticket: ticket.ticket });
  await nextFrame(x => x.type === 'authenticated', 'TERMINAL_AUTH_UNCONFIRMED');
  send({ type: 'open', mode: 'tmux', cols: 80, rows: 24 });
  await nextFrame(x => x.type === 'control', 'TERMINAL_OPEN_UNCONFIRMED');
  await nextFrame(x => x.type === 'error' && x.code === 'NEEDS_SELECTION', 'TERMINAL_SELECTION_REQUIRED');
  send({ type: 'takeover' });
  const taken = await nextFrame(x => x.type === 'control' && ['human', 'unknown'].includes(x.phase),
    'TAKEOVER_UNCONFIRMED');
  if (taken.phase !== 'human' || taken.owned !== true)
    throw Object.assign(new Error('Real executor retirement did not permit takeover'), { code: 'TAKEOVER_UNCONFIRMED' });
  send({ type: 'create', epoch: 0, name: sessionName });
  firstReady = await nextFrame(x => x.type === 'ready' && x.sessionRef, 'MANAGED_CREATE_UNCONFIRMED');
  record = await originalRecord();
  originalProof = await verifyManagedTmuxSession({ recordRoot, recordPath });
  if (!sameRef(originalProof.sessionRef, firstReady.sessionRef))
    throw Object.assign(new Error('Created managed identity is unconfirmed'), { code: 'IDENTITY_UNKNOWN' });
  await stage('managed-pane-created', { originalIdentityVerified: true });

  send({ type: 'input', epoch: firstReady.epoch, seq: 1,
    data: Buffer.from(`printf '%s\\n' '${marker}' >> state.txt\r`).toString('base64') });
  await until(async () => {
    try { await onlyFileLines(['before', marker]); return true; } catch { return false; }
  }, 'HUMAN_EDIT_UNCONFIRMED', 10_000);
  await stage('human-edit-confirmed', { exactTwoLines: true });
  send({ type: 'return', notes: 'Human edited state.txt. Reread and preserve both lines before continuing.' });
  const returned = await nextFrame(x => x.type === 'control' && ['ai_ready', 'unknown'].includes(x.phase),
    'MANAGED_RETURN_UNCONFIRMED', 45_000);
  if (returned.phase !== 'ai_ready' || !returned.changes?.some(item => item.path === 'state.txt'))
    throw Object.assign(new Error('Managed handback remained unknown'), { code: 'MANAGED_RETURN_UNCONFIRMED' });
  await shellStopped();
  assert.match(core.store.context(project.id), /Human terminal handoff/);
  assert.equal(core.leases.available({ taskId }), true);
  await stage('managed-return-confirmed', { shellStopped: true, relayFrozen: true });

  const beforeSecond = core.store.getTask(taskId);
  const secondCommandId = randomUUID();
  // Preserve the original adapter failure before the conversation API turns it
  // into a safe unknown receipt. Observe only this disposable command; rethrow
  // unchanged and never retry or change its result.
  const resume = core.plugin.resume.bind(core.plugin);
  core.plugin.resume = async input => {
    try { return await resume(input); }
    catch (error) {
      if (input.taskId === taskId && input.commandId === secondCommandId)
        evidence.secondAdapterError = { code: safeCode(error), message: safeMessage(error?.message) };
      throw error;
    }
  };
  await stage('second-turn-starting');
  const second = await core.request('POST', `/api/tasks/${taskId}/message`, {
    expectedRevision: beforeSecond.revision, commandId: secondCommandId,
    message: 'Continue this same isolated conversation. Reread state.txt, preserve its before and human lines, and append exactly one final line after. Do not edit another file, use network, change configuration or delegate agents. Reply HANDOFF_SECOND_OK.' });
  evidence.secondStart = { status: typeof second.status === 'string' && /^[a-z_]{1,32}$/.test(second.status)
    ? second.status : 'unknown' };
  if (!['running', 'completed', 'submitted'].includes(second.status))
    throw Object.assign(new Error('Second real command did not start'),
      { code: second.status === 'waiting_quota' ? 'QUOTA_WAIT' : 'SECOND_TURN_UNCONFIRMED' });
  const secondExecution = await waitSubmitted(secondCommandId, 'SECOND_TURN_UNCONFIRMED');
  await onlyFileLines(['before', marker, 'after']);
  assert.equal(core.store.getTask(taskId).conversationId, conversationId);
  assert.notEqual(core.store.getTask(taskId).acceptance, 'passed');
  await shellStopped();
  await stage('second-turn-complete', { sameConversation: true, exactThreeLines: true,
    originalShellStillStopped: true, acceptanceUnverified: true,
    modelMetadataObserved: Boolean(secondExecution.actualModel) });

  // Cleanup is part of the acceptance: reclaim only the recorded original.
  send({ type: 'takeover' });
  const retaken = await nextFrame(x => x.type === 'control' && ['human', 'unknown'].includes(x.phase),
    'CLEANUP_TAKEOVER_UNCONFIRMED');
  if (retaken.phase !== 'human' || retaken.owned !== true)
    throw Object.assign(new Error('Original shell could not be safely reclaimed'), { code: 'CLEANUP_TAKEOVER_UNCONFIRMED' });
  await verifyOriginal();
  // This is the same authenticated WS: return/takeover do not advance c.epoch;
  // the next attach advances it and supplies secondReady.epoch for new input.
  send({ type: 'select', epoch: firstReady.epoch, sessionRef: firstReady.sessionRef });
  secondReady = await nextFrame(x => x.type === 'ready' && sameRef(x.sessionRef, firstReady.sessionRef),
    'CLEANUP_SELECT_UNCONFIRMED');
  await verifyOriginal();
  send({ type: 'input', epoch: secondReady.epoch, seq: 1,
    data: Buffer.from('exit\r').toString('base64') });
  await nextFrame(x => x.type === 'exit' && x.epoch === secondReady.epoch && x.reason === 'process_exited',
    'ORIGINAL_SHELL_EXIT_UNCONFIRMED', 15_000);
  // Release Core's original supervisor controller before a separate status
  // connection. A failed close remains a failure; never retry it in finally.
  ws.terminate();
  await closeOnce('http', () => http.close());
  await closeOnce('core', () => core.close());
  await stage('core-closed-before-supervisor-cleanup', { cleanShutdown: true });
  pane = await connectManagedPane({ socketPath: record.pane.socketPath, capability: record.pane.capability,
    expectedIdentity: { supervisorPid: originalProof.identities.supervisor.pid,
      childPid: originalProof.identities.shell.pid } });
  const status = await pane.status();
  if (status.state !== 'exited' || status.childPid !== originalProof.identities.shell.pid)
    throw Object.assign(new Error('Original child exit not confirmed by supervisor'), { code: 'CHILD_EXIT_UNCONFIRMED' });
  await pane.shutdown(); pane.close(); pane = null;
  const adapter = createTmuxAdapter({ executable: tmuxPath, serverName });
  await until(async () => {
    const listing = await adapter.list();
    if (listing.sessions.some(item => !sameRef(item.sessionRef, firstReady.sessionRef)))
      throw Object.assign(new Error('Unexpected session in disposable tmux server'), { code: 'TMUX_IDENTITY_CHANGED' });
    return listing.sessions.length === 0;
  }, 'ORIGINAL_TMUX_SESSION_NOT_RETIRED', 10_000);
  await until(async()=>{
    const rows=await nativeProcessTable(pythonPath,15000);
    return ![originalProof.identities.supervisor,originalProof.identities.shell,originalProof.identities.relay]
      .some(identity=>sameBirth(rows.get(identity.pid),identity));
  }, 'ORIGINAL_MANAGED_PROCESSES_NOT_RETIRED', 10_000);
  const socketInfo=await lstat(record.pane.directory);
  if(!socketInfo.isDirectory()||socketInfo.isSymbolicLink()||socketInfo.uid!==process.geteuid()||
    (socketInfo.mode&0o777)!==0o700||await realpath(record.pane.directory)!==record.pane.directory||
    !/^seqivo-managed-pane-[A-Za-z0-9]+$/.test(basename(record.pane.directory)))
    throw Object.assign(new Error('Private socket directory identity changed'),{code:'SOCKET_DIRECTORY_CHANGED'});
  await rm(record.pane.directory,{recursive:true,force:true});
  retired = true;
  functionalPassed = true;
  await stage('isolated-pane-retired', { originalChildExited: true, originalTmuxSessionGone: true });
} catch (error) {
  process.exitCode = 1;
  evidence.failure = { phase, code: safeCode(error), message: safeMessage(error?.message),
    control: lastControl, terminalError: lastTerminalError };
  console.log(JSON.stringify({ phase, failed: true, code: evidence.failure.code }));
} finally {
  pane?.close();
  ws?.terminate();
  for (const [name, close] of [['http', () => http?.close()], ['core', () => core?.close()]]) {
    if (shutdownState[name] !== 'not-attempted') continue;
    try { await closeOnce(name, close); } catch { process.exitCode = 1; }
  }
  evidence.cleanShutdown = shutdownState.http === 'closed' && shutdownState.core === 'closed';
  if (shutdown.length) evidence.shutdownFailures = shutdown;
  evidence.functionalChecksPassed = functionalPassed;
  evidence.originalPaneRetired = retired;
  evidence.passed = functionalPassed && retired && evidence.cleanShutdown;
  evidence.finishedAt = new Date().toISOString();
  if (evidence.passed) await rm(root, { recursive: true, force: true });
  else await writeFile(join(qa, 'fixture-location.txt'), root + '\n', { mode: 0o600 });
  await privateWrite('result.json', evidence);
  console.log(JSON.stringify({ passed: evidence.passed, phase,
    originalPaneRetired: retired, cleanShutdown: evidence.cleanShutdown,
    failureCode: evidence.failure?.code || null }));
}
