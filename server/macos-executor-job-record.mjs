// Durable, non-secret authority record for a single temporary launchd job.
// This file never contains command arguments, environment, or socket tokens.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ID = /^[0-9a-f]{32}$/;
const PHASES = new Set(['prepared', 'intent', 'identity', 'stop_intent', 'retired']);
const MAX_RECORD = 16384;

function ownDirectory(row) {
  return row.isDirectory() && row.uid === process.geteuid() && (row.mode & 0o777) === 0o700;
}
function ownFile(row) {
  return row.isFile() && row.uid === process.geteuid() && (row.mode & 0o777) === 0o600 && row.nlink === 1;
}
export function directoryIdentity(row) {
  return { dev: String(row.dev), ino: String(row.ino), uid: row.uid, mode: row.mode & 0o777 };
}
function sameDirectory(actual, expected) {
  return actual.dev === expected?.dev && actual.ino === expected?.ino &&
    actual.uid === expected?.uid && actual.mode === expected?.mode;
}

export async function checkedRecordRoot(recordRoot, expected = null) {
  if (typeof recordRoot !== 'string' || !isAbsolute(recordRoot) || resolve(recordRoot) !== recordRoot)
    throw new Error('job_record_root_invalid');
  const row = await lstat(recordRoot), canonical = await realpath(recordRoot);
  // macOS /var may be an OS-owned alias of /private/var. Bind the canonical
  // directory, while lstat still rejects a replaced final component.
  if (!ownDirectory(row)) throw new Error('job_record_root_untrusted');
  const identity = directoryIdentity(row);
  if (expected && !sameDirectory(identity, expected)) throw new Error('job_record_root_replaced');
  return { path: canonical, identity };
}

export async function checkedJobDirectory(directory, expected) {
  const temporaryRoot = await realpath(tmpdir());
  if (typeof directory !== 'string' || !isAbsolute(directory) ||
    dirname(directory) !== temporaryRoot || !/^seqivo-executor-job-[A-Za-z0-9_-]+$/.test(basename(directory)))
    throw new Error('job_directory_outside_private_temp');
  const row = await lstat(directory), canonical = await realpath(directory);
  if (canonical !== directory || !ownDirectory(row)) throw new Error('job_directory_untrusted');
  const identity = directoryIdentity(row);
  if (expected && !sameDirectory(identity, expected)) throw new Error('job_directory_replaced');
  return identity;
}

export async function bootIdentity() {
  const { stdout } = await exec('/usr/sbin/sysctl', ['-n', 'kern.boottime'],
    { timeout: 3000, maxBuffer: 1024 });
  const match = /^\{ sec = (\d+), usec = (\d+) \}/.exec(stdout.trim());
  if (!match) throw new Error('job_boot_identity_unconfirmed');
  return `${match[1]}:${match[2]}`;
}

function pathFor(root, recordId) {
  if (!ID.test(recordId)) throw new Error('job_record_id_invalid');
  return join(root, `${recordId}.json`);
}

export async function writeJobRecord(root, record, expectedGeneration = null) {
  await checkedRecordRoot(root, record.rootIdentity);
  if (!PHASES.has(record.phase) || !ID.test(record.recordId) ||
    record.recordRoot !== root || record.label !== `com.seqivo.executor.${record.recordId}`)
    throw new Error('job_record_invalid');
  const bytes = Buffer.from(JSON.stringify(record));
  if (bytes.length > MAX_RECORD) throw new Error('job_record_too_large');
  const destination = pathFor(root, record.recordId);
  const temporary = join(root, `.${record.recordId}.${randomBytes(8).toString('hex')}.tmp`);
  const lockPath = join(root, `.${record.recordId}.mutation.lock`);
  let written = false, lock;
  try {
    // Serialize independent recovery handles. A crash can leave this lock in
    // place: that is an unknown outcome, never permission to overwrite it.
    try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL |
      constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch { throw new Error('job_record_mutation_busy'); }
    await lock.sync();
    const folder = await open(root, constants.O_RDONLY);
    try { await folder.sync(); } finally { await folder.close(); }
    let current = null, exists = false;
    try {
      const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        exists = true;
        const row = await file.stat();
        if (!ownFile(row) || row.size > MAX_RECORD) throw new Error('job_record_file_untrusted');
        current = JSON.parse(await file.readFile('utf8'));
      } finally { await file.close(); }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (expectedGeneration === null) {
      if (exists) throw new Error('job_record_already_exists');
      if (record.generation !== 0) throw new Error('job_record_generation_changed');
    } else if (!current || current.recordId !== record.recordId ||
      current.taskId !== record.taskId || current.recordRoot !== root ||
      current.generation !== expectedGeneration || record.generation !== expectedGeneration + 1)
      throw new Error('job_record_generation_changed');
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL |
      constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, destination); written = true;
    const committedFolder = await open(root, constants.O_RDONLY);
    try { await committedFolder.sync(); } finally { await committedFolder.close(); }
  } finally {
    if (!written) await unlink(temporary).catch(() => {});
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}

async function readBoundJobRecord(root, recordId, taskId, workspace, historicalRetired) {
  const checked = await checkedRecordRoot(root);
  const path = pathFor(checked.path, recordId);
  const before = await lstat(path);
  if (!ownFile(before)) throw new Error('job_record_file_untrusted');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let record;
  try {
    const row = await file.stat();
    if (!ownFile(row) || row.dev !== before.dev || row.ino !== before.ino || row.size > MAX_RECORD)
      throw new Error('job_record_file_replaced');
    record = JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
  if (record.schemaVersion !== 1 || record.recordId !== recordId ||
    record.taskId !== taskId || record.workspace !== workspace ||
    record.recordRoot !== checked.path ||
    !sameDirectory(checked.identity, record.rootIdentity) ||
    record.label !== `com.seqivo.executor.${recordId}` ||
    !PHASES.has(record.phase) || typeof record.attempted !== 'boolean' ||
    !Number.isSafeInteger(record.generation) || record.generation < 0 ||
    (historicalRetired ? record.phase !== 'retired' || record.ioFault !== false ||
      !/^[1-9]\d*:(?:0|[1-9]\d*)$/.test(record.boot || '') :
      record.boot !== await bootIdentity()))
    throw new Error('job_record_binding_unconfirmed');
  try { await checkedJobDirectory(record.directory, record.directoryIdentity); }
  catch (error) {
    // A retired tombstone survives safe deletion of its private launch config.
    // Any other missing/replaced directory remains an unresolved execution.
    if (!(record.phase === 'retired' && error.code === 'ENOENT')) throw error;
  }
  return record;
}

/** Read-only historical tombstone. Never use this to recover, signal, or adopt a process. */
export async function readRetiredJobRecord(root,recordId,taskId,workspace){
  return readBoundJobRecord(root,recordId,taskId,workspace,true);
}

/** Live/recovery callers require the current boot exactly as before. */
export async function readJobRecord(root,recordId,taskId,workspace){
  return readBoundJobRecord(root,recordId,taskId,workspace,false);
}
