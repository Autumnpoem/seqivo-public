import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { HubError } from './store.mjs';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validUnknownExecutions = (value, strictItems = true) => {
  if (!Array.isArray(value) || (strictItems && value.length < 1) || value.length > 16) return false;
  const seen = new Set();
  for (const item of value) {
    if (!record(item) || strictItems && Object.keys(item).some(key => !['taskId', 'commandId'].includes(key)) ||
      !id(item.taskId) || typeof item.commandId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(item.commandId)) return false;
    const key = JSON.stringify([item.taskId, item.commandId]);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
};
const normalizeUnknownExecutions = value => value.map(({ taskId, commandId }) => ({ taskId, commandId }));
const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const scopeSet = new Set(['view', 'input', 'create', 'default', 'takeover']);
const transferActions = new Set(['list-control-targets', 'transfer-control', 'accept-control', 'cancel-transfer']);
const transferReplies = new Set(['controlTargets', 'controlOffer', 'transferPending', 'transferAccepted', 'transferCompleted', 'transferEnded']);
const browserTypes = new Set(['open', 'list', 'select', 'create', 'default', 'input', 'resize', 'detach', 'takeover', 'takeover-existing', 'extend-existing', 'return', 'return-prepare', 'return-confirm', 'return-cancel', 'reconcile-control', ...transferActions]);
const nodeTypes = new Set(['ready', 'sessions', 'output', 'inputAck', 'gap', 'exit', 'error', 'control', ...transferReplies]);
const deny = (message = 'Terminal access denied', status = 403, code = 'TERMINAL_FORBIDDEN') => { throw new HubError(message, status, code); };
const cookieName = secure => secure ? '__Host-terminal_device' : 'terminal_device';
const sessionName = secure => secure ? '__Host-hub_session' : 'hub_session';

function cookie(req, name) {
  const header = req.headers.cookie || '';
  if (typeof header !== 'string' || header.length > 8192) deny('Invalid cookie', 401, 'UNAUTHORIZED');
  const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length > 1) deny('Duplicate cookie', 401, 'UNAUTHORIZED');
  return matches[0]?.slice(name.length + 1) || null;
}

function sameOrigin(req, publicOrigin, required = true) {
  const value = req.headers.origin;
  if (!value) { if (required) deny('Origin required', 403, 'ORIGIN'); return; }
  let parsed;
  try { parsed = new URL(value); } catch { deny('Origin not allowed', 403, 'ORIGIN'); }
  const expected = publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  if (parsed.origin !== expected || value !== parsed.origin) deny('Origin not allowed', 403, 'ORIGIN');
}

function browserSession(accounts, req, secure) {
  if (req.headers.authorization !== undefined) deny('Account login required', 403, 'ACCOUNT_LOGIN_REQUIRED');
  const token = cookie(req, sessionName(secure));
  const session = accounts.authenticateSession(token);
  return { ...session, tokenHash: hash(token) };
}

function nodeSubject(store, req) {
  const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization || '');
  if (!match) deny('Node bearer required', 401, 'UNAUTHORIZED');
  const subject = store.authenticate(match[1]);
  if (subject.role !== 'node') deny('Node role required');
  return subject;
}

function scopes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > scopeSet.size || value.some(item => !scopeSet.has(item)) || new Set(value).size !== value.length) {
    throw new HubError('Invalid terminal scopes', 400, 'INVALID_SCOPE');
  }
  return value;
}

function jsonFrame(data) {
  if (data.length > 65536) deny('Terminal frame too large', 413, 'FRAME_TOO_LARGE');
  let frame;
  try { frame = JSON.parse(data.toString('utf8')); } catch { deny('Invalid terminal frame', 400, 'INVALID_FRAME'); }
  if (!record(frame) || frame.v !== 1 || typeof frame.type !== 'string') deny('Invalid terminal frame', 400, 'INVALID_FRAME');
  return frame;
}

function send(ws, value) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > 65536 || ws.bufferedAmount > 1_048_576) { ws.close(1009, 'Backpressure'); return false; }
  ws.send(data);
  return true;
}

function safeReturnReview(value, generation, phase) {
  if(value===undefined)return null;
  const bad=()=>deny('Invalid return review',400,'INVALID_FRAME');
  const safePath=(path,allowDot=false)=>typeof path==='string'&&path.length<=240&&
    (allowDot&&path==='.'||path.length>0&&!/\\|[\x00-\x1f\x7f]/.test(path)&&!path.startsWith('/')&&
      !path.split('/').some(part=>!part||part==='.'||part==='..'));
  if(phase!=='return_review'||!record(value)||
    Object.keys(value).some(key=>!['reviewId','expiresAt','generation','workspaceRelativeDirectories','changes',
      'totalChanges','omittedChanges','snapshotScope','parkedManagedSessions','unownedWorkspaceWriters','notes'].includes(key))||
    !/^[a-f0-9]{64}$/.test(value.reviewId||'')||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=0||
    value.generation!==generation||!Array.isArray(value.workspaceRelativeDirectories)||
    value.workspaceRelativeDirectories.length>16||!Array.isArray(value.changes)||value.changes.length>80||
    !Number.isSafeInteger(value.totalChanges)||value.totalChanges<value.changes.length||value.totalChanges>40_000||
    value.omittedChanges!==value.totalChanges-value.changes.length||
    !['git-tracked-and-nonignored-untracked','directory-tree-excluding-git-metadata'].includes(value.snapshotScope)||
    !Number.isSafeInteger(value.parkedManagedSessions)||value.parkedManagedSessions<0||value.parkedManagedSessions>16||
    value.unownedWorkspaceWriters!==0||typeof value.notes!=='string'||value.notes.length>2000||
    value.changes.some(item=>!record(item)||Object.keys(item).some(key=>!['path','kind'].includes(key))||
      !safePath(item.path)||!['added','modified','deleted'].includes(item.kind))||
    value.workspaceRelativeDirectories.some(item=>!record(item)||Object.keys(item).some(key=>!['sessionRef','path'].includes(key))||
      !record(item.sessionRef)||Object.keys(item.sessionRef).some(key=>!['serverName','instanceId','sessionId'].includes(key))||
      typeof item.sessionRef.serverName!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(item.sessionRef.serverName)||
      typeof item.sessionRef.instanceId!=='string'||!/^[a-f0-9]{64}$/.test(item.sessionRef.instanceId)||
      typeof item.sessionRef.sessionId!=='string'||!/^\$(0|[1-9]\d*)$/.test(item.sessionRef.sessionId)||
      !safePath(item.path,true))||
    new Set(value.workspaceRelativeDirectories.map(item=>JSON.stringify(item.sessionRef))).size!==value.workspaceRelativeDirectories.length)
    bad();
  return {reviewId:value.reviewId,expiresAt:value.expiresAt,generation:value.generation,
    workspaceRelativeDirectories:value.workspaceRelativeDirectories.map(item=>({sessionRef:{...item.sessionRef},path:item.path})),
    changes:value.changes.map(item=>({path:item.path,kind:item.kind})),totalChanges:value.totalChanges,
    omittedChanges:value.omittedChanges,snapshotScope:value.snapshotScope,parkedManagedSessions:value.parkedManagedSessions,
    unownedWorkspaceWriters:0,notes:value.notes};
}

