import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectWorkspaceWriters } from './terminal/process-inspection.mjs';

const SCOPE = 'macos-observed-managed-command-trees-and-current-workspace-writers';
const MAX_PROCESSES = 256;
const MAX_TABLE = 65536;
const SNAPSHOT_HELPER = fileURLToPath(new URL('../plugins/codex-autocontinue/process_snapshot.py', import.meta.url));
// Captures are executor-lifetime capabilities, never importable JSON assertions.
// Restart recovery must observe a new baseline; old serialized data is evidence,
// not permission to claim that a now-unobservable process tree has stopped.
const issuedCaptures = new WeakSet();
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
const hash = value => createHash('sha256').update(value).digest('hex');
const validPid = value => Number.isSafeInteger(value) && value > 1;
const identityKey = row => `${row.pid}:${row.ppid}:${row.pgid}:${row.startedAt}`;
const birthKey = row => [row.pid, row.pgid, row.euid, row.ruid, row.startSec, row.startUsec].join(':');
const publicIdentity = (row, command) => ({ ...row, commandHash: hash(command) });
const within = (root, path) => {
  const rel = relative(root, path);
  return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const canonicalDirectory = path => {
  if (typeof path !== 'string' || path.length > 8192 || !isAbsolute(path)) throw new Error('Invalid workspace directory');
  const resolved = realpathSync(path);
  if (!statSync(resolved).isDirectory()) throw new Error('Workspace is not a directory');
  return resolved;
};
// lsof's printed names are not reversible: literal "\\xe4" and an escaped byte
// can have the same display. Correlate cwd using the kernel file identity instead.
const directoryIdentity = path => {
  const stat = statSync(path, { bigint: true });
  if (!stat.isDirectory()) throw new Error('Workspace is not a directory');
  return `${stat.dev.toString(16)}:${stat.ino.toString()}`;
};
const unknown = reason => ({ verified: false, stopped: false, unknown: true, liveIdentities: [], scope: SCOPE, reason });
const execute = (executable, args, timeoutMs, { nativeSnapshot = false } = {}) => new Promise((resolve, reject) => {
  execFile(executable, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (error, stdout, stderr) => {
    // Neither a truncated table nor a partial lsof response can support a proof.
    // The native helper deliberately exits 2 with bounded JSON when observation
    // is incomplete. Preserve its structured reason instead of hiding it as an
    // unspecified command error. Never surface argv, paths or raw stderr here.
    if ((error && !(nativeSnapshot && error.code === 2 && !error.signal && !error.killed)) || stderr?.trim())
      reject(new Error(nativeSnapshot ? 'Native process snapshot command failed' : 'Process inspection command failed'));
    else resolve(stdout);
  });
});

export async function processTable(psPath, timeoutMs) {
  // Read argv separately: a command may contain embedded newlines, which must not
  // turn the next line into a forged process-table row.
  const output = await execute(psPath, ['-axo', 'pid=,ppid=,pgid=,lstart='], timeoutMs);
  const rows = new Map();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(line);
    if (!match) throw new Error('Malformed process table');
    const row = { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startedAt: match[4].replace(/\s+/g, ' ') };
    if (!Number.isSafeInteger(row.pid) || row.pid < 1 || rows.has(row.pid) || rows.size >= MAX_TABLE)
      throw new Error('Ambiguous or oversized process table');
    rows.set(row.pid, row);
  }
  if (!rows.size) throw new Error('Empty process table');
  return rows;
}

