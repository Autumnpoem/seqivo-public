import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createTmuxAdapter } from './tmux.mjs';
import { connectManagedPane, createManagedTmuxSession, prepareManagedPane } from './managed-pane.mjs';
import { nativeSelectedIdentities } from './process-identities.mjs';

const VERSION = 1;
const LINUX_VERSION = 2;
const RECORD = 'record.json';
// The supervisor is deliberately detached and may be reparented when the app
// restarts. Its PPID is observational, not part of the process birth identity.
const IDENTITY_FIELDS = ['pid', 'pgid', 'euid', 'ruid', 'startSec', 'startUsec'];
const LINUX_IDENTITY_FIELDS = ['kind', 'pid', 'pgid', 'euid', 'ruid', 'bootId', 'startTicks'];
const secret = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validName = value => typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function unknown(message, diagnostic, snapshotDiagnostic, proofStage) {
  const error = Object.assign(new Error(message), { code: 'MANAGED_PANE_UNKNOWN' });
  // A fixed, private category is useful when an outer layer must retain the
  // original public error. Never attach process commands, paths or capabilities.
  if (diagnostic) Object.defineProperty(error, 'diagnostic', { value: diagnostic });
  if (snapshotDiagnostic) Object.defineProperty(error, 'snapshotDiagnostic', { value: snapshotDiagnostic });
  if (proofStage) Object.defineProperty(error, 'proofStage', { value: proofStage });
  return error;
}

