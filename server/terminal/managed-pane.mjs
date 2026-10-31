import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, chmod, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createTmuxAdapter } from './tmux.mjs';

const VERSION = 1;
const SCRIPT = fileURLToPath(new URL('./managed-pane-supervisor.py', import.meta.url));
const RELAY_SCRIPT = fileURLToPath(new URL('./managed-pane-relay.py', import.meta.url));
const execFileAsync = promisify(execFile);
const MAX_LINE = 65536;
const deadline = (work, ms, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), ms);
  Promise.resolve(work).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

/** One capability grants one current socket; disconnect preserves the child.
 * PTY output while disconnected is discarded by the supervisor.  Reconnect
 * gives status and future output, not a complete transcript or replay offset.
 * The UI must report this gap before presenting the pane as fully resumed.
 */
export class ManagedPane extends EventEmitter {
  constructor(socket, { socketPath, capability, hello, requestTimeoutMs = 5000 }) {
    super();
    this.socket = socket;
    this.socketPath = socketPath;
    Object.defineProperty(this, 'capability', { value: capability, enumerable: false });
    this.requestTimeoutMs = requestTimeoutMs;
    this.identity = Object.freeze({ supervisorPid: hello.supervisorPid, childPid: hello.childPid });
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    socket.on('data', chunk => this.onChunk(chunk));
    socket.on('close', () => this.onClose());
    socket.on('error', error => this.onClose(error));
  }

  onChunk(chunk) {
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > MAX_LINE * 2) { this.socket.destroy(new Error('Managed pane frame exceeds limit')); return; }
    for (let index; (index = this.buffer.indexOf('\n')) >= 0;) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      let frame;
      try { frame = JSON.parse(line); } catch { this.socket.destroy(new Error('Invalid managed pane frame')); return; }
      if (frame.type === 'reply') {
        const pending = this.pending.get(frame.id);
        if (!pending) continue;
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok === true) pending.resolve(frame.result);
        else pending.reject(Object.assign(new Error(String(frame.error || 'Managed pane operation failed')), { code: 'PANE_OPERATION_FAILED' }));
      } else if (frame.type === 'output' && typeof frame.data === 'string') {
        this.emit('data', Buffer.from(frame.data, 'base64'));
      } else if (frame.type === 'exit') this.emit('exit', frame.exitCode);
      else { this.socket.destroy(new Error('Unexpected managed pane frame')); return; }
    }
  }

  onClose(error = new Error('Managed pane connection closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('disconnect');
  }

  call(op, extra = {}) {
    if (this.closed) return Promise.reject(new Error('Managed pane connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // The request may already have taken effect.  Do not permit any more
        // input on this connection; a fresh authenticated status is required.
        const error = new Error(`Managed pane ${op} timed out; result unknown`);
        this.onClose(error);
        this.socket.destroy();
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ v: VERSION, op, id, ...extra }) + '\n', error => {
        if (error && this.pending.delete(id)) { clearTimeout(timer); reject(error); }
      });
    });
  }

  write(data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (bytes.length > 16384) return Promise.reject(new RangeError('Managed pane input exceeds limit'));
    return this.call('input', { data: bytes.toString('base64') });
  }
  resize(rows, cols) { return this.call('resize', { rows, cols }); }
  park() { return this.call('park'); }
  resume() { return this.call('resume'); }
  status() { return this.call('status'); }
  shutdown() { return this.call('shutdown'); }
  close() { this.socket.end(); this.socket.destroy(); this.onClose(); }
}

/** Allocate the private sockets and both capabilities before starting a shell.
 * Callers persisting this descriptor must keep it outside public metadata.
 */
