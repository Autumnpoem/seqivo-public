// Experimental macOS per-task launchd job primitive. It is deliberately not
// wired into host pause: `launchctl remove` is not process-retirement proof.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { chmod, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bootIdentity, checkedJobDirectory, checkedRecordRoot, readJobRecord,
  writeJobRecord } from './macos-executor-job-record.mjs';

const exec = promisify(execFile);
const HELPER = resolve(dirname(fileURLToPath(import.meta.url)), '../plugins/codex-autocontinue/executor_job.py');
const LIMIT = 64 * 1024;
const SCOPED = 'macos-unique-launchd-job-resource-coalition-current-members';
const CONSTRUCT = Symbol('prepared-macos-executor-job');
const unknown = reason => ({ verified: false, retired: false, unknown: true, reason, scope: SCOPED });

function sameIdentity(a, b) {
  return !!a && !!b && a.pid === b.pid && a.euid === b.euid &&
    a.startSec === b.startSec && a.startUsec === b.startUsec &&
    (!a.uniqueid || !b.uniqueid || a.uniqueid === b.uniqueid) &&
    a.coalition?.resource === b.coalition?.resource;
}
const hasSignalIdentity = value => !!value && typeof value.uniqueid === 'string' &&
  /^\d+$/.test(value.uniqueid) && Number.isSafeInteger(value.pidversion) &&
  value.pidversion > 0;
const COHORT_OBSERVATION_MS = 2000;
const COHORT_OBSERVATION_SAMPLES = 4;
const COHORT_RETRY_DELAY_MS = 50;
const RETRYABLE_STARTUP_OBSERVATIONS = new Set([
  'coalition_count_changed', 'native_identity_set_changed', 'native_list_changed_during_scan'
]);
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
function sameCohortBirth(a, b) {
  return !!a && !!b && hasSignalIdentity(a) && hasSignalIdentity(b) &&
    Number.isSafeInteger(a.pid) && a.pid > 0 &&
    Number.isSafeInteger(a.euid) && Number.isSafeInteger(a.ruid) &&
    Number.isSafeInteger(a.startSec) && Number.isSafeInteger(a.startUsec) &&
    a.pid === b.pid && a.euid === b.euid && a.ruid === b.ruid &&
    a.startSec === b.startSec && a.startUsec === b.startUsec &&
    a.uniqueid === b.uniqueid &&
    a.coalition?.resource === b.coalition?.resource;
}
const sameCohortIdentity = (a, b) => sameCohortBirth(a, b) &&
  a.pidversion === b.pidversion;
function sameObservationRecord(a, b) {
  return a.recordId === b.recordId && a.taskId === b.taskId &&
    a.workspace === b.workspace && a.recordRoot === b.recordRoot &&
    a.generation === b.generation && a.phase === b.phase &&
    a.attempted === b.attempted && a.ioFault === b.ioFault &&
    a.pythonPath === b.pythonPath && a.boot === b.boot &&
    a.directory === b.directory && a.label === b.label &&
    a.rootIdentity?.dev === b.rootIdentity?.dev &&
    a.rootIdentity?.ino === b.rootIdentity?.ino &&
    a.directoryIdentity?.dev === b.directoryIdentity?.dev &&
    a.directoryIdentity?.ino === b.directoryIdentity?.ino &&
    sameCohortIdentity(a.identity, b.identity);
}
function checkedCohortSnapshot(snapshot, identity) {
  if (!snapshot?.verified || !Array.isArray(snapshot.members) ||
    !Number.isSafeInteger(snapshot.count) || snapshot.count < 1 ||
    snapshot.count !== snapshot.members.length) return null;
  const members = new Map();
  for (const row of snapshot.members) {
    if (!sameCohortIdentity(row, row) ||
      row.coalition?.resource !== identity.coalition.resource ||
      members.has(row.pid)) return null;
    members.set(row.pid, row);
  }
  // The original durable identity precedes execve, which may increment
  // pidversion without replacing the process. Two *current* samples below
  // still require the exact same pidversion.
  return sameCohortBirth(members.get(identity.pid), identity) ? members : null;
}
function sameBirth(a, b) {
  return !!a && !!b && a.pid === b.pid &&
    a.startSec === b.startSec && a.startUsec === b.startUsec;
}