// Transfer messages never carry the node's control token, task snapshots or
// arbitrary device metadata. Rebuild replies rather than relay unknown fields.
function transferReply(frame) {
  const invalid = () => deny('Invalid transfer reply', 400, 'INVALID_FRAME');
  if (frame.requestId !== undefined && !id(frame.requestId)) invalid();
  const reply = { type: frame.type, v: 1, ...(frame.requestId !== undefined ? { requestId: frame.requestId } : {}) };
  if (frame.type === 'controlTargets') {
    if (!Array.isArray(frame.items) || frame.items.length > 16 ||
      new Set(frame.items.map(item => item?.connectionId)).size !== frame.items.length) invalid();
    reply.items = frame.items.map(item => {
      if (!record(item) || !id(item.connectionId) || typeof item.local !== 'boolean' ||
        (item.local ? item.deviceId !== null : !id(item.deviceId))) invalid();
      return { connectionId: item.connectionId, deviceId: item.deviceId, local: item.local,
        ...(item.local ? { label: '这台电脑' } : {}) };
    });
    return reply;
  }
  if (!id(frame.transferId)) invalid();
  reply.transferId = frame.transferId;
  if (frame.type === 'controlOffer' || frame.type === 'transferPending') {
    if (!Number.isSafeInteger(frame.expiresAt) || frame.expiresAt <= 0) invalid();
    reply.expiresAt = frame.expiresAt;
    if (frame.type === 'controlOffer') {
      if (!id(frame.projectId) || !id(frame.profileId) || frame.fromDeviceId !== null && !id(frame.fromDeviceId)) invalid();
      Object.assign(reply, { projectId: frame.projectId, profileId: frame.profileId, fromDeviceId: frame.fromDeviceId });
    } else {
      if (!id(frame.targetConnectionId) || !Number.isSafeInteger(frame.generation) || frame.generation < 1) invalid();
      Object.assign(reply, { targetConnectionId: frame.targetConnectionId, generation: frame.generation });
    }
  }
  if (frame.type === 'transferEnded') {
    if (frame.status !== 'unknown' || typeof frame.reason !== 'string' || frame.reason.length > 4000) invalid();
    Object.assign(reply, { status: frame.status, reason: frame.reason });
  }
  return reply;
}

function upgradeError(socket, status = 403) {
  if (socket.destroyed) return;
  const label = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 503: 'Service Unavailable' }[status] || 'Forbidden';
  socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Hub terminal authority and bounded WSS relay. HTTP integration calls handleHttp
 * before the ordinary route. WebSocket integration calls attachServer(server,
 * {allowedHosts,allowedOrigins}) before listen, or handleUpgrade directly.
 * Node auth: {type:'auth',v:1,nodeId,token,profiles:[{id,label}]}.
 * Node grant report: POST /api/node/terminal/grants with a current node bearer.
 * Relay to node: {type:'terminal',v:1,connectionId,deviceId,userId,profileId,
 * grantRevision,nodeEpoch,frame}. Relay from node: {type:'terminal',v:1,
 * connectionId,frame}. The node must verify its local grant on each input.
 */