function assertSupported() {
  if (!['darwin', 'linux'].includes(process.platform) || typeof process.geteuid !== 'function')
    throw unknown('Exact managed pane recovery is unsupported on this platform');
}
function assertConfig(config) {
  if (!config || !['recordRoot', 'pythonPath', 'shell', 'cwd', 'tmuxPath'].every(key =>
      typeof config[key] === 'string' && isAbsolute(config[key])) ||
      !validName(config.serverName) || !validName(config.name) ||
      config.args !== undefined && (!Array.isArray(config.args) || config.args.some(item => typeof item !== 'string')) ||
      config.rows !== undefined && (!Number.isInteger(config.rows) || config.rows < 5 || config.rows > 100) ||
      config.cols !== undefined && (!Number.isInteger(config.cols) || config.cols < 20 || config.cols > 300))
    throw new TypeError('Invalid managed tmux record configuration');
}
async function recordDirectory(recordRoot, recordPath) {
  const root = await realpath(recordRoot);
  if (!isAbsolute(recordPath) || basename(recordPath) !== RECORD ||
      resolve(dirname(dirname(recordPath))) !== root ||
      !/^seqivo-pane-record-[A-Za-z0-9]+$/.test(basename(dirname(recordPath))))
    throw unknown('Managed pane record is outside its expected root');
  const dir = dirname(recordPath);
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o700)
    throw unknown('Managed pane record directory identity is invalid');
  return dir;
}
async function privateFile(path, { optional = false } = {}) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid() ||
        (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > 65536)
      throw unknown('Managed pane private file identity is invalid');
    return await handle.readFile();
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}
async function durableWrite(path, value) {
  const dir = dirname(path), temporary = join(dir, `record-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, path);
    const directory = await open(dir, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
async function load({ recordRoot, recordPath }) {
  await recordDirectory(recordRoot, recordPath);
  let record;
  try { record = JSON.parse((await privateFile(recordPath)).toString('utf8')); }
  catch (error) { throw unknown(`Managed pane record unreadable: ${error.code || 'invalid'}`); }
  const p = record?.pane;
  if (!(process.platform === 'darwin' ? record?.version === VERSION && record.identityKind === undefined :
        record?.version === LINUX_VERSION && record.identityKind === 'linux-proc') ||
      !['prepared', 'starting', 'started', 'unknown'].includes(record.status) ||
      typeof record.id !== 'string' || !/^[0-9a-f-]{36}$/.test(record.id) ||
      !p || !secret(p.capability) || !secret(p.relayCapability) ||
      !isAbsolute(p.directory) || p.socketPath !== join(p.directory, 'control.sock') ||
      p.relaySocketPath !== join(p.directory, 'relay.sock') || p.relayTokenFile !== join(p.directory, 'relay.token') ||
      !record.config || !validName(record.config.serverName) || !validName(record.config.name) ||
      !isAbsolute(record.config.socketRoot) ||
      resolve(dirname(p.directory)) !== record.config.socketRoot ||
      !/^seqivo-managed-pane-[A-Za-z0-9]+$/.test(basename(p.directory)))
    throw unknown('Managed pane record content is invalid');
  const socketDir = await lstat(p.directory);
  if (!socketDir.isDirectory() || socketDir.isSymbolicLink() || socketDir.uid !== process.geteuid() ||
      (socketDir.mode & 0o777) !== 0o700) throw unknown('Managed pane socket directory identity is invalid');
  if (record.status === 'prepared') {
    const token = await privateFile(p.relayTokenFile);
    if (token.toString('utf8') !== p.relayCapability)
      throw unknown('Managed pane relay token changed');
  }
  return record;
}
function publicRecord(record, recordPath) {
  const value = { recordId: record.id, status: record.status };
  Object.defineProperty(value, 'recordPath', { value: recordPath });
  return Object.freeze(value);
}
function privateResult(value) {
  const { pane, recordPath, ...visible } = value;
  Object.defineProperties(visible, { pane: { value: pane }, recordPath: { value: recordPath } });
  return visible;
}
const sameIdentity = (a, b) => a && b &&
  (process.platform === 'linux' ? LINUX_IDENTITY_FIELDS : IDENTITY_FIELDS).every(key => a[key] === b[key]);
function matched(row, recorded) {
  return row && recorded && sameIdentity(row, recorded) && row.euid === process.geteuid() &&
    row.ruid === process.getuid();
}
async function identities(pythonPath, supervisorPid, childPid, relayPid, expected = null) {
  let rows;
  try { rows = await nativeSelectedIdentities(pythonPath, [supervisorPid, childPid, relayPid], 15000); }
  catch (error) { throw unknown('Managed pane process identity could not be sampled', 'identity_snapshot', error?.snapshotDiagnostic); }
  const supervisor = rows.get(supervisorPid), shell = rows.get(childPid), relay = rows.get(relayPid);
  if (!supervisor || !shell || !relay || shell.ppid !== supervisorPid ||
      [supervisor, shell, relay].some(row => row.euid !== process.geteuid() || row.ruid !== process.getuid()) ||
      expected && (!matched(supervisor, expected.supervisor) || !matched(shell, expected.shell) ||
        !matched(relay, expected.relay)))
    throw unknown('Managed pane process identity changed or is unconfirmed', 'identity_mismatch');
  return { supervisor, shell, relay };
}
async function exactTmux(record) {
  const adapter = createTmuxAdapter({ executable: record.config.tmuxPath, serverName: record.config.serverName });
  let sessions;
  try { sessions = await adapter.sessionsPanes([record.tmux.sessionRef]); }
  catch { throw unknown('Original managed tmux pane could not be queried', 'tmux_query'); }
  const panes = sessions?.[0]?.panes;
  if (!Array.isArray(panes) || panes.length !== 1 || panes[0].paneId !== record.tmux.relayPaneId ||
      panes[0].pid !== record.tmux.relayPanePid)
    throw unknown('Original managed tmux pane identity changed', 'tmux_mismatch');
}

/** Persist private credentials and startup intent before any shell exists. */
export async function prepareManagedTmuxSession(config) {
  assertSupported();
  assertConfig(config);
  const root = await realpath(config.recordRoot);
  const socketRoot = await realpath(config.socketRoot || tmpdir());
  const directory = await mkdtemp(join(root, 'seqivo-pane-record-'));
  let pane;
  try {
    await chmod(directory, 0o700);
    pane = await prepareManagedPane({ rootDir: socketRoot, relay: true });
    const record = { version: process.platform === 'linux' ? LINUX_VERSION : VERSION,
      ...(process.platform === 'linux' ? {identityKind:'linux-proc'} : {}), id: randomUUID(), status: 'prepared', pane,
      config: { pythonPath: config.pythonPath, shell: config.shell, args: config.args || ['-i'],
        cwd: config.cwd, tmuxPath: config.tmuxPath, socketRoot, serverName: config.serverName, name: config.name,
        rows: config.rows || 24, cols: config.cols || 80 } };
    const recordPath = join(directory, RECORD);
    await durableWrite(recordPath, record);
    return publicRecord(record, recordPath);
  } catch (error) {
    if (pane) await rm(pane.directory, { recursive: true, force: true }).catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** A durable one-shot transition: any uncertain start must be reconciled, never retried. */
export async function startPreparedManagedTmuxSession({ recordRoot, recordPath }) {
  assertSupported();
  const lockPath = join(dirname(recordPath), 'start.lock');
  await recordDirectory(recordRoot, recordPath);
  let lock;
  try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
  catch (error) { throw unknown(error.code === 'EEXIST'
    ? 'Managed pane start was already attempted' : 'Managed pane start intent could not be persisted'); }
  try { await lock.sync(); } finally { await lock.close(); }
  const record = await load({ recordRoot, recordPath });
  if (record.status !== 'prepared') throw unknown('Managed pane start was already attempted');
  record.status = 'starting';
  await durableWrite(recordPath, record);
  let subject;
  try {
    subject = await createManagedTmuxSession({ ...record.config, preparedPane: record.pane });
    const before = await identities(record.config.pythonPath, subject.shellIdentity.supervisorPid,
      subject.shellIdentity.childPid, subject.relayPanePid);
    record.tmux = { sessionRef: subject.sessionRef, relayPaneId: subject.relayPaneId,
      relayPanePid: subject.relayPanePid };
    await exactTmux(record);
    let status;
    for (let attempt = 0; attempt < 50; attempt++) {
      status = await subject.pane.status();
      if (status.relayConnected === true) break;
      await sleep(40);
    }
    if (status?.relayConnected !== true || status.state !== 'running')
      throw unknown('Managed pane relay startup was not confirmed');
    const after = await identities(record.config.pythonPath, subject.shellIdentity.supervisorPid,
      subject.shellIdentity.childPid, subject.relayPanePid, before);
    record.identities = after;
    record.status = 'started';
    await durableWrite(recordPath, record);
    return privateResult({ ...subject, recordId: record.id, recordPath, identities: after });
  } catch {
    // A shell may already exist. Keep the capability and coordinates on disk,
    // but never start again or claim a recovered identity from PID alone.
    record.status = 'unknown';
    await durableWrite(recordPath, record).catch(() => {});
    subject?.pane?.close();
    throw unknown('Managed pane start outcome is unknown; private recovery record retained');
  }
}

/** Reconnect only the original, fully persisted supervisor, child and tmux pane. */
export async function reconnectManagedTmuxSession({ recordRoot, recordPath }) {
  assertSupported();
  const record = await load({ recordRoot, recordPath });
  if (record.status !== 'started' || !record.identities || !record.tmux)
    throw unknown('Managed pane has no confirmed original identity');
  let pane, stage = 'reconnect_identity_before';
  try {
    const before = await identities(record.config.pythonPath, record.identities.supervisor.pid,
      record.identities.shell.pid, record.tmux.relayPanePid, record.identities);
    stage = 'reconnect_tmux_before';
    await exactTmux(record);
    stage = 'reconnect_socket';
    pane = await connectManagedPane({ socketPath: record.pane.socketPath, capability: record.pane.capability,
      expectedIdentity: { supervisorPid: before.supervisor.pid, childPid: before.shell.pid } });
    stage = 'reconnect_status_query';
    const status = await pane.status();
    if (status.supervisorPid !== before.supervisor.pid || status.childPid !== before.shell.pid ||
        status.state === 'unknown' || status.relayConnected !== true)
      throw unknown('Managed pane status is not confirmed', 'reconnect_status_mismatch');
    stage = 'reconnect_identity_after';
    await identities(record.config.pythonPath, before.supervisor.pid, before.shell.pid,
      record.tmux.relayPanePid, before);
    stage = 'reconnect_tmux_after';
    await exactTmux(record);
    return privateResult({ pane, sessionRef: record.tmux.sessionRef,
      shellIdentity: { supervisorPid: before.supervisor.pid, childPid: before.shell.pid },
      relayPaneId: record.tmux.relayPaneId, relayPanePid: record.tmux.relayPanePid,
      recordId: record.id, recordPath, identities: before,
      outputGap: { bytes: status.outputGapBytes, unknown: status.outputGapUnknown } });
  } catch (error) {
    pane?.close();
    throw unknown('Managed pane original identity could not be confirmed', error?.diagnostic || stage, error?.snapshotDiagnostic, stage);
  }
}

/** Read-only identity check for an already connected controller. This never
 * opens a second control socket (which would freeze the active relay). */
export async function verifyManagedTmuxSession({ recordRoot, recordPath }) {
  assertSupported();
  const record = await load({ recordRoot, recordPath });
  if (record.status !== 'started' || !record.identities || !record.tmux)
    throw unknown('Managed pane has no confirmed original identity');
  let stage = 'verify_identity_before';
  try {
    const before = await identities(record.config.pythonPath, record.identities.supervisor.pid,
      record.identities.shell.pid, record.tmux.relayPanePid, record.identities);
    stage = 'verify_tmux_before';
    await exactTmux(record);
    stage = 'verify_identity_after';
    await identities(record.config.pythonPath, before.supervisor.pid, before.shell.pid,
      record.tmux.relayPanePid, before);
    stage = 'verify_tmux_after';
    await exactTmux(record);
    return { recordId: record.id, sessionRef: record.tmux.sessionRef,
      relayPaneId: record.tmux.relayPaneId, relayPanePid: record.tmux.relayPanePid,
      identities: before };
  } catch (error) {
    throw unknown('Managed pane original identity could not be confirmed', error?.diagnostic || stage, error?.snapshotDiagnostic, stage);
  }
}