/** Internal observer implementation. Production dependencies are fixed below. */
function createCohortObserver({ readRecord, canonicalPython, observe, sleep, now, platform }) {
  return async function observeExecutorJobCohortBound({ recordRoot, recordId, taskId, workspace, pythonPath }) {
    const started = now();
    let stage = 'platform', samplesAttempted = 0, helperReason = null;
    // Non-enumerable local diagnostics never enter the plugin RPC/public DTO.
    const finish = (result, detail) => {
      Object.defineProperty(result, 'diagnostic', { value: Object.freeze({
        stage, detail, samplesAttempted, elapsedMs: Math.max(0, Math.round(now() - started)), helperReason
      }) });
      return result;
    };
    const fail = (reason, detail) => finish(unknown(reason), detail);
    if (platform !== 'darwin') return fail('unsupported_platform', 'unsupported');
    try {
      stage = 'canonical_python';
      const canonical = await canonicalPython(pythonPath);
      stage = 'original_record';
      const original = await readRecord(recordRoot, recordId, taskId, workspace);
      if (original.phase !== 'identity' || original.attempted !== true || original.ioFault ||
        !hasSignalIdentity(original.identity) || !original.identity.coalition?.resource ||
        original.pythonPath !== canonical)
        return fail('job_startup_record_unconfirmed', 'record_invalid');
      const deadline = now() + COHORT_OBSERVATION_MS;
      let previous = null;
      const seen = new Map();
      for (let sample = 0; sample < COHORT_OBSERVATION_SAMPLES; sample++) {
        stage = 'before_record';
        const before = await readRecord(recordRoot, recordId, taskId, workspace);
        if (!sameObservationRecord(original, before)) return fail('job_startup_record_changed', 'record_changed');
        if (now() >= deadline) return fail('job_current_cohort_unconfirmed', 'deadline');
        stage = 'native_observe'; samplesAttempted++;
        const current = await observe(pythonPath, original.identity.coalition.resource,
          Math.max(1, Math.floor(deadline - now())));
        const members = checkedCohortSnapshot(current, original.identity);
        if (!members) {
          helperReason = STARTUP_HELPER_REASONS.has(current?.reason) ? current.reason : null;
          const retryable = current?.verified === false &&
            RETRYABLE_STARTUP_OBSERVATIONS.has(current.reason) &&
            Object.keys(current).length === 2 && Object.hasOwn(current, 'reason');
          if (!retryable)
            return fail('job_current_cohort_unconfirmed', current?.verified ? 'snapshot_invalid' : 'helper_unconfirmed');
          // An invalid scan contributes no members or stability evidence. It
          // still consumes this sample and must not erase prior PID identities.
          stage = 'after_record';
          const after = await readRecord(recordRoot, recordId, taskId, workspace);
          if (!sameObservationRecord(original, after)) return fail('job_startup_record_changed', 'record_changed');
          if (now() >= deadline) return fail('job_current_cohort_unconfirmed', 'deadline');
          previous = null;
          if (sample + 1 === COHORT_OBSERVATION_SAMPLES) break;
          stage = 'retry_delay';
          await sleep(Math.min(COHORT_RETRY_DELAY_MS, Math.max(0, deadline - now())));
          continue;
        }
        stage = 'after_record';
        const after = await readRecord(recordRoot, recordId, taskId, workspace);
        if (!sameObservationRecord(original, after)) return fail('job_startup_record_changed', 'record_changed');
        if (now() >= deadline) return fail('job_current_cohort_unconfirmed', 'deadline');
        stage = 'compare';
        if ([...members].some(([pid, row]) => seen.has(pid) &&
          !sameCohortIdentity(seen.get(pid), row)))
          return fail('job_current_cohort_changed', 'member_changed');
        if (previous && [...previous].some(([pid, row]) => members.has(pid) &&
          !sameCohortIdentity(row, members.get(pid))))
          return fail('job_current_cohort_changed', 'member_changed');
        if (previous?.size === members.size && [...previous].every(([pid, row]) =>
          sameCohortIdentity(row, members.get(pid))))
          return finish({ verified: true, unknown: false, recordId, members: current.members,
            scope: 'original-job-record-and-double-current-cohort' }, 'stable');
        for (const [pid, row] of members) seen.set(pid, row);
        previous = members;
        if (sample + 1 === COHORT_OBSERVATION_SAMPLES) break;
        stage = 'retry_delay';
        await sleep(Math.min(COHORT_RETRY_DELAY_MS, Math.max(0, deadline - now())));
      }
      return fail('job_current_cohort_unconfirmed', 'sample_limit');
    } catch { return fail('job_current_cohort_unavailable', 'exception'); }
  };
}