export function createTerminalHub({ store, accounts, secure = false, now = Date.now, publicOrigin, heartbeatIntervalMs = 15_000 } = {}) {
  if (!store?.db || !accounts?.authenticateSession) throw new TypeError('Terminal Hub requires store and accounts');
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS terminal_devices(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      code_hash TEXT NOT NULL, code_expires_at INTEGER NOT NULL,
      revoked_at INTEGER, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS terminal_devices_user ON terminal_devices(tenant_id,user_id);
    CREATE TABLE IF NOT EXISTS terminal_confirmation_issues(
      device_id TEXT PRIMARY KEY,issued_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS terminal_grants(
      node_id TEXT NOT NULL,device_id TEXT NOT NULL,profile_id TEXT NOT NULL,
      scopes_json TEXT NOT NULL,revision INTEGER NOT NULL,
      revoked_at INTEGER,updated_at INTEGER NOT NULL,
      PRIMARY KEY(node_id,device_id,profile_id));
    CREATE TABLE IF NOT EXISTS terminal_tickets(
      token_hash TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,
      session_hash TEXT NOT NULL,device_id TEXT NOT NULL,node_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,scope TEXT NOT NULL,grant_revision INTEGER NOT NULL,
      node_epoch INTEGER NOT NULL,connection_id TEXT NOT NULL,
      resume_requested INTEGER NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER);
  `);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false, clientTracking: false });
  const sockets = new Set();
  const nodes = new Map();
  const clients = new Map();
  const resumable = new Map();
  let closed = false;
  let serverListener = null;
  let attachedServer = null;
  let pendingUpgrades = 0;

  const deviceFor = (req, user, subject) => {
    const token = cookie(req, cookieName(secure));
    if (!token || !/^[A-Za-z0-9_-]{32,100}$/.test(token)) deny('Terminal device required', 401, 'DEVICE_REQUIRED');
    const row = store.db.prepare('SELECT * FROM terminal_devices WHERE token_hash=?').get(hash(token));
    if (!row || row.revoked_at || row.user_id !== user.id || row.tenant_id !== subject.tenant_id) deny('Terminal device required', 401, 'DEVICE_REQUIRED');
    return row;
  };
  const nodeFor = (nodeId, tenantId) => {
    const online = nodes.get(nodeId);
    const row = store.db.prepare('SELECT * FROM subjects WHERE id=? AND tenant_id=? AND role=? AND revoked_at IS NULL').get(nodeId, tenantId, 'node');
    if (!row || !online || online.epoch !== row.epoch || online.ws.readyState !== WebSocket.OPEN) deny('Terminal node offline', 503, 'NODE_OFFLINE');
    return online;
  };
  const grantFor = (nodeId, deviceId, profileId, required) => {
    const grant = store.db.prepare('SELECT * FROM terminal_grants WHERE node_id=? AND device_id=? AND profile_id=? AND revoked_at IS NULL').get(nodeId, deviceId, profileId);
    if (!grant || !JSON.parse(grant.scopes_json).includes(required)) deny('Terminal grant required', 403, 'GRANT_REQUIRED');
    return grant;
  };
  const closeAffected = (predicate, code = 4003) => {
    for (const connection of clients.values()) if (predicate(connection)) {
      connection.forceClose = true;
      connection.ws.close(code, 'Terminal access changed');
    }
  };
  const clearResumable = predicate => {
    for (const [connectionId, item] of resumable) if (predicate(item)) {
      resumable.delete(connectionId);
      send(item.nodeWs, { type: 'terminal-close', v: 1, connectionId });
    }
  };
  const readOrigin = req => sameOrigin(req, publicOrigin, true);
  const pending = subject => store.db.prepare(`SELECT id AS deviceId,label,user_id AS userId,code_expires_at AS expiresAt
    FROM terminal_devices WHERE tenant_id=? AND revoked_at IS NULL AND code_expires_at>? ORDER BY created_at DESC LIMIT 30`).all(subject.tenant_id, now());
  const grantSnapshot = node => store.db.prepare(`SELECT g.device_id AS deviceId,d.user_id AS userId,g.profile_id AS profileId,
    g.scopes_json AS scopes,g.revision,g.revoked_at AS revokedAt FROM terminal_grants g
    JOIN terminal_devices d ON d.id=g.device_id WHERE g.node_id=? AND d.tenant_id=? ORDER BY g.updated_at DESC LIMIT 100`)
    .all(node.id, node.tenant_id).map(row => ({ ...row, scopes: JSON.parse(row.scopes) }));
  const heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      try { activeClient(client, 'view'); } catch { client.forceClose = true; client.ws.close(4003, 'Terminal access changed'); }
    }
    for (const [connectionId, item] of resumable) if (item.expiresAt <= now()) {
      resumable.delete(connectionId);
      send(item.nodeWs, { type: 'terminal-close', v: 1, connectionId });
    }
  }, 2000);
  heartbeat.unref?.();
  const socketHeartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!ws.heartbeatAlive) { ws.terminate(); continue; }
      ws.heartbeatAlive = false;
      ws.ping();
    }
  }, heartbeatIntervalMs);
  socketHeartbeat.unref?.();

  function handleHttp({ req, res, method, path, body = {}, send }) {
    if (!path.startsWith('/api/terminal/') && !path.startsWith('/api/node/terminal/')) return false;
    if (closed) deny('Terminal Hub closing', 503, 'SHUTTING_DOWN');
    if (!record(body)) throw new HubError('Invalid JSON object', 400, 'INVALID_JSON');
    if (path.startsWith('/api/node/terminal/')) {
      const node = nodeSubject(store, req);
      if (method === 'GET' && path === '/api/node/terminal/pending') { send(200, { devices: pending(node), grants: grantSnapshot(node) }); return true; }
      if (method === 'POST' && path === '/api/node/terminal/grants') {
        if (!['grant', 'revoke'].includes(body.action) || !id(body.deviceId) || !id(body.profileId)) throw new HubError('Invalid grant request', 400, 'INVALID_GRANT');
        const device = store.db.prepare('SELECT * FROM terminal_devices WHERE id=? AND tenant_id=? AND revoked_at IS NULL').get(body.deviceId, node.tenant_id);
        if (!device) deny('Device unavailable', 404, 'DEVICE_NOT_FOUND');
        if (body.action === 'grant') {
          const allowed = scopes(body.scopes);
          if (!allowed.includes('view')) throw new HubError('View scope required', 400, 'INVALID_SCOPE');
          if (typeof body.confirmationCode !== 'string' || device.code_expires_at <= now() || !timingSafeEqual(Buffer.from(hash(body.confirmationCode)), Buffer.from(device.code_hash))) deny('Confirmation code invalid', 403, 'INVALID_CODE');
          const revision = store.tx(() => {
            const old = store.db.prepare('SELECT revision FROM terminal_grants WHERE node_id=? AND device_id=? AND profile_id=?').get(node.id, device.id, body.profileId);
            const next = (old?.revision || 0) + 1;
            store.db.prepare(`INSERT INTO terminal_grants VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(node_id,device_id,profile_id) DO UPDATE SET scopes_json=excluded.scopes_json,revision=excluded.revision,revoked_at=NULL,updated_at=excluded.updated_at`)
              .run(node.id, device.id, body.profileId, JSON.stringify(allowed), next, null, now());
            store.db.prepare('UPDATE terminal_devices SET code_expires_at=0 WHERE id=?').run(device.id);
            return next;
          });
          closeAffected(c => c.nodeId === node.id && c.deviceId === device.id && c.profileId === body.profileId);
          clearResumable(c => c.nodeId === node.id && c.deviceId === device.id && c.profileId === body.profileId);
          send(200, { granted: true, revision }); return true;
        }
        store.tx(() => {
          store.db.prepare('UPDATE terminal_grants SET revoked_at=?,revision=revision+1,updated_at=? WHERE node_id=? AND device_id=? AND profile_id=?')
            .run(now(), now(), node.id, device.id, body.profileId);
          store.db.prepare('DELETE FROM terminal_tickets WHERE node_id=? AND device_id=? AND profile_id=?').run(node.id, device.id, body.profileId);
        });
        closeAffected(c => c.nodeId === node.id && c.deviceId === device.id && c.profileId === body.profileId);
        clearResumable(c => c.nodeId === node.id && c.deviceId === device.id && c.profileId === body.profileId);
        send(200, { revoked: true }); return true;
      }
      throw new HubError('Route not found', 404, 'NOT_FOUND');
    }
    const session = browserSession(accounts, req, secure);
    if (method === 'POST') readOrigin(req);
    if (method === 'POST' && path === '/api/terminal/devices') {
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      if (!label || label.length > 80) throw new HubError('Device label required', 400, 'INVALID_DEVICE');
      const count = store.db.prepare('SELECT count(*) AS n FROM terminal_devices WHERE tenant_id=? AND user_id=? AND revoked_at IS NULL').get(session.subject.tenant_id, session.user.id).n;
      if (count >= 20) deny('Too many terminal devices', 429, 'DEVICE_LIMIT');
      const previous = cookie(req, cookieName(secure));
      if (previous && store.db.prepare('SELECT 1 FROM terminal_devices WHERE token_hash=? AND revoked_at IS NULL').get(hash(previous))) deny('Device already enrolled', 409, 'DEVICE_EXISTS');
      const issuedAt = now();
      const deviceId = randomUUID(), token = secret(), confirmationCode = randomBytes(12).toString('base64url'), expiresAt = issuedAt + 600_000;
      store.tx(() => {
        store.db.prepare('INSERT INTO terminal_devices VALUES(?,?,?,?,?,?,?,?,?)')
          .run(deviceId, session.subject.tenant_id, session.user.id, hash(token), label, hash(confirmationCode), expiresAt, null, issuedAt);
        store.db.prepare('INSERT INTO terminal_confirmation_issues(device_id,issued_at) VALUES(?,?)').run(deviceId, issuedAt);
      });
      const parts = [`${cookieName(secure)}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${365 * 24 * 60 * 60}`];
      if (secure) parts.push('Secure');
      res.setHeader('Set-Cookie', parts.join('; '));
      send(200, { deviceId, status: 'pending', confirmationCode, expiresAt }); return true;
    }
    if (method === 'POST' && path === '/api/terminal/devices/confirmation') {
      if (Object.keys(body).length) throw new HubError('Confirmation request takes no device identifier', 400, 'INVALID_DEVICE');
      const result = store.tx(() => {
        const device = deviceFor(req, session.user, session.subject);
        const issued = store.db.prepare('SELECT issued_at FROM terminal_confirmation_issues WHERE device_id=?').get(device.id);
        const issuedAt = now();
        if (device.code_expires_at > issuedAt && issued && issuedAt - issued.issued_at < 30_000)
          deny('Confirmation code requested too recently', 429, 'CONFIRMATION_RATE_LIMIT');
        let confirmationCode, codeHash;
        do { confirmationCode = randomBytes(12).toString('base64url'); codeHash = hash(confirmationCode); }
        while (codeHash === device.code_hash);
        const expiresAt = issuedAt + 600_000;
        store.db.prepare('UPDATE terminal_devices SET code_hash=?,code_expires_at=? WHERE id=? AND revoked_at IS NULL')
          .run(codeHash, expiresAt, device.id);
        store.db.prepare(`INSERT INTO terminal_confirmation_issues(device_id,issued_at) VALUES(?,?)
          ON CONFLICT(device_id) DO UPDATE SET issued_at=excluded.issued_at`).run(device.id, issuedAt);
        return { deviceId: device.id, confirmationCode, expiresAt };
      });
      send(200, result); return true;
    }
    if (method === 'GET' && path === '/api/terminal/status') {
      let device = null;
      try { device = deviceFor(req, session.user, session.subject); } catch (error) { if (error.code !== 'DEVICE_REQUIRED') throw error; }
      const grants = device ? store.db.prepare(`SELECT node_id AS nodeId,profile_id AS profileId,scopes_json AS scopes,revision
        FROM terminal_grants g JOIN subjects s ON s.id=g.node_id
        WHERE g.device_id=? AND g.revoked_at IS NULL AND s.tenant_id=? AND s.role='node' AND s.revoked_at IS NULL`)
        .all(device.id, session.subject.tenant_id).map(item => ({ ...item, scopes: JSON.parse(item.scopes) }))
        .filter(item => item.scopes.includes('view')) : [];
      const allowed = new Map();
      for (const grant of grants) {
        if (!allowed.has(grant.nodeId)) allowed.set(grant.nodeId, new Set());
        allowed.get(grant.nodeId).add(grant.profileId);
      }
      const online = [...nodes.values()].flatMap(item => {
        const profiles = item.profiles.filter(profile => allowed.get(item.nodeId)?.has(profile.id));
        const subject = profiles.length && store.db.prepare('SELECT epoch FROM subjects WHERE id=? AND tenant_id=? AND role=? AND revoked_at IS NULL')
          .get(item.nodeId, session.subject.tenant_id, 'node');
        return subject?.epoch === item.epoch && item.ws.readyState === WebSocket.OPEN ? [{ nodeId: item.nodeId, profiles }] : [];
      });
      send(200, { device: device ? { deviceId: device.id, label: device.label, status: grants.length ? 'approved' : 'pending' } : null, nodes: online, grants }); return true;
    }
    const devicePath = /^\/api\/terminal\/devices\/([A-Za-z0-9_-]{1,100})$/.exec(path);
    if (method === 'DELETE' && devicePath) {
      readOrigin(req);
      const own = store.db.prepare('SELECT id FROM terminal_devices WHERE id=? AND tenant_id=? AND user_id=?').get(devicePath[1], session.subject.tenant_id, session.user.id);
      if (!own) deny('Device unavailable', 404, 'DEVICE_NOT_FOUND');
      store.tx(() => {
        store.db.prepare('UPDATE terminal_devices SET revoked_at=? WHERE id=?').run(now(), own.id);
        store.db.prepare('UPDATE terminal_grants SET revoked_at=?,revision=revision+1,updated_at=? WHERE device_id=?').run(now(), now(), own.id);
        store.db.prepare('DELETE FROM terminal_tickets WHERE device_id=?').run(own.id);
      });
      closeAffected(c => c.deviceId === own.id);
      clearResumable(c => c.deviceId === own.id);
      send(200, { revoked: true }); return true;
    }
    if (method === 'POST' && path === '/api/terminal/tickets') {
      if (!id(body.nodeId) || !id(body.profileId) || !['view', 'control'].includes(body.scope)) throw new HubError('Invalid ticket request', 400, 'INVALID_TICKET');
      const device = deviceFor(req, session.user, session.subject);
      const node = nodeFor(body.nodeId, session.subject.tenant_id);
      if (!node.profiles.some(profile => profile.id === body.profileId)) deny('Terminal profile unavailable', 404, 'PROFILE_NOT_FOUND');
      const grant = grantFor(node.nodeId, device.id, body.profileId, 'view');
      if (body.scope === 'control' && !JSON.parse(grant.scopes_json).some(scope => scope !== 'view')) deny('Control grant required', 403, 'GRANT_REQUIRED');
      if (body.resumeConnectionId && !id(body.resumeConnectionId)) throw new HubError('Invalid resume connection', 400, 'INVALID_CONNECTION');
      let connectionId = randomUUID();
      if (body.resumeConnectionId) {
        const prior = clients.get(body.resumeConnectionId) || resumable.get(body.resumeConnectionId);
        if (!prior || prior.expiresAt !== undefined && prior.expiresAt <= now() || prior.userId !== session.user.id ||
          prior.deviceId !== device.id || prior.nodeId !== node.nodeId || prior.profileId !== body.profileId || prior.grantRevision !== grant.revision)
          deny('Resume unavailable', 409, 'RESUME_UNAVAILABLE');
        connectionId = body.resumeConnectionId;
      }
      const ticket = secret(), expiresAt = now() + 30_000;
      store.db.prepare('DELETE FROM terminal_tickets WHERE expires_at<=? OR used_at IS NOT NULL').run(now());
      store.db.prepare('INSERT INTO terminal_tickets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(hash(ticket), session.subject.tenant_id, session.user.id, session.tokenHash, device.id, node.nodeId, body.profileId,
          body.scope, grant.revision, node.epoch, connectionId, body.resumeConnectionId ? 1 : 0, expiresAt, null);
      send(200, { ticket, expiresAt, connectionId }); return true;
    }
    throw new HubError('Route not found', 404, 'NOT_FOUND');
  }

  function activeClient(client, required) {
    const session = browserSession(accounts, client.req, secure);
    const device = deviceFor(client.req, session.user, session.subject);
    if (device.id !== client.deviceId || session.tokenHash !== client.sessionHash || session.user.id !== client.userId) deny();
    const node = nodeFor(client.nodeId, session.subject.tenant_id);
    if (node.epoch !== client.nodeEpoch || node.ws !== client.nodeWs) deny('Node changed', 409, 'NODE_CHANGED');
    const grant = grantFor(client.nodeId, client.deviceId, client.profileId, required);
    if (grant.revision !== client.grantRevision) deny('Grant changed', 403, 'GRANT_CHANGED');
    return node;
  }
  function consumeTicket(ticket, req) {
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{32,100}$/.test(ticket)) deny('Ticket invalid', 401, 'TICKET_INVALID');
    const session = browserSession(accounts, req, secure);
    const device = deviceFor(req, session.user, session.subject);
    const row = store.tx(() => {
      const current = store.db.prepare('SELECT * FROM terminal_tickets WHERE token_hash=?').get(hash(ticket));
      if (!current || current.used_at !== null || current.expires_at <= now()) deny('Ticket invalid', 401, 'TICKET_INVALID');
      store.db.prepare('UPDATE terminal_tickets SET used_at=? WHERE token_hash=? AND used_at IS NULL').run(now(), current.token_hash);
      return current;
    });
    if (row.session_hash !== session.tokenHash || row.device_id !== device.id || row.user_id !== session.user.id || row.tenant_id !== session.subject.tenant_id) deny('Ticket binding changed', 403, 'TICKET_BINDING');
    const node = nodeFor(row.node_id, row.tenant_id);
    if (node.epoch !== row.node_epoch) deny('Node changed', 409, 'NODE_CHANGED');
    const grant = grantFor(row.node_id, row.device_id, row.profile_id, 'view');
    if (row.scope === 'control' && !JSON.parse(grant.scopes_json).some(scope => scope !== 'view')) deny('Control grant required', 403, 'GRANT_REQUIRED');
    if (grant.revision !== row.grant_revision) deny('Grant changed', 403, 'GRANT_CHANGED');
    const prior = clients.get(row.connection_id) || resumable.get(row.connection_id);
    if (row.resume_requested && (!prior || prior.expiresAt !== undefined && prior.expiresAt <= now() ||
      prior.userId !== row.user_id || prior.deviceId !== row.device_id || prior.nodeId !== row.node_id ||
      prior.profileId !== row.profile_id || prior.grantRevision !== row.grant_revision)) deny('Resume unavailable', 409, 'RESUME_UNAVAILABLE');
    if (clients.has(row.connection_id)) clients.get(row.connection_id).ws.close(4001, 'Connection replaced');
    resumable.delete(row.connection_id);
    return { connectionId: row.connection_id, deviceId: device.id, userId: session.user.id, sessionHash: session.tokenHash,
      nodeId: row.node_id, nodeEpoch: row.node_epoch, nodeWs: node.ws, profileId: row.profile_id, grantRevision: grant.revision,
      scope: row.scope, ws: null, req, count: 0, windowStart: now(), attachmentEpoch: prior?.attachmentEpoch || 0,
      inputSeq: prior?.inputSeq ?? -1, switching: true, resumed: Boolean(row.resume_requested) };
  }

  function rate(client, bytes) {
    const current = now();
    if (current - client.windowStart >= 1000) { client.windowStart = current; client.count = 0; client.bytes = 0; }
    client.count++; client.bytes = (client.bytes || 0) + bytes;
    if (client.count > 150 || client.bytes > 1_048_576) deny('Terminal rate limit', 429, 'RATE_LIMIT');
  }

  function browserSocket(ws, req) {
    let client = null;
    const timer = setTimeout(() => ws.close(4001, 'Auth timeout'), 5000); timer.unref?.();
    ws.on('message', (data, binary) => {
      try {
        if (binary) deny('Binary frames unsupported', 400, 'INVALID_FRAME');
        const frame = jsonFrame(data);
        if (!client) {
          if (frame.type !== 'auth') deny('Auth required', 401, 'UNAUTHORIZED');
          client = consumeTicket(frame.ticket, req);
          const deviceCount = [...clients.values()].filter(item => item.deviceId === client.deviceId).length;
          const nodeCount = [...clients.values()].filter(item => item.nodeId === client.nodeId).length;
          if (deviceCount >= 4 || nodeCount >= 16) deny('Too many terminal connections', 429, 'CONNECTION_LIMIT');
          clearTimeout(timer); client.ws = ws; clients.set(client.connectionId, client);
          send(ws, { type: 'authenticated', v: 1, connectionId: client.connectionId });
          return;
        }
        rate(client, data.length);
        if (clients.get(client.connectionId) !== client || client.ws !== ws) deny('Connection replaced', 409, 'CONNECTION_CHANGED');
        if (!browserTypes.has(frame.type)) deny('Invalid terminal action', 400, 'INVALID_FRAME');
        if(client.detachRequestId)deny('Terminal is detaching',409,'CONNECTION_CHANGED');
        if (frame.connectionId !== undefined && frame.connectionId !== client.connectionId ||
          frame.profileId !== undefined && frame.profileId !== client.profileId) deny('Terminal binding mismatch', 403, 'BINDING_MISMATCH');
        if (frame.endUnknownCommands !== undefined && frame.type !== 'takeover') deny('Unknown-command disposition is takeover-only', 400, 'INVALID_FRAME');
        if (frame.type === 'open' && frame.recoverSessionRef !== undefined &&
          (frame.mode !== 'tmux' || !record(frame.recoverSessionRef) ||
            Object.keys(frame.recoverSessionRef).some(key => !['serverName','instanceId','sessionId'].includes(key)) ||
            typeof frame.recoverSessionRef.serverName !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(frame.recoverSessionRef.serverName) ||
            typeof frame.recoverSessionRef.instanceId !== 'string' || !/^[a-f0-9]{64}$/.test(frame.recoverSessionRef.instanceId) ||
            typeof frame.recoverSessionRef.sessionId !== 'string' || !/^\$(0|[1-9]\d*)$/.test(frame.recoverSessionRef.sessionId)))
          deny('Invalid recovery session', 400, 'INVALID_SESSION_REF');
        if (transferActions.has(frame.type)) {
          const fields = ['v', 'type', 'requestId', ...(frame.type === 'transfer-control'
            ? ['targetConnectionId', 'expectedGeneration'] : frame.type === 'list-control-targets' ? [] : ['transferId'])];
          if (Object.keys(frame).some(key => !fields.includes(key)) ||
            frame.requestId !== undefined && !id(frame.requestId) ||
            frame.type === 'transfer-control' && (!id(frame.targetConnectionId) ||
              !Number.isSafeInteger(frame.expectedGeneration) || frame.expectedGeneration < 1 || frame.expectedGeneration >= Number.MAX_SAFE_INTEGER) ||
            ['accept-control', 'cancel-transfer'].includes(frame.type) && !id(frame.transferId))
            deny('Invalid transfer action', 400, 'INVALID_FRAME');
        }
        if (['takeover', 'takeover-existing', 'extend-existing', 'return', 'return-prepare', 'return-confirm', 'return-cancel', 'reconcile-control'].includes(frame.type)) {
          const fields = ['return','return-prepare'].includes(frame.type) ? ['v', 'type', 'notes'] :
            ['return-confirm','return-cancel'].includes(frame.type) ? ['v','type','reviewId','expectedGeneration'] :
            frame.type === 'reconcile-control' ? ['v', 'type', 'action', 'requestId'] :
            ['takeover-existing','extend-existing'].includes(frame.type) ? ['v','type','sessionRefs'] : ['v', 'type'];
          if (frame.type === 'takeover' && frame.endUnknownCommands !== undefined) fields.push('endUnknownCommands');
          if (Object.keys(frame).some(key => !fields.includes(key)) ||
            frame.endUnknownCommands !== undefined && !validUnknownExecutions(frame.endUnknownCommands) ||
            ['return','return-prepare'].includes(frame.type) && (frame.notes !== undefined && (typeof frame.notes !== 'string' || frame.notes.length > 2000)) ||
            ['return-confirm','return-cancel'].includes(frame.type) && (!/^[a-f0-9]{64}$/.test(frame.reviewId||'') ||
              !Number.isSafeInteger(frame.expectedGeneration) || frame.expectedGeneration < 1) ||
            frame.type === 'reconcile-control' && (!['acquire', 'release'].includes(frame.action) ||
              frame.requestId !== undefined && !id(frame.requestId)) ||
            ['takeover-existing','extend-existing'].includes(frame.type) && (!Array.isArray(frame.sessionRefs)||!frame.sessionRefs.length||frame.sessionRefs.length>16||
              frame.sessionRefs.some(ref=>!record(ref)||Object.keys(ref).some(key=>!['serverName','instanceId','sessionId'].includes(key))||
                typeof ref.serverName!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(ref.serverName)||
                typeof ref.instanceId!=='string'||!/^[a-f0-9]{64}$/.test(ref.instanceId)||
                typeof ref.sessionId!=='string'||!/^\$(0|[1-9]\d*)$/.test(ref.sessionId))))
            deny('Invalid control action', 400, 'INVALID_FRAME');
        }
        const required = transferActions.has(frame.type) ? 'takeover' : ({ input: 'input', resize: 'view', create: 'create', default: 'default',
          takeover: 'takeover', 'takeover-existing':'takeover','extend-existing':'takeover',return: 'takeover',
          'return-prepare':'takeover','return-confirm':'takeover','return-cancel':'takeover','reconcile-control': 'takeover' })[frame.type] || 'view';
        if (client.scope === 'view' && !['view'].includes(required)) deny('Control ticket required');
        const node = activeClient(client, required);
        if (frame.type === 'takeover' && frame.endUnknownCommands !== undefined) {
          activeClient(client, 'input');
          const profile = node.profiles.find(item => item.id === client.profileId);
          if (!profile || profile.runtime === 'wsl') deny('Unknown-command disposition is unavailable for this profile', 403, 'TAKEOVER_REQUIRED');
        }
        if (transferActions.has(frame.type)) {
          activeClient(client, 'input');
          if (frame.type !== 'list-control-targets') {
            client.controlBlocked = true;
            client.pendingTransferAction = { type: frame.type, requestId: frame.requestId, transferId: frame.transferId };
          }
          if (frame.type === 'transfer-control') client.minimumControlGeneration = frame.expectedGeneration + 1;
        }
        if(frame.type==='detach'&&frame.requestId!==undefined){
          if(!id(frame.requestId))deny('Invalid detach request',400,'INVALID_FRAME');
          client.detachRequestId=frame.requestId;client.switching=true;
        }
        if (['open', 'select', 'create'].includes(frame.type)) client.switching = true;
        if (frame.type === 'input') {
          if (!Number.isSafeInteger(frame.seq) || frame.seq < 0 || !Number.isSafeInteger(frame.epoch) || frame.epoch < 1 || typeof frame.data !== 'string' || frame.data.length > 44000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data) || Buffer.from(frame.data, 'base64').length > 32768) deny('Invalid input', 400, 'INVALID_FRAME');
          if (client.controlBlocked || client.switching || frame.epoch !== client.attachmentEpoch || frame.seq <= client.inputSeq) deny('Stale input', 409, 'INPUT_STALE');
          client.inputSeq = frame.seq;
        }
        if (frame.type === 'resize' && (client.switching || frame.epoch !== client.attachmentEpoch)) deny('Stale resize', 409, 'INPUT_STALE');
        if (frame.type === 'resize' && (!Number.isInteger(frame.cols) || frame.cols < 20 || frame.cols > 300 || !Number.isInteger(frame.rows) || frame.rows < 5 || frame.rows > 100)) deny('Invalid size', 400, 'INVALID_FRAME');
        send(node.ws, { type: 'terminal', v: 1, connectionId: client.connectionId, deviceId: client.deviceId,
          userId: client.userId, profileId: client.profileId, grantRevision: client.grantRevision, nodeEpoch: client.nodeEpoch, frame });
      } catch (error) { if (client) client.forceClose = true; send(ws, { type: 'error', v: 1, code: error.code || 'INVALID_FRAME' }); ws.close(4003, 'Terminal denied'); }
    });
    ws.on('close', () => { clearTimeout(timer); if (client && clients.get(client.connectionId)?.ws === ws) {
      clients.delete(client.connectionId);
      if (!closed && nodes.get(client.nodeId)?.ws === client.nodeWs && !client.forceClose) {
        resumable.set(client.connectionId, { ...client, ws: null, expiresAt: now() + 30_000 });
        send(client.nodeWs, { type: 'terminal-suspend', v: 1, connectionId: client.connectionId, ttlMs: 30_000 });
      } else send(client.nodeWs, { type: 'terminal-close', v: 1, connectionId: client.connectionId });
    } });
  }

  function nodeSocket(ws) {
    let node = null;
    const timer = setTimeout(() => ws.close(4001, 'Auth timeout'), 5000); timer.unref?.();
    ws.on('message', (data, binary) => {
      try {
        if (binary) deny('Binary frames unsupported', 400, 'INVALID_FRAME');
        const frame = jsonFrame(data);
        if (!node) {
          if (frame.type !== 'auth' || !id(frame.nodeId) || typeof frame.token !== 'string') deny('Node auth required', 401, 'UNAUTHORIZED');
          const subject = store.authenticate(frame.token);
          if (subject.role !== 'node' || subject.id !== frame.nodeId) deny('Node auth failed', 401, 'UNAUTHORIZED');
          const profiles = frame.profiles === undefined ? [{ id: 'default', label: 'Terminal' }] : frame.profiles;
          if (!Array.isArray(profiles) || !profiles.length || profiles.length > 8 ||
            profiles.some(item => !record(item) || !id(item.id) || typeof item.label !== 'string' || !item.label || item.label.length > 80) ||
            new Set(profiles.map(item => item.id)).size !== profiles.length) deny('Invalid profiles', 400, 'INVALID_PROFILES');
          const prior = nodes.get(subject.id);
          if (prior) { prior.ws.close(4001, 'Node replaced'); closeAffected(c => c.nodeId === subject.id); clearResumable(c => c.nodeId === subject.id); }
          node = { nodeId: subject.id, tenantId: subject.tenant_id, epoch: subject.epoch, profiles, ws, count: 0, bytes: 0, windowStart: now() };
          nodes.set(subject.id, node); clearTimeout(timer);
          const owners = store.db.prepare(`SELECT u.id FROM account_users u JOIN subjects s ON s.id=u.owner_subject_id
            WHERE s.tenant_id=? AND s.role='owner' AND s.revoked_at IS NULL LIMIT 2`).all(subject.tenant_id);
          send(ws, { type: 'ready', v: 1, nodeId: subject.id, epoch: subject.epoch, attachmentCloseV1: true,
            ...(owners.length === 1 ? { ownerUserId: owners[0].id } : {}) }); return;
        }
        const current = store.db.prepare('SELECT epoch,revoked_at FROM subjects WHERE id=?').get(node.nodeId);
        if (nodes.get(node.nodeId) !== node || !current || current.revoked_at || current.epoch !== node.epoch) deny('Node revoked', 403, 'NODE_REVOKED');
        rate(node, data.length);
        if(frame.type==='terminal-attachment-close'){
          if(!id(frame.connectionId)||frame.v!==1||frame.code!=='INPUT_OVERLOADED'||
            Object.keys(frame).some(key=>!['type','v','connectionId','code'].includes(key)))
            deny('Invalid attachment close',400,'INVALID_FRAME');
          const client=clients.get(frame.connectionId);
          if(client&&client.nodeId===node.nodeId&&client.nodeWs===ws&&client.nodeEpoch===node.epoch){
            client.forceClose=true;
            send(client.ws,{type:'error',v:1,code:'INPUT_OVERLOADED',message:'输入过快，未确认的按键已停止发送。请重新连接并核对终端内容。'});
            client.ws.close(4003,'Terminal input overloaded');
          }
          return;
        }
        if (frame.type !== 'terminal' || !id(frame.connectionId) || !record(frame.frame) || !nodeTypes.has(frame.frame.type) || frame.frame.v !== 1) deny('Invalid node frame', 400, 'INVALID_FRAME');
        const client = clients.get(frame.connectionId);
        if (!client || client.nodeId !== node.nodeId || client.nodeWs !== ws) return;
        try { activeClient(client, 'view'); } catch { client.forceClose = true; client.ws.close(4003, 'Terminal access changed'); return; }
        if(client.detachRequestId){
          // A failed switch may advance the node's attachment epoch without a
          // ready frame. A completed detach is correlated to the exact request
          // on this authenticated connection, independent of that epoch.
          if(frame.frame.type==='exit'&&frame.frame.reason==='detached'&&frame.frame.requestId===client.detachRequestId){
            client.forceClose=true;send(client.ws,frame.frame);client.ws.close(1000,'Terminal detached');return;
          }
          if(frame.frame.type==='error')send(client.ws,frame.frame);
          return;
        }
        if (frame.frame.type === 'error' && client.pendingTransferAction) {
          // A generic error is not proof that a transfer did not start. Retire
          // this attachment instead of reviving old input or leaving it frozen
          // forever. A fresh ticket must recheck the remaining ownership.
          client.forceClose = true;
          send(client.ws, frame.frame);
          client.ws.close(4003, 'Transfer not confirmed; reconnect with a new ticket');
          return;
        }
        if (frame.frame.type === 'ready') {
          if (!Number.isSafeInteger(frame.frame.epoch) || frame.frame.epoch < 1 ||
            frame.frame.epoch < client.attachmentEpoch ||
            frame.frame.epoch === client.attachmentEpoch && !client.resumed) deny('Invalid attachment epoch', 400, 'INVALID_FRAME');
          if (frame.frame.epoch > client.attachmentEpoch) client.inputSeq = -1;
          client.attachmentEpoch = frame.frame.epoch; client.switching = false; client.resumed = false;
        }
        if (['output', 'inputAck', 'gap', 'exit'].includes(frame.frame.type) && frame.frame.epoch !== client.attachmentEpoch) return;
        if (frame.frame.type === 'output' && (typeof frame.frame.data !== 'string' || frame.frame.data.length > 44000 || Buffer.from(frame.frame.data, 'base64').length > 32768)) deny('Output too large', 413, 'FRAME_TOO_LARGE');
        if (frame.frame.type === 'control') {
          const control = frame.frame;
          if (control.unresolvedExecutions !== undefined && !validUnknownExecutions(control.unresolvedExecutions, false)) deny('Invalid unresolved executions', 400, 'INVALID_FRAME');
          if (typeof control.managed !== 'boolean' || typeof control.owned !== 'boolean' ||
            control.requestId !== undefined && !id(control.requestId) ||
            control.requiresSessionSelection !== undefined && typeof control.requiresSessionSelection !== 'boolean' ||
            control.canReconcileAcquire !== undefined && typeof control.canReconcileAcquire !== 'boolean' ||
            !['ai_ready','stopping','human','return_check','return_review','transfer_pending','unknown'].includes(control.phase) ||
            control.generation !== undefined && control.generation !== null && (!Number.isSafeInteger(control.generation) || control.generation < 1) ||
            ![null,undefined,'managed','existing'].includes(control.mode)||
            control.authorizedSessionRefs!==undefined&&(!Array.isArray(control.authorizedSessionRefs)||control.authorizedSessionRefs.length>16||
            control.authorizedSessionRefs.some(ref=>!record(ref)||typeof ref.serverName!=='string'||typeof ref.instanceId!=='string'||typeof ref.sessionId!=='string'||
              !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(ref.serverName)||!/^[a-f0-9]{64}$/.test(ref.instanceId)||!/^\$(0|[1-9]\d*)$/.test(ref.sessionId)))||
            control.reason !== null && (typeof control.reason !== 'string' || control.reason.length > 4000) ||
            !Array.isArray(control.changes) || control.changes.length > 1000 ||
            control.changes.some(item => !record(item) || typeof item.path !== 'string' || item.path.length > 4096 ||
              !['added', 'modified', 'deleted'].includes(item.kind))) deny('Invalid control frame', 400, 'INVALID_FRAME');
          const returnReview=safeReturnReview(control.returnReview,control.generation,control.phase);
          if (Number.isSafeInteger(control.generation)) {
            if (control.generation < (client.controlGeneration || 0) ||
              control.generation < (client.minimumControlGeneration || 0)) return;
            client.controlGeneration = control.generation;
          } else if (client.minimumControlGeneration) return;
          client.controlBlocked = control.managed && (control.phase !== 'human' || !control.owned);
          send(client.ws, { type: 'control', v: 1, ...(control.requestId !== undefined ? { requestId: control.requestId } : {}),
            managed: control.managed, owned: control.owned,
            phase: control.phase, generation: control.generation ?? null, mode:control.mode||null,
            requiresSessionSelection: !(control.mode === 'managed' && control.requiresSessionSelection === false),
            canReconcileAcquire: control.canReconcileAcquire === true && control.managed === true && ['unknown','human'].includes(control.phase),
            authorizedSessionRefs:(control.authorizedSessionRefs||[]).map(({serverName,instanceId,sessionId})=>({serverName,instanceId,sessionId})), reason: control.reason,
            changes: control.changes.map(item => ({ path: item.path, kind: item.kind })),
            snapshotScope: ['git-tracked-and-nonignored-untracked','directory-tree-excluding-git-metadata','legacy-unspecified'].includes(control.snapshotScope) ? control.snapshotScope : null,
            ...(control.unresolvedExecutions !== undefined ? { unresolvedExecutions: normalizeUnknownExecutions(control.unresolvedExecutions) } : {}),
            ...(returnReview?{returnReview}: {}) });
        } else if (transferReplies.has(frame.frame.type)) {
          try { activeClient(client, 'takeover'); activeClient(client, 'input'); }
          catch { client.forceClose = true; client.ws.close(4003, 'Terminal access changed'); return; }
          if (client.scope !== 'control') { client.forceClose = true; client.ws.close(4003, 'Control ticket required'); return; }
          const reply = transferReply(frame.frame);
          const pending = client.pendingTransferAction;
          if (pending && (
            reply.type === 'transferPending' && pending.type === 'transfer-control' && reply.requestId === pending.requestId ||
            reply.type === 'transferAccepted' && pending.type === 'accept-control' && reply.requestId === pending.requestId && reply.transferId === pending.transferId ||
            reply.type === 'transferEnded' && (!pending.transferId || reply.transferId === pending.transferId)))
            client.pendingTransferAction = null;
          if (frame.frame.type !== 'controlTargets') client.controlBlocked = true;
          send(client.ws, reply);
        } else send(client.ws, frame.frame);
      } catch (error) { send(ws, { type: 'error', v: 1, code: error.code || 'INVALID_FRAME' }); ws.close(4003, 'Terminal denied'); }
    });
    ws.on('close', () => { clearTimeout(timer); if (node && nodes.get(node.nodeId) === node) {
      nodes.delete(node.nodeId); closeAffected(c => c.nodeId === node.nodeId, 4004);
      for (const [connectionId, item] of resumable) if (item.nodeId === node.nodeId) resumable.delete(connectionId);
    } });
  }

  function handleUpgrade(req, socket, head, { allowedHosts, allowedOrigins } = {}) {
    let path;
    try { const url = new URL(req.url, 'http://localhost'); if (url.search || url.hash) deny('Query forbidden', 400, 'QUERY_NOT_ALLOWED'); path = url.pathname; }
    catch { upgradeError(socket, 400); return true; }
    if (path !== '/api/terminal/ws' && path !== '/api/terminal/node') return false;
    try {
      if (closed) deny('Terminal Hub closing', 503, 'SHUTTING_DOWN');
      if (pendingUpgrades >= 32) deny('Too many unauthenticated sockets', 429, 'CONNECTION_LIMIT');
      if (!(allowedHosts instanceof Set) || !(allowedOrigins instanceof Set) || !allowedHosts.has(req.headers.host)) deny('Host not allowed', 403, 'HOST');
      if (path === '/api/terminal/ws') {
        if (!req.headers.origin || !allowedOrigins.has(req.headers.origin)) deny('Origin not allowed', 403, 'ORIGIN');
        const session = browserSession(accounts, req, secure);
        deviceFor(req, session.user, session.subject);
      } else if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) deny('Origin not allowed', 403, 'ORIGIN');
      if (req.headers.origin && req.headers.origin !== publicOrigin) {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host) deny('Origin not allowed', 403, 'ORIGIN');
      }
      pendingUpgrades++;
      wss.handleUpgrade(req, socket, head, ws => {
        sockets.add(ws);
        ws.heartbeatAlive = true;
        ws.on('pong', () => { ws.heartbeatAlive = true; });
        ws.once('close', () => sockets.delete(ws));
        let unauthenticated = true;
        const release = () => { if (unauthenticated) { unauthenticated = false; pendingUpgrades--; } };
        ws.once('message', release);
        ws.once('close', release);
        if (path === '/api/terminal/ws') browserSocket(ws, req); else nodeSocket(ws);
      });
    } catch (error) { upgradeError(socket, error.status || 403); }
    return true;
  }
  function attachServer(server, policy) {
    if (serverListener) throw new Error('Terminal Hub already attached');
    serverListener = (req, socket, head) => { if (!handleUpgrade(req, socket, head, policy)) upgradeError(socket, 404); };
    attachedServer = server;
    server.on('upgrade', serverListener);
  }
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearInterval(socketHeartbeat);
    if (attachedServer && serverListener) attachedServer.off('upgrade', serverListener);
    const settled = [...sockets].map(ws => new Promise(resolve => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', resolve);
      ws.terminate();
    }));
    await Promise.all(settled);
    clients.clear(); nodes.clear(); resumable.clear(); sockets.clear();
    await new Promise(resolve => wss.close(resolve));
  }
  return { handleHttp, handleUpgrade, attachServer, close };
}
