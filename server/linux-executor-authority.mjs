import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { BoardError } from './store.mjs';
import { readLinuxExecutorJobRecord } from './linux-executor-job.mjs';
import { nativeSelectedIdentities } from './terminal/process-identities.mjs';
import { inspectWorkspaceWriters } from './terminal/process-inspection.mjs';

const KEY = 'linux.executor-admissions.v1';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const birth = (a, b) => !!a && !!b && a.kind === 'linux-proc' && b.kind === 'linux-proc' &&
  ['pid', 'euid', 'ruid', 'bootId', 'startTicks'].every(key => a[key] === b[key]);
const fail = () => { throw new BoardError('Linux 原任务进程或执行记录未能核实', 409, 'PROCESS_PROOF_UNAVAILABLE'); };

// A durable Core admission binds one original supervisor to its commands. A
// retired job proves process exit only, never the provider's business result.
export function createLinuxExecutorAuthority({ store, dataDir, pythonPath, control, terminal, resolveWorkspace, leases }) {
  const root = join(dataDir, 'plugins', 'codex-autocontinue', 'linux-executor-jobs');
  const read = () => {
    const row = store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY);
    const image = row ? JSON.parse(row.value) : { version: 1, admissions: [] };
    if (image.version !== 1 || !Array.isArray(image.admissions)) fail();
    return image;
  };
  const save = image => store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(KEY, JSON.stringify(image));
  const host = taskId => {
    const path = join(dataDir, 'plugins', 'codex-autocontinue', 'codex-autocontinue.json');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid() ||
      (stat.mode & 0o777) !== 0o600 || stat.size > 16_000_000) fail();
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return { state, marker: state.executors?.[`task:${taskId}`] };
  };
  const binding = input => {
    const task = store.getTask(input.taskId), workspace = resolveWorkspace(input);
    const generation = control.handoffForProject(task.projectId)?.generation ?? null;
    if (process.platform !== 'linux' || (task.executionProvider || 'codex-autocontinue') !== 'codex-autocontinue' ||
      workspace.directory !== input.workspace || realpathSync(input.workspace) !== input.workspace ||
      workspace.worktreeId !== input.worktreeId) fail();
    return { task, workspace, generation };
  };
  const recordFor = (input, task) => readLinuxExecutorJobRecord({ recordRoot: root,
    recordId: input.recordId, taskId: task.id, projectId: task.projectId,
    workspace: input.workspace, pythonPath });
  const markerMatches = (marker, record, task) => {
    if (marker?.kind !== 'linux-job' || marker.recordId !== record.recordId ||
      marker.recordRoot !== record.recordRoot || marker.taskId !== task.id ||
      marker.projectId !== task.projectId || marker.workspace !== record.workspace ||
      marker.canonicalWorkspace !== record.workspace || marker.pid !== record.bridgeIdentity?.pid ||
      !record.authority || marker.requestCommandId !== record.authority.requestCommandId ||
      (marker.worktreeId ?? null) !== record.authority.worktreeId ||
      (marker.expectedHandoffGeneration ?? null) !== record.authority.expectedHandoffGeneration) fail();
  };
  const observed = async saved => {
    const identities = [saved.worker, saved.supervisor, saved.bridge, saved.appServer];
    const rows = await nativeSelectedIdentities(pythonPath, identities.map(item => item.pid));
    if (identities.some(item => !birth(item, rows.get(item.pid))) ||
      rows.get(saved.worker.pid).ppid !== process.pid ||
      rows.get(saved.supervisor.pid).ppid !== saved.worker.pid ||
      rows.get(saved.bridge.pid).ppid !== saved.supervisor.pid ||
      rows.get(saved.appServer.pid).ppid !== saved.bridge.pid) fail();
    return { members: [...rows.values()] };
  };
  const current = (input, saved, task) => {
    if (!saved || saved.taskId !== task.id || saved.projectId !== task.projectId ||
      saved.workspace !== input.workspace || saved.worktreeId !== input.worktreeId ||
      !saved.commands.includes(input.commandId)) fail();
  };

  async function admit(input) {
    const before = binding(input), record = await recordFor(input, before.task);
    const snapshot = host(input.taskId); markerMatches(snapshot.marker, record, before.task);
    if (record.phase !== 'running' || record.attempted !== true ||
      record.authority.worktreeId !== input.worktreeId ||
      record.authority.expectedHandoffGeneration !== before.generation ||
      snapshot.marker.appServerPid !== input.appServerPid || record.bridgeIdentity.pid !== input.bridgePid) fail();
    const rows = await nativeSelectedIdentities(pythonPath,
      [input.trustedWorkerPid, record.supervisorIdentity.pid, input.bridgePid, input.appServerPid]);
    const candidate = { worker: rows.get(input.trustedWorkerPid), supervisor: rows.get(record.supervisorIdentity.pid),
      bridge: rows.get(input.bridgePid), appServer: rows.get(input.appServerPid) };
    if (!birth(candidate.supervisor, record.supervisorIdentity) || !birth(candidate.bridge, record.bridgeIdentity)) fail();
    await observed(candidate);
    control.assertMayStart(before.task.projectId);
    await terminal.verifyManagedForExecution(before.task.projectId, { members: [...rows.values()] });
    const afterRecord = await recordFor(input, before.task), after = binding(input);
    markerMatches(host(input.taskId).marker, afterRecord, after.task);
    if (!same(after, before) || afterRecord.phase !== 'running' ||
      !birth(afterRecord.supervisorIdentity, record.supervisorIdentity) ||
      !birth(afterRecord.bridgeIdentity, record.bridgeIdentity)) fail();
    await observed(candidate);
    // No await between final mutable binding checks and the durable admission.
    return store.transaction(() => {
      if (!same(binding(input), before)) fail();
      markerMatches(host(input.taskId).marker, afterRecord, before.task);
      const image = read(), existing = image.admissions.find(item => item.recordId === input.recordId);
      if (existing) {
        if (existing.receipt || existing.taskId !== input.taskId || existing.projectId !== before.task.projectId ||
          existing.workspace !== input.workspace || existing.worktreeId !== input.worktreeId ||
          existing.expectedHandoffGeneration !== before.generation ||
          Object.keys(candidate).some(key => !birth(existing[key], candidate[key]))) fail();
        if (!existing.commands.includes(input.commandId)) existing.commands.push(input.commandId);
      } else {
        if (record.authority.requestCommandId !== input.commandId ||
          image.admissions.some(item => !item.receipt && item.taskId === input.taskId)) fail();
        image.admissions.push({ recordId: input.recordId, taskId: input.taskId, projectId: before.task.projectId,
          workspace: input.workspace, worktreeId: input.worktreeId, expectedHandoffGeneration: before.generation,
          requestCommandId: record.authority.requestCommandId, ...candidate, commands: [input.commandId] });
      }
      save(image);
      return { verified: true, scope: 'linux-original-task-job-admission' };
    });
  }

  function has(taskId, commandId) {
    return read().admissions.some(item => item.taskId === taskId && item.commands.includes(commandId));
  }
  async function live(input, task, generation) {
    const saved = read().admissions.find(item => item.taskId === task.id && item.commands.includes(input.commandId));
    const full = { ...input, workspace: resolveWorkspace(input).directory, worktreeId: input.worktreeId ?? null };
    current(full, saved, task);
    if (saved.receipt || saved.expectedHandoffGeneration !== generation) fail();
    const record = await recordFor({ ...full, recordId: saved.recordId }, task);
    markerMatches(host(task.id).marker, record, task);
    if (record.phase !== 'running' || !birth(record.supervisorIdentity, saved.supervisor) ||
      !birth(record.bridgeIdentity, saved.bridge)) fail();
    return observed(saved);
  }

  async function retire(input) {
    const before = binding(input), imageBefore = read();
    const saved = imageBefore.admissions.find(item => item.recordId === input.recordId);
    const aborted = host(input.taskId);
    if (aborted.marker?.sessionAbortBeforeSend === true)
      return retireUnsentSession(input, before, saved, aborted);
    current(input, saved, before.task);
    const original = input.expectedHandoffGeneration === null ? null :
      control.retirementHandoff(before.task.projectId, input.expectedHandoffGeneration);
    if (saved.expectedHandoffGeneration !== input.expectedHandoffGeneration ||
      saved.bridge.pid !== input.bridgePid || saved.appServer.pid !== input.appServerPid) fail();
    const record = await recordFor(input, before.task);
    if (record.phase !== 'retired' || record.attempted !== true ||
      !birth(record.supervisorIdentity, saved.supervisor) || !birth(record.bridgeIdentity, saved.bridge)) fail();
    const snapshot = host(input.taskId); markerMatches(snapshot.marker, record, before.task);
    const { marker, state } = snapshot, intent = marker.linuxStopIntent;
    const expected = { taskId: input.taskId, projectId: before.task.projectId, recordId: input.recordId,
      commandId: input.commandId, workspace: input.workspace, worktreeId: input.worktreeId,
      expectedHandoffGeneration: input.expectedHandoffGeneration, bridgePid: input.bridgePid,
      appServerPid: input.appServerPid, threadId: intent?.threadId ?? null, turnId: intent?.turnId ?? null };
    if (!same(intent, expected) || !['stopping', 'retirement_unknown', 'stopped_unknown'].includes(marker.status) ||
      (marker.lastCommandId || marker.requestCommandId) !== input.commandId ||
      (before.task.conversationId || null) !== expected.threadId) fail();
    const command = state.commands?.[`${input.taskId}:${input.commandId}`];
    const session = state.sessions?.[input.commandId];
    const proof = marker.finalTurnProof;
    const exactCommand = command?.taskId === input.taskId && command.commandId === input.commandId &&
      command.threadId === expected.threadId && command.turnId === expected.turnId &&
      command.bridgePid === input.bridgePid && command.workspace === input.workspace;
    const final = exactCommand && !!expected.turnId && command.turnCompleteEvent === true &&
      ['completed', 'failed', 'interrupted'].includes(command.status) && proof?.commandKey === `${input.taskId}:${input.commandId}` &&
      proof.threadId === expected.threadId && proof.turnId === expected.turnId &&
      proof.bridgePid === input.bridgePid && proof.workspace === input.workspace && proof.status === command.status;
    const idle = !command && session?.status === 'created' && session.taskId === input.taskId &&
      session.threadId === expected.threadId && session.workspace === input.workspace &&
      saved.requestCommandId === input.commandId && expected.turnId === null;
    const uncertain = exactCommand && !!expected.threadId && !!expected.turnId &&
      (['sending', 'running', 'unknown', 'awaiting_approval'].includes(command.status) ||
        command.status === 'interrupted' && command.stopProof?.status === 'unverified') &&
      command.stopProof?.status !== 'verified';
    if (!final && !idle && !uncertain) fail();
    const scope = input.expectedHandoffGeneration !== null ?
      'linux-original-task-job-and-managed-handoff' : 'linux-original-task-job-and-current-writers';
    const receipt = { ...expected, version: 1, scope, recordGeneration: record.generation };
    if (saved.receipt && !same(saved.receipt, receipt) || marker.linuxStoppedReceipt && !same(marker.linuxStoppedReceipt, receipt)) fail();
    // Human takeover consumes the old parked handoff. A receipt already
    // recorded by both authorities can still prove this original job retired;
    // it does not prove the current workspace is idle or resolve the command.
    if (saved.receipt && marker.linuxStoppedReceipt) {
      if (marker.status !== 'stopped_unknown' || command?.status !== 'unknown' || !uncertain) fail();
      const readLease = () => {
        const row = store.db.prepare('SELECT value FROM metadata WHERE key=?').get('execution.leases.v1');
        const lease = row && JSON.parse(row.value).reservations?.find(item => item.taskId === input.taskId &&
          item.commandId === input.commandId && item.provider === 'codex-autocontinue');
        if (!lease || lease.startupId || lease.status !== 'unknown' || lease.projectId !== before.task.projectId ||
          lease.workspace !== input.workspace || (lease.worktreeId ?? null) !== input.worktreeId ||
          !same(lease.shutdownStoppedReceipt, receipt)) fail();
        return lease;
      };
      const lease = readLease(), afterRecord = await recordFor(input, before.task), fresh = host(input.taskId);
      if (!same(afterRecord, record) || !same(fresh.marker, marker) ||
        !same(fresh.state.commands?.[`${input.taskId}:${input.commandId}`], command)) fail();
      return store.transaction(() => {
        if (!same(binding(input), before) || !same(readLease(), lease) ||
          !same(read().admissions.find(item => item.recordId === input.recordId), saved)) fail();
        return { verified: true, retired: true, unknown: false, scope, recordGeneration: record.generation, receipt };
      });
    }
    if (input.expectedHandoffGeneration === null ? before.generation !== null : !original) fail();
    if (original) await terminal.verifyRetirementWorkspace({ projectId: before.task.projectId,
      workspace: input.workspace, expectedHandoffGeneration: input.expectedHandoffGeneration });
    else {
      const writers = await inspectWorkspaceWriters({ workspace: input.workspace });
      if (!writers.verified || !writers.quiescent || writers.unknown || writers.livePids.length) fail();
    }
    const afterRecord = await recordFor(input, before.task), after = binding(input);
    const afterHandoff = original ? control.retirementHandoff(before.task.projectId, input.expectedHandoffGeneration) : null;
    const fresh = host(input.taskId);
    if (!same(after, before) || !same(afterHandoff, original) || afterRecord.phase !== 'retired' ||
      afterRecord.generation !== record.generation || !same(fresh.marker, marker) ||
      !same(fresh.state.commands?.[`${input.taskId}:${input.commandId}`], command) ||
      !same(fresh.state.sessions?.[input.commandId], session)) fail();
    return store.transaction(() => {
      const image = read(), currentAdmission = image.admissions.find(item => item.recordId === input.recordId);
      if (!same(currentAdmission, saved)) fail();
      // Missing leases and pre-turn failures remain fenced. A process receipt
      // does not grant permission to reconstruct an unknown command.
      if (uncertain) leases.markLinuxStoppedUnknown({ taskId: input.taskId, commandId: input.commandId,
        provider: 'codex-autocontinue', receipt });
      currentAdmission.receipt = receipt; save(image);
      return { verified: true, retired: true, unknown: false, scope, recordGeneration: record.generation, receipt };
    });
  }

  // Only the same live worker may retire a session it rejected before sending.
  // This receipt closes its original job; it does not settle a turn, release a
  // lease, prove other writers stopped, or grant human control of the workspace.
  async function retireUnsentSession(input, before, saved, snapshot) {
    const record = await recordFor(input, before.task);
    const { marker, state } = snapshot;
    markerMatches(marker, record, before.task);
    const session = state.sessions?.[input.commandId];
    const expected = { taskId: input.taskId, projectId: before.task.projectId, recordId: input.recordId,
      commandId: input.commandId, workspace: input.workspace, worktreeId: input.worktreeId,
      expectedHandoffGeneration: input.expectedHandoffGeneration, bridgePid: input.bridgePid,
      appServerPid: input.appServerPid, threadId: null, turnId: null };
    if (record.phase !== 'retired' || record.attempted !== true ||
      !['stopping', 'retirement_unknown'].includes(marker.status) ||
      !same(marker.linuxStopIntent, expected) || marker.lastCommandId || marker.threadId ||
      marker.requestCommandId !== input.commandId || marker.pid !== input.bridgePid ||
      marker.appServerPid !== input.appServerPid ||
      record.authority.expectedHandoffGeneration !== input.expectedHandoffGeneration ||
      record.authority.worktreeId !== input.worktreeId || before.task.conversationId ||
      session?.status !== 'not_started' || session.taskId !== input.taskId ||
      session.commandId !== input.commandId || session.workspace !== input.workspace ||
      (session.worktreeId ?? null) !== input.worktreeId || session.threadId || session.turnId ||
      Object.values(state.commands || {}).some(command => command.taskId === input.taskId) ||
      leases.state().active.some(lease => lease.taskId === input.taskId)) fail();
    const worker = (await nativeSelectedIdentities(pythonPath, [input.trustedWorkerPid])).get(input.trustedWorkerPid);
    const supervisor = record.supervisorIdentity, bridge = record.bridgeIdentity;
    if (!birth(worker, marker.linuxStartupOwner) || worker.ppid !== process.pid ||
      ![supervisor, bridge].every(identity => identity?.kind === 'linux-proc' &&
        Number.isSafeInteger(identity.pid) && identity.pid > 1 && identity.bootId === worker.bootId &&
        identity.euid === worker.euid && identity.ruid === worker.ruid &&
        typeof identity.startTicks === 'string' && /^[1-9][0-9]*$/.test(identity.startTicks)) ||
      supervisor.ppid !== worker.pid || BigInt(supervisor.startTicks) < BigInt(worker.startTicks) ||
      bridge.ppid !== supervisor.pid || BigInt(bridge.startTicks) < BigInt(supervisor.startTicks)) fail();
    if (saved) {
      current(input, saved, before.task);
      if (saved.requestCommandId !== input.commandId || saved.commands.length !== 1 ||
        saved.expectedHandoffGeneration !== input.expectedHandoffGeneration ||
        !birth(saved.worker, worker) || !birth(saved.supervisor, supervisor) ||
        !birth(saved.bridge, bridge) || saved.appServer.pid !== input.appServerPid) fail();
    }
    const scope = 'linux-original-task-job-before-session-send';
    const receipt = { ...expected, version: 1, scope, recordGeneration: record.generation };
    if (saved?.receipt && !same(saved.receipt, receipt) ||
      marker.linuxStoppedReceipt && !same(marker.linuxStoppedReceipt, receipt)) fail();
    const afterRecord = await recordFor(input, before.task);
    const freshWorker = (await nativeSelectedIdentities(pythonPath, [input.trustedWorkerPid])).get(input.trustedWorkerPid);
    if (!same(afterRecord, record) || !birth(freshWorker, worker) || freshWorker.ppid !== process.pid) fail();
    return store.transaction(() => {
      const fresh = host(input.taskId), image = read();
      const currentAdmission = image.admissions.find(item => item.recordId === input.recordId);
      if (!same(binding(input), before) || !same(fresh.marker, marker) ||
        !same(fresh.state.sessions?.[input.commandId], session) ||
        Object.values(fresh.state.commands || {}).some(command => command.taskId === input.taskId) ||
        leases.state().active.some(lease => lease.taskId === input.taskId) ||
        !same(currentAdmission, saved)) fail();
      if (currentAdmission) { currentAdmission.receipt = receipt; save(image); }
      return { verified: true, retired: true, unknown: false, scope, recordGeneration: record.generation, receipt };
    });
  }

  return { admit, has, live, retire };
}
