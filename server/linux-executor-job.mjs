// Independent Linux task supervisor primitive. Core/host integration is separate.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeSelectedIdentities } from './terminal/process-identities.mjs';

const HELPER = fileURLToPath(new URL('../plugins/codex-autocontinue/linux_executor_job.py', import.meta.url));
const SCOPE = 'linux-original-subreaper-current-descendants';
const unknown = reason => ({ verified: false, unknown: true, retired: false, reason, scope: SCOPE });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const validId = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const validAuthority = value => value === null || !!value && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).sort().join(',') ===
    'expectedHandoffGeneration,requestCommandId,worktreeId' &&
  typeof value.requestCommandId === 'string' && value.requestCommandId.length > 0 &&
  (value.worktreeId === null || typeof value.worktreeId === 'string' && value.worktreeId.length > 0) &&
  (value.expectedHandoffGeneration === null || Number.isSafeInteger(value.expectedHandoffGeneration) &&
    value.expectedHandoffGeneration > 0);
const sameBirth = (a, b) => !!a && !!b && a.kind === 'linux-proc' && b.kind === 'linux-proc' &&
  a.pid === b.pid && a.euid === b.euid && a.ruid === b.ruid &&
  a.bootId === b.bootId && a.startTicks === b.startTicks;

async function privateDirectory(path) {
  const row = await lstat(path);
  if (!row.isDirectory() || row.uid !== process.geteuid() || (row.mode & 0o777) !== 0o700)
    throw new Error('job_directory_untrusted');
  return await realpath(path);
}

