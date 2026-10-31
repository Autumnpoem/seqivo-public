import { mkdir, readdir, readFile, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareLinuxExecutorJob, recoverLinuxExecutorJob,
  readLinuxExecutorJobRecord } from '../../server/linux-executor-job.mjs';

const RECORD_ID = /^[0-9a-f]{32}$/;

export async function linuxJobRecordRoot(dataDir) {
  const root = join(await realpath(dataDir), 'linux-executor-jobs');
  await mkdir(root, { mode: 0o700, recursive: true });
  const row = await lstat(root);
  if (!row.isDirectory() || row.uid !== process.geteuid() || (row.mode & 0o777) !== 0o700)
    throw new Error('Linux job record root is untrusted');
  return await realpath(root);
}

export async function auditLinuxJobIndex(root, markers) {
  for (const recordId of await readdir(root)) {
    if (!RECORD_ID.test(recordId)) throw new Error('Linux job record index is unconfirmed');
    const raw = JSON.parse(await readFile(join(root, recordId, 'record.json'), 'utf8'));
    const record = await readLinuxExecutorJobRecord({ recordRoot: root, recordId,
      taskId: raw.taskId, projectId: raw.projectId, workspace: raw.workspace,
      pythonPath: raw.pythonPath });
    if (record.phase === 'retired') continue;
    const marker = markers?.[`task:${record.taskId}`];
    if (marker?.kind !== 'linux-job' || marker.recordId !== recordId ||
      marker.recordRoot !== root || marker.projectId !== record.projectId ||
      marker.canonicalWorkspace !== record.workspace ||
      JSON.stringify(record.authority) !== JSON.stringify({requestCommandId:marker.requestCommandId,
        worktreeId:marker.worktreeId ?? null,
        expectedHandoffGeneration:marker.expectedHandoffGeneration ?? null}))
      throw new Error('Original Linux job is absent from host executor index');
  }
}

export async function prepareLinuxTaskJob({ dataDir, taskId, projectId, workspace,
  worktreeId, expectedHandoffGeneration, requestCommandId, pythonPath, bridgePath, env }) {
  const recordRoot = await linuxJobRecordRoot(dataDir);
  const canonicalWorkspace = await realpath(workspace);
  const authority = { requestCommandId, worktreeId: worktreeId ?? null,
    expectedHandoffGeneration: expectedHandoffGeneration ?? null };
  const job = await prepareLinuxExecutorJob({ recordRoot, taskId, projectId, workspace,
    command: pythonPath, args: ['-B', bridgePath], env, pythonPath, authority });
  return { job, recordRoot, recordId: job.recordId, projectId, workspace,
    canonicalWorkspace, authority };
}

export async function recoverLinuxTaskJob({ recordRoot, recordId, taskId, projectId,
  workspace, pythonPath }) {
  return recoverLinuxExecutorJob({ recordRoot, recordId, taskId, projectId, workspace, pythonPath });
}
