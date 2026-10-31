import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubStore } from '../server/hub/store.mjs';
import { AccountService } from '../server/hub/accounts.mjs';
import { authenticateRequest, handleAccountRequest } from '../server/hub/account-http.mjs';

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hub-accounts-'));
  let clock = Date.now();
  const now = () => clock;
  const store = new HubStore(join(root, 'data'), { now });
  const accounts = new AccountService(store, { now, ...options });
  const call = async (method, path, body = {}, { cookie, bearer, secure = false, source = 'test' } = {}) => {
    const req = { headers: { ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } };
    const headers = {};
    const res = { setHeader: (name, value) => { headers[name] = value; } };
    let response;
    const send = (status, data) => { response = { status, data, headers }; };
    try {
      const handled = await handleAccountRequest({ accounts, store, req, res, method, path, body, send, secure, source });
      assert.equal(handled, true);
      return response;
    } catch (error) {
      return { status: error.status || 500, data: { error: error.message, code: error.code }, headers };
    }
  };
  return {
    root, store, accounts, call,
    advance: ms => { clock += ms; },
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

const getCookie = response => response.headers['Set-Cookie']?.split(';')[0];

test('register, login, me and logout use revocable HttpOnly sessions and an owner subject', async () => {
  const x = await fixture();
  try {
    const registered = await x.call('POST', '/api/auth/register', { username: 'Alice', password: 'correct horse long' }, { secure: true });
    assert.equal(registered.status, 200);
    assert.equal(registered.data.user.username, 'alice');
    assert.equal('sessionToken' in registered.data, false);
    assert.match(registered.headers['Set-Cookie'], /^__Host-hub_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800; Secure$/);
    assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM subjects WHERE role=?').get('owner').n, 1);
    assert.equal((await x.call('GET', '/api/auth/me', {}, { cookie: getCookie(registered), secure: true })).data.user.id, registered.data.user.id);
    const req = { headers: { cookie: getCookie(registered) } };
    const subject = authenticateRequest({ accounts: x.accounts, store: x.store, req, secure: true });
    assert.equal(subject.role, 'owner');
    assert.equal(subject.tenant_id, registered.data.user.tenantId);
    assert.equal((await x.call('POST', '/api/auth/logout', {}, { cookie: getCookie(registered), secure: true })).status, 200);
    assert.equal((await x.call('GET', '/api/auth/me', {}, { cookie: getCookie(registered), secure: true })).status, 401);
    const login = await x.call('POST', '/api/auth/login', { username: 'ALICE', password: 'correct horse long' }, { secure: true });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.id, registered.data.user.id);
    x.advance(7 * 24 * 60 * 60 * 1000 + 1);
    assert.equal((await x.call('GET', '/api/auth/me', {}, { cookie: getCookie(login), secure: true })).status, 401);
  } finally { await x.close(); }
});

