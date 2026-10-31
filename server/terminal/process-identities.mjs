import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('../../plugins/codex-autocontinue/process_identities.py', import.meta.url));
const SCOPE = 'macos-selected-pids-two-observed-enumerations';
const LINUX_SCOPE = 'linux-selected-pids-two-observed-enumerations';
const FIELDS = ['pid', 'ppid', 'pgid', 'euid', 'ruid', 'startSec', 'startUsec'];
const LINUX_FIELDS = ['kind', 'pid', 'ppid', 'pgid', 'euid', 'ruid', 'bootId', 'startTicks'];
const REASONS = new Set(['abi_mismatch', 'libproc_unavailable', 'pid_info_incomplete',
  'pid_identity_changed', 'unsupported_platform', 'unexpected_uid']);
const validPid = value => Number.isSafeInteger(value) && value > 1 && value <= 2147483647;

/** Only proves the observed identities of the requested live PIDs. This must
 * never replace the full process table used for descendants, writers or stop
 * proofs; a missing requested PID is an error, not evidence it has stopped. */
export async function nativeSelectedIdentities(pythonPath, pids, timeoutMs = 15000) {
  if (typeof pythonPath !== 'string' || !pythonPath.trim() || pythonPath.length > 8192 ||
    !Array.isArray(pids) || pids.length < 1 || pids.length > 8 || pids.some(pid => !validPid(pid)) ||
    new Set(pids).size !== pids.length || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000)
    throw new Error('Invalid selected process identity request');
  const requested = [...pids].sort((a, b) => a - b);
  const uid = process.geteuid(), ruid = process.getuid();
  const raw = await new Promise((resolve, reject) => {
    execFile(pythonPath, ['-B', HELPER, '--expected-uid', String(uid), ...requested.flatMap(pid => ['--pid', String(pid)])],
      { timeout: timeoutMs, maxBuffer: 32 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
      (error, stdout, stderr) => {
        if (stderr?.trim() || error && !(error.code === 2 && !error.signal && !error.killed))
          reject(new Error('Selected process identity command failed'));
        else resolve(stdout);
      });
  });
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error('Malformed selected process identities'); }
  const linux = process.platform === 'linux';
  const schemaVersion = linux ? 2 : 1;
  const scope = linux ? LINUX_SCOPE : SCOPE;
  if (result?.schemaVersion === schemaVersion && result.scope === scope && result.uid === uid && result.verified === false &&
    REASONS.has(result.reason) && Array.isArray(result.rows) && result.rows.length === 0) {
    const error = new Error('Selected process identities are unconfirmed');
    Object.defineProperty(error, 'snapshotDiagnostic', { value: result.reason });
    throw error;
  }
  if (result?.schemaVersion !== schemaVersion || result.verified !== true || result.reason !== null || result.uid !== uid ||
    result.scope !== scope || result.attempts !== 2 || !validPid(result.observerPid) ||
    result.ignoredObserverPid !== result.observerPid || requested.includes(result.observerPid) ||
    !Array.isArray(result.requestedPids) || JSON.stringify(result.requestedPids) !== JSON.stringify(requested) ||
    !Array.isArray(result.rows) || result.rows.length !== requested.length)
    throw new Error('Unverified selected process identities');
  const rows = new Map();
  const fields = linux ? LINUX_FIELDS : FIELDS;
  for (const row of result.rows) {
    if (!row || Object.keys(row).sort().join(',') !== [...fields].sort().join(',') ||
      !requested.includes(row.pid) || rows.has(row.pid) ||
      !(linux ? Number.isSafeInteger(row.pgid) && row.pgid > 0 && row.pgid <= 2147483647 : validPid(row.pgid)) ||
      !Number.isSafeInteger(row.ppid) || row.ppid < 0 || row.euid !== uid || row.ruid !== ruid ||
      (linux ? row.kind !== 'linux-proc' || typeof row.bootId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.bootId) ||
        typeof row.startTicks !== 'string' || !/^[1-9][0-9]*$/.test(row.startTicks) ||
        BigInt(row.startTicks) > 18446744073709551615n :
        !Number.isSafeInteger(row.startSec) || row.startSec <= 0 ||
        !Number.isSafeInteger(row.startUsec) || row.startUsec < 0 || row.startUsec >= 1000000))
      throw new Error('Invalid selected process identity');
    rows.set(row.pid, Object.fromEntries(fields.map(field => [field, row[field]])));
  }
  if (linux && new Set([...rows.values()].map(row => row.bootId)).size !== 1)
    throw new Error('Invalid selected process identity');
  return rows;
}