export async function prepareManagedPane({ rootDir = tmpdir(), relay = false } = {}) {
  if (typeof rootDir !== 'string' || !isAbsolute(rootDir) || typeof relay !== 'boolean')
    throw new TypeError('Invalid managed pane preparation');
  const directory = await mkdtemp(join(await realpath(rootDir), 'seqivo-managed-pane-'));
  try {
    await chmod(directory, 0o700);
    const socketPath = join(directory, 'control.sock');
    const relaySocketPath = join(directory, 'relay.sock');
    const relayTokenFile = join(directory, 'relay.token');
    if (Buffer.byteLength(socketPath) >= 100 || (relay && Buffer.byteLength(relaySocketPath) >= 100))
      throw new RangeError('Managed pane control socket path is too long');
    const capability = randomBytes(32).toString('hex');
    const relayCapability = relay ? randomBytes(32).toString('hex') : null;
    if (relay) await writeFile(relayTokenFile, relayCapability, { mode: 0o600, flag: 'wx' });
    return { directory, socketPath, relaySocketPath, relayTokenFile, capability, relayCapability };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Reattach only with the original random capability; no PID-based adoption. */
export async function connectManagedPane({ socketPath, capability, expectedIdentity = null, timeoutMs = 5000,
  requestTimeoutMs = 5000 }) {
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath) ||
      typeof capability !== 'string' || !/^[a-f0-9]{64}$/.test(capability) ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 10 || requestTimeoutMs > 30000)
    throw new TypeError('Invalid managed pane capability or timeout');
  const socket = createConnection(socketPath);
  try {
    const hello = await deadline(new Promise((resolve, reject) => {
      let buffer = '';
      const cleanup = () => { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); };
      const onError = error => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error('Managed pane authentication refused')); };
      const onData = chunk => {
        buffer += chunk.toString('utf8');
        if (buffer.length > MAX_LINE) { cleanup(); reject(new Error('Managed pane greeting exceeds limit')); return; }
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        cleanup();
        try {
          const frame = JSON.parse(buffer.slice(0, index));
          if (frame.type !== 'hello' || !Number.isSafeInteger(frame.childPid) || !Number.isSafeInteger(frame.supervisorPid))
            throw new Error('Invalid managed pane greeting');
          if (expectedIdentity && (expectedIdentity.childPid !== frame.childPid || expectedIdentity.supervisorPid !== frame.supervisorPid))
            throw new Error('Managed pane process identity changed');
          resolve({ frame, remainder: buffer.slice(index + 1) });
        } catch (error) { reject(error); }
      };
      socket.on('data', onData); socket.once('error', onError); socket.once('close', onClose);
      socket.once('connect', () => socket.write(JSON.stringify({ v: VERSION, op: 'hello', capability }) + '\n'));
    }), timeoutMs, 'Managed pane authentication timed out');
    const pane = new ManagedPane(socket, { socketPath, capability, hello: hello.frame, requestTimeoutMs });
    if (hello.remainder) pane.onChunk(Buffer.from(hello.remainder));
    return pane;
  } catch (error) { socket.destroy(); throw error; }
}

