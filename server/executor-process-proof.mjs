import { realpathSync } from 'node:fs';
import { nativeProcessTable } from './codex-process-proof.mjs';
import { inspectWorkspaceWriters } from './terminal/process-inspection.mjs';

// Read-only lifecycle proof. This module never sends a signal. Authority comes
// from a baseline taken BEFORE spawning a dedicated task executor, not from a
// provider's display command or a list of background terminals.
const SCOPE = process.platform === 'linux'
  ? 'linux-dedicated-executor-with-prelaunch-process-baseline'
  : 'macos-dedicated-executor-with-prelaunch-process-baseline';
const baselines = new WeakMap(), captures = new WeakMap();
const MAX_ROWS = 65536, MAX_OWNED = 512;
const birth = row => row.native
  ? row.native.kind === 'linux-proc'
    ? `${row.pid}:${row.native.bootId}:${row.native.startTicks}:${row.native.euid}:${row.native.ruid}:${row.native.pgid}`
    : `${row.pid}:${row.native.euid}:${row.native.ruid}:${row.native.startSec}:${row.native.startUsec}`
  : null;
const sameBirth = (a, b) => !!a && !!b && birth(a) !== null && birth(a) === birth(b);
const publicRow = row => ({ pid: row.pid, ppid: row.ppid, pgid: row.pgid,
  ...(row.native?.kind === 'linux-proc'
    ? { kind: 'linux-proc', euid: row.native.euid, ruid: row.native.ruid,
      bootId: row.native.bootId, startTicks: row.native.startTicks }
    : row.native ? { euid: row.native.euid, ruid: row.native.ruid,
      startSec: row.native.startSec, startUsec: row.native.startUsec } : {}),
});
const unknown = reason => ({ verified: false, retired: false, unknown: true,
  scope: SCOPE, liveIdentities: [], reason });

async function snapshot({ pythonPath, timeoutMs = 15000, platform = process.platform,
  retryIdentityChurn = true }) {
  if (!['darwin', 'linux'].includes(platform) || platform !== process.platform)
    throw new Error('Dedicated executor process proof is unsupported on this platform');
  const native = await nativeProcessTable(pythonPath, timeoutMs, { allVisible: true, retryIdentityChurn });
  if (native.size > MAX_ROWS) throw new Error('Process snapshot exceeds limit');
  // The helper already requires two complete, equal native enumerations and
  // cross-checks its ABI against libproc. ps adds no identity needed here and
  // extending this observation over three subprocesses makes unrelated process
  // churn fail otherwise coherent native snapshots. Keep every native identity;
  // do not filter names, process groups, UIDs or unknown post-baseline orphans.
  return new Map([...native].map(([pid, row]) => [pid, { ...row, stable: true, native: row }]));
}

/** Returned baseline is a live in-memory capability; serialized data is not one. */
export async function captureExecutorBaseline(options = {}) {
  // No task executor has been spawned yet. A changed whole-system list can be
  // replaced by a fresh coherent prelaunch observation, bounded to three reads.
  // Never retry missing identities/ABI/access failures, reuse partial rows, or
  // replace an issued baseline. Postlaunch capture/retirement stay fail-closed.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const rows = await snapshot({ ...options, retryIdentityChurn: false });
      const baseline = Object.freeze({ scope: SCOPE, createdAt: new Date().toISOString() });
      baselines.set(baseline, { rows, uid: process.geteuid() });
      return { verified: true, unknown: false, scope: SCOPE, baseline, attempts: attempt };
    } catch (error) {
      const changedList = /^Native process snapshot is unconfirmed: (?:identity_set_changed|list_changed_during_scan)$/.test(error.message);
      if (!changedList || attempt === 3)
        return { ...unknown(error.message), baseline: null, attempts: attempt };
    }
  }
}

function descendants(rows, root) {
  const found = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows.values()) if (!found.has(row.pid) && found.has(row.ppid)) {
      found.add(row.pid); changed = true;
      if (found.size > MAX_OWNED) throw new Error('Dedicated executor tree exceeds limit');
    }
  }
  return found;
}

