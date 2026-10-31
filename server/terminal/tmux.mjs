import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTerminalCwd } from './runtime.mjs';

const execFileAsync = promisify(execFile);
export const SESSION_FORMAT = '#{pid}\t#{start_time}\t#{socket_path}\t#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}';

export class TmuxAdapterError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TmuxAdapterError';
    this.code = code;
  }
}

function executablePath(configured, env) {
  const bundled = fileURLToPath(new URL('../../terminal/bin/tmux', import.meta.url));
  const candidate = configured ?? env.TMUX_PATH ?? (existsSync(bundled) ? bundled : 'tmux');
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) return null;
  const paths = isAbsolute(candidate)
    ? [candidate]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, candidate));
  for (const path of paths) {
    try {
      const real = realpathSync(path);
      if (statSync(real).isFile()) {
        accessSync(real, constants.X_OK);
        return real;
      }
    } catch { /* Try the next configured PATH entry. */ }
  }
  return null;
}

export function validName(value, kind) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    throw new TmuxAdapterError('INVALID_NAME', `${kind} must be 1–64 ASCII letters, digits, dot, underscore or hyphen`);
  }
  return value;
}

export function parseSessions(stdout) {
  if (!stdout.trim()) return [];
  return stdout.trimEnd().split('\n').map(line => {
    const fields = line.split('\t');
    if (fields.length !== 7 || !/^[1-9]\d*$/.test(fields[0]) || !/^\d+$/.test(fields[1])
      || !fields[2].startsWith('/') || !/^\$(0|[1-9]\d*)$/.test(fields[3])
      || !/^\d+$/.test(fields[5]) || !/^\d+$/.test(fields[6])) {
      throw new TmuxAdapterError('PROTOCOL_ERROR', 'Unexpected tmux session listing');
    }
    return {
      serverPid: Number(fields[0]),
      serverStartTime: fields[1],
      socketPath: fields[2],
      sessionId: fields[3],
      name: fields[4],
      windows: Number(fields[5]),
      attached: Number(fields[6]),
    };
  });
}

export function noServer(error) {
  const message = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
  return /no server running|failed to connect to server|error connecting to .*No such file or directory/i.test(message);
}