test('duplicate registration race and wrong credentials never create another account or expose secrets', async () => {
  const x = await fixture();
  try {
    const attempts = await Promise.all([
      x.call('POST', '/api/auth/register', { username: 'sameuser', password: 'one correct secret' }),
      x.call('POST', '/api/auth/register', { username: 'SAMEUSER', password: 'two correct secret' }),
    ]);
    assert.deepEqual(attempts.map(item => item.status).sort(), [200, 409]);
    assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM account_users').get().n, 1);
    const wrong = await x.call('POST', '/api/auth/login', { username: 'sameuser', password: 'not the password' });
    const unknown = await x.call('POST', '/api/auth/login', { username: 'nobody', password: 'not the password' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.data.error, unknown.data.error);
    assert.equal(JSON.stringify(attempts).includes('correct secret'), false);
    const short = await x.call('POST', '/api/auth/register', { username: 'shortpass', password: 'too short' });
    assert.equal(short.status, 400);
  } finally { await x.close(); }
});

test('direct owner claim retains the existing tenant and cannot steal another account space', async () => {
  const x = await fixture();
  try {
    const a = x.store.bootstrap('tenant-with-tasks');
    const b = x.store.bootstrap('tenant-other');
    const tokenA = (await readFile(a.tokenPath, 'utf8')).trim();
    const tokenB = (await readFile(b.tokenPath, 'utf8')).trim();
    const ownerA = x.store.authenticate(tokenA);
    const oldNode = x.store.redeem(x.store.createPairing(ownerA, { role: 'node', projectIds: ['existing-project'] }).code);
    const claim = await x.call('POST', '/api/auth/claim', { username: 'legacy', password: 'legacy owner password' }, { bearer: tokenA });
    assert.equal(claim.status, 200);
    assert.equal(claim.data.user.tenantId, 'tenant-with-tasks');
    assert.equal(authenticateRequest({ accounts: x.accounts, store: x.store,
      req: { headers: { cookie: getCookie(claim) } } }).id, ownerA.id);
    assert.equal(x.store.authenticate(oldNode.token).tenant_id, 'tenant-with-tasks');
    assert.equal((await x.call('POST', '/api/auth/claim', { username: 'thief', password: 'another long password' }, { bearer: tokenA })).status, 409);
    assert.equal((await x.call('POST', '/api/auth/claim', { username: 'nobearer', password: 'another long password' })).status, 401);
    const other = await x.call('POST', '/api/auth/claim', { username: 'other', password: 'another long password' }, { bearer: tokenB });
    assert.equal(other.status, 200);
    assert.notEqual(other.data.user.tenantId, claim.data.user.tenantId);
    const explicit = authenticateRequest({ accounts: x.accounts, store: x.store,
      req: { headers: { cookie: getCookie(claim), authorization: `Bearer ${tokenB}` } } });
    assert.equal(explicit.tenant_id, 'tenant-other');
    assert.throws(() => authenticateRequest({ accounts: x.accounts, store: x.store,
      req: { headers: { cookie: 'hub_session=expired', authorization: 'Bearer malformed secret' } } }), { status: 401 });
  } finally { await x.close(); }
});

test('node pairing validates account credentials and grants only its tenant', async () => {
  const x = await fixture();
  try {
    const registered = await x.call('POST', '/api/auth/register', { username: 'nodeowner', password: 'node owner password' });
    const pairing = await x.call('POST', '/api/auth/node-pairing',
      { username: 'nodeowner', password: 'node owner password', projectIds: ['p1'] });
    assert.equal(pairing.status, 200);
    assert.equal(pairing.headers['Set-Cookie'], undefined);
    const redeemed = x.store.redeem(pairing.data.code);
    assert.equal(x.store.authenticate(redeemed.token).tenant_id, registered.data.user.tenantId);
    assert.deepEqual(redeemed.projectIds, ['p1']);
    assert.equal((await x.call('POST', '/api/auth/node-pairing',
      { username: 'nodeowner', password: 'wrong password', projectIds: ['p1'] })).status, 401);
  } finally { await x.close(); }
});

test('password change revokes every old session, and login attempts are bounded', async () => {
  const x = await fixture();
  try {
    const first = await x.call('POST', '/api/auth/register', { username: 'changeme', password: 'original long password' });
    const second = await x.call('POST', '/api/auth/login', { username: 'changeme', password: 'original long password' });
    assert.equal(second.status, 200);
    const change = await x.call('POST', '/api/auth/password',
      { currentPassword: 'original long password', password: 'changed long password' },
      { cookie: getCookie(first) });
    assert.equal(change.status, 200);
    assert.equal((await x.call('GET', '/api/auth/me', {}, { cookie: getCookie(first) })).status, 401);
    assert.equal((await x.call('GET', '/api/auth/me', {}, { cookie: getCookie(second) })).status, 401);
    assert.equal((await x.call('POST', '/api/auth/login', { username: 'changeme', password: 'original long password' })).status, 401);
    assert.equal((await x.call('POST', '/api/auth/login', { username: 'changeme', password: 'changed long password' })).status, 200);
    let last;
    for (let i = 0; i < 12; i++) last = await x.call('POST', '/api/auth/login',
      { username: 'limituser', password: 'some incorrect password' }, { source: 'rate-test' });
    assert.equal(last.status, 401);
    assert.equal((await x.call('POST', '/api/auth/login',
      { username: 'limituser', password: 'some incorrect password' }, { source: 'rate-test' })).status, 429);
  } finally { await x.close(); }
});

test('disabled registration still permits a legacy owner to claim its space', async () => {
  const x = await fixture({ registrationEnabled: false });
  try {
    assert.deepEqual((await x.call('GET', '/api/auth/status')).data, { registrationEnabled: false });
    assert.equal((await x.call('POST', '/api/auth/register',
      { username: 'newuser', password: 'long enough password' })).status, 403);
    const boot = x.store.bootstrap('old-space');
    const token = (await readFile(boot.tokenPath, 'utf8')).trim();
    assert.equal((await x.call('POST', '/api/auth/claim',
      { username: 'oldowner', password: 'long enough password' }, { bearer: token })).status, 200);
  } finally { await x.close(); }
});

test('session count stays bounded and stale credentials cannot mint node pairings', async () => {
  const x = await fixture();
  try {
    const registered = await x.accounts.register({ username: 'manysessions', password: 'session password long' });
    const row = x.store.db.prepare('SELECT * FROM account_users WHERE id=?').get(registered.user.id);
    for (let i = 0; i < 25; i++) x.accounts.issueSession(row);
    assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM account_sessions WHERE user_id=?').get(row.id).n, 20);
    const originalCredentials = x.accounts.credentials;
    x.accounts.credentials = async () => row;
    try {
      await x.accounts.changePassword(row.id, {
        currentPassword: 'session password long', newPassword: 'new session password long',
      });
      await assert.rejects(x.accounts.nodePairing({
        username: 'manysessions', password: 'session password long', projectIds: ['p1'],
      }), { status: 401, code: 'INVALID_CREDENTIALS' });
    } finally { x.accounts.credentials = originalCredentials; }
    assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM pairings').get().n, 0);
  } finally { await x.close(); }
});

test('password change attempts are independently rate limited', async () => {
  const x = await fixture();
  try {
    const registered = await x.call('POST', '/api/auth/register',
      { username: 'limitedpass', password: 'original long password' });
    for (let i = 0; i < 5; i++) {
      const response = await x.call('POST', '/api/auth/password',
        { currentPassword: 'wrong password', password: 'new longer password' },
        { cookie: getCookie(registered) });
      assert.equal(response.status, 401);
    }
    assert.equal((await x.call('POST', '/api/auth/password',
      { currentPassword: 'original long password', password: 'new longer password' },
      { cookie: getCookie(registered) })).status, 429);
  } finally { await x.close(); }
});

test('mixed cookie and bearer cannot mislabel an account or change the hidden cookie account password',async()=>{
  const x=await fixture();try{
    const registered=await x.call('POST','/api/auth/register',{username:'cookieuser',password:'correct horse long'});
    const bearer=(await readFile(x.store.bootstrap('legacy-space').tokenPath,'utf8')).trim();
    const identity=await x.call('GET','/api/auth/me',{}, {cookie:getCookie(registered),bearer});
    assert.equal(identity.status,200);assert.equal(identity.data.user,null);
    assert.equal((await x.call('POST','/api/auth/password',{currentPassword:'correct horse long',password:'different long password'}, {cookie:getCookie(registered),bearer})).status,403);
    assert.equal((await x.call('POST','/api/auth/logout',{}, {cookie:getCookie(registered),bearer})).status,200);
    assert.equal((await x.call('GET','/api/auth/me',{}, {cookie:getCookie(registered)})).status,401);
    assert.equal((await x.call('POST','/api/auth/logout')).status,200);
  }finally{await x.close();}
});

test('failed login attempts from one source cannot lock out the account on another source',async()=>{
  const x=await fixture();try{
    await x.call('POST','/api/auth/register',{username:'legitimate',password:'correct horse long'});
    for(let i=0;i<12;i++)await x.call('POST','/api/auth/login',{username:'legitimate',password:'wrong'},{source:'attacker'});
    assert.equal((await x.call('POST','/api/auth/login',{username:'legitimate',password:'wrong'},{source:'attacker'})).status,429);
    assert.equal((await x.call('POST','/api/auth/login',{username:'legitimate',password:'correct horse long'},{source:'owner-device'})).status,200);
    for(let i=0;i<13;i++)assert.equal((await x.call('POST','/api/auth/login',{username:'legitimate',password:'correct horse long'},{source:'owner-device'})).status,200);
  }finally{await x.close();}
});
