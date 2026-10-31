import { HubError } from './store.mjs';

function cookieName(secure) { return secure ? '__Host-hub_session' : 'hub_session'; }

function sessionCookie(req, secure) {
  const header = req.headers.cookie || '';
  if (typeof header !== 'string' || header.length > 8192) throw new HubError('Authentication required', 401, 'UNAUTHORIZED');
  const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName(secure)}=`));
  if (matches.length > 1) throw new HubError('Authentication required', 401, 'UNAUTHORIZED');
  return matches[0]?.slice(cookieName(secure).length + 1);
}

function setSessionCookie(res, token, secure, clear = false) {
  const parts = [`${cookieName(secure)}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${clear ? 0 : 7 * 24 * 60 * 60}`];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function accountSession(accounts, req, secure) {
  return accounts.authenticateSession(sessionCookie(req, secure));
}

/**
 * Resolve a Hub subject. Explicit Authorization always takes precedence; a malformed
 * bearer header is an error, even if a valid browser cookie is also present.
 */
export function authenticateRequest({ accounts, store, req, secure = false }) {
  if (req.headers.authorization !== undefined) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization);
    if (!match) throw new HubError('Authentication required', 401, 'UNAUTHORIZED');
    return store.authenticate(match[1]);
  }
  return accountSession(accounts, req, secure).subject;
}

/**
 * Returns true only for an account endpoint. Parent's normal Hub handler handles
 * errors so all API responses retain its existing error shape.
 */
export async function handleAccountRequest({
  accounts, store, req, res, method, path, body = {}, send,
  source = 'unknown', secure = false, registrationEnabled = accounts.registrationEnabled,
}) {
  if (!path.startsWith('/api/auth/')) return false;
  if (method === 'GET' && path === '/api/auth/status') {
    send(200, { registrationEnabled: Boolean(registrationEnabled) });
    return true;
  }
  if (method === 'POST' && path === '/api/auth/register') {
    if (!registrationEnabled) throw new HubError('Registration is disabled', 403, 'REGISTRATION_DISABLED');
    const result = await accounts.register({ username: body.username, password: body.password, source });
    setSessionCookie(res, result.sessionToken, secure);
    send(200, { user: result.user, expiresAt: result.expiresAt });
    return true;
  }
  if (method === 'POST' && path === '/api/auth/login') {
    const result = await accounts.login({ username: body.username, password: body.password, source });
    setSessionCookie(res, result.sessionToken, secure);
    send(200, { user: result.user, expiresAt: result.expiresAt });
    return true;
  }
  if (method === 'POST' && path === '/api/auth/claim') {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '');
    if (!match) throw new HubError('Legacy owner token required', 401, 'UNAUTHORIZED');
    const result = await accounts.claim(store.authenticate(match[1]),
      { username: body.username, password: body.password, source });
    setSessionCookie(res, result.sessionToken, secure);
    send(200, { user: result.user, expiresAt: result.expiresAt });
    return true;
  }
  if (method === 'GET' && path === '/api/auth/me') {
    if(req.headers.authorization!==undefined) {
      authenticateRequest({accounts,store,req,secure});
      send(200,{user:null});return true;
    }
    send(200, { user: accountSession(accounts, req, secure).user });
    return true;
  }
  if (method === 'POST' && path === '/api/auth/logout') {
    const token = sessionCookie(req, secure);
    if(token) {try{accounts.logout(token);}catch(error){if(error.status!==401)throw error;}}
    setSessionCookie(res, '', secure, true);
    send(200, { loggedOut: true });
    return true;
  }
  if (method === 'POST' && path === '/api/auth/password') {
    if(req.headers.authorization!==undefined) throw new HubError('请使用账号登录后修改密码',403,'ACCOUNT_LOGIN_REQUIRED');
    const session = accountSession(accounts, req, secure);
    await accounts.changePassword(session.user.id, {
      currentPassword: body.currentPassword, newPassword: body.password,
    });
    setSessionCookie(res, '', secure, true);
    send(200, { changed: true });
    return true;
  }
  if (method === 'POST' && path === '/api/auth/node-pairing') {
    send(200, await accounts.nodePairing({
      username: body.username, password: body.password, projectIds: body.projectIds, source,
    }));
    return true;
  }
  throw new HubError('Route not found', 404, 'NOT_FOUND');
}
