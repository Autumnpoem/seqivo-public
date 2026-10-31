import { accessSync, constants, existsSync, lstatSync, opendirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareManagedTmuxSession, reconnectManagedTmuxSession,
  startPreparedManagedTmuxSession, verifyManagedTmuxSession } from './managed-pane-record.mjs';
import { nativeProcessTable, nativeTerminalProcessObservation } from '../codex-process-proof.mjs';
import { nativeSelectedIdentities } from './process-identities.mjs';
import { inspectWorkspaceWriters } from './process-inspection.mjs';

const KEY = 'terminal.managed-panes.v1';
const DIAGNOSTICS = new Set(['identity_snapshot', 'identity_mismatch', 'tmux_query', 'tmux_mismatch',
  'reconnect_identity_before', 'reconnect_tmux_before', 'reconnect_socket', 'reconnect_status_query',
  'reconnect_status_mismatch', 'reconnect_identity_after', 'reconnect_tmux_after',
  'verify_identity_before', 'verify_tmux_before', 'verify_identity_after', 'verify_tmux_after',
  'ensure_reconnect_mismatch', 'ensure_reconnect_unknown', 'ensure_status_query',
  'ensure_record_mismatch', 'ensure_status_mismatch']);
const SNAPSHOT_DIAGNOSTICS = new Set(['abi_mismatch','libproc_unavailable','list_size_failed',
  'list_capacity_exceeded','list_failed','list_truncated','list_invalid_pid',
  'list_duplicate_pid','pid_info_incomplete','pid_identity_changed','observer_missing',
  'list_changed_during_scan','kinfo_abi_unsupported','kinfo_size_failed',
  'kinfo_size_invalid','kinfo_read_failed','kinfo_partial_result',
  'kinfo_identity_invalid','kinfo_abi_or_observer_mismatch','unsupported_platform',
  'unexpected_uid','identity_set_changed']);
const PHASES = new Set(['index_read','index_shape','inventory_scan','initialize',
  'ensure_reconnect','ensure_verify','prepare_persist','start','park_return',
  'mark_unknown','resume_persist','resume', ...DIAGNOSTICS]);
const diagnosticPhase = (error, fallback) => PHASES.has(error?.proofStage) ? error.proofStage :
  PHASES.has(error?.diagnostic) ? error.diagnostic : fallback;
const diagnosticCategory = error => SNAPSHOT_DIAGNOSTICS.has(error?.snapshotDiagnostic)
  ? error.snapshotDiagnostic : DIAGNOSTICS.has(error?.diagnostic) ? error.diagnostic : 'unconfirmed';
const unknown = (diagnostic, fallback) => {
  const error = Object.assign(new Error('受管会话身份或启动结果未核实。原会话不会自动替换；请在本机检查后再恢复。'),
    { code: 'MANAGED_PANE_UNKNOWN', status: 409 });
  const category = DIAGNOSTICS.has(diagnostic) ? diagnostic : fallback;
  if (category) Object.defineProperty(error, 'diagnostic', { value: category });
  return error;
};
const sameRef = (a, b) => a?.serverName === b?.serverName && a?.instanceId === b?.instanceId && a?.sessionId === b?.sessionId;
// A detached supervisor can legitimately be reparented across app restart.
// Its birth identity is PID, group, UID and native start time; the shell's
// direct-parent relation is checked again by verifyManagedTmuxSession.
const sameIdentity = (a,b) => Boolean(a&&b&&a.pid===b.pid&&a.pgid===b.pgid&&
  a.euid===b.euid&&a.ruid===b.ruid&&
  (process.platform==='linux'
    ? a.kind==='linux-proc'&&b.kind==='linux-proc'&&a.bootId===b.bootId&&a.startTicks===b.startTicks
    : a.startSec===b.startSec&&a.startUsec===b.startUsec));
const name = value => typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(value);

function executable(configured, fallbacks) {
  const candidates = configured ? [configured] : fallbacks;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) continue;
    const paths = isAbsolute(candidate) ? [candidate] : (process.env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, candidate));
    for (const path of paths) try {
      const real = realpathSync(path);
      if (!statSync(real).isFile()) continue;
      accessSync(real, constants.X_OK);
      return real;
    } catch { /* Try the next trusted installation path. */ }
  }
  throw unknown();
}

