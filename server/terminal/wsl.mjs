import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import { SESSION_FORMAT, TmuxAdapterError, noServer, parseSessions, validName } from './tmux.mjs';

const execFileAsync = promisify(execFile);

function decodedList(output) {
  if (typeof output === 'string') return output.replace(/^\uFEFF/, '');
  if (!Buffer.isBuffer(output)) throw new TmuxAdapterError('PROTOCOL_ERROR', 'Unexpected WSL distribution listing');
  if (output.length >= 2 && output[0] === 0xff && output[1] === 0xfe) return output.subarray(2).toString('utf16le');
  if (output.length >= 2 && output[0] === 0xfe && output[1] === 0xff) throw new TmuxAdapterError('PROTOCOL_ERROR', 'Unexpected WSL distribution encoding');
  if (output.includes(0)) return output.toString('utf16le');
  return output.toString('utf8').replace(/^\uFEFF/, '');
}

export function createWslSupport({
  platform = process.platform,
  env = process.env,
  executable,
  run = execFileAsync,
  timeoutMs = 5000,
} = {}) {
  const command = platform === 'win32'
    ? executable ?? win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'wsl.exe')
    : null;
  const present = Boolean(command && win32.isAbsolute(command) && (executable || existsSync(command)));

  async function invoke(args, encoding = 'utf8') {
    if (!present) throw new TmuxAdapterError('CAPABILITY_UNAVAILABLE', 'WSL executable is unavailable');
    return run(command, args, {
      env, timeout: timeoutMs, maxBuffer: 128 * 1024, encoding, windowsHide: true,
    });
  }

  async function discover() {
    if (platform !== 'win32') return { supported: false, available: false, distributions: [], reason: 'WSL requires Windows' };
    if (!present) return { supported: true, available: false, distributions: [], reason: 'WSL executable is unavailable' };
    try {
      const { stdout } = await invoke(['--list', '--quiet'], 'buffer');
      const distributions = decodedList(stdout).split(/\r?\n/).map(name => name.trim()).filter(Boolean);
      return { supported: true, available: distributions.length > 0, distributions,
        ...(distributions.length ? {} : { reason: 'No installed WSL distribution was listed' }) };
    } catch {
      return { supported: true, available: false, distributions: [], reason: 'Unable to list installed WSL distributions' };
    }
  }

  function inDistro(distro, user, argv) {
    return invoke(['--distribution', distro, ...(user ? ['--user', user] : []), '--exec', ...argv]);
  }

  async function configure({ distro, cwd } = {}) {
    const found = await discover();
    if (!found.available) throw new TmuxAdapterError('CAPABILITY_UNAVAILABLE', found.reason);
    if (typeof distro !== 'string' || !found.distributions.includes(distro)) {
      throw new TmuxAdapterError('DISTRO_UNAVAILABLE', 'Selected WSL distribution is unavailable');
    }
    if (typeof cwd !== 'string' || !posix.isAbsolute(cwd) || cwd.includes('\0')) {
      throw new TmuxAdapterError('INVALID_CWD', 'WSL working directory must be an absolute Linux path');
    }
    let user, uidText;
    try {
      user = (await inDistro(distro, null, ['id', '-un'])).stdout.trim();
      uidText = (await inDistro(distro, user, ['id', '-u'])).stdout.trim();
      await inDistro(distro, user, ['test', '-d', cwd]);
    } catch (cause) {
      throw new TmuxAdapterError('DISTRO_UNAVAILABLE', 'Unable to verify WSL user or working directory', cause);
    }
    if (!user || /[\r\n\0]/.test(user) || !/^(0|[1-9]\d*)$/.test(uidText)
      || !Number.isSafeInteger(Number(uidText))) {
      throw new TmuxAdapterError('PROTOCOL_ERROR', 'Unexpected WSL user identity');
    }
    return { distro, user, uid: Number(uidText), cwd };
  }

  function adapter(profile) {
    const { wsl, serverName } = profile ?? {};
    validName(serverName, 'serverName');
    if (!wsl || typeof wsl.distro !== 'string' || !wsl.distro ||
      typeof wsl.user !== 'string' || !wsl.user ||
      !Number.isSafeInteger(wsl.uid) || wsl.uid < 0 ||
      typeof wsl.cwd !== 'string' || !posix.isAbsolute(wsl.cwd) || wsl.cwd.includes('\0')) {
      throw new TmuxAdapterError('INVALID_PROFILE', 'Invalid WSL terminal profile');
    }
    const { distro, user, uid, cwd } = wsl;

    async function targetAvailable() {
      try {
        const actualUid = (await inDistro(distro, user, ['id', '-u'])).stdout.trim();
        if (!/^(0|[1-9]\d*)$/.test(actualUid) || Number(actualUid) !== uid) {
          return { available: false, reason: 'WSL user identity changed' };
        }
        const version = (await inDistro(distro, user, ['tmux', '-V'])).stdout.trim();
        return { available: true, version };
      } catch {
        return { available: false, reason: 'WSL distribution, user or tmux is unavailable' };
      }
    }

    function tmuxArgs(args) {
      return ['--distribution', distro, '--user', user, '--exec', 'tmux', '-u', '-L', serverName, ...args];
    }

    async function list() {
      const status = await targetAvailable();
      if (!status.available) return { available: false, serverName, instanceId: null, serverPid: null, sessions: [], reason: status.reason };
      let rows;
      try {
        rows = parseSessions((await invoke(tmuxArgs(['list-sessions', '-F', SESSION_FORMAT]))).stdout);
      } catch (cause) {
        if (noServer(cause)) rows = [];
        else if (cause instanceof TmuxAdapterError) throw cause;
        else throw new TmuxAdapterError('TMUX_COMMAND_FAILED', 'Unable to list WSL tmux sessions', cause);
      }
      let instanceId = null;
      if (rows.length) {
        const first = rows[0];
        if (rows.some(row => row.serverPid !== first.serverPid ||
          row.serverStartTime !== first.serverStartTime || row.socketPath !== first.socketPath)) {
          throw new TmuxAdapterError('PROTOCOL_ERROR', 'WSL tmux listing contains multiple server identities');
        }
        instanceId = createHash('sha256').update(JSON.stringify([
          distro, user, uid, first.serverPid, first.serverStartTime, first.socketPath,
        ])).digest('hex');
      }
      return { available: true, serverName, instanceId, serverPid: null,
        sessions: rows.map(({ sessionId, name, windows, attached }) => ({
          sessionRef: { serverName, instanceId, sessionId }, name, windows, attached,
        })) };
    }

    async function inspect() {
      const status = await targetAvailable();
      if (!status.available) return { available: false, serverName, instanceId: null, serverPid: null, reason: status.reason };
      const state = await list();
      if (!state.available) return { available: false, serverName, instanceId: null, serverPid: null, reason: state.reason };
      return { available: true, version: status.version, serverName, instanceId: state.instanceId, serverPid: null };
    }

    async function create({ name } = {}) {
      validName(name, 'session name');
      const status = await targetAvailable();
      if (!status.available) throw new TmuxAdapterError('CAPABILITY_UNAVAILABLE', status.reason);
      let createdId;
      try {
        createdId = (await invoke(tmuxArgs(['new-session', '-d', '-s', name, '-c', cwd, '-P', '-F', '#{session_id}']))).stdout.trim();
      } catch (cause) {
        throw new TmuxAdapterError('TMUX_CREATE_FAILED', 'Unable to create WSL tmux session', cause);
      }
      if (!/^\$(0|[1-9]\d*)$/.test(createdId)) throw new TmuxAdapterError('PROTOCOL_ERROR', 'WSL tmux returned an invalid session ID');
      const state = await list();
      const row = state.sessions.find(session => session.name === name && session.sessionRef.sessionId === createdId);
      if (!row) throw new TmuxAdapterError('SESSION_MISSING', 'Created WSL tmux session is no longer present');
      return row;
    }

    async function attachTarget({ sessionRef, readOnly = false } = {}) {
      if (!sessionRef || sessionRef.serverName !== serverName ||
        typeof sessionRef.instanceId !== 'string' || !/^[a-f0-9]{64}$/.test(sessionRef.instanceId) ||
        typeof sessionRef.sessionId !== 'string' || !/^\$(0|[1-9]\d*)$/.test(sessionRef.sessionId)) {
        throw new TmuxAdapterError('INVALID_SESSION_REF', 'Invalid WSL tmux session reference');
      }
      const state = await list();
      if (!state.available || state.instanceId !== sessionRef.instanceId) throw new TmuxAdapterError('STALE_SERVER', 'WSL tmux server or user has changed');
      if (!state.sessions.some(row => row.sessionRef.sessionId === sessionRef.sessionId)) throw new TmuxAdapterError('SESSION_MISSING', 'WSL tmux session is no longer present');
      return { command, args: tmuxArgs(['attach-session', ...(readOnly ? ['-r'] : []), '-t', sessionRef.sessionId]), env };
    }

    function unsupportedProof() {
      throw new TmuxAdapterError('CAPABILITY_UNAVAILABLE', 'WSL tmux process proof is unavailable');
    }
    return { inspect, list, create, attachTarget, sessionPanes: unsupportedProof, sessionsPanes: unsupportedProof };
  }

  return { discover, configure, adapter };
}
