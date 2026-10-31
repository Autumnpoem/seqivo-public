import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createSshManager } from './manager.mjs';
import { fail } from './store.mjs';

/** Account-only gateway. Viewer/node bearer tokens never confer arbitrary SSH access. */
export function createSshHub({ dataDir, accounts, secure, publicOrigin, allowPrivateTargets = false }) {
  const manager = createSshManager({ dataDir: join(dataDir, 'ssh'), allowPrivateTargets });
  function actor(req) {
    if (req.headers.authorization !== undefined) fail('通用 SSH 请使用账号登录', 'ACCOUNT_LOGIN_REQUIRED', 403);
    const name = secure ? '__Host-hub_session' : 'hub_session';
    const matches = (req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
    if (matches.length !== 1) fail('请先登录账号', 'SSH_UNAUTHORIZED', 401);
    const token = matches[0].slice(name.length + 1);
    const session = accounts.authenticateSession(token);
    return { owner: session.user.id, binding: createHash('sha256').update(token).digest('hex'),
      validate: () => { try { return accounts.authenticateSession(token).user.id === session.user.id; } catch { return false; } } };
  }
  return {
    handleHttp({ req, method, path, body, send }) {
      if (!path.startsWith('/api/ssh/')) return false;
      const expected = publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
      if (method !== 'GET' && req.headers.origin !== expected) fail('请求来源不受信任', 'ORIGIN', 403);
      send(200, manager.request(method, path, body, actor(req)));
      return true;
    },
    handleUpgrade(req, socket, head, policy) {
      return manager.upgrade(req, socket, head, { hosts: policy.allowedHosts, origins: policy.allowedOrigins }, actor);
    },
    close: manager.close,
  };
}