const STARTUP_HELPER_REASONS = new Set([
  'helper_unavailable', 'helper_unconfirmed', 'native_identity_set_changed',
  'native_list_changed_during_scan', 'coalition_count_changed', 'coalition_member_changed',
  'coalition_members_incomplete', 'coalition_missing_with_members',
  'coalition_list_size_unconfirmed', 'coalition_list_unconfirmed', 'coalition_duplicate'
]);

// Fixed executor helper reasons accepted on exit 2. The list-changed code is
// retained for the existing startup retry contract; current snapshot.py emits
// identity_set_changed instead. Never pass through an
// exception message, stderr, or an arbitrary stdout reason: those may contain
// local paths or command data.
const EXIT_2_HELPER_REASONS = new Set([
  'native_abi_mismatch', 'native_libproc_unavailable',
  'native_pid_info_incomplete', 'native_pid_identity_changed',
  'native_kinfo_abi_unsupported', 'native_kinfo_size_failed',
  'native_kinfo_size_invalid', 'native_kinfo_read_failed',
  'native_kinfo_partial_result', 'native_kinfo_identity_invalid',
  'native_kinfo_abi_or_observer_mismatch', 'native_unsupported_platform',
  'native_unexpected_uid', 'native_invalid_mode', 'native_identity_set_changed',
  'native_list_changed_during_scan',
  'coalition_list_size_unconfirmed', 'coalition_list_unconfirmed',
  'coalition_duplicate', 'coalition_member_changed', 'coalition_count_changed',
  'coalition_members_incomplete', 'coalition_missing_with_members',
  'member_unique_identity_unconfirmed', 'member_unique_identity_invalid',
  'member_identity_changed', 'member_coalition_changed',
  'audit_token_signal_unsupported', 'member_request_invalid',
  'member_signal_unconfirmed'
]);
function classifyHelperFailure(error) {
  const unavailable = { verified: false, reason: 'helper_unavailable' };
  if (error?.code !== 2 || error.killed !== false || error.signal != null ||
      typeof error.stdout !== 'string' || error.stdout.length > 512) return unavailable;
  try {
    const reply = JSON.parse(error.stdout);
    if (!reply || Array.isArray(reply) || typeof reply !== 'object' ||
        Object.keys(reply).length !== 2 || !Object.hasOwn(reply, 'verified') ||
        !Object.hasOwn(reply, 'reason') || reply.verified !== false ||
        !EXIT_2_HELPER_REASONS.has(reply.reason)) return unavailable;
    return { verified: false, reason: reply.reason };
  } catch { return unavailable; }
}

/** Trusted local pure test seam; never accepts a remote RPC input. */
export const classifyExecutorHelperFailureForTest = classifyHelperFailure;

/** Trusted local seam for pure observer regression tests; never wired to RPC. */
export function createExecutorJobCohortObserverForTest(dependencies) {
  return createCohortObserver(dependencies);
}

/** Read-only current cohort evidence for Core startup admission. Never accepts
 * an in-memory plugin handle or caller-provided PID as the authority. */
export const observeExecutorJobCohort = createCohortObserver({
  readRecord: readJobRecord, canonicalPython: realpath,
  observe: (path, coalition, timeoutMs) => helper(path, 'observe', coalition, timeoutMs),
  sleep: wait, now: () => performance.now(), platform: process.platform
});

