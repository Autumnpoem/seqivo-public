import { randomBytes, createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createSshStore, fail } from './store.mjs';
import { createSshSession } from './session.mjs';

export function createSshManager({ dataDir, allowPrivateTargets = false, now = Date.now }) {
  const store = createSshStore(dataDir);
  const tickets = new Map(), connections = new Map(), sockets = new Set();
  const buckets = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  let origin = '', closed = false, closePromise;
  const key = value => createHash('sha256').update(value).digest('hex');
  const reap = () => { for (const [k, v] of tickets) if (v.expires <= now()) tickets.delete(k); };
  const ticketTimer = setInterval(reap, 10000); ticketTimer.unref?.();
  function request(method, path, body, actor) {
    if (closed) fail('SSH 服务正在关闭', 'SSH_CLOSING', 503);
    if (!actor?.owner || !actor.validate()) fail('请先登录账号', 'SSH_UNAUTHORIZED', 401);
    const parts = path.split('/').filter(Boolean);
    const owner = actor.owner;
    if (path === '/api/ssh/hosts' && method === 'GET')
      return { hosts: store.list(owner), library: actor.local ? 'local' : 'account', allowPrivateTargets };
    if (path === '/api/ssh/hosts' && method === 'POST') return store.put(owner, body);
    if (parts.length === 4 && parts[2] === 'hosts') {
      if (method === 'PUT') return store.put(owner, body, parts[3]);
      if (method === 'DELETE') {
        // DELETE carries no body on the Hub; optimistic version is part of the route below instead.
        fail('请使用移除连接操作');
      }
    }
    if (parts.length === 5 && parts[2] === 'hosts' && parts[4] === 'remove' && method === 'POST') {
      const result = store.delete(owner, parts[3], body.expectedRevision);
      for (const c of connections.values()) if (c.owner === owner && c.hostId === parts[3]) c.session.close();
      return result;
    }
    if (path === '/api/ssh/tickets' && method === 'POST') {
      reap();
      if (tickets.size >= 256 || [...tickets.values()].filter(t => t.owner === owner).length >= 8)
        fail('连接请求过多，请稍后重试', 'SSH_LIMIT', 429);
      const bucket = buckets.get(owner);
      if (!bucket || now() - bucket.start >= 60000) buckets.set(owner, { start: now(), count: 1 });
      else if (++bucket.count > 20) fail('连接过于频繁，请稍后再试', 'SSH_LIMIT', 429);
      if (buckets.size > 10000) for (const [id, b] of buckets) if (now() - b.start > 60000) buckets.delete(id);
      const host = store.get(owner, body.hostId);
      const recoverSession = body.recoverSession;
      if (recoverSession !== undefined) {
        if (!recoverSession || typeof recoverSession !== 'object' || Array.isArray(recoverSession) ||
          !/^\$\d+$/.test(recoverSession.id) || !/^[a-f0-9]{64}$/.test(recoverSession.server) ||
          !Number.isInteger(body.expectedHostRevision) || body.expectedHostRevision !== host.revision)
          fail('原 SSH 会话或主机配置已变化，请重新选择', 'SSH_CONFLICT', 409);
      } else if (body.expectedHostRevision !== undefined) fail('恢复会话信息不完整', 'SSH_CONFLICT', 409);
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(key(ticket), { ...actor, hostId: body.hostId, credentials: body.credentials,
        jumpCredentials: body.jumpCredentials, recoverSession: recoverSession ?? null,
        expectedHostRevision: recoverSession ? host.revision : null, expires: now() + 30000 });
      return { ticket, expiresAt: now() + 30000, websocketUrl: actor.local ? origin.replace(/^http/, 'ws') + '/api/ssh/ws' : '/api/ssh/ws' };
    }
    fail('找不到 SSH 接口', 'NOT_FOUND', 404);
  }
  const send = (ws, frame) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1_048_576) { ws.close(4008, 'Slow consumer'); return; }
    ws.send(JSON.stringify({ v: 1, ...frame }));
  };
  function upgrade(req, socket, head, policy, actorForRequest = null) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/ssh/ws') return false;
    try {
      if (closed || url.search || !policy.hosts.has(req.headers.host) || !policy.origins.has(req.headers.origin) || sockets.size >= 32)
        fail('SSH websocket denied');
      const upgradeActor = actorForRequest?.(req);
      wss.handleUpgrade(req, socket, head, ws => {
        sockets.add(ws);
        let session = null, actor = null, starting = false, alive = true, second = now(), count = 0, bytes = 0;
        const authDeadline = setTimeout(() => ws.close(4001, 'Authentication timeout'), 5000);
        authDeadline.unref?.();
        let pong = true;
        const heartbeat = setInterval(() => {
          if (!pong) { ws.terminate(); return; }
          pong = false;
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 15000);
        heartbeat.unref?.();
        ws.on('pong', () => { pong = true; });
        ws.on('error', () => {});
        ws.on('message', (raw, binary) => {
          try {
            if (binary) fail('Invalid frame');
            if (now() - second >= 1000) { second = now(); count = 0; bytes = 0; }
            if (++count > 200 || (bytes += raw.length) > 1_048_576) fail('输入过快', 'SSH_LIMIT', 429);
            const frame = JSON.parse(raw.toString());
            if (!frame || frame.v !== 1 || typeof frame.type !== 'string') fail('Invalid frame');
            if (!session) {
              if (starting || frame.type !== 'auth' || typeof frame.ticket !== 'string') fail('SSH ticket required');
              reap();
              const saved = tickets.get(key(frame.ticket)); tickets.delete(key(frame.ticket));
              if (!saved || saved.expires <= now() || !saved.validate() ||
                upgradeActor && (upgradeActor.owner !== saved.owner || upgradeActor.binding !== saved.binding || !upgradeActor.validate()))
                fail('登录已失效，请重新连接', 'SSH_UNAUTHORIZED', 401);
              if ([...connections.values()].filter(c => c.owner === saved.owner).length >= 8) fail('同时连接数已达上限', 'SSH_LIMIT', 429);
              starting = true; actor = saved; clearTimeout(authDeadline);
              session = createSshSession({ store, owner: saved.owner, hostId: saved.hostId,
                suppliedCredentials: saved.credentials, jumpCredentials: saved.jumpCredentials,
                recoverSession: saved.recoverSession, expectedHostRevision: saved.expectedHostRevision,
                allowPrivateTargets, send: frame => send(ws, frame),
                validate: () => alive && actor.validate() && (!upgradeActor || upgradeActor.validate()),
                onClose: () => { connections.delete(ws); if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'SSH closed'); } });
              saved.credentials = null; saved.jumpCredentials = null;
              connections.set(ws, { owner: actor.owner, hostId: actor.hostId, session });
              send(ws, { type: 'authenticated' });
              void session.start(); return;
            }
            if (frame.type === 'disconnect') { session.close(); return; }
            void session.frame(frame).catch(error => {
              send(ws, { type: 'error', code: error.code || 'SSH_FAILED',
                message: error.status ? error.message : '操作失败，请刷新会话列表核对。' });
              if (['SSH_UNAUTHORIZED', 'SSH_CONFLICT', 'SSH_INPUT_STALE'].includes(error.code)) session.close();
            });
          } catch (error) {
            send(ws, { type: 'error', code: error.code || 'SSH_PROTOCOL', message: error.status ? error.message : 'SSH 连接验证失败，请重新连接。' });
            ws.close(4003, 'Denied');
          }
        });
        ws.on('close', () => {
          alive = false; clearTimeout(authDeadline); clearInterval(heartbeat); sockets.delete(ws); connections.delete(ws); session?.close();
        });
      });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
    return true;
  }
  return {
    request, upgrade, setOrigin: value => { origin = value; },
    close: () => closePromise ??= (async () => {
      closed = true; clearInterval(ticketTimer); tickets.clear(); buckets.clear();
      for (const c of connections.values()) c.session.close();
      for (const ws of sockets) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
    })(),
  };
}
