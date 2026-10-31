import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createCore } from '../../server/core.mjs';
import { connectManagedPane } from '../../server/terminal/managed-pane.mjs';
import { nativeSelectedIdentities } from '../../server/terminal/process-identities.mjs';
import { nativeProcessTable } from '../../server/codex-process-proof.mjs';

const exec = promisify(execFile);
const [mode, root, dataDir, workspace, serverName, readyJson, scenario = 'turn-with-id'] = process.argv.slice(2);
const pythonPath = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const tmuxPath = process.env.TASKBOARD_TEST_TMUX || join(repo, '.tools/terminal-build/install/bin/tmux');
const sourcePlugin = join(repo, 'plugins/codex-autocontinue');
const pluginRoot = join(root, 'plugins');
const scenarioPath = join(root, 'fake-scenario.json');
const logPath = join(root, 'fake-appserver.jsonl');
const appPidPath = join(root, 'fake-appserver.pid');
const runTmux = (...args) => exec(tmuxPath, ['-L', serverName, ...args], { timeout: 5000 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, reason, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(50); }
  throw new Error(reason);
}
async function jsonFile(path) { return JSON.parse(await readFile(path, 'utf8')); }
function meta(core, key) {
  const row = core.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : null;
}
async function hostState() { return jsonFile(join(dataDir, 'plugins', 'codex-autocontinue', 'codex-autocontinue.json')); }
async function openOwner(core, connectionId, frames) {
  const ctx = { local: true, profileId: 'managed', connectionId };
  const send = frame => frames.push(frame);
  await core.terminal.frame(ctx, { v: 1, type: 'open', mode: 'tmux', cols: 80, rows: 24 }, send);
  return { ctx, send };
}
async function writeInShell(core, owner, epoch, seq, path, value) {
  await core.terminal.frame(owner.ctx, { v: 1, type: 'input', epoch, seq,
    data: Buffer.from(`printf '${value}' > '${path}'\n`).toString('base64') }, owner.send);
  await until(async () => (await readFile(path, 'utf8').catch(() => '')) === value,
    `original managed shell did not write ${value}`);
}
function logRequests() {
  return readFile(logPath, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
    .then(raw => raw.trim() ? raw.trim().split('\n').map(line => JSON.parse(line)) : []);
}
async function cleanupPaneRecord(record, expectedSessionRef) {
  if (expectedSessionRef) assert.deepEqual(record.tmux.sessionRef, expectedSessionRef,
    'cleanup refers only to the original test-owned pane');
  const pane = await connectManagedPane({ socketPath: record.pane.socketPath, capability: record.pane.capability });
  try {
    let state = await pane.status();
    if (state.state !== 'exited') {
      if (state.state === 'stopped' || state.inputFrozen) await pane.resume();
      await runTmux('send-keys', '-t', record.tmux.relayPaneId, 'exit', 'Enter');
      state = await until(async () => {
        const current = await pane.status(); return current.state === 'exited' ? current : null;
      }, 'test-owned original shell did not exit during cleanup', 8000);
    }
    assert.equal(state.state, 'exited');
    await pane.shutdown();
  } finally { pane.close(); }
  await rm(record.pane.directory, { recursive: true, force: true });
  await until(async () => {
    try { return !(await runTmux('list-sessions')).stdout.trim(); }
    catch (error) { if (error.code === 1) return true; throw error; }
  }, 'fixture tmux server has no remaining sessions after relay exit', 5000);
  try { await runTmux('kill-server'); } catch (error) { if (error.code !== 1) throw error; }
}

await mkdir(root, { recursive: true });
await mkdir(dataDir, { recursive: true });
await mkdir(workspace, { recursive: true });
if (mode === 'start') {
  await symlink(join(repo, 'server'), join(root, 'server'), 'dir');
  await cp(sourcePlugin, join(pluginRoot, 'codex-autocontinue'), { recursive: true });
  const codexPath = join(workspace, 'fake-codex.py');
  await cp(join(repo, 'tests/plugin-fake-codex.py'), codexPath);
  await chmod(codexPath, 0o700);
  await writeFile(scenarioPath, JSON.stringify(scenario === 'turn-no-id'
    ? { sendHang: true } : scenario === 'turn-interrupted'
      ? { completeStatus: 'interrupted' } : { interruptError: true }));
  process.env.TASKBOARD_FAKE_SCENARIO = scenarioPath;
  process.env.TASKBOARD_FAKE_LOG = logPath;
  process.env.TASKBOARD_FAKE_PID = appPidPath;
  process.env.TASKBOARD_FAKE_CWD = workspace;
  process.env.CODEX_CLI_PATH = relative(workspace, codexPath);
}
process.env.TASKBOARD_FAKE_SCENARIO = scenarioPath;
process.env.TASKBOARD_FAKE_LOG = logPath;
process.env.TASKBOARD_FAKE_PID = appPidPath;
process.env.TASKBOARD_FAKE_CWD = workspace;
process.env.CODEX_CLI_PATH = relative(workspace, join(workspace, 'fake-codex.py'));

let core;
let ready = null;
let cleanupConfirmed = false;
let paneRecordForCleanup = null;
let explicitRecoveryRechecks = 0;
const shutdownRows=[];
try {
  core = await createCore({ dataDir, pluginDir: pluginRoot, files: false, managedPythonPath: pythonPath,
    onShutdown:row=>shutdownRows.push(row) });
  if (mode === 'start') {
    const project = core.store.project({ name: 'Linux executor Core restart recovery', directory: workspace });
    await core.request('POST', '/api/terminal/profiles', { id: 'managed', label: 'Linux recovery fixture',
      projectId: project.id, enabled: true, shell: '/bin/sh', serverName, allowSharedServer: true,
      tmuxExecutable: tmuxPath });
    await core.request('PATCH', '/api/plugins/codex-autocontinue/config', {
      pythonPath: relative(workspace, pythonPath), codexPath: relative(workspace, join(workspace, 'fake-codex.py')),
      pollSeconds: 86400 });
    const quota = await core.request('POST', '/api/plugin/check');
    assert.equal(quota.available, true, quota.lastError);

    const frames = [], owner = await openOwner(core, 'linux-core-recovery-owner', frames);
    await core.terminal.frame(owner.ctx, { v: 1, type: 'takeover' }, owner.send);
    assert.equal(frames.filter(frame => frame.type === 'control').at(-1)?.phase, 'human');
    await core.terminal.frame(owner.ctx, { v: 1, type: 'create', epoch: 0, name: 'original-shell' }, owner.send);
    const readyFrame = frames.filter(frame => frame.type === 'ready').at(-1);
    assert.ok(readyFrame?.sessionRef, 'the fixture creates one real managed Linux pane');
    const paneIndex = meta(core, 'terminal.managed-panes.v1');
    assert.equal(paneIndex.entries.length, 1);
    const paneRecord = await jsonFile(join(dataDir, 'terminal-managed-records', paneIndex.entries[0].directory, 'record.json'));
    paneRecordForCleanup = paneRecord;
    const beforePath = join(workspace, 'before-core-crash.txt');
    await writeInShell(core, owner, readyFrame.epoch, 1, beforePath, 'BEFORE');
    await core.terminal.frame(owner.ctx, { v: 1, type: 'return', notes: 'Prepare Linux executor recovery' }, owner.send);
    const review = frames.filter(frame => frame.type === 'control').at(-1);
    assert.equal(review?.phase, 'return_review', review?.reason);
    await core.terminal.frame(owner.ctx, { v: 1, type: 'return-confirm', reviewId: review.returnReview.reviewId,
      expectedGeneration: review.generation }, owner.send);
    assert.equal(frames.filter(frame => frame.type === 'control').at(-1)?.phase, 'ai_ready');

    const task = core.store.createTask({ projectId: project.id, title: 'Unresolved Linux turn after Core crash',
      executionProvider: 'codex-autocontinue' });
    const commandId = 'linux-core-recovery-command';
    const session = await core.request('POST', `/api/tasks/${task.id}/session`, {
      expectedRevision: task.revision, commandId: 'linux-core-recovery-session', workspaceWrite: true });
    assert.equal(session.status, 'created', session.error);
    const bound = core.store.getTask(task.id);
    const turnRequest = core.request('POST', `/api/tasks/${task.id}/continue`, {
      expectedRevision: bound.revision, commandId });
    if (scenario !== 'turn-no-id') {
      const turn = await turnRequest;
      assert.equal(turn.status, 'running', turn.error);
    } else void turnRequest.catch(() => {});

    const details = await until(async () => {
      const state = await hostState();
      const marker = state.executors?.[`task:${task.id}`];
      const command = state.commands?.[`${task.id}:${commandId}`];
      const admission = meta(core, 'linux.executor-admissions.v1')?.admissions?.find(item =>
        item.taskId === task.id && item.recordId === marker?.recordId && item.commands?.includes(commandId));
      const turnRequestObserved = (await logRequests()).some(row => row.method === 'turn/start');
      const turnReady = scenario === 'turn-no-id' ? turnRequestObserved && !command?.turnId :
        scenario === 'turn-interrupted' ? command?.turnId && command.status === 'interrupted' &&
          command.stopProof?.status === 'unverified' : !!command?.turnId;
      if (marker?.kind !== 'linux-job' || !marker.recordId || !marker.appServerPid || !command || !turnReady || !admission)
        return null;
      return { state, marker, command, admission };
    }, 'Linux job, persisted Core admission, and provider turn ID did not all become durable');
    assert.equal(details.admission.requestCommandId, details.marker.requestCommandId,
      'the first admitted command is bound to the original request ID');
    assert.equal(details.admission.projectId, project.id);
    assert.equal(details.admission.workspace, workspace);
    if (scenario === 'turn-interrupted') {
      assert.equal(details.command.status, 'interrupted', 'fake provider interruption is durably observed before Core crash');
      assert.equal(details.command.stopProof?.status, 'unverified', 'provider interruption does not prove command process exit');
      assert.equal(details.state.executors[`task:${task.id}`].finalTurnProof, undefined,
        'host has not manufactured a final-turn proof for the interrupted event');
    }
    const requests = await logRequests();
    assert.equal(requests.filter(row => row.method === 'turn/start').length, 1,
      'the controlled provider observed one original turn start');
    const childIdentity = await nativeSelectedIdentities(pythonPath, [process.pid], 15000);
    const coreIdentity = childIdentity.get(process.pid);
    assert.equal(coreIdentity?.kind, 'linux-proc');
    ready = { coreIdentity, taskId: task.id, projectId: project.id, commandId,
      sessionRef: readyFrame.sessionRef, shellIdentity: paneRecord.identities.shell,
      recordId: details.marker.recordId, recordRoot: details.marker.recordRoot,
      bridgePid: details.marker.pid, appServerPid: details.marker.appServerPid,
      turnId: details.command.turnId || null, threadId: details.command.threadId || null,
      preCrashCommandStatus: details.command.status,
      preCrashStopProofStatus: details.command.stopProof?.status || null,
      preCrashFinalTurnProof: details.marker.finalTurnProof || null,
      requestCommandId: details.marker.requestCommandId,
      admission: details.admission };
    process.stdout.write(`${JSON.stringify(ready)}\n`);
    await new Promise(resolve => process.stdin.once('data', resolve));
  } else if (mode === 'restart') {
    const original = JSON.parse(readyJson);
    const currentIdentity = (await nativeSelectedIdentities(pythonPath, [process.pid], 15000)).get(process.pid);
    process.stdout.write(`${JSON.stringify({ stage: 'restart-core-ready', coreIdentity: currentIdentity })}\n`);
    assert.ok(original.recordId && original.commandId && original.coreIdentity,
      'restart requires the actual prior Core admission evidence');
    if (scenario !== 'turn-no-id') assert.ok(original.turnId, 'positive restart requires the actual provider turn ID');
    const task = core.store.getTask(original.taskId);
    assert.equal(task.projectId, original.projectId);
    const stateAfterRestart = await hostState();
    const markerAfterRestart = stateAfterRestart.executors?.[`task:${original.taskId}`];
    assert.equal(markerAfterRestart?.kind, 'linux-job');
    assert.equal(markerAfterRestart?.recordId, original.recordId,
      'new Core recovers the original durable Linux executor record');
    assert.equal(markerAfterRestart?.requestCommandId, original.requestCommandId);
    if (scenario === 'turn-interrupted') {
      const interruptedCommand = stateAfterRestart.commands?.[`${original.taskId}:${original.commandId}`];
      assert.equal(original.preCrashCommandStatus, 'interrupted');
      assert.equal(original.preCrashStopProofStatus, 'unverified');
      assert.equal(original.preCrashFinalTurnProof, null);
      assert.equal(interruptedCommand?.status, 'interrupted', 'restart starts from the provider-interrupted command');
      assert.equal(interruptedCommand?.stopProof?.status, 'unverified');
      assert.equal(markerAfterRestart.finalTurnProof, undefined,
        'Core restart cannot promote the interrupted event into final-turn proof');
    }

    if (scenario === 'turn-no-id') {
      if (markerAfterRestart.status !== 'retirement_unknown' && !markerAfterRestart.linuxStopIntent) {
        await core.request('POST', `/api/tasks/${task.id}/pause`, { expectedRevision: task.revision });
      }
      const unresolved = await until(async () => {
        const state = await hostState(), marker = state.executors?.[`task:${original.taskId}`];
        const command = state.commands?.[`${original.taskId}:${original.commandId}`];
        if (!marker || !command || !['retirement_unknown', 'stopped_unknown'].includes(marker.status)) return null;
        return { marker, command };
      }, 'missing-turn-ID job did not remain fenced after restart');
      assert.equal(unresolved.marker.linuxStoppedReceipt, undefined,
        'no provider turn ID cannot create a Linux stopped receipt');
      assert.equal(unresolved.marker.linuxStopIntent?.turnId, null,
        'persisted stop intent records the actual absence of a turn ID');
      assert.equal(unresolved.command.turnId, undefined,
        'the provider command never acquired a turn identity');
      assert.ok(['sending', 'running', 'unknown', 'awaiting_approval'].includes(unresolved.command.status),
        'command remains unresolved rather than becoming a successful stop');
      const leaseImage = meta(core, 'execution.leases.v1');
      const lease = leaseImage.reservations.find(item => item.taskId === original.taskId && item.commandId === original.commandId);
      assert.ok(lease && ['startup', 'reserved', 'running', 'unknown'].includes(lease.status),
        'lease remains active/fenced without a provider turn ID');
      assert.equal(lease.shutdownStoppedReceipt, undefined,
        'lease cannot carry a verified stop receipt without the required turn identity');
      assert.equal((await logRequests()).filter(row => row.method === 'turn/start').length, 1,
        'restart did not resend the request held before provider turn identity');

      const paneRecord = await jsonFile(join(dataDir, 'terminal-managed-records',
        meta(core, 'terminal.managed-panes.v1').entries[0].directory, 'record.json'));
      paneRecordForCleanup = paneRecord;
      const frames = [], owner = await openOwner(core, 'linux-core-recovery-without-turn', frames);
      await core.terminal.frame(owner.ctx, { v: 1, type: 'takeover' }, owner.send);
      const control = frames.filter(frame => frame.type === 'control').at(-1);
      assert.notEqual(control?.phase, 'human', 'missing turn identity never grants manual takeover');
      assert.notEqual(control?.owned, true, 'missing turn identity never claims ownership');
      const parkedStat=await readFile(`/proc/${original.shellIdentity.pid}/stat`,'utf8');
      assert.match(parkedStat.slice(parkedStat.lastIndexOf(')')+1).trim(), /^[Tt]\s/,
        'original shell remains parked while takeover is refused');
      assert.equal((await logRequests()).filter(row => row.method === 'turn/start').length, 1);
      const closeClaimedSafe = await core.close().then(() => true, () => false);
      core = null;
      assert.equal(closeClaimedSafe, false,
        'Core close does not claim safe retirement when the admitted job has no turn ID');
      await cleanupPaneRecord(paneRecord, original.sessionRef);
      paneRecordForCleanup = null;
      cleanupConfirmed = true;
      process.stdout.write(`${JSON.stringify({ phase: 'rejected-no-turn-id', taskId: original.taskId,
        recordId: original.recordId, commandId: original.commandId, retirementReceipt: false,
        takeoverGranted: false, closeClaimedSafe, shellPid: original.shellIdentity.pid,
        providerTurnStarts: (await logRequests()).filter(row => row.method === 'turn/start').length,
        cleanupConfirmed })}\n`);
    } else {
      // If startup recovery has not already retired the task job, request the
      // ordinary explicit pause path; it must stop only this admitted original.
      if (!markerAfterRestart.linuxStoppedReceipt) {
        let paused = await core.request('POST', `/api/tasks/${task.id}/pause`, { expectedRevision: task.revision });
        if (paused.status === 'unknown' &&
            paused.error === 'Native process snapshot is unconfirmed: pid_info_incomplete') {
          assert.notEqual(paused.linuxStoppedVerified, true);
          assert.notEqual(meta(core, 'terminal.control.v1').entries[task.projectId]?.phase, 'human');
          const state = await hostState();
          assert.equal(state.executors[`task:${task.id}`].linuxStoppedReceipt, undefined);
          assert.equal(meta(core, 'linux.executor-admissions.v1').admissions.find(item =>
            item.recordId === original.recordId).receipt, undefined);
          const lease = meta(core, 'execution.leases.v1').reservations.find(item =>
            item.taskId === task.id && item.commandId === original.commandId);
          assert.ok(['reserved', 'running', 'unknown'].includes(lease.status));
          assert.equal(lease.shutdownStoppedReceipt, undefined);
          assert.equal((await logRequests()).filter(row => row.method === 'turn/start').length, 1);
          explicitRecoveryRechecks += 1;
          // This is one explicit user-style recheck after a recorded refusal,
          // not a product retry or permission to ignore an incomplete snapshot.
          paused = await core.request('POST', `/api/tasks/${task.id}/pause`, {
            expectedRevision: core.store.getTask(task.id).revision });
        }
        assert.equal(paused.linuxStoppedVerified, true, `original job pause: ${JSON.stringify(paused)}`);
      }
      const stopped = await until(async () => {
      const state = await hostState();
      const marker = state.executors?.[`task:${original.taskId}`];
      const admission = meta(core, 'linux.executor-admissions.v1')?.admissions?.find(item =>
        item.taskId === original.taskId && item.recordId === original.recordId);
      const command = state.commands?.[`${original.taskId}:${original.commandId}`];
      if (!marker?.linuxStoppedReceipt || !admission?.receipt || !command) return null;
      return { state, marker, admission, command };
    }, 'new Core did not stop/reconcile the original Linux job with a persisted receipt');
    const receipt = stopped.marker.linuxStoppedReceipt;
    assert.deepEqual(receipt, stopped.admission.receipt,
      'Core admission and host marker hold the same exact retirement receipt');
    assert.equal(receipt.recordId, original.recordId);
    assert.equal(receipt.commandId, original.commandId);
    assert.equal(receipt.turnId, original.turnId);
    assert.equal(receipt.bridgePid, original.bridgePid);
    assert.equal(receipt.appServerPid, original.appServerPid);
    if (scenario === 'turn-interrupted') {
      assert.equal(stopped.marker.finalTurnProof, undefined,
        'verified process retirement does not become provider final-turn proof');
      assert.equal(stopped.command.status, 'unknown',
        'interrupted provider outcome remains unknown after process retirement');
      assert.equal(stopped.command.stopProof?.status, 'unverified');
    }
    const retiredRecord = await jsonFile(join(original.recordRoot, original.recordId, 'record.json'));
    assert.equal(retiredRecord.phase, 'retired', 'the original Linux job record itself confirms retirement');
    assert.equal(stopped.command.status, 'unknown', 'stopping processes does not resolve business outcome');
    assert.equal(stopped.marker.status, 'stopped_unknown');
    const leases = meta(core, 'execution.leases.v1');
    const lease = leases.reservations.find(item => item.taskId === original.taskId && item.commandId === original.commandId);
    assert.equal(lease?.status, 'unknown', 'the ordinary command lease stays active and unknown');
    assert.equal(lease?.provider, 'codex-autocontinue');
    assert.deepEqual(lease?.shutdownStoppedReceipt, receipt,
      'the ordinary unknown lease retains the exact Core retirement receipt');
    assert.equal((await logRequests()).filter(row => row.method === 'turn/start').length, 1,
      'Core recovery did not resend the original provider command');

    const before = await nativeProcessTable(pythonPath, 15000, { allVisible: true });
    assert.equal(before.get(original.bridgePid), undefined, 'original bridge is retired');
    assert.equal(before.get(original.appServerPid), undefined, 'original app-server is retired');
    const paneRecord = await jsonFile(join(dataDir, 'terminal-managed-records',
      (meta(core, 'terminal.managed-panes.v1').entries[0]).directory, 'record.json'));
    assert.deepEqual({ kind: paneRecord.identities.shell.kind, pid: paneRecord.identities.shell.pid,
      bootId: paneRecord.identities.shell.bootId, startTicks: paneRecord.identities.shell.startTicks },
    { kind: original.shellIdentity.kind, pid: original.shellIdentity.pid,
      bootId: original.shellIdentity.bootId, startTicks: original.shellIdentity.startTicks },
    'Core recovery retains the exact original parked shell birth identity');
    const parkedStat=await readFile(`/proc/${original.shellIdentity.pid}/stat`,'utf8');
    assert.match(parkedStat.slice(parkedStat.lastIndexOf(')')+1).trim(), /^[Tt]\s/,
      'original shell stays parked before human selection');

    const frames = [], owner = await openOwner(core, 'linux-core-recovery-after-restart', frames);
    await core.terminal.frame(owner.ctx, { v: 1, type: 'takeover' }, owner.send);
    const handoff = frames.filter(frame => frame.type === 'control').at(-1);
    assert.equal(handoff?.phase, 'human', handoff?.reason);
    assert.equal(handoff?.owned, true);
    assert.equal((await logRequests()).filter(row => row.method === 'turn/start').length, 1,
      'manual takeover does not restart the old provider command');
    await core.terminal.frame(owner.ctx, { v: 1, type: 'select', epoch: 0,
      sessionRef: original.sessionRef }, owner.send);
    const readyFrame = frames.filter(frame => frame.type === 'ready').at(-1);
    assert.deepEqual(readyFrame?.sessionRef, original.sessionRef,
      'manual takeover selects only the original managed pane');
    const markerPath = join(workspace, 'after-core-restart.txt');
    await writeInShell(core, owner, readyFrame.epoch, 1, markerPath, 'AFTER');
    const finalShell = await nativeSelectedIdentities(pythonPath, [original.shellIdentity.pid], 15000);
    assert.deepEqual({ kind: finalShell.get(original.shellIdentity.pid)?.kind,
      pid: finalShell.get(original.shellIdentity.pid)?.pid,
      bootId: finalShell.get(original.shellIdentity.pid)?.bootId,
      startTicks: finalShell.get(original.shellIdentity.pid)?.startTicks },
    { kind: original.shellIdentity.kind, pid: original.shellIdentity.pid,
      bootId: original.shellIdentity.bootId, startTicks: original.shellIdentity.startTicks },
    'post-restart human input ran in the original shell identity');

    // The same receipt must remain fenced after human takeover. Tampering with
    // the fixture's lease cannot turn the old process receipt into authority.
    const originalLeaseImage = meta(core, 'execution.leases.v1');
    const alteredLeaseImage = structuredClone(originalLeaseImage);
    alteredLeaseImage.reservations.find(item => item.taskId === original.taskId &&
      item.commandId === original.commandId).shutdownStoppedReceipt.turnId = 'wrong-turn';
    core.store.db.prepare('UPDATE metadata SET value=? WHERE key=?')
      .run(JSON.stringify(alteredLeaseImage), 'execution.leases.v1');
    const rejected = await core.request('POST', `/api/tasks/${task.id}/pause`, {
      expectedRevision: core.store.getTask(task.id).revision });
    assert.equal(rejected.linuxStoppedVerified, undefined, 'changed lease receipt cannot be reused');
    assert.equal(rejected.status, 'unknown');
    core.store.db.prepare('UPDATE metadata SET value=? WHERE key=?')
      .run(JSON.stringify(originalLeaseImage), 'execution.leases.v1');

      const finalPaneRecord = await jsonFile(join(dataDir, 'terminal-managed-records',
      meta(core, 'terminal.managed-panes.v1').entries[0].directory, 'record.json'));
      paneRecordForCleanup = finalPaneRecord;
      await core.close();
      core = null;
      await cleanupPaneRecord(finalPaneRecord, original.sessionRef);
      paneRecordForCleanup = null;
      cleanupConfirmed = true;
      process.stdout.write(`${JSON.stringify({ phase: 'recovered', taskId: original.taskId,
      recordId: original.recordId, commandId: original.commandId, turnId: original.turnId,
      leaseStatus: lease.status, takeover: handoff.phase, shellPid: original.shellIdentity.pid,
      providerTurnStarts: (await logRequests()).filter(row => row.method === 'turn/start').length,
      cleanupConfirmed, explicitRecoveryRechecks })}\n`);
    }
  } else {
    throw new Error('fixture mode must be start or restart');
  }
} finally {
  if (core) {
    let closeFailed = false;
    try { await core.close(); }
    catch (error) { closeFailed = true; process.stderr.write(`Core fixture close unconfirmed: ${String(error.message).slice(0, 400)}\n`);
      process.stderr.write(JSON.stringify({shutdownRows})+'\n');
      const state=await hostState();
      for(const marker of Object.values(state.executors||{}))if(marker.pid){
        const stat=await readFile(`/proc/${marker.pid}/stat`,'utf8').catch(()=>null);
        if(stat)process.stderr.write(JSON.stringify({markerKind:marker.kind||'quota',process:stat.slice(stat.lastIndexOf(')')+1).trim().split(/\s+/).slice(0,4)})+'\n');
      }
    }
    if (mode === 'restart' && !cleanupConfirmed) {
      const state = await hostState();
      const db = new DatabaseSync(join(dataDir, 'board.sqlite'), { readOnly: true });
      process.stderr.write(JSON.stringify({ recoveryDiagnostic: {
        commands: state.commands,
        taskMarkers: Object.fromEntries(Object.entries(state.executors || {}).filter(([key]) => key.startsWith('task:'))),
        leases: meta({ store: { db } }, 'execution.leases.v1'),
        admissions: meta({ store: { db } }, 'linux.executor-admissions.v1'),
      } })+'\n');
      db.close();
    }
    core = null;
    if (!closeFailed && paneRecordForCleanup && (mode === 'start' || mode === 'restart')) {
      try {
        await cleanupPaneRecord(paneRecordForCleanup, ready?.sessionRef || JSON.parse(readyJson || '{}').sessionRef);
        paneRecordForCleanup = null;
        cleanupConfirmed = true;
      } catch (error) { process.stderr.write(`Fixture pane cleanup unconfirmed: ${String(error.message).slice(0, 400)}\n`); }
    }
  }
  if (mode === 'restart' && !cleanupConfirmed)
    process.stderr.write(`Retained Linux recovery fixture for inspection: ${root}\n`);
}