/** All commands use execFile argv; serverName selects only this current user's tmux socket. */
export function createTmuxAdapter({
  executable,
  serverName,
  env = process.env,
  timeoutMs = 5000,
} = {}) {
  validName(serverName, 'serverName');
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new TmuxAdapterError('INVALID_ENV', 'tmux environment must be an object');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TmuxAdapterError('INVALID_TIMEOUT', 'timeoutMs must be from 1 to 30000');
  }
  const command = executablePath(executable, env);
  const childEnv = { ...env };
  delete childEnv.TMUX;

  async function run(args) {
    if (!command) throw new TmuxAdapterError('CAPABILITY_UNAVAILABLE', 'tmux executable is unavailable');
    try {
      return await execFileAsync(command, ['-L', serverName, ...args], {
        env: childEnv,
        timeout: timeoutMs,
        maxBuffer: 128 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      });
    } catch (cause) {
      if (cause.killed || cause.signal === 'SIGTERM') {
        throw new TmuxAdapterError('TMUX_TIMEOUT', 'tmux command timed out', cause);
      }
      throw cause;
    }
  }

  async function listRaw() {
    try {
      return parseSessions((await run(['-u', 'list-sessions', '-F', SESSION_FORMAT])).stdout);
    } catch (cause) {
      if (noServer(cause)) return [];
      if (cause instanceof TmuxAdapterError) throw cause;
      throw new TmuxAdapterError('TMUX_COMMAND_FAILED', 'Unable to list tmux sessions', cause);
    }
  }

  function instanceFor(sessions) {
    if (!sessions.length) return { instanceId: null, serverPid: null };
    const { serverPid, serverStartTime, socketPath } = sessions[0];
    if (sessions.some(session => session.serverPid !== serverPid
      || session.serverStartTime !== serverStartTime || session.socketPath !== socketPath)) {
      throw new TmuxAdapterError('PROTOCOL_ERROR', 'tmux listing contains multiple server identities');
    }
    const instanceId = createHash('sha256').update(`${serverPid}\0${serverStartTime}\0${socketPath}`).digest('hex');
    return { instanceId, serverPid };
  }

  async function list() {
    if (!command) return { available: false, serverName, instanceId: null, serverPid: null, sessions: [], reason: 'tmux executable is unavailable' };
    const rows = await listRaw();
    const { instanceId, serverPid } = instanceFor(rows);
    return {
      available: true,
      serverName,
      instanceId,
      serverPid,
      sessions: rows.map(({ sessionId, name, windows, attached }) => ({
        sessionRef: { serverName, instanceId, sessionId },
        name,
        windows,
        attached,
      })),
    };
  }

  async function inspect() {
    if (!command) return { available: false, serverName, instanceId: null, serverPid: null, reason: 'tmux executable is unavailable' };
    let version;
    try {
      version = (await run(['-V'])).stdout.trim();
    } catch (cause) {
      throw new TmuxAdapterError('TMUX_COMMAND_FAILED', 'Unable to inspect tmux executable', cause);
    }
    const state = await list();
    return { available: true, version, serverName, instanceId: state.instanceId, serverPid: state.serverPid };
  }

  async function create({ name, cwd } = {}) {
    validName(name, 'session name');
    const directory = validateTerminalCwd(cwd);
    if (!command) throw new TmuxAdapterError('CAPABILITY_UNAVAILABLE', 'tmux executable is unavailable');
    let createdId;
    try {
      createdId = (await run(['new-session', '-d', '-s', name, '-c', directory, '-P', '-F', '#{session_id}'])).stdout.trim();
    } catch (cause) {
      throw new TmuxAdapterError('TMUX_CREATE_FAILED', 'Unable to create tmux session', cause);
    }
    if (!/^\$(0|[1-9]\d*)$/.test(createdId)) {
      throw new TmuxAdapterError('PROTOCOL_ERROR', 'tmux did not return a valid session ID');
    }
    const state = await list();
    const row = state.sessions.find(session => session.name === name && session.sessionRef.sessionId === createdId);
    if (!row) throw new TmuxAdapterError('SESSION_MISSING', 'Created tmux session is no longer present');
    return row;
  }

  async function attachTarget({ sessionRef, readOnly = false } = {}) {
    if (!sessionRef || typeof sessionRef !== 'object'
      || sessionRef.serverName !== serverName
      || typeof sessionRef.instanceId !== 'string'
      || !/^[a-f0-9]{64}$/.test(sessionRef.instanceId)
      || typeof sessionRef.sessionId !== 'string'
      || !/^\$(0|[1-9]\d*)$/.test(sessionRef.sessionId)) {
      throw new TmuxAdapterError('INVALID_SESSION_REF', 'Invalid tmux session reference');
    }
    const state = await list();
    if (!state.available || state.instanceId !== sessionRef.instanceId) {
      throw new TmuxAdapterError('STALE_SERVER', 'tmux server instance has changed');
    }
    if (!state.sessions.some(row => row.sessionRef.sessionId === sessionRef.sessionId)) {
      throw new TmuxAdapterError('SESSION_MISSING', 'tmux session is no longer present');
    }
    return { command, args: ['-L', serverName, 'attach-session', ...(readOnly ? ['-r'] : []), '-t', sessionRef.sessionId], env: childEnv };
  }

  async function sessionsPanes(sessionRefs) {
    if (!Array.isArray(sessionRefs) || !sessionRefs.length || sessionRefs.length > 16) {
      throw new TmuxAdapterError('INVALID_SESSION_REF', 'Invalid tmux session selection');
    }
    const before = await list();
    if (!before.available || !before.instanceId || sessionRefs.some(ref => !ref ||
      ref.serverName !== serverName || ref.instanceId !== before.instanceId ||
      typeof ref.sessionId !== 'string' || !/^\$(0|[1-9]\d*)$/.test(ref.sessionId) ||
      !before.sessions.some(row => row.sessionRef.sessionId === ref.sessionId))) {
      throw new TmuxAdapterError('SESSION_MISSING', 'Selected tmux session is no longer present');
    }
    if (new Set(sessionRefs.map(ref => ref.sessionId)).size !== sessionRefs.length) {
      throw new TmuxAdapterError('INVALID_SESSION_REF', 'Duplicate tmux session selection');
    }
    let stdout;
    try { ({stdout}=await run(['-u','list-panes','-a','-F','#{session_id}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}'])); }
    catch(cause){throw new TmuxAdapterError('TMUX_COMMAND_FAILED','Unable to inspect tmux panes',cause);}
    const bySession = new Map(sessionRefs.map(ref => [ref.sessionId, []]));
    for (const line of stdout.trimEnd().split('\n').filter(Boolean)) {
      const fields=line.split('\t');
      if(fields.length!==4 || !/^\$(0|[1-9]\d*)$/.test(fields[0]) || !/^%\d+$/.test(fields[1]) ||
        !/^[1-9]\d*$/.test(fields[2]) || !isAbsolute(fields[3]) || fields[3].includes('\0'))
        throw new TmuxAdapterError('PROTOCOL_ERROR','Unexpected tmux pane listing');
      bySession.get(fields[0])?.push({paneId:fields[1],pid:Number(fields[2]),cwd:fields[3]});
    }
    const sessions=sessionRefs.map(sessionRef=>{
      const panes=bySession.get(sessionRef.sessionId);
      if(!panes.length||panes.length>64||new Set(panes.map(p=>p.paneId)).size!==panes.length)
        throw new TmuxAdapterError('PROTOCOL_ERROR','Invalid tmux pane count or identity');
      return {sessionRef,panes};
    });
    // A final listing catches a server restart or selected session exit during the pane snapshot.
    const after=await list();
    if(after.instanceId!==before.instanceId||sessionRefs.some(ref=>!after.sessions.some(row=>row.sessionRef.sessionId===ref.sessionId)))
      throw new TmuxAdapterError('SESSION_MISSING','Selected tmux session changed during inspection');
    return sessions;
  }

  async function sessionPanes(sessionRef) {
    return (await sessionsPanes([sessionRef]))[0].panes;
  }

  return { inspect, list, create, attachTarget, sessionPanes, sessionsPanes };
}