async function privateFile(path) {
  const row = await lstat(path);
  if (!row.isFile() || row.uid !== process.geteuid() || (row.mode & 0o777) !== 0o600 || row.nlink !== 1)
    throw new Error('job_file_untrusted');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function durableWrite(path, value, create = false) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.new`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  if (create) {
    const existing = await lstat(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) { await unlink(temporary); throw new Error('job_record_already_exists'); }
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function currentIdentity(pythonPath, pid) {
  return (await nativeSelectedIdentities(pythonPath, [pid])).get(pid);
}

async function request(directory, capability, op, keepSocket = false) {
  // Linux limits the socket address, not the directory containing the socket.
  // A held directory descriptor keeps the existing private filesystem socket
  // usable under normal, longer application-data paths.
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
  const path = `/proc/self/fd/${handle.fd}/control.sock`;
  const socket = createConnection(path);
  const deadline = setTimeout(() => socket.destroy(new Error('job_socket_timeout')), 5000);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  }).catch(error => { clearTimeout(deadline); socket.destroy(); throw error; });
  socket.write(`${JSON.stringify({ capability, op })}\n`);
  const response = await new Promise((resolve, reject) => {
    let raw = '';
    const fail = error => { socket.off('data', onData); reject(error); };
    const onData = bytes => {
      raw += bytes.toString();
      if (raw.length > 65536) return fail(new Error('job_response_too_large'));
      const end = raw.indexOf('\n');
      if (end < 0) return;
      socket.off('data', onData);
      try { resolve(JSON.parse(raw.slice(0, end))); }
      catch { fail(new Error('job_response_invalid')); }
    };
    socket.on('data', onData);
    socket.once('error', fail);
    socket.once('end', () => fail(new Error('job_socket_closed')));
  }).catch(error => { clearTimeout(deadline); socket.destroy(); throw error; });
  clearTimeout(deadline);
  if (keepSocket) { socket.pause(); return { response, socket }; }
  socket.destroy();
  return response;
  } finally { await handle.close(); }
}

class LinuxExecutorJob {
  #record; #directory; #capability; #pythonPath; #recovered; #attempted = false;
  #stdin = null; #stdout = null; #stderr = null; #stopRequested = false;
  constructor(record, directory, capability, pythonPath, recovered = false) {
    this.#record = record;
    this.#directory = directory;
    this.#capability = capability;
    this.#pythonPath = pythonPath;
    this.#recovered = recovered;
  }
  get recordId() { return this.#record.recordId; }
  get recordRoot() { return this.#record.recordRoot; }
  get taskId() { return this.#record.taskId; }
  get identity() { return this.#record.bridgeIdentity || null; }
  get stdin() { return this.#stdin; }
  get stdout() { return this.#stdout; }
  get stderr() { return this.#stderr; }
  get directory() { return this.#directory; }

  async #read() {
    await privateDirectory(this.#record.recordRoot);
    await privateDirectory(this.#directory);
    const record = await privateFile(join(this.#directory, 'record.json'));
    if (record.schemaVersion !== 1 || record.recordId !== this.recordId ||
      record.recordRoot !== this.recordRoot || record.taskId !== this.taskId ||
      record.projectId !== this.#record.projectId || record.workspace !== this.#record.workspace ||
      record.pythonPath !== this.#record.pythonPath || record.directory !== this.#directory ||
      JSON.stringify(record.authority ?? null) !== JSON.stringify(this.#record.authority ?? null) ||
      record.generation < this.#record.generation)
      throw new Error('job_record_binding_changed');
    this.#record = record;
    return record;
  }

  async verifySupervisor() {
    const record = await this.#read();
    if (!record.supervisorIdentity) throw new Error('job_supervisor_unavailable');
    if (!sameBirth(await currentIdentity(this.#pythonPath, record.supervisorIdentity.pid), record.supervisorIdentity))
      throw new Error('job_supervisor_identity_changed');
    return record;
  }

  async spawn() {
    if (this.#recovered || this.#attempted || this.#stopRequested || this.#record.phase !== 'prepared')
      throw new Error('job_start_already_attempted');
    this.#attempted = true;
    try {
      const record = { ...this.#record, phase: 'intent', attempted: true, generation: this.#record.generation + 1 };
      await durableWrite(join(this.#directory, 'record.json'), record);
      this.#record = record;
      const child = spawn(this.#pythonPath, ['-B', HELPER, this.#directory],
        { detached: true, stdio: 'ignore', cwd: '/', env: process.env, windowsHide: true });
      child.unref();
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const ready = await this.verifySupervisor();
          if (ready.phase === 'ready') break;
        } catch { /* Supervisor startup is bounded by this deadline. */ }
        if (attempt === 99) throw new Error('job_supervisor_start_unconfirmed');
        await pause(50);
      }
      const streams = [];
      try {
        for (const name of ['stdin', 'stdout', 'stderr']) {
          const attached = await request(this.#directory, this.#capability, name, true);
          if (attached.response.verified !== true) throw new Error('job_stream_unconfirmed');
          streams.push(attached.socket);
        }
        const launched = await request(this.#directory, this.#capability, 'start');
        const running = await this.verifySupervisor();
        if (launched.verified !== true || !sameBirth(launched.identity, running.bridgeIdentity) ||
          running.bridgeIdentity.ppid !== running.supervisorIdentity.pid ||
          !sameBirth(await currentIdentity(this.#pythonPath, running.bridgeIdentity.pid), running.bridgeIdentity))
          throw new Error('job_bridge_identity_unconfirmed');
        [this.#stdin, this.#stdout, this.#stderr] = streams;
        return { stdin: this.#stdin, stdout: this.#stdout, stderr: this.#stderr,
          identity: running.bridgeIdentity, pid: running.bridgeIdentity.pid };
      } catch (error) { for (const socket of streams) socket.destroy(); throw error; }
    } catch {
      throw new Error('job_start_unconfirmed');
    }
  }

  async observe() {
    try {
      const record = await this.#read();
      if (record.phase === 'retired') return { verified: true, retired: true, unknown: false,
        members: [], count: 0, scope: SCOPE, resultUnknown: true, outputLost: !!record.outputLost };
      await this.verifySupervisor();
      const observed = await request(this.#directory, this.#capability, 'observe');
      await this.verifySupervisor();
      return observed.verified === true ? observed : unknown('job_observation_unconfirmed');
    } catch { return unknown('job_supervisor_unconfirmed'); }
  }

  async stop() {
    this.#stopRequested = true;
    this.#stdin?.destroy();
    try {
      const record = await this.#read();
      if (record.phase === 'retired') return this.recheck();
      await this.verifySupervisor();
      const result = await request(this.#directory, this.#capability, 'stop');
      const after = await this.#read();
      if (result.verified === true && result.retired === true && after.phase === 'retired')
        return result;
      return unknown('job_stop_unconfirmed');
    } catch { return unknown('job_stop_unconfirmed'); }
  }

  async recheck() {
    try {
      const record = await this.#read();
      if (record.phase === 'retired') return { verified: true, retired: true, unknown: false,
        members: [], count: 0, scope: SCOPE, resultUnknown: true, outputLost: !!record.outputLost };
      await this.verifySupervisor();
      const result = await request(this.#directory, this.#capability, 'recheck');
      return result.verified === true ? result : unknown('job_recheck_unconfirmed');
    } catch { return unknown('job_supervisor_unconfirmed'); }
  }
}

export async function prepareLinuxExecutorJob({ recordRoot, taskId, projectId, workspace,
  command, args = [], env = process.env, pythonPath, authority = null } = {}) {
  if (process.platform !== 'linux') throw new Error('unsupported_platform');
  if (typeof taskId !== 'string' || !taskId || typeof projectId !== 'string' || !projectId ||
    typeof workspace !== 'string' || typeof command !== 'string' || !isAbsolute(command) ||
    typeof pythonPath !== 'string' || !isAbsolute(pythonPath) ||
    !Array.isArray(args) || args.some(value => typeof value !== 'string') ||
    !env || typeof env !== 'object' || Object.values(env).some(value => typeof value !== 'string') ||
    !validAuthority(authority))
    throw new TypeError('invalid_job_configuration');
  const root = await privateDirectory(recordRoot);
  const recordId = randomBytes(16).toString('hex');
  const directory = join(root, recordId);
  const cwd = await realpath(workspace);
  const executable = await realpath(command);
  const python = await realpath(pythonPath);
  await mkdir(directory, { mode: 0o700 });
  const capability = randomBytes(32).toString('hex');
  const record = { schemaVersion: 1, recordId, recordRoot: root, directory,
    taskId, projectId, workspace: cwd, pythonPath: python, authority, phase: 'prepared',
    attempted: false, generation: 0, supervisorIdentity: null, bridgeIdentity: null,
    outputLost: false, resultUnknown: true };
  await durableWrite(join(directory, 'launch.json'), { capability, command: executable, args, env }, true);
  await durableWrite(join(directory, 'record.json'), record, true);
  return new LinuxExecutorJob(record, directory, capability, python, false);
}

export async function recoverLinuxExecutorJob({ recordRoot, recordId, taskId, projectId,
  workspace, pythonPath } = {}) {
  if (process.platform !== 'linux') return unknown('unsupported_platform');
  try {
    if (!validId(recordId)) throw new Error('job_record_id_invalid');
    const root = await privateDirectory(recordRoot);
    const directory = await privateDirectory(join(root, recordId));
    const record = await readLinuxExecutorJobRecord({ recordRoot: root, recordId, taskId,
      projectId, workspace, pythonPath });
    const launch = await privateFile(join(directory, 'launch.json'));
    if (typeof launch.capability !== 'string' || launch.capability.length !== 64)
      throw new Error('job_record_binding_changed');
    const job = new LinuxExecutorJob(record, directory, launch.capability, record.pythonPath, true);
    if (record.phase !== 'retired') await job.verifySupervisor();
    return { verified: true, unknown: false, job };
  } catch { return unknown('job_recovery_unconfirmed'); }
}

export async function readLinuxExecutorJobRecord({ recordRoot, recordId, taskId, projectId,
  workspace, pythonPath } = {}) {
  if (process.platform !== 'linux' || !validId(recordId)) throw new Error('job_record_invalid');
  const root = await privateDirectory(recordRoot);
  const directory = await privateDirectory(join(root, recordId));
  const record = await privateFile(join(directory, 'record.json'));
  if (record.schemaVersion !== 1 || record.recordId !== recordId || record.recordRoot !== root ||
    record.directory !== directory || record.taskId !== taskId || record.projectId !== projectId ||
    record.workspace !== await realpath(workspace) || record.pythonPath !== await realpath(pythonPath) ||
    !validAuthority(record.authority ?? null) || !Number.isSafeInteger(record.generation) ||
    record.generation < 0 || !['prepared', 'intent', 'ready', 'launch_intent', 'running',
      'stop_intent', 'retired'].includes(record.phase))
    throw new Error('job_record_binding_changed');
  return record;
}
