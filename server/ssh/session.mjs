import ssh2 from 'ssh2';
const { Client } = ssh2;
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { credentials, fail, SshError } from './store.mjs';
import { resolveSshTarget } from './network.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const format = '#{pid}\t#{start_time}\t#{socket_path}\t#{session_id}\t#{session_name}\t#{session_windows}';
const sameSession = (a, b) => a && b && a.id === b.id && a.server === b.server;
export function initialTmuxSession(sessions, defaultSession, recoverSession) {
  const wanted = recoverSession || defaultSession;
  return wanted ? sessions.find(item => sameSession(item, wanted)) || null : null;
}
const size = (n, fallback) => Number.isInteger(n) && n >= 2 && n <= 500 ? n : fallback;
const fingerprint = key => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** One socket owns one SSH connection. Detach never kills a remote tmux session. */
export function createSshSession({ store, owner, hostId, suppliedCredentials, jumpCredentials,
  send, validate, allowPrivateTargets = false, recoverSession = null,
  expectedHostRevision = null, onClose = () => {} }) {
  let host = store.get(owner, hostId), jump = host.jumpHostId ? store.get(owner, host.jumpHostId) : null;
  if (recoverSession && host.revision !== expectedHostRevision)
    fail('原 SSH 主机配置已变化，请重新选择', 'SSH_CONFLICT', 409);
  let channel = null, selected = null, generation = null, sequence = 0, rows = 24, cols = 80;
  let closed = false, pendingTrust = null, busy = false, client = null;
  const clients = new Set();
  const timers = new Set();
  const check = () => {
    if (closed || !validate()) fail('登录已失效，请重新连接', 'SSH_UNAUTHORIZED', 401);
    if (store.get(owner, hostId).revision !== host.revision ||
      jump && store.get(owner, jump.id).revision !== jump.revision)
      fail('连接配置已变更，请重新连接', 'SSH_CONFLICT', 409);
  };
  function timer(fn, ms) { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); t.unref?.(); return t; }
  function clear(t) { clearTimeout(t); timers.delete(t); }
  function close() {
    if (closed) return;
    closed = true; generation = null;
    if (pendingTrust) { const p = pendingTrust; pendingTrust = null; p.accept(false); }
    for (const t of timers) clearTimeout(t); timers.clear();
    clearInterval(authTimer);
    channel?.close(); channel = null;
    for (const c of clients) c.destroy(); clients.clear();
    suppliedCredentials = null; jumpCredentials = null;
    onClose();
  }
  function report(error) {
    if (!closed) send({ type: 'error', code: error.code || 'SSH_CONNECTION_FAILED',
      message: error instanceof SshError ? error.message : 'SSH 连接失败，请检查地址、网络和登录凭据。' });
  }
  const authTimer = setInterval(() => { try { check(); } catch (e) { report(e); close(); } }, 3000);
  authTimer.unref?.();
  timer(() => { report(new SshError('连接已到期，请重新连接；tmux 会话仍在目标主机上。', 'SSH_EXPIRED')); close(); }, 8 * 60 * 60 * 1000);

  async function connect(profile, provided, sock) {
    check();
    const secret = credentials(provided ?? store.credential(owner, profile.id), profile.authMethod);
    const address = sock ? null : await resolveSshTarget(profile.host, allowPrivateTargets);
    check();
    const c = new Client(); clients.add(c);
    c.on('error', () => {}); // Per-operation error listeners handle user-facing failures.
    await new Promise((resolve, reject) => {
      let settled = false;
      const deadline = timer(() => finish(new SshError('SSH 连接超时，请重试', 'SSH_TIMEOUT')), 60000);
      const finish = error => {
        if (settled) return; settled = true; clear(deadline);
        if (error) { c.destroy(); clients.delete(c); reject(error); } else resolve();
      };
      c.once('error', () => finish(new SshError('SSH 登录失败，请检查凭据或服务器配置。', 'SSH_AUTH_FAILED')));
      c.once('close', () => {
        if (!settled) finish(new SshError('SSH 连接已断开', 'SSH_DISCONNECTED'));
        else if (!closed) { send({ type: 'disconnected', message: 'SSH 连接已断开；不会重发输入。' }); close(); }
      });
      c.once('ready', () => { try { check(); finish(); } catch (e) { finish(e); } });
      try {
        c.connect({ ...(sock ? { sock } : { host: address, port: profile.port }),
          username: profile.username, ...secret, readyTimeout: 60000,
          keepaliveInterval: 15000, keepaliveCountMax: 3,
          tryKeyboard: false,
          hostVerifier(key, accept) {
            try {
              check();
              const presented = fingerprint(key);
              const currentProfile = store.get(owner, profile.id);
              if (currentProfile.fingerprint === presented) return accept(true);
              // No password/private-key authentication is sent until this challenge is approved.
              const challenge = randomUUID();
              pendingTrust = { challenge, profile: currentProfile, fingerprint: presented, accept };
              send({ type: 'hostKey', challenge, hostId: profile.id, name: profile.name,
                host: profile.host, port: profile.port, fingerprint: presented,
                previousFingerprint: currentProfile.fingerprint, changed: Boolean(currentProfile.fingerprint) });
            } catch { accept(false); }
          },
        });
      } catch (e) { finish(e); }
    });
    return c;
  }
  function exec(command) {
    check();
    return new Promise((resolve, reject) => {
      let stream, settled = false, length = 0, out = '', err = '';
      const decoder = new StringDecoder('utf8'), errors = new StringDecoder('utf8');
      const done = (error, code) => {
        if (settled) return; settled = true; clear(deadline);
        stream?.close();
        error ? reject(error) : resolve({ code, out: out + decoder.end(), err: err + errors.end() });
      };
      const deadline = timer(() => done(new SshError('读取远程会话超时', 'SSH_TIMEOUT')), 10000);
      client.exec(command, (error, opened) => {
        if (error) return done(error);
        stream = opened;
        if (settled || closed) { stream.close(); return done(new Error('Closed')); }
        const append = (data, stderr) => {
          length += data.length;
          if (length > 262144) return done(new SshError('远程会话列表过大', 'SSH_OUTPUT_LIMIT'));
          if (stderr) err += errors.write(data); else out += decoder.write(data);
        };
        stream.on('data', data => append(data, false));
        stream.stderr.on('data', data => append(data, true));
        stream.once('error', e => done(e));
        stream.once('close', code => done(null, code));
      });
    });
  }
  const tmux = () => `tmux -L ${quote(host.tmuxServer)}`;
  async function list() {
    const result = await exec(`${tmux()} list-sessions -F ${quote(format)}`);
    check();
    if (result.code !== 0) {
      if (/no server running|error connecting to .*No such file|failed to connect to server/i.test(result.err))
        return { available: true, sessions: [] };
      if (result.code === 127 || /tmux:.*not found/i.test(result.err))
        return { available: false, sessions: [] };
      fail('无法读取 tmux 会话，请检查远程账号权限和 tmux 设置', 'SSH_TMUX_LIST');
    }
    const sessions = result.out.trimEnd().split('\n').filter(Boolean).map(line => {
      const fields = line.split('\t');
      if (fields.length !== 6 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1]) ||
        !fields[2].startsWith('/') || !/^\$\d+$/.test(fields[3]) || !/^\d+$/.test(fields[5]))
        fail('远程 tmux 返回了无法识别的会话列表', 'SSH_TMUX_PROTOCOL');
      return { id: fields[3], name: fields[4].slice(0, 160), windows: Number(fields[5]),
        server: createHash('sha256').update(fields.slice(0, 3).join('\0')).digest('hex') };
    });
    return { available: true, sessions };
  }
  async function sendList() {
    const result = await list();
    send({ type: 'sessions', ...result, defaultSession: host.defaultSession, current: selected,
      hostRevision: host.revision });
    return result;
  }
  function sealInputForSwitch() {
    generation = null;
    selected = null;
    const previous = channel;
    channel = null;
    previous?.close();
  }
  async function open(ref) {
    check();
    // Reject old-generation input before list() or opening a new SSH channel can await.
    sealInputForSwitch();
    let picked = null;
    if (ref) {
      const result = await list();
      picked = result.sessions.find(item => sameSession(item, ref));
      if (!picked) fail('此 tmux 会话已结束或发生变化，请重新选择', 'SSH_SESSION_GONE', 409);
    }
    check();
    await new Promise((resolve, reject) => {
      let finished = false;
      const deadline = timer(() => { finished = true; reject(new SshError('打开终端超时', 'SSH_TIMEOUT')); }, 10000);
      const ready = (error, stream) => {
        clear(deadline);
        if (finished) { stream?.close(); return; }
        finished = true;
        if (error) return reject(error);
        if (closed) { stream.close(); return reject(new Error('Closed')); }
        try { check(); } catch (e) { stream.close(); close(); return reject(e); }
        channel = stream; selected = picked; generation = randomUUID(); sequence = 0;
        const current = generation, decoder = new StringDecoder('utf8');
        const output = data => {
          if (channel !== stream) return;
          try { check(); } catch { close(); return; }
          send({ type: 'output', generation: current, data: decoder.write(data) });
        };
        stream.on('data', output);
        stream.stderr.on('data', output);
        stream.on('error', () => {});
        stream.on('close', () => {
          if (channel !== stream) return;
          channel = null; generation = null;
          send({ type: 'exit', generation: current, message: '终端已结束；可选择其他会话。' });
        });
        send({ type: 'ready', generation, session: picked, mode: picked ? 'tmux' : 'shell' });
        resolve();
      };
      const pty = { term: 'xterm-256color', rows, cols };
      if (picked) client.exec(`${tmux()} attach-session -t ${quote(picked.id)}`, { pty }, ready);
      else client.shell(pty, ready);
    });
  }
  async function start() {
    // A recovery must finish its exact selection before another socket frame
    // can select or create a different session from the initial list.
    if (recoverSession) busy = true;
    try {
      let forwarded;
      if (jump) {
        const jumpClient = await connect(jump, jumpCredentials);
        forwarded = await new Promise((resolve, reject) => {
          let finished = false;
          const deadline = timer(() => { finished = true; reject(new SshError('跳板连接超时', 'SSH_TIMEOUT')); }, 10000);
          jumpClient.forwardOut('127.0.0.1', 0, host.host, host.port, (error, stream) => {
            clear(deadline);
            if (finished) { stream?.close(); return; }
            finished = true;
            if (closed) { stream?.close(); return reject(new Error('Closed')); }
            error ? reject(error) : resolve(stream);
          });
        });
      }
      client = await connect(host, suppliedCredentials, forwarded);
      check();
      suppliedCredentials = null; jumpCredentials = null;
      send({ type: 'connected', host: store.get(owner, hostId) });
      let result;
      try { result = await sendList(); }
      catch (error) {
        check();
        // A non-POSIX login shell or a broken tmux setup must not prevent ordinary SSH.
        if (!['SSH_TMUX_LIST', 'SSH_TMUX_PROTOCOL', 'SSH_TIMEOUT', 'SSH_OUTPUT_LIMIT'].includes(error.code)) throw error;
        result = { available: false, sessions: [] };
        send({ type: 'sessions', ...result, defaultSession: host.defaultSession, current: null,
          hostRevision: host.revision });
        send({ type: 'notice', message: 'SSH 已登录，但无法读取 tmux。可先打开普通 Shell 核对目标环境。' });
      }
      if (recoverSession) {
        const found = result.available ? initialTmuxSession(result.sessions, null, recoverSession) : null;
        if (found) await open(found);
        else {
          send({ type: 'notice', message: '原 tmux 会话已结束、变化或暂时无法核对，请明确选择；不会进入默认会话或新建。' });
          send({ type: 'recoverySettled', outcome: 'missing', session: recoverSession });
        }
      } else if (host.defaultSession) {
        const found = initialTmuxSession(result.sessions, host.defaultSession, null);
        if (found) await open(found);
        else send({ type: 'notice', message: '默认会话已结束或变化，请选择其他会话；不会自动新建。' });
      }
    } catch (e) { report(e); close(); }
    finally { if (recoverSession) busy = false; }
  }
  async function frame(value) {
    check();
    if (value.type === 'trust') {
      const p = pendingTrust;
      if (!p || value.challenge !== p.challenge || value.fingerprint !== p.fingerprint ||
        value.approve !== true || p.profile.fingerprint && value.replace !== true)
        fail('主机身份确认无效，请重新连接', 'SSH_HOST_KEY');
      const updated = store.pin(owner, p.profile.id, p.fingerprint, p.profile.revision);
      if (p.profile.id === host.id) host = updated; else jump = updated;
      pendingTrust = null; p.accept(true);
      return;
    }
    if (!client) fail('正在建立 SSH 连接', 'SSH_CONNECTING', 409);
    if (pendingTrust) fail('请先核对服务器身份', 'SSH_HOST_KEY', 409);
    if (value.type === 'input') {
      if (!channel || !generation || value.generation !== generation || value.sequence !== sequence + 1 ||
        typeof value.data !== 'string' || Buffer.byteLength(value.data) > 16384)
        fail('输入现场已变化；内容未重发，请重新连接', 'SSH_INPUT_STALE', 409);
      if (channel.writableLength > 262144) fail('远程主机暂时无法接收更多输入', 'SSH_BACKPRESSURE', 429);
      sequence = value.sequence; channel.write(value.data);
      send({ type: 'inputAck', generation, sequence }); return;
    }
    if (value.type === 'resize') {
      rows = size(value.rows, 24); cols = size(value.cols, 80);
      channel?.setWindow(rows, cols, 0, 0); return;
    }
    if (busy) fail('正在切换，请稍候', 'SSH_BUSY', 409);
    busy = true;
    try {
      if (value.type === 'list') await sendList();
      else if (value.type === 'select') { await open(value.session); await sendList(); }
      else if (value.type === 'shell') await open(null);
      else if (value.type === 'create') {
        if (typeof value.name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(value.name)) fail('会话名请使用 1–64 位字母、数字、下划线或短横线');
        sealInputForSwitch();
        const result = await exec(`${tmux()} new-session -d -s ${quote(value.name)}`);
        if (result.code !== 0) fail('新建会话未成功，请刷新列表核对；不会自动重试', 'SSH_CREATE_FAILED');
        const found = (await sendList()).sessions.find(item => item.name === value.name);
        if (found) await open(found);
      } else if (value.type === 'default') {
        const found = value.session === null ? null : (await list()).sessions.find(item => sameSession(item, value.session));
        if (value.session !== null && !found) fail('该会话已结束，请刷新', 'SSH_SESSION_GONE');
        host = store.setDefault(owner, hostId, found, host.revision);
        await sendList();
      } else fail('不支持的终端操作');
    } finally { busy = false; }
  }
  return { start, frame, close };
}