async function readNativeProcessSnapshot(pythonPath, timeoutMs, { allVisible = false, singleObservation = false } = {}) {
  if (typeof pythonPath !== 'string' || !pythonPath.trim() || pythonPath.length > 8192)
    throw new Error('Native process snapshot requires the configured Python executable');
  const uid = process.geteuid();
  const raw = await execute(pythonPath, ['-B', SNAPSHOT_HELPER, '--expected-uid', String(uid),
    ...(allVisible ? ['--all-visible'] : []), ...(singleObservation ? ['--single-observation'] : [])], timeoutMs, { nativeSnapshot: true });
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error('Malformed native process snapshot'); }
  const linux = process.platform === 'linux', schemaVersion = linux ? 2 : 1;
  if (result?.schemaVersion === schemaVersion && result.uid === uid && result.verified === false &&
      typeof result.reason === 'string' && /^[a-z_]{1,64}$/.test(result.reason) &&
      Array.isArray(result.rows) && result.rows.length === 0) {
    const error = new Error(`Native process snapshot is unconfirmed: ${result.reason}`);
    // A fixed, non-enumerable category for internal diagnostics. Never expose
    // the helper's raw output, stderr, command, or process table.
    const categories = new Set(['abi_mismatch','libproc_unavailable','list_size_failed',
      'list_capacity_exceeded','list_failed','list_truncated','list_invalid_pid',
      'list_duplicate_pid','pid_info_incomplete','pid_identity_changed',
      'observer_missing','list_changed_during_scan','kinfo_abi_unsupported',
      'kinfo_size_failed','kinfo_size_invalid','kinfo_read_failed',
      'kinfo_partial_result','kinfo_identity_invalid',
      'kinfo_abi_or_observer_mismatch','unsupported_platform','unexpected_uid',
      'identity_set_changed']);
    if (categories.has(result.reason)) Object.defineProperty(error, 'snapshotDiagnostic', { value: result.reason });
    throw error;
  }
  if (result?.schemaVersion !== schemaVersion || result.verified !== true || result.reason !== null ||
    result.uid !== uid || !validPid(result.observerPid) || result.ignoredObserverPid !== result.observerPid ||
    result.scope !== (linux
      ? singleObservation ? 'linux-current-effective-uid-complete-observation' :
        allVisible ? 'linux-all-visible-exact-births-two-observed-enumerations' : 'linux-current-effective-uid-two-observed-enumerations'
      : singleObservation ? 'macos-current-effective-uid-complete-observation' :
        allVisible ? 'macos-all-visible-exact-births-two-observed-enumerations' : 'macos-current-effective-uid-two-observed-enumerations') ||
    !Number.isInteger(result.attempts) || (singleObservation ? result.attempts !== 1 : result.attempts < 2 || result.attempts > 8) ||
    !Array.isArray(result.rows) || result.rows.length > MAX_TABLE)
    throw new Error('Unverified native process snapshot');
  const rows = new Map();
  for (const row of result.rows) {
    if (!Number.isSafeInteger(row?.pid) || row.pid < (linux || allVisible ? 1 : 2) || !Number.isInteger(row.ppid) || row.ppid < 0 ||
      !Number.isSafeInteger(row.pgid) || row.pgid < (linux ? 0 : allVisible ? 1 : 2) ||
      !Number.isInteger(row.euid) || row.euid < 0 || (!allVisible && row.euid !== uid) || !Number.isInteger(row.ruid) || row.ruid < 0 ||
      (linux ? row.kind !== 'linux-proc' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.bootId || '') ||
        typeof row.startTicks !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(row.startTicks) ||
        row.startTicks.length > 20 || BigInt(row.startTicks) > 18446744073709551615n
        : !Number.isSafeInteger(row.startSec) || row.startSec <= 0 ||
          !Number.isSafeInteger(row.startUsec) || row.startUsec < 0 || row.startUsec >= 1000000) ||
      rows.has(row.pid) || row.pid === result.observerPid)
      throw new Error('Invalid native process identity');
    rows.set(row.pid, row);
  }
  return rows;
}

/** One complete current-UID bulk observation for paired terminal writer checks.
 * This is not a stable two-enumeration stop proof. The caller must compare its
 * relevant roots and each accepted writer's complete ancestry across observations.
 */
export function nativeTerminalProcessObservation(pythonPath, timeoutMs) {
  return readNativeProcessSnapshot(pythonPath, timeoutMs, {singleObservation:true});
}

export async function nativeProcessTable(pythonPath, timeoutMs, {allVisible=false, retryIdentityChurn=true}={}) {
  // A complete two-enumeration scan can straddle an unrelated short-lived
  // process. Retry only that fixed diagnostic, once, inside the caller's
  // original monotonic budget. Neither scan contributes partial rows.
  const deadline = performance.now() + timeoutMs;
  const remaining = () => Math.floor(deadline - performance.now());
  const read = async () => {
    const budget = remaining();
    if (budget < 1) throw new Error('Native process snapshot deadline exceeded');
    const rows = await readNativeProcessSnapshot(pythonPath, budget, { allVisible });
    if (performance.now() >= deadline) throw new Error('Native process snapshot deadline exceeded');
    return rows;
  };
  try { return await read(); }
  catch (error) {
    if (!retryIdentityChurn || error?.snapshotDiagnostic !== 'identity_set_changed') throw error;
    return read();
  }
}

