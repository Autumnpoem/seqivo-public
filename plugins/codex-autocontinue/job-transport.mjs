// Private host adapter for the macOS task-owned launchd job. This does not
// interpret a Codex turn result: it proves only the original process cohort
// and currently observable workspace writers have stopped.
import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareExecutorJob, recoverExecutorJob } from '../../server/macos-executor-job.mjs';
import { bootIdentity, checkedRecordRoot, readJobRecord, readRetiredJobRecord, writeJobRecord } from '../../server/macos-executor-job-record.mjs';
import { nativeProcessTable } from '../../server/codex-process-proof.mjs';
import { inspectWorkspaceWriters } from '../../server/terminal/process-inspection.mjs';

const RECORD = /^[0-9a-f]{32}\.json$/;
const birth = row => [row.pid, row.euid, row.ruid, row.startSec, row.startUsec].join(':');
const unknown = reason => ({ verified: false, retired: false, unknown: true, reason });

export async function taskJobRecordRoot(dataDir) {
  const root = join(await realpath(dataDir), 'executor-jobs');
  try { await mkdir(root, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return (await checkedRecordRoot(root)).path;
}

// The private job index is independent of host state.json. A restored old
// host state cannot silently forget a live job, including an intent that may
// have reached launchd without returning an ACK.
export async function auditTaskJobIndex(root, markers) {
  const checked = await checkedRecordRoot(root);
  for (const name of await readdir(checked.path)) {
    if (!RECORD.test(name)) throw new Error('Task job record index contains an unconfirmed entry');
    const file = await open(join(checked.path, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw;
    try { raw = JSON.parse(await file.readFile('utf8')); }
    finally { await file.close(); }
    // The untrusted phase selects only a stricter retired-only reader. A live
    // or malformed old-boot record still fails the current-boot reader.
    const record = await (raw?.phase === 'retired' ? readRetiredJobRecord : readJobRecord)(
      checked.path, name.slice(0, -5), raw?.taskId, raw?.workspace);
    if (record.phase === 'retired' || (record.phase === 'prepared' && record.attempted === false)) continue;
    const marker = markers?.[`task:${record.taskId}`];
    let currentWorkspace = null;
    try { currentWorkspace = marker?.workspace && await realpath(marker.workspace); }
    catch { /* Missing or retargeted workspace is never accepted as the original record. */ }
    if (marker?.kind !== 'macos-job' || marker.recordId !== record.recordId ||
        marker.canonicalWorkspace !== record.workspace || currentWorkspace !== record.workspace ||
        typeof marker.projectId !== 'string') {
      const reason = !marker ? 'marker_missing' : marker.kind !== 'macos-job' ? 'marker_kind_changed'
        : marker.recordId !== record.recordId ? 'record_id_changed'
          : marker.canonicalWorkspace !== record.workspace || currentWorkspace !== record.workspace
            ? 'workspace_changed' : 'project_missing';
      throw new Error(`Task job record is absent from the current host executor index: ${reason}`);
    }
  }
}

export async function prepareTaskJob({ dataDir, taskId, projectId, workspace,
  pythonPath, bridgePath, env }) {
  const recordRoot = await taskJobRecordRoot(dataDir);
  const canonicalWorkspace = await realpath(workspace);
  const job = await prepareExecutorJob({ taskId, command: pythonPath,
    args: ['-B', bridgePath], cwd: workspace, env, pythonPath, recordRoot });
  return { job, recordRoot, recordId: job.recordId, projectId, workspace,
    canonicalWorkspace };
}

export async function recoverTaskJob({ recordRoot, recordId, taskId, workspace, pythonPath }) {
  return recoverExecutorJob({ recordRoot, recordId, taskId, cwd: workspace, pythonPath });
}

export async function verifyTaskJobMarker({ recordRoot, recordId, taskId, workspace }) {
  return readJobRecord(recordRoot, recordId, taskId, workspace);
}

export async function verifyHistoricalRetiredTaskJobMarker({recordRoot,recordId,taskId,workspace}) {
  return readRetiredJobRecord(recordRoot,recordId,taskId,workspace);
}

export async function currentTaskJobBoot() { return bootIdentity(); }

// The host calls this only before its first candidate.open(). Stopping the
// original in-memory authority prevents a later spawn; the original fsynced
// intent record then distinguishes a never-submitted job from an uncertain
// launch. Keep a retired tombstone rather than deleting the audit record.
export async function abandonPreparedTaskJob({ job, recordRoot, recordId, taskId, workspace }) {
  if (!job || job.recordId !== recordId || job.recordRoot !== recordRoot)
    throw new Error('Original prepared job authority changed');
  const stopped = await job.stop();
  if (stopped?.reason !== 'job_not_submitted')
    throw new Error('Original prepared job may have started');
  const record = await readJobRecord(recordRoot, recordId, taskId, workspace);
  if (record.phase !== 'prepared' || record.attempted !== false || record.identity !== null ||
      record.generation !== 0)
    throw new Error('Original prepared job start state is unconfirmed');
  await writeJobRecord(recordRoot, { ...record, phase: 'retired', generation: 1 }, 0);
  return { verified: true, retired: true, recordId };
}

export async function verifyTaskJobRetired({ job, workspace, pythonPath, knownIdentities = [],
  retirementBinding = null, verifyRetirementWorkspace = null }) {
  if (!job) return unknown('Original task job authority is unavailable');
  let retired;
  try { retired = await job.stop(); }
  catch (error) { return unknown(error?.message || 'Task job stop failed'); }
  for (let attempt = 0; attempt < 12 && retired?.retired !== true; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { retired = await job.recheck(); }
    catch (error) { return unknown(error?.message || 'Task job recheck failed'); }
    if (retired?.unknown && !['job_output_streams_open', 'coalition_members_live'].includes(retired.reason))
      return unknown(retired.reason || 'Task job retirement is unconfirmed');
  }
  if (retired?.verified !== true || retired.retired !== true)
    return unknown(retired?.reason || 'Task job retirement is unconfirmed');
  try {
    if (!Array.isArray(knownIdentities) || knownIdentities.length > 512)
      return unknown('Known task process evidence is incomplete');
    if (knownIdentities.length) {
      const rows = await nativeProcessTable(pythonPath, 15000, { allVisible: true });
      for (const expected of knownIdentities) {
        if (!Number.isSafeInteger(expected?.pid) || !Number.isSafeInteger(expected?.startSec) ||
            !Number.isSafeInteger(expected?.startUsec))
          return unknown('Known task process identity is malformed');
        const current = rows.get(expected.pid);
        if (current && birth(current) !== birth(expected))
          return unknown('Known task process PID identity changed');
        if (current) return unknown('Known task process remains live outside retired job');
      }
    }
    const bound=retirementBinding?.expectedHandoffGeneration;
    if(bound!==null&&bound!==undefined&&(!Number.isSafeInteger(bound)||bound<1||
      retirementBinding?.workspace!==workspace||retirementBinding?.recordId!==job.recordId||
      !retirementBinding?.taskId))return unknown('Original managed handoff binding changed');
    const writers=Number.isSafeInteger(bound)&&bound>0
      ?typeof verifyRetirementWorkspace==='function'
        ?await verifyRetirementWorkspace(retirementBinding)
        :unknown('Managed retirement verification is unavailable')
      :await inspectWorkspaceWriters({ workspace });
    if (!writers.verified || writers.unknown || !writers.quiescent ||
      Number.isSafeInteger(bound)&&bound>0&&(!Array.isArray(writers.livePids)||writers.livePids.length||
        writers.scope!=='macos-parked-managed-pane-and-visible-writers'))
      return unknown(writers.reason || 'Current workspace writer remains visible');
    return { verified: true, retired: true, unknown: false,
      scope: Number.isSafeInteger(bound)&&bound>0
        ?'macos-original-task-job-coalition-known-descendants-and-managed-handoff'
        :'macos-original-task-job-coalition-known-descendants-and-current-writers',
      checkedAt: new Date().toISOString(), resultUnknown: retired.resultUnknown };
  } catch (error) { return unknown(error?.message || 'Task process or writer inspection failed'); }
}