async function helper(pythonPath, mode, value, timeoutMs = 15000, execute = exec) {
  try {
    const { stdout } = await execute(pythonPath, ['-B', HELPER, mode, String(value)],
      { timeout: timeoutMs, maxBuffer: LIMIT, windowsHide: true });
    const response = JSON.parse(stdout);
    return response?.verified ? response : { verified: false, reason: response?.reason || 'helper_unconfirmed' };
  } catch (error) {
    return classifyHelperFailure(error);
  }
}

async function startupObservation(pythonPath, mode, value, execute = exec) {
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await helper(pythonPath, mode, value, 15000, execute);
    if (result.verified || !/^native_(?:identity_set_changed|list_changed_during_scan)$/.test(result.reason || ''))
      break;
  }
  return result;
}

/** Trusted local test seam; injected exec observes the real helper/startup path. */
export const startupObservationForTest = (execute, mode = 'observe') =>
  startupObservation('/test/python', mode, 1, execute);

function readLine(socket, max = 1024) {
  return new Promise((resolveLine, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => error(new Error('handshake_timeout')), 10000);
    const cleanup = () => { clearTimeout(timer); socket.off('data', data); socket.off('error', error); socket.off('close', closed); };
    const error = e => { cleanup(); reject(e); };
    const closed = () => error(new Error('socket_closed_before_handshake'));
    const data = chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(10);
      if (bytes.length > max || (newline >= 0 && newline !== bytes.length - 1))
        return error(new Error('handshake_frame_invalid'));
      if (newline >= 0) { cleanup(); socket.pause(); resolveLine(bytes.subarray(0, newline).toString()); }
    };
    socket.on('data', data); socket.once('error', error); socket.once('close', closed);
    socket.resume();
  });
}

function within(promise, ms, label) {
  let timer;
  return Promise.race([promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })
  ]).finally(() => clearTimeout(timer));
}

/** Internal socket primitive exported for isolated protocol regression tests. */
export async function privateServer(path, secret, onFault, onClosed) {
  const server = createServer();
  const sockets = new Set();
  const connection = new Promise((resolveConnection, rejectConnection) => {
    let accepted = false;
    server.on('connection', async socket => {
      let authenticated = false;
      sockets.add(socket);
      socket.on('close', () => { sockets.delete(socket); if (authenticated) onClosed(); });
      // Keep a permanent error observer after handshake; pipe() does not
      // forward source errors and an unhandled socket error would crash Node.
      socket.on('error', () => { if (authenticated) onFault(); });
      if (accepted) { socket.destroy(); return; }
      accepted = true;
      try {
        if (await readLine(socket, 100) !== secret) throw new Error('unauthorized_socket');
        authenticated = true;
        socket.write('1');
        resolveConnection(socket);
      } catch (error) { socket.destroy(); rejectConnection(error); }
    });
    server.once('error', rejectConnection);
  });
  // A failed early authentication can precede the caller attaching a waiter.
  connection.catch(() => {});
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(path, () => { server.off('error', rejectListen); resolveListen(); });
  });
  await chmod(path, 0o600);
  return { server, connection, closeAll() {
    for (const socket of sockets) socket.destroy();
    if (server.listening) server.close();
  } };
}

export class MacosExecutorJob {
  #secret; #pythonPath; #directory; #label; #taskId; #servers = new Map(); #sockets = new Map();
  #attempted = false; #removeRequested = false; #retired = false; #identity = null;
  #stdin = null; #stdout = null; #stderr = null;
  #ioFault = false; #ioClosed = new Set();
  #recordRoot; #record; #recordWrite = Promise.resolve(); #recordFailure = false;
  #recovered = false; #externalAttempted = false;
  #spawnPromise = null; #stopRequested = false; #removePromise = null;
  constructor(authority, { directory, label, secret, pythonPath, taskId, recordRoot, record } = {}) {
    if (authority !== CONSTRUCT) throw new Error('job_must_be_prepared');
    this.#directory = directory;
    this.#label = label;
    this.#taskId = taskId;
    this.#secret = secret;
    this.#pythonPath = pythonPath;
    this.#recordRoot = recordRoot;
    this.#record = record;
    Object.preventExtensions(this);
  }