function stableNative(psBefore, psAfter, nativeBefore, nativeAfter, pids) {
  for (const pid of new Set(pids)) {
    const first = psBefore.get(pid), second = psAfter.get(pid);
    const nFirst = nativeBefore.get(pid), nSecond = nativeAfter.get(pid);
    if (Boolean(first) !== Boolean(second) || Boolean(nFirst) !== Boolean(nSecond) ||
      Boolean(first) !== Boolean(nFirst))
      throw new Error('Process appeared or vanished during native inspection');
    if (!first) continue;
    const firstSecond = Date.parse(first.startedAt) / 1000;
    const secondSecond = Date.parse(second.startedAt) / 1000;
    if (first.ppid !== nFirst.ppid || second.ppid !== nSecond.ppid ||
      first.pgid !== nFirst.pgid || second.pgid !== nSecond.pgid ||
      !Number.isSafeInteger(firstSecond) || !Number.isSafeInteger(secondSecond) ||
      firstSecond !== nFirst.startSec || secondSecond !== nSecond.startSec ||
      identityKey(first) !== identityKey(second) ||
      [nFirst.pid, nFirst.ppid, nFirst.pgid, nFirst.euid, nFirst.ruid, nFirst.startSec, nFirst.startUsec].join(':') !==
      [nSecond.pid, nSecond.ppid, nSecond.pgid, nSecond.euid, nSecond.ruid, nSecond.startSec, nSecond.startUsec].join(':'))
      throw new Error('Process identity changed during native inspection');
  }
}

const joinedIdentity = (psRow, nativeRow) => ({ ...psRow,
  euid: nativeRow.euid, ruid: nativeRow.ruid,
  startSec: nativeRow.startSec, startUsec: nativeRow.startUsec });

function descendants(rows, roots) {
  const found = new Set(roots);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows.values()) if (!found.has(row.pid) && found.has(row.ppid)) {
      found.add(row.pid); changed = true;
      if (found.size > MAX_PROCESSES) throw new Error('Process tree exceeds inspection limit');
    }
  }
  return found;
}

async function commandsFor(pids, psPath, timeoutMs) {
  if (pids.length > MAX_PROCESSES + 2) throw new Error('Too many command identities');
  const result = new Map();
  // Bounded concurrency and fixed executable/argv; never invoke a shell here.
  for (let offset = 0; offset < pids.length; offset += 8) {
    await Promise.all(pids.slice(offset, offset + 8).map(async pid => {
      const output = await execute(psPath, ['-ww', '-p', String(pid), '-o', 'command='], timeoutMs);
      const command = output.replace(/\r?\n$/, '');
      if (!command || command.length > 65536) throw new Error('Invalid command identity');
      result.set(pid, command);
    }));
  }
  return result;
}

async function workingDirectories(pids, lsofPath, timeoutMs) {
  if (!pids.length) return new Map();
  const output = await execute(lsofPath, ['-nP', '-a', '-p', pids.join(','), '-d', 'cwd', '-F0pfDi'], timeoutMs);
  const dirs = new Map(); let pid = null, file = null;
  const flush = () => {
    if (!file) return;
    if (!validPid(pid) || dirs.has(pid) || file.fd !== 'cwd' || !file.device || !file.inode)
      throw new Error('Ambiguous process cwd identity');
    dirs.set(pid, `${BigInt(file.device).toString(16)}:${BigInt(file.inode).toString()}`);
    file = null;
  };
  for (const part of output.split('\0')) {
    const field = part.replace(/^\n+/, '');
    if (!field) continue;
    if (field[0] === 'p') {
      flush();
      if (!/^p\d+$/.test(field)) throw new Error('Malformed cwd PID');
      pid = Number(field.slice(1));
      if (!pids.includes(pid)) throw new Error('Unexpected cwd PID');
    } else if (field[0] === 'f') {
      flush(); file = { fd: field.slice(1) };
    } else if (field[0] === 'D' || field[0] === 'i') {
      const key = field[0] === 'D' ? 'device' : 'inode';
      const pattern = key === 'device' ? /^0x[0-9a-f]+$/i : /^\d+$/;
      if (!file || file[key] || !pattern.test(field.slice(1))) throw new Error('Invalid cwd file identity');
      file[key] = field.slice(1);
    }
  }
  flush();
  if (dirs.size !== pids.length) throw new Error('A process cwd is unavailable');
  return dirs;
}

