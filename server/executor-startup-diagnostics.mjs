// Local, bounded observations only. This file is never an execution authority
// and is deliberately absent from task state, plugin RPC and remote APIs.
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 64 * 1024;
const PHASES = new Set(['confirm.first', 'confirm.second', 'confirm.cross_check',
  'verify.first', 'verify.second', 'verify.cross_check',
  'authorize.first', 'authorize.second', 'authorize.cross_check',
  'revalidate.first', 'revalidate.second', 'revalidate.cross_check']);
const STAGES = new Set(['platform', 'canonical_python', 'original_record', 'before_record',
  'native_observe', 'after_record', 'compare', 'retry_delay']);
const DETAILS = new Set(['unsupported', 'record_invalid', 'record_changed', 'deadline',
  'snapshot_invalid', 'helper_unconfirmed', 'member_changed', 'stable', 'sample_limit', 'exception']);
const HELPER_REASONS = new Set(['helper_unavailable', 'helper_unconfirmed', 'native_identity_set_changed',
  'native_list_changed_during_scan', 'coalition_count_changed', 'coalition_member_changed',
  'coalition_members_incomplete', 'coalition_missing_with_members', 'coalition_list_size_unconfirmed',
  'coalition_list_unconfirmed', 'coalition_duplicate']);
const bounded = (value, limit) => Number.isFinite(value) && value >= 0 ? Math.min(limit, Math.round(value)) : null;
const owned = stat => !process.getuid || stat.uid === process.getuid();
const privateFile = stat => stat.isFile() && stat.nlink === 1 && owned(stat) && (stat.mode & 0o077) === 0;

export function createStartupCohortDiagnostics({ dataDir, observe }) {
  const directory = join(dataDir, 'diagnostics');
  const path = join(directory, 'executor-startup.jsonl');
  const previous = `${path}.previous`;
  function record(phase, recordId, result) {
    let fd;
    try {
      if (!PHASES.has(phase)) return;
      const d = result?.diagnostic;
      const row = { at: new Date().toISOString(), phase,
        record: typeof recordId === 'string' && recordId.length <= 200
          ? createHash('sha256').update(recordId).digest('hex').slice(0, 24) : null,
        verified: result?.verified === true && result?.unknown !== true,
        stage: STAGES.has(d?.stage) ? d.stage : null,
        detail: DETAILS.has(d?.detail) ? d.detail : null,
        samplesAttempted: bounded(d?.samplesAttempted, 4), elapsedMs: bounded(d?.elapsedMs, 60000),
        helperReason: HELPER_REASONS.has(d?.helperReason) ? d.helperReason : null };
      const line = Buffer.from(JSON.stringify(row) + '\n');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const dir = lstatSync(directory);
      if (!dir.isDirectory() || !owned(dir) || (dir.mode & 0o077) !== 0) return;
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0);
      fd = openSync(path, flags, 0o600);
      const current = fstatSync(fd);
      if (!privateFile(current)) return;
      if (current.size + line.length > MAX_BYTES) {
        closeSync(fd); fd = undefined;
        try { if (!privateFile(lstatSync(previous))) return; }
        catch (error) { if (error.code !== 'ENOENT') return; }
        const beforeRename = lstatSync(path);
        if (beforeRename.dev !== current.dev || beforeRename.ino !== current.ino || !privateFile(beforeRename)) return;
        renameSync(path, previous);
        fd = openSync(path, flags | constants.O_EXCL, 0o600);
      }
      writeSync(fd, line);
    } catch { /* A failed diagnostic cannot change admission or erase its refusal. */ }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
  }
  return {
    record,
    async observe(phase, input) {
      const result = await observe(input);
      record(phase, input.recordId, result);
      return result;
    }
  };
}