  get directory() { return this.#directory; }
  get label() { return this.#label; }
  get taskId() { return this.#taskId; }
  get recordId() { return this.#record?.recordId; }
  get recordRoot() { return this.#recordRoot; }
  get identity() { return this.#identity ? structuredClone(this.#identity) : null; }
  get stdin() { return this.#stdin; }
  get stdout() { return this.#stdout; }
  get stderr() { return this.#stderr; }
  toJSON() { return { state: this.#retired ? 'retired' : this.#attempted ? 'unconfirmed' : 'prepared' }; }

  async #persist(patch) {
    this.#recordWrite = this.#recordWrite.then(async () => {
      const next = { ...this.#record, ...patch, generation: this.#record.generation + 1 };
      await writeJobRecord(this.#recordRoot, next, this.#record.generation);
      this.#record = next;
    });
    try { await this.#recordWrite; }
    catch (error) { this.#recordFailure = true; throw error; }
  }

  static async recover({ recordRoot, recordId, taskId, cwd, pythonPath } = {}) {
    if (process.platform !== 'darwin') return unknown('unsupported_platform');
    try {
      if (typeof pythonPath !== 'string' || !isAbsolute(pythonPath))
        throw new Error('job_python_path_invalid');
      const workspace = await realpath(cwd);
      const record = await readJobRecord(recordRoot, recordId, taskId, workspace);
      if (record.pythonPath !== await realpath(pythonPath))
        throw new Error('job_python_binding_changed');
      const owner = await helper(pythonPath, 'inspect', record.ownerIdentity?.pid);
      if (!owner.verified) throw new Error('job_owner_identity_unconfirmed');
      if (owner.identity && sameBirth(owner.identity, record.ownerIdentity))
        throw new Error('job_original_owner_still_alive');
      const job = new MacosExecutorJob(CONSTRUCT, { directory: record.directory,
        label: record.label, secret: null, pythonPath, taskId,
        recordRoot: record.recordRoot, record });
      job.#attempted = record.attempted;
      job.#externalAttempted = record.attempted;
      job.#identity = record.identity ? Object.freeze({ ...record.identity,
        coalition: Object.freeze({ ...record.identity.coalition }) }) : null;
      job.#ioFault = record.ioFault;
      job.#removeRequested = record.phase === 'retired';
      job.#retired = record.phase === 'retired';
      job.#recovered = true;
      return { verified: true, unknown: false, job };
    } catch (error) { return unknown(error.message.startsWith('job_') ? error.message : 'job_recovery_unconfirmed'); }
  }

  spawn({ testFailpoint = null, testBarrier = null } = {}) {
    if (this.#attempted || this.#spawnPromise) return Promise.reject(new Error('job_start_already_attempted'));
    if (this.#stopRequested) return Promise.reject(new Error('job_stop_already_requested'));
    if (this.#recovered) return Promise.reject(new Error('job_recovery_cannot_spawn'));
    if (process.platform !== 'darwin') return Promise.reject(new Error('unsupported_platform'));
    // Reserve the only start before the first await. stop() can now latch a
    // request while private sockets and the durable intent are being made.
    this.#attempted = true;
    const work = this.#spawnStarted(testFailpoint, testBarrier);
    this.#spawnPromise = work;
    return work;
  }

  async #spawnStarted(testFailpoint, testBarrier) {
    const fail = stage => {
      if (testFailpoint === stage && process.env.SEQIVO_JOB_TEST_FAILPOINTS === '1')
        throw new Error(`job_test_${stage}`);
    };
    const pause = async stage => {
      if (process.env.SEQIVO_JOB_TEST_FAILPOINTS === '1' && typeof testBarrier === 'function')
        await testBarrier(stage);
    };
    try {
      for (const name of ['control', 'stdin', 'stdout', 'stderr'])
        this.#servers.set(name, await privateServer(join(this.directory, `${name}.sock`), this.#secret,
          () => { this.#ioFault = true; this.#stdin?.destroy();
            void this.#persist({ ioFault: true, resultUnknown: true }).catch(() => {}); },
          () => this.#ioClosed.add(name)));
      const args = ['submit', '-l', this.label, '-o', join(this.directory, 'job.out'),
        '-e', join(this.directory, 'job.err'), '--', this.#pythonPath, '-B', HELPER, 'launch', this.directory];
      // From this point a timeout/failure may have created a live job. Never
      // issue a second submit with the same or a fresh label via this handle.
      await this.#persist({ phase: 'intent', attempted: true });
      fail('beforeSubmit');
      if (this.#stopRequested) throw new Error('job_stop_requested');
      this.#externalAttempted = true;
      await exec('/bin/launchctl', args, { timeout: 10000, maxBuffer: LIMIT, windowsHide: true });
      fail('afterSubmit');
      await pause('afterSubmit');
      if (this.#stopRequested) throw new Error('job_stop_requested');
      const sockets = await within(Promise.all([
        ...this.#servers].map(async ([name, item]) => [name, await item.connection])),
        10000, 'job_handshake_timeout');
      for (const [name, socket] of sockets) this.#sockets.set(name, socket);
      if (this.#ioFault) throw new Error('job_socket_error');
      const raw = await within(readLine(this.#sockets.get('control'), 512),
        10000, 'job_identity_handshake_timeout');
      const announced = JSON.parse(raw);
      const checked = await startupObservation(this.#pythonPath, 'inspect', announced.pid);
      if (!checked.verified || !checked.identity ||
        !sameIdentity(checked.identity, { ...announced, euid: process.geteuid() }) ||
        checked.identity.coalition?.jetsam !== announced.coalition?.jetsam)
        throw new Error('job_identity_unconfirmed');
      const observed = await startupObservation(this.#pythonPath, 'observe', announced.coalition.resource);
      if (!observed.verified || observed.count !== 1 || observed.members.length !== 1 ||
        !sameIdentity(observed.members[0], checked.identity))
        throw new Error('job_coalition_not_unique');
      if (this.#ioFault) throw new Error('job_socket_error');
      if (this.#stopRequested) throw new Error('job_stop_requested');
      fail('beforeIdentityCommit');
      // The command cannot exec until this exact native identity is fsynced.
      await this.#persist({ phase: 'identity', identity: checked.identity });
      this.#identity = Object.freeze({ ...checked.identity,
        coalition: Object.freeze({ ...checked.identity.coalition }) });
      await pause('beforeAck');
      if (this.#stopRequested) throw new Error('job_stop_requested');
      this.#sockets.get('control').write('1');
      this.#stdin = this.#sockets.get('stdin');
      // A PassThrough buffers early command output until the caller attaches.
      // Directly resuming the socket here discards fast output; leaving it
      // paused forever would make even `cat` appear hung.
      this.#stdout = new PassThrough(); this.#stderr = new PassThrough();
      this.#sockets.get('stdout').pipe(this.#stdout);
      this.#sockets.get('stderr').pipe(this.#stderr);
      for (const { server } of this.#servers.values()) server.close();
      return { stdin: this.#stdin, stdout: this.#stdout, stderr: this.#stderr,
        identity: this.identity, label: this.label };
    } catch (error) {
      // A submitted job may still exist. Preserve authority and its private
      // directory for recheck; request removal of this unique label to stop
      // launchctl's retry-on-failure loop, but never call removal proof.
      if (this.#externalAttempted) await this.#requestRemoval();
      for (const entry of this.#servers.values()) entry.closeAll();
      const failure = new Error('job_start_unconfirmed');
      Object.defineProperty(failure, 'reason', { value: /^job_[a-z_]+$/.test(error.message)
        ? error.message : 'startup_observation_unconfirmed', enumerable: false });
      Object.defineProperty(failure, 'recovery', { value: this, enumerable: false });
      throw failure;
    }
  }

  async inspect() {
    if (!this.#attempted || !this.#identity) return unknown('job_identity_unavailable');
    if (this.#recordFailure) return unknown('job_record_write_failed');
    const observed = await helper(this.#pythonPath, 'observe', this.#identity.coalition.resource);
    if (!observed.verified) return unknown(observed.reason || 'coalition_observation_unconfirmed');
    // A replaced leader PID is never adopted as the original job.
    const leader = observed.members.find(row => row.pid === this.#identity.pid);
    if (leader && !sameIdentity(leader, this.#identity)) return unknown('job_pid_identity_changed');
    return { verified: true, retired: false, unknown: false, scope: SCOPED,
      count: observed.count, members: observed.members,
      ioFault: this.#ioFault, resultUnknown: true };
  }

  async stop() {
    // This line runs synchronously when stop() is called, before any await.
    this.#stopRequested = true;
    this.#stdin?.destroy();
    if (this.#spawnPromise) await this.#spawnPromise.catch(() => {});
    if (!this.#attempted) return unknown('job_not_submitted');
    return this.#requestRemoval();
  }

  async #requestRemoval() {
    if (this.#removePromise) return this.#removePromise;
    const work = this.#removeAndRecheck();
    this.#removePromise = work;
    try { return await work; }
    finally { if (this.#removePromise === work) this.#removePromise = null; }
  }

  async #removeAndRecheck() {
    if (this.#recordFailure) return unknown('job_record_write_failed');
    if (!this.#removeRequested) {
      try { await this.#persist({ phase: 'stop_intent', ioFault: this.#ioFault,
        resultUnknown: true }); }
      catch { return unknown('job_stop_intent_not_durable'); }
      try {
        await exec('/bin/launchctl', ['remove', this.label],
          { timeout: 10000, maxBuffer: LIMIT, windowsHide: true });
        this.#removeRequested = true;
      } catch {
        // A timed-out remove may already have taken effect. Only a fresh
        // query of our unpredictable label can establish that it is absent;
        // process/cohort retirement still needs the independent proof below.
        try {
          await exec('/bin/launchctl', ['list', this.label],
            { timeout: 10000, maxBuffer: LIMIT, windowsHide: true });
          return unknown('job_remove_unconfirmed');
        } catch (error) {
          if (error.code !== 113) return unknown('job_label_status_unconfirmed');
          this.#removeRequested = true;
        }
      }
    }
    const first = await this.recheck();
    if (first.retired || !first.verified || first.count === 0) return first;
    // Existing records without the original native unique identity can only
    // retire naturally. A recovered handle must never invent signal authority.
    if (!hasSignalIdentity(this.#identity)) return unknown('job_legacy_signal_identity_unavailable');
    return this.#stopOriginalMembers();
  }

  async #stopOriginalMembers() {
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (const [signal, rounds] of [['TERM', 4], ['KILL', 4]]) {
      for (let round = 0; round < rounds; round++) {
        const state = await this.recheck();
        if (state.retired || !state.verified || state.count === 0) return state;
        if (state.members.length !== state.count ||
          state.members.some(member => !hasSignalIdentity(member) ||
            member.coalition?.resource !== this.#identity.coalition.resource ||
            member.euid !== process.geteuid()))
          return unknown('job_member_identity_unconfirmed');
        // Each call checks full native identity twice and the kernel matches
        // pidversion again. ESRCH/exec races require a new complete snapshot;
        // no PID-only fallback is allowed.
        for (const member of state.members) {
          const response = await helper(this.#pythonPath, 'signal-member', JSON.stringify({
            pid: member.pid, euid: member.euid, ruid: member.ruid,
            startSec: member.startSec, startUsec: member.startUsec,
            uniqueid: member.uniqueid, pidversion: member.pidversion,
            resource: this.#identity.coalition.resource, signal: signal === 'TERM' ? 15 : 9
          }));
          if (!response.verified && response.reason !== 'member_changed_before_signal')
            return unknown(response.reason || 'job_member_signal_unconfirmed');
        }
        await pause(150);
      }
    }
    return this.recheck();
  }

  async recheck() {
    if (!this.#removeRequested || !this.#identity) return unknown('job_stop_or_identity_unconfirmed');
    if (this.#recordFailure) return unknown('job_record_write_failed');
    // Removal is asynchronous. A label still present may restart a failed job.
    try {
      await exec('/bin/launchctl', ['list', this.label],
        { timeout: 10000, maxBuffer: LIMIT, windowsHide: true });
      return unknown('job_label_still_present');
    } catch (error) {
      if (error.code !== 113) return unknown('job_label_status_unconfirmed');
    }
    const observed = await this.inspect();
    if (!observed.verified) return observed;
    if (observed.count !== 0 || observed.members.length)
      return { ...observed, retired: false, reason: 'coalition_members_live' };
    if (!this.#recovered && (!this.#ioClosed.has('stdout') || !this.#ioClosed.has('stderr')))
      return unknown('job_output_streams_open');
    try { await this.#persist({ phase: 'retired', ioFault: this.#ioFault,
      resultUnknown: true }); }
    catch { return unknown('job_retirement_not_durable'); }
    this.#retired = true;
    return { verified: true, retired: true, unknown: false, scope: SCOPED,
      count: 0, members: [], ioFault: this.#ioFault, resultUnknown: true,
      streamStatus: this.#recovered ? 'unobserved_after_owner_exit' : 'closed' };
  }

  async dispose() {
    if (this.#attempted && !this.#retired) throw new Error('job_retirement_not_verified');
    if (this.#recordFailure) throw new Error('job_record_write_failed');
    try { await checkedJobDirectory(this.#directory, this.#record.directoryIdentity); }
    catch (error) {
      if (this.#retired && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of this.#servers.values()) entry.closeAll();
    await rm(this.#directory, { recursive: true, force: true });
  }

  /** Original-owner proof that this prepared handle never entered spawn(). */
  async abandonPrepared() {
    if (this.#attempted || this.#spawnPromise || this.#recovered || this.#stopRequested || this.#retired)
      throw new Error('job_prepare_abandon_unconfirmed');
    // This latch is set before the first await, so a concurrent spawn() cannot
    // turn the never-started proof into an attempted external submission.
    this.#stopRequested = true;
    if (this.#recordFailure || this.#record?.phase !== 'prepared' || this.#identity)
      throw new Error('job_prepare_record_unconfirmed');
    await checkedJobDirectory(this.#directory, this.#record.directoryIdentity);
    await this.#persist({ phase: 'retired', attempted: false, resultUnknown: false });
    this.#retired = true;
    await this.dispose();
    return { verified: true, retired: true, neverSubmitted: true };
  }
}

export async function prepareExecutorJob({ taskId, command, args = [], cwd, env = process.env,
  pythonPath, recordRoot } = {}) {
  if (process.platform !== 'darwin') throw new Error('unsupported_platform');
  if (typeof taskId !== 'string' || !taskId || taskId.length > 200 ||
    typeof pythonPath !== 'string' || !isAbsolute(pythonPath) ||
    typeof command !== 'string' || !isAbsolute(command) ||
    !Array.isArray(args) || args.some(x => typeof x !== 'string') ||
    !env || typeof env !== 'object' || !cwd || !recordRoot)
    throw new TypeError('invalid_job_configuration');
  const root = await checkedRecordRoot(recordRoot);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-executor-job-')));
  await chmod(directory, 0o700);
  const recordId = randomBytes(16).toString('hex');
  const label = `com.seqivo.executor.${recordId}`;
  const secret = randomBytes(32).toString('hex');
  try {
    const config = { capability: secret, command: await realpath(command), args,
      cwd: await realpath(cwd), env };
    const pythonRealpath = await realpath(pythonPath);
    const owner = await startupObservation(pythonPath, 'inspect', process.pid);
    if (!owner.verified || !owner.identity || owner.identity.pid !== process.pid ||
      owner.identity.euid !== process.geteuid())
      throw new Error('job_owner_identity_unconfirmed');
    const file = await open(join(directory, 'launch.json'), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(config)); } finally { await file.close(); }
    const record = { schemaVersion: 1, recordId, taskId, workspace: config.cwd,
      recordRoot: root.path, rootIdentity: root.identity, directory,
      directoryIdentity: await checkedJobDirectory(directory), label,
      pythonPath: pythonRealpath, boot: await bootIdentity(),
      ownerIdentity: owner.identity, generation: 0, phase: 'prepared',
      attempted: false, identity: null, ioFault: false, resultUnknown: true };
    await writeJobRecord(root.path, record);
    return new MacosExecutorJob(CONSTRUCT, { directory, label, secret, pythonPath,
      taskId, recordRoot: root.path, record });
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

/** Recovery has no launch token or stdio: it can only stop/recheck the original job. */
export async function recoverExecutorJob(options) {
  return MacosExecutorJob.recover(options);
}