export async function captureTaskExecutorTree({ baseline, taskId, bridgePid, appServerPid, workspace, ...options } = {}) {
  try {
    const initial = baselines.get(baseline);
    if (!initial || initial.uid !== process.geteuid()) throw new Error('Prelaunch executor baseline is unavailable');
    if (typeof taskId !== 'string' || !taskId || taskId.length > 300 ||
      !Number.isSafeInteger(bridgePid) || bridgePid < 2 ||
      !Number.isSafeInteger(appServerPid) || appServerPid < 2 || bridgePid === appServerPid)
      throw new Error('Invalid dedicated executor identity');
    if (initial.rows.has(bridgePid) || initial.rows.has(appServerPid))
      throw new Error('Executor was not observed as newly spawned after the baseline');
    const rows = await snapshot(options), directory = realpathSync(workspace);
    const bridge = rows.get(bridgePid), server = rows.get(appServerPid);
    if (!bridge?.native || !server?.native || !bridge.stable || !server.stable)
      throw new Error('Executor was not observed as newly spawned after the baseline');
    const owned = descendants(rows, bridgePid);
    if (!owned.has(appServerPid)) throw new Error('App-server is outside the dedicated bridge tree');
    for (const pid of owned) if (!rows.get(pid)?.native || !rows.get(pid)?.stable)
      throw new Error('Executor descendant identity or UID is unconfirmed');
    const capture = Object.freeze({ taskId, scope: SCOPE, capturedAt: new Date().toISOString() });
    captures.set(capture, { initial, owned: new Map([...owned].map(pid => [pid, rows.get(pid)])),
      bridgePid, appServerPid, workspace: directory });
    return { verified: true, unknown: false, scope: SCOPE, capture,
      identities: [...owned].map(pid => publicRow(rows.get(pid))) };
  } catch (error) { return { ...unknown(error.message), capture: null }; }
}

// An unobserved orphan is deliberately NOT assigned to a task or terminated.
// Only a stable, pre-existing, non-executor ancestor can exclude a newly born
// process. PID 1 cannot prove ancestry: it adopts detached children.
function classify(row, current, initial, owned) {
  const seen = new Set(); let next = row;
  while (next) {
    if (seen.has(next.pid)) return 'unknown';
    seen.add(next.pid);
    const known = owned.get(next.pid);
    if (known) return sameBirth(known, next) ? 'owned' : 'unknown';
    const prior = initial.rows.get(next.pid);
    if (prior && next.pid !== 1 && next.stable && sameBirth(prior, next)) return 'outside';
    if (next.ppid <= 1 || !current.has(next.ppid)) return 'unknown';
    next = current.get(next.ppid);
  }
  return 'unknown';
}

export async function verifyTaskExecutorRetired({ capture, taskId, bridgePid, appServerPid, workspace,
  verifyWorkspace = null, ...options } = {}) {
  try {
    const record = captures.get(capture);
    if (!record || record.initial.uid !== process.geteuid()) throw new Error('Live executor capture is unavailable');
    if (taskId !== capture.taskId || bridgePid !== record.bridgePid || appServerPid !== record.appServerPid)
      throw new Error('Executor capture does not match the expected task and process identities');
    if (realpathSync(workspace) !== record.workspace) throw new Error('Executor workspace changed');
    const rows = await snapshot(options), live = [], unassigned = [];
    for (const [pid, previous] of record.owned) {
      const row = rows.get(pid);
      if (row && !sameBirth(previous, row)) throw new Error('Recorded executor PID identity changed');
      if (row) live.push(publicRow(row));
    }
    for (const row of rows.values()) {
      // Only exact baseline identities or provable outside ancestors can be
      // excluded. An orphan born after the baseline remains unassigned.
      const previous = record.initial.rows.get(row.pid);
      if (previous && sameBirth(previous, row)) continue;
      const owner = classify(row, rows, record.initial, record.owned);
      if (owner === 'unknown') unassigned.push(publicRow(row));
      else if (owner === 'owned' && !live.some(item => item.pid === row.pid)) live.push(publicRow(row));
    }
    if (unassigned.length) return { ...unknown('New process ancestry could not be assigned after executor retirement'),
      liveIdentities: live, unassignedIdentities: unassigned.slice(0, MAX_OWNED) };
    if (live.length) return { verified: true, retired: false, unknown: false, scope: SCOPE,
      liveIdentities: live, reason: 'A dedicated executor process or observed descendant is still running' };
    const writers = verifyWorkspace
      ? await verifyWorkspace({workspace:record.workspace})
      : await inspectWorkspaceWriters({ workspace: record.workspace, ...options });
    if (!writers.verified || writers.unknown) return unknown(writers.reason || 'Workspace writer inspection unavailable');
    if (!writers.quiescent) return { verified: true, retired: false, unknown: false, scope: SCOPE,
      liveIdentities: writers.livePids.map(pid => ({ pid })), reason: 'The workspace still has a visible current writer' };
    return { verified: true, retired: true, unknown: false, scope: SCOPE,
      liveIdentities: [], checkedAt: new Date().toISOString() };
  } catch (error) { return unknown(error.message); }
}
