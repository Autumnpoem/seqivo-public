import { accessSync, realpathSync, statSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import pty from 'node-pty';

export class TerminalRuntimeError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TerminalRuntimeError';
    this.code = code;
  }
}

export function validateTerminalCwd(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new TerminalRuntimeError('INVALID_CWD', 'Terminal working directory must be absolute');
  }
  try {
    const real = realpathSync(cwd);
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
    return real;
  } catch (cause) {
    throw new TerminalRuntimeError('INVALID_CWD', 'Terminal working directory is unavailable', cause);
  }
}

function validateExecutable(shell) {
  if (typeof shell !== 'string' || !isAbsolute(shell)) {
    throw new TerminalRuntimeError('INVALID_SHELL', 'Terminal executable must be an absolute path');
  }
  try {
    const real = realpathSync(shell);
    if (!statSync(real).isFile()) throw new Error('not a file');
    accessSync(real, constants.X_OK);
    return real;
  } catch (cause) {
    throw new TerminalRuntimeError('INVALID_SHELL', 'Terminal executable is unavailable', cause);
  }
}

function dimension(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new TerminalRuntimeError('INVALID_SIZE', `${name} must be an integer from 1 to 500`);
  }
  return value;
}

function splitBounded(text, maxBytes, emit) {
  let chunk = '';
  let size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > maxBytes && chunk) {
      emit(chunk);
      chunk = '';
      size = 0;
    }
    chunk += char;
    size += bytes;
  }
  if (chunk) emit(chunk);
}

/**
 * Spawn an owned local PTY. `close()` ends only this PTY's child and awaits its exit.
 * When the child is `tmux attach-session`, this detaches this client; it does not
 * terminate a tmux session or server. A plain shell cannot survive close: retain
 * this handle across client disconnects if its shell must continue running.
 */
export function createTerminalRuntime({
  shell,
  cwd,
  args = [],
  env = process.env,
  cols = 80,
  rows = 24,
  onData = () => {},
  onExit = () => {},
  maxChunkBytes = 64 * 1024,
} = {}) {
  const command = validateExecutable(shell);
  const directory = validateTerminalCwd(cwd);
  dimension(cols, 'cols');
  dimension(rows, 'rows');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new TerminalRuntimeError('INVALID_ARGS', 'Terminal arguments must be strings without NUL');
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new TerminalRuntimeError('INVALID_ENV', 'Terminal environment must be an object');
  }
  if (typeof onData !== 'function' || typeof onExit !== 'function') {
    throw new TerminalRuntimeError('INVALID_CALLBACK', 'Terminal callbacks must be functions');
  }
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 4 || maxChunkBytes > 64 * 1024) {
    throw new TerminalRuntimeError('INVALID_BOUND', 'maxChunkBytes must be from 4 to 65536');
  }

  let child;
  try {
    child = pty.spawn(command, args, {
      cwd: directory,
      env,
      cols,
      rows,
      name: 'xterm-256color',
    });
  } catch (cause) {
    throw new TerminalRuntimeError('SPAWN_FAILED', 'Unable to start terminal PTY', cause);
  }

  let closed = false;
  let exited = false;
  let exitResult;
  let resolveExit;
  const exitPromise = new Promise(resolve => { resolveExit = resolve; });
  const dataSubscription = child.onData(data => {
    if (!closed) splitBounded(data, maxChunkBytes, onData);
  });
  const exitSubscription = child.onExit(event => {
    if (exited) return;
    exited = true;
    exitResult = { exitCode: event.exitCode, signal: event.signal };
    resolveExit(exitResult);
    onExit(exitResult);
  });

  return {
    pid: child.pid,
    write(data) {
      if (closed || exited) throw new TerminalRuntimeError('TERMINAL_CLOSED', 'Terminal is closed');
      if (typeof data !== 'string' || Buffer.byteLength(data) > 16 * 1024) {
        throw new TerminalRuntimeError('INVALID_INPUT', 'Terminal input must be a string of at most 16384 bytes');
      }
      child.write(data);
    },
    resize(nextCols, nextRows) {
      if (closed || exited) throw new TerminalRuntimeError('TERMINAL_CLOSED', 'Terminal is closed');
      child.resize(dimension(nextCols, 'cols'), dimension(nextRows, 'rows'));
    },
    async close({ timeoutMs = 3000 } = {}) {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
        throw new TerminalRuntimeError('INVALID_TIMEOUT', 'timeoutMs must be from 1 to 30000');
      }
      if (!closed) {
        closed = true;
        dataSubscription.dispose();
        if (!exited) {
          try { child.kill(); } catch (cause) {
            if (!exited) throw new TerminalRuntimeError('CLOSE_FAILED', 'Unable to close terminal PTY', cause);
          }
        }
      }
      if (exited) return exitResult;
      let timer;
      try {
        return await Promise.race([
          exitPromise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new TerminalRuntimeError('CLOSE_TIMEOUT', 'Terminal PTY exit was not observed')), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        if (exited) exitSubscription.dispose();
      }
    },
  };
}
