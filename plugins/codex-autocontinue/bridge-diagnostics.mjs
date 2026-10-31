// Private observations, never execution authority or part of a remote DTO.
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 64 * 1024;
const EVENTS = new Set(['first_stop', 'read_budget_exhausted', 'provider_request']);
const REASONS = new Set(['request_timeout', 'provider_closed', 'provider_approval',
  'stdout_closed', 'stream_error', 'process_error', 'process_exit', 'tracked_retirement', 'explicit_stop']);
const METHODS = new Set(['open', 'thread', 'quota', 'createThread', 'resumeThread', 'turn',
  'interrupt', 'listBackgroundTerminals', 'terminateBackgroundTerminal', 'parseLimit', 'close']);
const owned = stat => !process.getuid || stat.uid === process.getuid();
const privateFile = stat => stat.isFile() && stat.nlink === 1 && owned(stat) && (stat.mode & 0o077) === 0;
const digest = value => typeof value === 'string' && value.length > 0 && value.length <= 200
  ? createHash('sha256').update(value).digest('hex').slice(0, 24) : null;

// Only these fixed protocol spellings are diagnostic facts. Never persist an
// unrecognized raw method, JSON-RPC id, request params, or provider text.
const REQUEST_CATEGORIES = new Map([
  ['item/commandExecution/requestApproval', 'command_approval'],
  ['item/fileChange/requestApproval', 'file_approval'],
  ['item/permissions/requestApproval', 'permissions_approval'],
  ['item/tool/requestUserInput', 'user_input'],
  ['mcpServer/elicitation/request', 'elicitation'],
]);
const ACTIVE_COMMAND = new Set(['sending', 'running', 'awaiting_approval']);
export function providerRequestDiagnostic(method, ownerTaskId, threadId, turnId, commands) {
  const active = Array.isArray(commands) ? commands.filter(command => command &&
    command.taskId === ownerTaskId && ACTIVE_COMMAND.has(command.status)) : [];
  const taskMatched = typeof ownerTaskId === 'string' && ownerTaskId.length > 0 && active.length > 0;
  const threadMatched = taskMatched && typeof threadId === 'string' && threadId.length > 0 &&
    active.some(command => command.threadId === threadId);
  const turnMatched = threadMatched && typeof turnId === 'string' && turnId.length > 0 &&
    active.some(command => command.threadId === threadId && command.turnId === turnId);
  return { event: 'provider_request', category: REQUEST_CATEGORIES.get(method) ?? 'unknown',
    taskMatched, threadMatched, turnMatched };
}

export function createBridgeDiagnostics(dataDir) {
  const directory = join(dataDir, 'diagnostics');
  const path = join(directory, 'bridge-lifecycle.jsonl');
  const previous = `${path}.previous`;
  return {
    record(input) {
      let fd;
      try {
        if (!EVENTS.has(input?.event)) return;
        const row = { at: new Date().toISOString(), event: input.event,
          bridge: digest(input.bridgeId), record: digest(input.recordId),
          reason: REASONS.has(input.reason) ? input.reason : null,
          method: METHODS.has(input.method) ? input.method : null,
          timeoutMs: Number.isFinite(input.timeoutMs) && input.timeoutMs >= 0
            ? Math.min(60000, Math.round(input.timeoutMs)) : null };
        if (input.event === 'provider_request') {
          row.category = new Set(REQUEST_CATEGORIES.values()).has(input.category) ? input.category : 'unknown';
          row.taskMatched = input.taskMatched === true;
          row.threadMatched = input.threadMatched === true;
          row.turnMatched = input.turnMatched === true;
        }
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
      } catch { /* Diagnostics cannot change admission, stopping, or unknown state. */ }
      finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
    },
  };
}