function paths(profile, configuredPython) {
  const bundledPython = resolve(dirname(process.execPath), '../../python/bin/python3');
  const bundledTmux = fileURLToPath(new URL('../../terminal/bin/tmux', import.meta.url));
  const pythonPath = executable(configuredPython || process.env.TASKBOARD_PYTHON,
    [bundledPython, 'python3', 'python']);
  const tmuxPath = executable(profile.tmuxExecutable || process.env.TMUX_PATH,
    [...(existsSync(bundledTmux) ? [bundledTmux] : []), 'tmux']);
  const shell = executable(profile.shell, []);
  return { pythonPath, tmuxPath, shell };
}

function binding(profile) {
  return createHash('sha256').update(JSON.stringify([profile.id, profile.projectId, profile.cwd,
    profile.serverName, profile.shell, profile.tmuxExecutable || null])).digest('hex');
}

/** Private, Core-owned index. It contains coordinates, never capabilities. */
export function createManagedPaneRegistry({ store, recordRoot, pythonPath } = {}) {
  if (!store?.db || !isAbsolute(recordRoot) || !['darwin','linux'].includes(process.platform)) throw unknown();
  const root = realpathSync(recordRoot), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o700) throw unknown();
  const firstFailures = new Map();
  let firstInventoryFailure = null;
  const event = (phase, category, recordId = null) => Object.freeze({
    phase: PHASES.has(phase) ? phase : 'initialize',
    category: SNAPSHOT_DIAGNOSTICS.has(category) || DIAGNOSTICS.has(category) ||
      ['unconfirmed','index_invalid','inventory_mismatch','write_failed','record_unresolved'].includes(category)
      ? category : 'unconfirmed',
    at: new Date().toISOString(),
    ...(recordId ? { recordDigest: createHash('sha256').update(recordId).digest('hex').slice(0, 16) } : {}) });
  const latchInventory = (phase, category) => { firstInventoryFailure ||= event(phase, category); };
  const latch = (item, phase, category) => {
    if (item?.recordId && firstFailures.size < 128 && !firstFailures.has(item.recordId))
      firstFailures.set(item.recordId, event(phase, category, item.recordId));
  };
  const row = store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY);
  let state, inventoryUnknown = false;
  try { state = row ? JSON.parse(row.value) : { version: 1, entries: [] }; }
  catch { state = { version: 1, entries: [] }; inventoryUnknown = true; latchInventory('index_read','index_invalid'); }
  if (!state || state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > 128 ||
    state.entries.some(item => !item || typeof item.recordId !== 'string' ||
      !/^seqivo-pane-record-[A-Za-z0-9]+$/.test(item.directory) ||
      !['intent', 'started', 'unknown'].includes(item.status) || !name(item.profileId) ||
      item.parked !== undefined && typeof item.parked !== 'boolean' ||
      typeof item.projectId !== 'string' || typeof item.actorId !== 'string' ||
      !Number.isSafeInteger(item.generation) || item.generation < 1 ||
      !/^[a-f0-9]{64}$/.test(item.binding) ||
      item.sessionRef != null && (!name(item.sessionRef.serverName) ||
        !/^[a-f0-9]{64}$/.test(item.sessionRef.instanceId) || !/^\$\d+$/.test(item.sessionRef.sessionId)))) {
    state = { version: 1, entries: [] };
    inventoryUnknown = true;
    latchInventory('index_shape','index_invalid');
  }
  // The private files are an independent durable fence. A restored database
  // cannot erase a prepared, started or unknown on-disk pane by omitting its
  // metadata row. Inspect only direct, trusted children and cap the scan.
  const inventory = () => {
    const seen = new Set(); let suspicious = false, count = 0;
    const directory = opendirSync(root);
    try {
      let entry;
      while ((entry = directory.readSync()) !== null) {
        if (++count > 128) { suspicious = true; break; }
        const path = join(root, entry.name);
        try {
          const info = lstatSync(path);
          if (!/^seqivo-pane-record-[A-Za-z0-9]+$/.test(entry.name) ||
            !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid() ||
            (info.mode & 0o777) !== 0o700 || realpathSync(path) !== path)
            suspicious = true;
        } catch { suspicious = true; }
        seen.add(entry.name);
      }
    } finally { directory.closeSync(); }
    const expected = new Set(state.entries.map(item => item.directory));
    if (expected.size !== state.entries.length || expected.size !== seen.size ||
      [...expected].some(directory => !seen.has(directory))) suspicious = true;
    return { suspicious, count };
  };
  try { if (inventory().suspicious) { inventoryUnknown = true; latchInventory('inventory_scan','inventory_mismatch'); } }
  catch { inventoryUnknown = true; latchInventory('inventory_scan','unconfirmed'); }
  const connected = new Map(), unavailable = new Set();
  const recordPath = item => join(root, item.directory, 'record.json');
  const persist = () => {
    if (inventoryUnknown) throw unknown();
    return store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(KEY, JSON.stringify(state));
  };
  const find = ref => state.entries.find(item => item.sessionRef && sameRef(item.sessionRef, ref)) || null;
  const assertBinding = (item, profile) => {
    if (!profile || item.profileId !== profile.id || item.projectId !== profile.projectId || item.binding !== binding(profile)) throw unknown();
  };
  const ensure = async (item, profile) => {
    if (item.status !== 'started' || unavailable.has(item.recordId)) throw unknown();
    assertBinding(item, profile);
    let subject = connected.get(item.recordId);
    if (!subject) {
      try {
        subject = await reconnectManagedTmuxSession({ recordRoot: root, recordPath: recordPath(item) });
        if (subject.recordId !== item.recordId || !sameRef(subject.sessionRef, item.sessionRef))
          throw unknown('ensure_reconnect_mismatch');
        connected.set(item.recordId, subject);
      } catch (error) { subject?.pane?.close(); unavailable.add(item.recordId);
        latch(item, diagnosticPhase(error,'ensure_reconnect'), diagnosticCategory(error));
        throw unknown(error?.diagnostic, 'ensure_reconnect_unknown'); }
    }
    let stage = 'ensure_record_mismatch';
    try {
      const proof = await verifyManagedTmuxSession({ recordRoot: root, recordPath: recordPath(item) });
      stage = 'ensure_status_query';
      const status = await subject.pane.status();
      if (proof.recordId !== item.recordId || !sameRef(proof.sessionRef, item.sessionRef))
        throw unknown('ensure_record_mismatch');
      if (status.state === 'unknown' || status.state === 'exited' || status.relayConnected !== true ||
        status.supervisorPid !== proof.identities.supervisor.pid || status.childPid !== proof.identities.shell.pid)
        throw unknown('ensure_status_mismatch');
      if (item.parked && (status.state !== 'stopped' || status.inputFrozen !== true))
        throw unknown('ensure_status_mismatch');
      return { subject, proof, status };
    } catch (error) { subject.pane.close(); connected.delete(item.recordId); unavailable.add(item.recordId);
      latch(item, diagnosticPhase(error,'ensure_verify'), diagnosticCategory(error));
      throw unknown(error?.diagnostic, stage); }
  };
  return {
    find,
    diagnostics() { return { supported:true, scope:'current-process-observation-not-authorization',
      inventoryUnknown, firstInventoryFailure,
      items:state.entries.slice(0,128).filter(item=>item.status!=='started'||unavailable.has(item.recordId))
        .map(item=>({status:item.status,firstCause:firstFailures.get(item.recordId)||null,
          recordDigest:createHash('sha256').update(item.recordId).digest('hex').slice(0,16)})) }; },
    projectItems(projectId) { return state.entries.filter(item => item.projectId === projectId); },
    unparkedProjects() { return [...new Set(state.entries.filter(item => item.status === 'started' && !item.parked)
      .map(item => item.projectId))]; },
    hasUnresolved(projectId) { return inventoryUnknown || state.entries.some(item => item.projectId === projectId &&
      (item.status !== 'started' || unavailable.has(item.recordId))); },
    unresolvedProjects() { return [...new Set(state.entries.filter(item =>
      item.status !== 'started' || unavailable.has(item.recordId)).map(item => item.projectId))]; },
    hasUnknownInventory() { return inventoryUnknown; },
    assertMetadataReplacementSafe(incomingMetadata) {
      let observed;
      try { observed = inventory(); } catch { throw unknown(); }
      if (inventoryUnknown || observed.suspicious || observed.count !== 0 || state.entries.length !== 0)
        throw unknown();
      const current = store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY);
      if (current) {
        let parsed;
        try { parsed = JSON.parse(current.value); } catch { throw unknown(); }
        if (parsed?.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length)
          throw unknown();
      }
      if (!Array.isArray(incomingMetadata)) throw unknown();
      const next = incomingMetadata.filter(item => item?.key === KEY);
      if (next.length > 1) throw unknown();
      if (next.length) {
        let parsed;
        try { parsed = JSON.parse(next[0].value); } catch { throw unknown(); }
        if (parsed?.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length)
          throw unknown();
      }
    },
    async prepare({ profile, actorId, generation, sessionName, cols, rows }) {
      if (state.entries.length >= 128 || this.hasUnresolved(profile.projectId)) throw unknown();
      const resolved = paths(profile, pythonPath);
      const prepared = await prepareManagedTmuxSession({ recordRoot: root, socketRoot: tmpdir(),
        ...resolved, cwd: profile.cwd, serverName: profile.serverName, name: sessionName, cols, rows, args: ['-l'] });
      const item = { recordId: prepared.recordId, directory: basename(dirname(prepared.recordPath)),
        profileId: profile.id, projectId: profile.projectId, actorId, generation,
        binding: binding(profile), status: 'intent', parked: false, sessionRef: null };
      state.entries.push(item);
      try { persist(); } catch (error) { state.entries.pop(); inventoryUnknown = true;
        latchInventory('prepare_persist','write_failed'); throw error; }
      return item;
    },
    async start(item, profile) {
      assertBinding(item, profile);
      if (item.status !== 'intent') throw unknown();
      let subject;
      try {
        subject = await startPreparedManagedTmuxSession({ recordRoot: root, recordPath: recordPath(item) });
        if (subject.recordId !== item.recordId) throw unknown();
        // Startup itself is not a grant. Freeze and stop the shell before the
        // control record has admitted this exact session and actor.
        await subject.pane.park();
        const parked = await subject.pane.status();
        if (parked.state !== 'stopped' || parked.inputFrozen !== true) throw unknown();
        item.status = 'started'; item.parked = false; item.sessionRef = subject.sessionRef;
        persist();
        connected.set(item.recordId, subject);
        return subject;
      } catch (error) {
        subject?.pane?.close(); connected.delete(item.recordId);
        item.status = 'unknown'; unavailable.add(item.recordId);
        latch(item,'start',diagnosticCategory(error));
        try { persist(); } catch { /* Original durable intent still prevents another start. */ }
        throw unknown();
      }
    },
    async initialize(profiles) {
      for (const item of state.entries) {
        if (item.status !== 'started') { unavailable.add(item.recordId); latch(item,'initialize','record_unresolved'); continue; }
        try { await ensure(item, profiles.find(profile => profile.id === item.profileId)); }
        catch { /* Preserve the persisted record and fail closed on later use. */ }
      }
    },
    async inspect(item, profile) { return ensure(item, profile); },
    processTable(profile) { return nativeProcessTable(paths(profile, pythonPath).pythonPath, 15000); },
    observeProcessTable(profile) { return nativeTerminalProcessObservation(paths(profile, pythonPath).pythonPath, 15000); },
    selectedIdentities(profile,pids) { return nativeSelectedIdentities(paths(profile,pythonPath).pythonPath,pids,15000); },
    async parkForReturn(item, profile) {
      const { subject } = await ensure(item, profile);
      try {
        await subject.pane.park();
        const status = await subject.pane.status();
        if (status.state !== 'stopped' || status.inputFrozen !== true || status.relayConnected !== true)
          throw unknown('ensure_status_mismatch');
        await verifyManagedTmuxSession({recordRoot:root,recordPath:recordPath(item)});
        item.parked = true;
        persist();
        return {status};
      } catch(error) {
        unavailable.add(item.recordId);
        latch(item,diagnosticPhase(error,'park_return'),diagnosticCategory(error));
        subject.pane.close(); connected.delete(item.recordId);
        throw unknown(error?.diagnostic);
      }
    },
    async inspectParked({projectId,workspace,profile,sessionRefs,admittedJob=null}) {
      if (inventoryUnknown || !Array.isArray(sessionRefs) || !sessionRefs.length) throw unknown();
      const items = state.entries.filter(item => item.projectId === projectId && item.profileId === profile.id);
      if (items.length !== sessionRefs.length || items.some(item => item.status !== 'started' || !item.parked ||
        unavailable.has(item.recordId) || !sessionRefs.some(ref => sameRef(ref,item.sessionRef)))) throw unknown();
      const before = await nativeProcessTable(paths(profile,pythonPath).pythonPath,15000,
        {allVisible:process.platform==='linux'});
      const trusted = new Map(), shellPids = new Set();
      for (const item of items) {
        const {proof,status}=await ensure(item,profile);
        if (status.state !== 'stopped' || status.inputFrozen !== true || status.relayConnected !== true)
          throw unknown();
        for (const identity of Object.values(proof.identities)) {
          if (!sameIdentity(before.get(identity.pid),identity)) throw unknown();
          trusted.set(identity.pid,identity);
        }
        shellPids.add(proof.identities.shell.pid);
      }
      const writers = await inspectWorkspaceWriters({workspace});
      if (!writers.verified || writers.unknown || !Array.isArray(writers.writers)) throw unknown();
      const after = await nativeProcessTable(paths(profile,pythonPath).pythonPath,15000,
        {allVisible:process.platform==='linux'});
      for (const [pid,identity] of trusted) if (!sameIdentity(after.get(pid),identity)) throw unknown();
      const admitted = new Map();
      if (admittedJob !== null) {
        if (!Array.isArray(admittedJob.members) || !admittedJob.members.length || admittedJob.members.length > 512)
          throw unknown();
        for (const identity of admittedJob.members) {
          if (!Number.isSafeInteger(identity?.pid) || admitted.has(identity.pid) ||
            !sameIdentity(before.get(identity.pid),identity) ||
            !sameIdentity(after.get(identity.pid),identity)) throw unknown();
          admitted.set(identity.pid,identity);
        }
      }
      const descendant = (pid,rows) => {
        const seen=new Set(); let current=pid;
        while(current&&!seen.has(current)) {
          if(shellPids.has(current)) return true;
          seen.add(current);current=rows.get(current)?.ppid;
        }
        return false;
      };
      for (const row of [...before.values(),...after.values()])
        if (!trusted.has(row.pid) && (descendant(row.pid,before) || descendant(row.pid,after)))
          throw unknown();
      const unowned=writers.writers.filter(writer=>
        !sameIdentity(before.get(writer.pid),after.get(writer.pid)) ||
        !trusted.has(writer.pid) && !(writer.reason === 'cwd' && admitted.has(writer.pid)));
      const scope=process.platform==='linux'?'linux-parked-managed-pane-and-visible-writers':
        'macos-parked-managed-pane-and-visible-writers';
      if(unowned.length) return {verified:true,quiescent:false,unknown:false,
        livePids:[...new Set(unowned.map(writer=>writer.pid))],scope};
      return {verified:true,quiescent:true,unknown:false,livePids:[],
        scope,checkedAt:new Date().toISOString()};
    },
    markUnknown(item) {
      this.freeze(item);
      unavailable.add(item.recordId);
      latch(item,'mark_unknown','unconfirmed');
      item.status = 'unknown';
      try { persist(); } catch { /* Original durable intent/start remains a fence. */ }
    },
    async resume(item, profile) {
      const { subject, status } = await ensure(item, profile);
      if (status.state === 'running' && status.inputFrozen === false) return subject;
      // Persist the AI fence before re-enabling any input or sending SIGCONT.
      if (item.parked) { item.parked = false; try { persist(); } catch(error) {
        item.parked = true; unavailable.add(item.recordId); latch(item,'resume_persist','write_failed'); throw unknown(); } }
      try { await subject.pane.resume(); }
      catch (error) { subject.pane.close(); connected.delete(item.recordId); unavailable.add(item.recordId);
        latch(item,'resume',diagnosticCategory(error));
        const failure = unknown(); Object.defineProperty(failure, 'cause', { value: error }); throw failure; }
      return subject;
    },
    freeze(item) {
      if (!item) return;
      const subject = connected.get(item.recordId);
      subject?.pane?.close(); connected.delete(item.recordId);
    },
    close() { for (const subject of connected.values()) subject.pane.close(); connected.clear(); },
  };
}