function stable(before, after, pids) {
  for (const pid of pids) if (!before.has(pid) || !after.has(pid) || identityKey(before.get(pid)) !== identityKey(after.get(pid)))
    throw new Error('Process identity changed during inspection');
}
function infrastructure(rows, appServerPid, bridgePid) {
  if (!validPid(appServerPid) || !validPid(bridgePid) || appServerPid === bridgePid ||
    !rows.has(bridgePid) || rows.get(appServerPid)?.ppid !== bridgePid)
    throw new Error('App server is not a live child of the expected bridge');
  return [rows.get(bridgePid), rows.get(appServerPid)];
}
async function workspaceWriters(workspace, platform, lsofPath, timeoutMs, infrastructurePids) {
  const result = await inspectWorkspaceWriters({ workspace, platform, lsofPath, timeoutMs, ignorePids: [process.pid] });
  if (!result.verified || result.unknown) throw new Error('Workspace writer inspection failed');
  // The bridge/server's idle cwd is not a command. Their write handles still block.
  return result.writers.filter(row => !(row.reason === 'cwd' && infrastructurePids.includes(row.pid)));
}

/**
 * Capture only a trusted provider-scoped list supplied by the host. A unique argv
 * and cwd match is correlated with live app-server ancestry; it is not authority
 * to kill a PID. The caller stops exact provider handles on the same connection.
 * No argv is persisted. This observes current trees/handles, not an OS sandbox or
 * descendants that escaped before observation. The host must retain missing
 * command provenance as unknown even when an empty-list capture succeeds.
 */
export async function captureCommandProcesses({ appServerPid, bridgePid, workspace, terminals,
  pythonPath, platform = process.platform, psPath = '/bin/ps', lsofPath = '/usr/sbin/lsof', timeoutMs = 15000 } = {}) {
  if (platform !== 'darwin') return unknown('Command process proof is not implemented on this platform');
  try {
    const root = canonicalDirectory(workspace);
    if (!Array.isArray(terminals) || terminals.length > 128) throw new Error('Invalid terminal list');
    const itemIds = new Set(), processIds = new Set();
    const targets = terminals.map(terminal => {
      if (!terminal || typeof terminal.itemId !== 'string' || !terminal.itemId || terminal.itemId.length > 512 ||
        typeof terminal.processId !== 'string' || !terminal.processId || terminal.processId.length > 512 ||
        typeof terminal.command !== 'string' || !terminal.command || terminal.command.length > 65536 ||
        itemIds.has(terminal.itemId) || processIds.has(terminal.processId) ||
        (terminal.osPid != null && !validPid(terminal.osPid))) throw new Error('Ambiguous terminal identity');
      itemIds.add(terminal.itemId); processIds.add(terminal.processId);
      const cwd = canonicalDirectory(terminal.cwd);
      if (!within(root, cwd)) throw new Error('Terminal cwd is outside the task workspace');
      return { ...terminal, cwd, directoryIdentity: directoryIdentity(cwd) };
    });
    const before = await processTable(psPath, timeoutMs);
    const nativeBefore = await nativeProcessTable(pythonPath, timeoutMs);
    const infra = infrastructure(before, appServerPid, bridgePid);
    const candidates = [...descendants(before, [appServerPid])].filter(pid => pid !== appServerPid);
    const commands = await commandsFor([...candidates, bridgePid, appServerPid], psPath, timeoutMs);
    const cwd = await workingDirectories(candidates, lsofPath, timeoutMs);
    const roots = [], selected = new Set();
    for (const target of targets) {
      // osPid may narrow a *unique* match, never choose between indistinguishable
      // commands. Provider processId is deliberately never interpreted as a PID.
      const matches = candidates.filter(pid => commands.get(pid) === target.command && cwd.get(pid) === target.directoryIdentity);
      if (matches.length !== 1 || selected.has(matches[0]) || (target.osPid != null && target.osPid !== matches[0]))
        throw new Error('Terminal has no unique live command identity');
      const pid = matches[0]; selected.add(pid);
      roots.push({ itemId: target.itemId, processId: target.processId, pid });
    }
    const observed = descendants(before, roots.map(row => row.pid));
    const groups = [...new Set([...observed].map(pid => before.get(pid).pgid))];
    if (groups.some(pgid => infra.some(row => row.pgid === pgid)))
      throw new Error('Command shares the infrastructure process group');
    for (const row of before.values()) if (groups.includes(row.pgid) && !observed.has(row.pid))
      throw new Error('Command process group has an unowned member');
    // +D workspace below selects descendant directories by file identity too,
    // without attempting to decode lsof's lossy display names.
    const writers = await workspaceWriters(root, platform, lsofPath, timeoutMs, [bridgePid, appServerPid]);
    if (!terminals.length && writers.length) throw new Error('Empty provider list still has workspace writers');
    const after = await processTable(psPath, timeoutMs);
    const nativeAfter = await nativeProcessTable(pythonPath, timeoutMs);
    stable(before, after, [...candidates, bridgePid, appServerPid]);
    stableNative(before, after, nativeBefore, nativeAfter, [...candidates, bridgePid, appServerPid]);
    const afterCandidates = [...descendants(after, [appServerPid])].filter(pid => pid !== appServerPid);
    if (afterCandidates.length !== candidates.length || afterCandidates.some(pid => !candidates.includes(pid)))
      throw new Error('Command tree changed during capture');
    const secondCommands = await commandsFor([...observed, bridgePid, appServerPid], psPath, timeoutMs);
    for (const target of targets) if (directoryIdentity(target.cwd) !== target.directoryIdentity)
      throw new Error('Terminal cwd identity changed during capture');
    for (const pid of secondCommands.keys()) if (secondCommands.get(pid) !== commands.get(pid))
      throw new Error('Command identity changed during capture');
    const capture = freeze({ version: 2, verified: true, unknown: false, scope: SCOPE, workspace: root,
      appServerPid, bridgePid, infrastructure: infra.map(row => publicIdentity(joinedIdentity(row, nativeBefore.get(row.pid)), commands.get(row.pid))),
      roots, identities: [...observed].map(pid => publicIdentity(joinedIdentity(before.get(pid), nativeBefore.get(pid)), commands.get(pid))),
      groups, emptyBaseline: terminals.length === 0, capturedAt: new Date().toISOString() });
    issuedCaptures.add(capture);
    return capture;
  } catch (error) { return unknown(error.message); }
}