/** Starts only a new shell; callers must retain the returned capability securely. */
export async function createManagedPane({ pythonPath, shell, args = ['-i'], cwd, rows = 24, cols = 80,
  rootDir = tmpdir(), timeoutMs = 5000, relay = false, prepared = null } = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Managed pane is unsupported on this platform');
  if (![pythonPath, shell, cwd, rootDir].every(value => typeof value === 'string' && isAbsolute(value)) ||
      !Array.isArray(args) || args.some(value => typeof value !== 'string') ||
      !Number.isInteger(rows) || rows < 5 || rows > 100 || !Number.isInteger(cols) || cols < 20 || cols > 300 ||
      typeof relay !== 'boolean')
    throw new TypeError('Invalid managed pane configuration');
  const descriptor = prepared || await prepareManagedPane({ rootDir, relay });
  const { directory, socketPath, relaySocketPath, relayTokenFile, capability, relayCapability } = descriptor;
  if (prepared && (!relay || typeof directory !== 'string' || !isAbsolute(directory) ||
      socketPath !== join(directory, 'control.sock') || relaySocketPath !== join(directory, 'relay.sock') ||
      relayTokenFile !== join(directory, 'relay.token') ||
      !/^[a-f0-9]{64}$/.test(capability) || !/^[a-f0-9]{64}$/.test(relayCapability)))
    throw new TypeError('Invalid prepared managed pane');
  const child = spawn(pythonPath, ['-B', SCRIPT], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let startupDiagnostic = '';
  child.stderr.on('data', chunk => { startupDiagnostic = (startupDiagnostic + chunk.toString('utf8')).slice(0, 160); });
  let ready;
  try {
    ready = await deadline(new Promise((resolve, reject) => {
      let output = '';
      const onData = chunk => {
        output += chunk.toString('utf8');
        if (output.length > 4096) { cleanup(); reject(new Error('Managed pane startup frame exceeds limit')); return; }
        const index = output.indexOf('\n');
        if (index < 0) return;
        cleanup();
        try {
          const frame = JSON.parse(output.slice(0, index));
          if (frame.v !== VERSION || frame.ready !== true || !Number.isSafeInteger(frame.childPid) || frame.supervisorPid !== child.pid)
            throw new Error('Invalid managed pane startup identity');
          resolve(frame);
        } catch (error) { reject(error); }
      };
      const onExit = () => { cleanup(); reject(new Error(`Managed pane supervisor exited before readiness; child state unknown${startupDiagnostic ? ` (${startupDiagnostic.trim()})` : ''}`)); };
      const onError = error => { cleanup(); reject(error); };
      const cleanup = () => { child.stdout.off('data', onData); child.off('exit', onExit); child.off('error', onError); };
      child.stdout.on('data', onData); child.once('exit', onExit); child.once('error', onError);
      child.stdin.end(JSON.stringify({ v: VERSION, capability, socketPath, shell, args, cwd, rows, cols,
        ...(relay ? { relayCapability, relaySocketPath } : {}) }) + '\n');
    }), timeoutMs, 'Managed pane startup timed out; child state unknown');
  } catch (error) {
    // A shell might already exist. Never claim it stopped or signal an
    // unconfirmed PID; return the private recovery coordinates to the caller.
    Object.defineProperty(error, 'recovery', { value: { supervisorPid: child.pid, socketPath, capability } });
    throw error;
  }
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  try {
    const pane = await connectManagedPane({ socketPath, capability, expectedIdentity: ready, timeoutMs });
    if (relay) Object.defineProperty(pane, 'relay', {
      value: Object.freeze({ socketPath: relaySocketPath, tokenFile: relayTokenFile }), enumerable: false,
    });
    return pane;
  }
  catch (error) {
    Object.defineProperty(error, 'recovery', { value: { supervisorPid: ready.supervisorPid, childPid: ready.childPid, socketPath, capability } });
    throw error;
  }
}

/** Prototype: creates a *new* tmux session whose pane is only a relay.
 * The shell remains the direct child of the separate supervisor. A session
 * creation failure retains the shell and recovery coordinates; it never
 * kills an existing tmux server or claims a completed handoff.
 */
export async function createManagedTmuxSession({ pythonPath, shell, args = ['-i'], cwd,
  rootDir = tmpdir(), tmuxPath, serverName, name, rows = 24, cols = 80, timeoutMs = 5000, preparedPane = null } = {}) {
  if (![tmuxPath, serverName, name].every(value => typeof value === 'string') ||
      !isAbsolute(tmuxPath) ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(serverName) ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name))
    throw new TypeError('Invalid managed tmux identity');
  const pane = await createManagedPane({ pythonPath, shell, args, cwd, rootDir, rows, cols, timeoutMs, relay: true, prepared: preparedPane });
  const adapter = createTmuxAdapter({ executable: tmuxPath, serverName, timeoutMs });
  let createdId;
  try {
    const { stdout } = await execFileAsync(tmuxPath,
      ['-L', serverName, 'new-session', '-d', '-s', name, '-c', await realpath(cwd), '-P', '-F', '#{session_id}',
        pythonPath, '-B', RELAY_SCRIPT, pane.relay.socketPath, pane.relay.tokenFile],
      { timeout: timeoutMs, maxBuffer: 8192, env: { ...process.env, TMUX: '' },
        ...(process.platform==='linux'?{cwd:'/'}:{}) });
    createdId = stdout.trim();
    if (!/^\$\d+$/.test(createdId)) throw new Error('Invalid created tmux session identity');
    const state = await adapter.list();
    const session = state.sessions.find(row => row.name === name && row.sessionRef.sessionId === createdId);
    if (!session) throw new Error('Created tmux session disappeared');
    const panes = await adapter.sessionPanes(session.sessionRef);
    if (panes.length !== 1) throw new Error('Managed tmux session has an unexpected pane count');
    return Object.freeze({ pane, sessionRef: session.sessionRef, shellIdentity: pane.identity,
      relayPaneId: panes[0].paneId, relayPanePid: panes[0].pid });
  } catch (error) {
    // Release this control connection so the recovery coordinates can be
    // used. This freezes relay input; it does not stop the shell or tmux.
    pane.close();
    Object.defineProperty(error, 'recovery', { value: {
      socketPath: pane.socketPath, capability: pane.capability, identity: pane.identity,
      serverName, sessionId: createdId || null,
    }, enumerable: false });
    throw error;
  }
}
