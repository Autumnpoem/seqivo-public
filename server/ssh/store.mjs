import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export class SshError extends Error {
  constructor(message, code = 'SSH_INVALID', status = 400) {
    super(message); this.code = code; this.status = status;
  }
}
export const fail = (message, code, status) => { throw new SshError(message, code, status); };
const text = (value, max, label, required = true) => {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value) || required && !value.trim())
    fail(`${label}格式不正确`);
  return value.trim();
};
export function credentials(value, method) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('请输入 SSH 登录凭据', 'SSH_CREDENTIALS');
  const result = {};
  const field = (name, max, required) => {
    const v = value[name] ?? '';
    if (typeof v !== 'string' || Buffer.byteLength(v) > max || v.includes('\0') || required && !v)
      fail('SSH 登录凭据格式不正确', 'SSH_CREDENTIALS');
    result[name] = v;
  };
  if (method === 'password') field('password', 4096, true);
  else { field('privateKey', 24000, true); field('passphrase', 4096, false); }
  return result;
}
function profile(body, prior) {
  const name = text(body.name, 80, '连接名称');
  const host = text(body.host, 253, '主机地址');
  if (!/^[a-zA-Z0-9.:\-]+$/.test(host) || host.startsWith('-')) fail('请输入 IP 或域名，不要包含协议、路径或端口');
  const port = body.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('端口须为 1–65535');
  const username = text(body.username, 128, 'SSH 用户名');
  if (!['server', 'computer'].includes(body.kind) || !['password', 'key'].includes(body.authMethod)) fail('请选择主机类型和登录方式');
  const tmuxServer = text(body.tmuxServer ?? 'default', 64, 'tmux 服务名称');
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(tmuxServer)) fail('tmux 服务名称格式不正确');
  const group = text(body.group ?? '', 60, '分组', false);
  const jumpHostId = body.jumpHostId || null;
  if (jumpHostId !== null && !/^[a-f0-9-]{36}$/.test(jumpHostId)) fail('跳板机格式不正确');
  const sameTarget = prior && prior.host === host && prior.port === port && prior.username === username &&
    prior.tmuxServer === tmuxServer && prior.jumpHostId === jumpHostId;
  return { id: prior?.id ?? randomUUID(), name, host, port, username, kind: body.kind, group,
    authMethod: body.authMethod, tmuxServer, jumpHostId,
    fingerprint: prior?.host === host && prior?.port === port ? prior.fingerprint : null,
    defaultSession: sameTarget ? prior.defaultSession : null, revision: (prior?.revision ?? 0) + 1,
    updatedAt: new Date().toISOString() };
}

/** Separate from task metadata/backups: secrets are never returned by the host API. */
export function createSshStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = join(dataDir, 'ssh-vault.key'), path = join(dataDir, 'ssh-hosts.json');
  let key;
  try { key = readFileSync(keyPath); }
  catch (e) { if (e.code !== 'ENOENT') throw e; key = randomBytes(32); writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 }); }
  if (key.length !== 32) throw new Error('SSH vault key is invalid');
  chmodSync(keyPath, 0o600);
  let state = { version: 1, owners: {} };
  try { state = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (state.version !== 1 || !state.owners || typeof state.owners !== 'object' || Array.isArray(state.owners))
    throw new Error('SSH host store is invalid');
  const rows = owner => state.owners[owner] || [];
  const publicHost = ({ secret, ...host }) => ({ ...host, hasCredential: Boolean(secret) });
  const get = (owner, id) => rows(owner).find(h => h.id === id) || fail('找不到此连接', 'SSH_HOST_NOT_FOUND', 404);
  function commit(owner, next) {
    const changed = { ...state, owners: { ...state.owners, [owner]: next } };
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(changed), { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path); state = changed;
  }
  function seal(owner, id, value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${owner}/${id}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  return {
    list: owner => rows(owner).map(publicHost),
    get: (owner, id) => publicHost(get(owner, id)),
    credential(owner, id) {
      const item = get(owner, id); if (!item.secret) return null;
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(item.secret.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${owner}/${id}`)); decipher.setAuthTag(Buffer.from(item.secret.tag, 'base64'));
      return credentials(JSON.parse(Buffer.concat([decipher.update(Buffer.from(item.secret.data, 'base64')), decipher.final()]).toString()), item.authMethod);
    },
    put(owner, body, id = null) {
      const prior = id ? get(owner, id) : null;
      if (prior && body.expectedRevision !== prior.revision) fail('连接资料已更新，请刷新后再编辑', 'SSH_CONFLICT', 409);
      if (!prior && rows(owner).length >= 128) fail('最多保存 128 个连接', 'SSH_LIMIT', 429);
      const next = profile(body, prior);
      if (next.jumpHostId) {
        const jump = get(owner, next.jumpHostId);
        if (jump.id === next.id || jump.jumpHostId) fail('跳板机不能是自身或另一条跳板链');
      }
      if (rows(owner).some(h => h.jumpHostId === next.id) && next.jumpHostId) fail('被引用的跳板机不能再设置跳板机');
      next.secret = prior?.authMethod === next.authMethod && prior?.host === next.host &&
        prior?.port === next.port && prior?.username === next.username ? prior.secret : null;
      if (body.forgetCredential === true) next.secret = null;
      if (body.rememberCredential === true) next.secret = seal(owner, next.id, credentials(body.credentials, next.authMethod));
      commit(owner, [...rows(owner).filter(h => h.id !== next.id), next]);
      return publicHost(next);
    },
    delete(owner, id, revision) {
      const host = get(owner, id);
      if (host.revision !== revision) fail('连接资料已更新，请刷新', 'SSH_CONFLICT', 409);
      if (rows(owner).some(h => h.jumpHostId === id)) fail('请先移除使用此跳板机的连接配置');
      commit(owner, rows(owner).filter(h => h.id !== id));
      return { deleted: true };
    },
    pin(owner, id, fingerprint, revision) {
      const host = get(owner, id);
      if (host.revision !== revision) fail('主机资料已变化，请重新连接', 'SSH_CONFLICT', 409);
      const next = { ...host, fingerprint, revision: host.revision + 1 };
      commit(owner, rows(owner).map(h => h.id === id ? next : h)); return publicHost(next);
    },
    setDefault(owner, id, session, revision) {
      const host = get(owner, id);
      if (host.revision !== revision) fail('主机资料已变化，请重新连接', 'SSH_CONFLICT', 409);
      const next = { ...host, defaultSession: session, revision: host.revision + 1 };
      commit(owner, rows(owner).map(h => h.id === id ? next : h)); return publicHost(next);
    },
  };
}