/** Re-observe captured identities and current writers; this function never signals processes. */
export async function verifyCommandProcessesStopped({ capture, workspace, platform = process.platform,
  pythonPath, psPath = '/bin/ps', lsofPath = '/usr/sbin/lsof', timeoutMs = 15000 } = {}) {
  if (platform !== 'darwin') return unknown('Command process proof is not implemented on this platform');
  try {
    const root = canonicalDirectory(workspace);
    if (!issuedCaptures.has(capture) || capture?.version !== 2 || capture.verified !== true || capture.scope !== SCOPE || capture.workspace !== root ||
      !Array.isArray(capture.identities) || capture.identities.length > MAX_PROCESSES ||
      !Array.isArray(capture.infrastructure) || capture.infrastructure.length !== 2 ||
      !Array.isArray(capture.groups) || capture.groups.length > MAX_PROCESSES || capture.groups.some(pgid => !validPid(pgid)) ||
      !Array.isArray(capture.roots) || capture.roots.length > 128 ||
      typeof capture.emptyBaseline !== 'boolean' ||
      (capture.emptyBaseline ? (capture.roots.length || capture.identities.length || capture.groups.length) : !capture.roots.length))
      throw new Error('Invalid process capture');
    const recorded = [...capture.infrastructure, ...capture.identities];
    const seen = new Set();
    for (const row of recorded) {
      if (!validPid(row?.pid) || !Number.isInteger(row.ppid) || row.ppid < 1 || !validPid(row.pgid) ||
        seen.has(row.pid) || typeof row.startedAt !== 'string' || !row.startedAt ||
        row.euid !== process.geteuid() || !Number.isInteger(row.ruid) || row.ruid < 0 ||
        !Number.isSafeInteger(row.startSec) || row.startSec <= 0 ||
        !Number.isSafeInteger(row.startUsec) || row.startUsec < 0 || row.startUsec >= 1000000 ||
        !/^[a-f0-9]{64}$/.test(row.commandHash || '')) throw new Error('Invalid recorded process identity');
      seen.add(row.pid);
    }
    const infraPids = capture.infrastructure.map(row => row.pid);
    if (!infraPids.includes(capture.bridgePid) || !infraPids.includes(capture.appServerPid) ||
      capture.roots.some(row => !capture.identities.some(identity => identity.pid === row.pid)) ||
      capture.groups.length !== new Set(capture.groups).size ||
      capture.groups.some(pgid => !capture.identities.some(row => row.pgid === pgid) || capture.infrastructure.some(row => row.pgid === pgid)) ||
      capture.identities.some(row => !capture.groups.includes(row.pgid))) throw new Error('Inconsistent capture scope');
    const before = await processTable(psPath, timeoutMs);
    const nativeBefore = await nativeProcessTable(pythonPath, timeoutMs);
    infrastructure(before, capture.appServerPid, capture.bridgePid);
    const live = recorded.filter(row => before.has(row.pid));
    const commands = await commandsFor(live.map(row => row.pid), psPath, timeoutMs);
    // Reparenting does not erase a known child's identity. In particular, a child
    // in its own session must remain observable after its command parent exits.
    for (const row of live) if (!nativeBefore.has(row.pid) ||
      birthKey(row) !== birthKey(joinedIdentity(before.get(row.pid), nativeBefore.get(row.pid))) ||
      row.commandHash !== hash(commands.get(row.pid)))
      throw new Error('Recorded process identity changed');
    for (const row of recorded) if (!before.has(row.pid) && nativeBefore.has(row.pid))
      throw new Error('Recorded PID changed during inspection');
    if (capture.infrastructure.some(row => !before.has(row.pid))) throw new Error('Execution infrastructure changed');
    const remaining = live.filter(row => capture.identities.some(identity => identity.pid === row.pid));
    const discovered = descendants(before, remaining.map(row => row.pid));
    for (const row of before.values()) if (capture.groups.includes(row.pgid)) discovered.add(row.pid);
    if (discovered.size > MAX_PROCESSES) throw new Error('Remaining process scope exceeds limit');
    const writers = discovered.size ? [] : await workspaceWriters(root, platform, lsofPath, timeoutMs, [capture.bridgePid, capture.appServerPid]);
    const after = await processTable(psPath, timeoutMs);
    const nativeAfter = await nativeProcessTable(pythonPath, timeoutMs);
    const inspected = [...seen, ...discovered, ...writers.map(row => row.pid)];
    stableNative(before, after, nativeBefore, nativeAfter, inspected);
    for (const row of live) if (birthKey(row) !== birthKey(joinedIdentity(after.get(row.pid), nativeAfter.get(row.pid))))
      throw new Error('Recorded process identity changed');
    const oldDescendants = descendants(before, [capture.appServerPid]);
    const newDescendants = descendants(after, [capture.appServerPid]);
    if ([...newDescendants].some(pid => !oldDescendants.has(pid)))
      throw new Error('New execution appeared during final inspection');
    // A new member of a retained group, or a previously absent PID reappearing,
    // invalidates a no-process observation instead of being silently ignored.
    if (capture.identities.some(row => after.has(row.pid)) || [...after.values()].some(row => capture.groups.includes(row.pgid)))
      { if (!discovered.size) throw new Error('Process scope changed during final inspection'); }
    if (discovered.size) return { verified: true, stopped: false, unknown: false, scope: SCOPE,
      liveIdentities: [...discovered].map(pid => ({ ...joinedIdentity(before.get(pid), nativeBefore.get(pid)),
        commandHash: commands.has(pid) ? hash(commands.get(pid)) : null })),
      reason: 'An observed command, descendant or independent process group is still running', checkedAt: new Date().toISOString() };
    if (writers.length) return { verified: true, stopped: false, unknown: false, scope: SCOPE,
      liveIdentities: [...new Set(writers.map(row => row.pid))].map(pid => joinedIdentity(after.get(pid), nativeAfter.get(pid))),
      reason: 'The workspace still has a visible current writer', checkedAt: new Date().toISOString() };
    return { verified: true, stopped: true, unknown: false, scope: SCOPE, liveIdentities: [], checkedAt: new Date().toISOString() };
  } catch (error) { return unknown(error.message); }
}
