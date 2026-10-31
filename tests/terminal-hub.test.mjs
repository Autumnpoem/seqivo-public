import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { HubStore } from '../server/hub/store.mjs';
import { AccountService } from '../server/hub/accounts.mjs';
import { createTerminalHub } from '../server/hub/terminal.mjs';
import { createHub } from '../server/hub/http.mjs';

const next = ws => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { cleanup(); reject(new Error('WebSocket frame timeout')); }, 3000);
  function cleanup() { clearTimeout(timer); ws.off('message', message); ws.off('close', closed); }
  function message(data) { cleanup(); resolve(JSON.parse(data.toString())); }
  function closed(code) { cleanup(); reject(new Error(`WebSocket closed ${code}`)); }
  ws.once('message', message); ws.once('close', closed);
});
const opened = ws => new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
const closed = ws => new Promise(resolve => ws.once('close', resolve));

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'terminal-hub-'));
  const store = new HubStore(join(root, 'hub'));
  const accounts = new AccountService(store);
  const terminal = createTerminalHub({ store, accounts, ...options });
  const hosts = new Set(), origins = new Set();
  const server = createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      let raw = '';
      for await (const part of req) { raw += part; if (raw.length > 65536) throw new Error('Body too large'); }
      const body = raw ? JSON.parse(raw) : {};
      const path = new URL(req.url, 'http://localhost').pathname;
      if (!terminal.handleHttp({ req, res, method: req.method, path, body, send })) send(404, { code: 'NOT_FOUND' });
    } catch (error) { send(error.status || 500, { code: error.code || 'ERROR', error: error.message }); }
  });
  terminal.attachServer(server, { allowedHosts: hosts, allowedOrigins: origins });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  hosts.add(new URL(origin).host); origins.add(origin);
  const call = async (method, path, body, { cookie = '', bearer = '', requestOrigin = origin } = {}) => {
    const response = await fetch(`${origin}${path}`, { method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const register = async name => {
    const result = await accounts.register({ username: name, password: 'correct horse long', source: name });
    return { ...result, cookie: `hub_session=${result.sessionToken}` };
  };
  const node = async (account, profiles = [{ id: 'default', label: 'Terminal' }]) => {
    const subject = store.db.prepare('SELECT * FROM subjects WHERE id=(SELECT owner_subject_id FROM account_users WHERE id=?)').get(account.user.id);
    const pairing = store.createPairing(subject, { role: 'node', projectIds: ['test'] });
    const redeemed = store.redeem(pairing.code);
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/terminal/node');
    await opened(ws);
    const response = next(ws);
    ws.send(JSON.stringify({ type: 'auth', v: 1, nodeId: redeemed.nodeId, token: redeemed.token, profiles }));
    assert.equal((await response).type, 'ready');
    return { ...redeemed, ws };
  };
  const browser = async (ticket, cookie, requestOrigin = origin) => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/terminal/ws', { headers: { Cookie: cookie, Origin: requestOrigin } });
    await opened(ws);
    const response = next(ws);
    ws.send(JSON.stringify({ type: 'auth', v: 1, ticket }));
    return { ws, response };
  };
  return { root, store, accounts, terminal, server, origin, call, register, node, browser,
    close: async () => { await terminal.close(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('correlated detach survives a failed-switch epoch and ignores late frames', async () => {
  const x=await fixture();
  try {
    const account=await x.register('detachowner'),node=await x.node(account);
    const enrolled=await x.call('POST','/api/terminal/devices',{label:'Phone'},{cookie:account.cookie});
    const cookie=`${account.cookie}; ${enrolled.cookie}`;
    assert.equal((await x.call('POST','/api/node/terminal/grants',{action:'grant',deviceId:enrolled.data.deviceId,
      profileId:'default',scopes:['view','input'],confirmationCode:enrolled.data.confirmationCode},{bearer:node.token})).status,200);
    const ticket=await x.call('POST','/api/terminal/tickets',{nodeId:node.nodeId,profileId:'default',scope:'control'},{cookie});
    const browser=await x.browser(ticket.data.ticket,cookie);await browser.response;
    const relay=frame=>node.ws.send(JSON.stringify({type:'terminal',v:1,connectionId:ticket.data.connectionId,frame:{v:1,...frame}}));
    const ready=next(browser.ws);relay({type:'ready',epoch:1});await ready;
    const forwarded=next(node.ws);
    browser.ws.send(JSON.stringify({type:'detach',v:1,epoch:1,requestId:'detach-after-failed-switch'}));
    assert.equal((await forwarded).frame.requestId,'detach-after-failed-switch');
    const observed=[];browser.ws.on('message',data=>observed.push(JSON.parse(data.toString())));
    const gone=closed(browser.ws);
    relay({type:'ready',epoch:2});
    relay({type:'output',epoch:2,offset:0,data:Buffer.from('late output').toString('base64')});
    relay({type:'exit',epoch:1,reason:'detached',requestId:'wrong-request'});
    relay({type:'exit',epoch:3,reason:'detached',requestId:'detach-after-failed-switch'});
    assert.equal(await gone,1000);
    assert.deepEqual(observed.map(f=>[f.type,f.requestId]),[['exit','detach-after-failed-switch']]);
    assert.equal(observed[0].epoch,3,'the confirmed close is not discarded with the stale attachment epoch');
    const resume=await x.call('POST','/api/terminal/tickets',{nodeId:node.nodeId,profileId:'default',scope:'control',resumeConnectionId:ticket.data.connectionId},{cookie});
    assert.equal(resume.status,409,'an explicitly detached connection is not retained for resume');
  } finally {await x.close();}
});

test('node control recovery hint rejects nonboolean values before browser forwarding', async () => {
  const x=await fixture();
  try {
    const account=await x.register('recoveryhint'),node=await x.node(account);
    const enrolled=await x.call('POST','/api/terminal/devices',{label:'Viewer'},{cookie:account.cookie});
    const cookie=`${account.cookie}; ${enrolled.cookie}`;
    assert.equal((await x.call('POST','/api/node/terminal/grants',{action:'grant',deviceId:enrolled.data.deviceId,
      profileId:'default',scopes:['view'],confirmationCode:enrolled.data.confirmationCode},{bearer:node.token})).status,200);
    const ticket=await x.call('POST','/api/terminal/tickets',{nodeId:node.nodeId,profileId:'default',scope:'view'},{cookie});
    assert.equal(ticket.status,200);
    const browser=await x.browser(ticket.data.ticket,cookie);await browser.response;
    const rejected=next(node.ws),nodeClosed=closed(node.ws);
    node.ws.send(JSON.stringify({type:'terminal',v:1,connectionId:ticket.data.connectionId,
      frame:{type:'control',v:1,managed:true,owned:false,phase:'unknown',mode:'managed',
        canReconcileAcquire:'true',reason:null,changes:[]}}));
    assert.equal((await rejected).code,'INVALID_FRAME');
    await nodeClosed;
    browser.ws.close();
  } finally { await x.close(); }
});

test('fresh tmux open relays only a valid exact recovery identity',async()=>{
  const x=await fixture();
  try{
    const account=await x.register('exactresume'),node=await x.node(account);
    const enrolled=await x.call('POST','/api/terminal/devices',{label:'Phone'},{cookie:account.cookie});
    const cookie=`${account.cookie}; ${enrolled.cookie}`;
    assert.equal((await x.call('POST','/api/node/terminal/grants',{action:'grant',deviceId:enrolled.data.deviceId,
      profileId:'default',scopes:['view','input'],confirmationCode:enrolled.data.confirmationCode},{bearer:node.token})).status,200);
    const ticket=await x.call('POST','/api/terminal/tickets',{nodeId:node.nodeId,profileId:'default',scope:'control'},{cookie});
    const browser=await x.browser(ticket.data.ticket,cookie);await browser.response;
    const a={serverName:'default',instanceId:'a'.repeat(64),sessionId:'$1'};
    const forwarded=next(node.ws);
    browser.ws.send(JSON.stringify({type:'open',v:1,mode:'tmux',cols:80,rows:24,recoverSessionRef:a}));
    assert.deepEqual((await forwarded).frame.recoverSessionRef,a);
    const rejected=next(browser.ws),gone=closed(browser.ws);
    browser.ws.send(JSON.stringify({type:'open',v:1,mode:'tmux',cols:80,rows:24,recoverSessionRef:{...a,sessionId:'bad'}}));
    assert.equal((await rejected).code,'INVALID_SESSION_REF');
    assert.equal(await gone,4003);
  }finally{await x.close();}
});

test('resume expiring between ticket issue and WebSocket auth rejects old identity but permits a fresh authenticated connection',async()=>{
  let clock=Date.now();
  const x=await fixture({now:()=>clock});
  try{
    const account=await x.register('authstageresume'),node=await x.node(account);
    const enrolled=await x.call('POST','/api/terminal/devices',{label:'Phone'},{cookie:account.cookie});
    const cookie=`${account.cookie}; ${enrolled.cookie}`;
    assert.equal((await x.call('POST','/api/node/terminal/grants',{action:'grant',deviceId:enrolled.data.deviceId,
      profileId:'default',scopes:['view','input'],confirmationCode:enrolled.data.confirmationCode},{bearer:node.token})).status,200);
    const request={nodeId:node.nodeId,profileId:'default',scope:'control'};
    const first=await x.call('POST','/api/terminal/tickets',request,{cookie});
    assert.equal(first.status,200);
    const browser=await x.browser(first.data.ticket,cookie);
    assert.equal((await browser.response).type,'authenticated');
    const suspended=next(node.ws),browserClosed=closed(browser.ws);
    browser.ws.close();
    assert.equal((await suspended).type,'terminal-suspend');
    await browserClosed;

    clock+=29_000;
    const resume=await x.call('POST','/api/terminal/tickets',{...request,resumeConnectionId:first.data.connectionId},{cookie});
    assert.equal(resume.status,200,'the old connection is still resumable when the ticket is issued');
    assert.equal(resume.data.connectionId,first.data.connectionId);
    clock+=1_001;
    assert.ok(resume.data.expiresAt>clock,'the ticket remains valid; only its old connection has expired');
    const stale=await x.browser(resume.data.ticket,cookie),staleClosed=closed(stale.ws);
    assert.equal((await stale.response).code,'RESUME_UNAVAILABLE');
    assert.equal(await staleClosed,4003);

    const fresh=await x.call('POST','/api/terminal/tickets',request,{cookie});
    assert.equal(fresh.status,200);
    assert.notEqual(fresh.data.connectionId,first.data.connectionId);
    const recovered=await x.browser(fresh.data.ticket,cookie);
    assert.equal((await recovered.response).type,'authenticated');
    const original={serverName:'default',instanceId:'b'.repeat(64),sessionId:'$2'};
    const forwarded=next(node.ws);
    recovered.ws.send(JSON.stringify({type:'open',v:1,mode:'tmux',cols:80,rows:24,recoverSessionRef:original}));
    const envelope=await forwarded;
    assert.equal(envelope.connectionId,fresh.data.connectionId);
    assert.deepEqual(envelope.frame.recoverSessionRef,original);
  }finally{await x.close();}
});

test('device approval, ticket, relay, stale input and live revocation', async () => {
  const x = await fixture();
  try {
    const account = await x.register('terminalowner');
    const node = await x.node(account);
    const enrolled = await x.call('POST', '/api/terminal/devices', { label: 'Phone' }, { cookie: account.cookie });
    assert.equal(enrolled.status, 200);
    const browserCookie = `${account.cookie}; ${enrolled.cookie}`;
    assert.equal((await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default', scope: 'control' }, { cookie: browserCookie })).status, 403);
    const pending = await x.call('GET', '/api/node/terminal/pending', undefined, { bearer: node.token });
    assert.equal(pending.data.devices[0].deviceId, enrolled.data.deviceId);
    assert.equal((await x.call('POST', '/api/node/terminal/grants', { action: 'grant', deviceId: enrolled.data.deviceId,
      profileId: 'default', scopes: ['view', 'input', 'create', 'default'], confirmationCode: 'wrong' }, { bearer: node.token })).status, 403);
    const grant = await x.call('POST', '/api/node/terminal/grants', { action: 'grant', deviceId: enrolled.data.deviceId,
      profileId: 'default', scopes: ['view', 'input', 'create', 'default'], confirmationCode: enrolled.data.confirmationCode }, { bearer: node.token });
    assert.equal(grant.status, 200);
    const ticket = await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default', scope: 'control' }, { cookie: browserCookie });
    assert.equal(ticket.status, 200);
    const browser = await x.browser(ticket.data.ticket, browserCookie);
    assert.equal((await browser.response).type, 'authenticated');
    const envelope = next(node.ws);
    browser.ws.send(JSON.stringify({ type: 'open', v: 1, connectionId: ticket.data.connectionId, profileId: 'default', cols: 80, rows: 24 }));
    assert.equal((await envelope).frame.type, 'open');
    const ready = next(browser.ws);
    node.ws.send(JSON.stringify({ type: 'terminal', v: 1, connectionId: ticket.data.connectionId,
      frame: { type: 'ready', v: 1, connectionId: ticket.data.connectionId, epoch: 1, sessionRef: { sessionId: '$1' } } }));
    assert.equal((await ready).epoch, 1);
    const input = next(node.ws);
    browser.ws.send(JSON.stringify({ type: 'input', v: 1, epoch: 1, seq: 1, data: Buffer.from('a').toString('base64') }));
    assert.equal((await input).frame.type, 'input');
    const denied = next(browser.ws);
    browser.ws.send(JSON.stringify({ type: 'input', v: 1, epoch: 1, seq: 1, data: Buffer.from('a').toString('base64') }));
    assert.equal((await denied).code, 'INPUT_STALE');
    await closed(browser.ws);
    const ticket2 = await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default', scope: 'view' }, { cookie: browserCookie });
    const browser2 = await x.browser(ticket2.data.ticket, browserCookie);
    assert.equal((await browser2.response).type, 'authenticated');
    const revoked = closed(browser2.ws);
    assert.equal((await x.call('POST', '/api/node/terminal/grants', { action: 'revoke', deviceId: enrolled.data.deviceId, profileId: 'default' }, { bearer: node.token })).status, 200);
    await revoked;
    assert.equal((await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default', scope: 'view' }, { cookie: browserCookie })).status, 403);
    node.ws.close();
  } finally { await x.close(); }
});

test('account, device, Origin and one-use ticket boundaries', async () => {
  const x = await fixture();
  try {
    const a = await x.register('terminalalice');
    const b = await x.register('terminalbob');
    const node = await x.node(a);
    assert.equal((await x.call('POST', '/api/terminal/devices', { label: 'Phone' }, { cookie: a.cookie, requestOrigin: 'https://evil.example' })).status, 403);
    const enrolled = await x.call('POST', '/api/terminal/devices', { label: 'Phone' }, { cookie: a.cookie });
    const cookies = `${a.cookie}; ${enrolled.cookie}`;
    await x.call('POST', '/api/node/terminal/grants', { action: 'grant', deviceId: enrolled.data.deviceId,
      profileId: 'default', scopes: ['view'], confirmationCode: enrolled.data.confirmationCode }, { bearer: node.token });
    assert.equal((await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default', scope: 'view' }, { cookie: `${b.cookie}; ${enrolled.cookie}` })).status, 401);
    const ticket = await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default', scope: 'view' }, { cookie: cookies });
    const first = await x.browser(ticket.data.ticket, cookies);
    assert.equal((await first.response).type, 'authenticated');
    const second = await x.browser(ticket.data.ticket, cookies);
    assert.equal((await second.response).code, 'TICKET_INVALID');
    await closed(second.ws);
    const bad = new WebSocket(x.origin.replace('http:', 'ws:') + '/api/terminal/ws', { headers: { Cookie: cookies, Origin: 'https://evil.example' } });
    await assert.rejects(opened(bad));
    first.ws.close(); node.ws.close();
  } finally { await x.close(); }
});

test('an enrolled device can rotate a confirmation code without changing its credential or grants', async () => {
  let clock = Date.now();
  const x = await fixture({ now: () => clock });
  try {
    const owner = await x.register('terminalreenroll');
    const other = await x.register('terminalreenrollother');
    const node = await x.node(owner, [{ id: 'default', label: 'Default' }, { id: 'new', label: 'New' }]);
    const enrolled = await x.call('POST', '/api/terminal/devices', { label: 'Phone' }, { cookie: owner.cookie });
    const cookies = `${owner.cookie}; ${enrolled.cookie}`;
    const grant = (profileId, confirmationCode) => x.call('POST', '/api/node/terminal/grants', {
      action: 'grant', deviceId: enrolled.data.deviceId, profileId, scopes: ['view'], confirmationCode,
    }, { bearer: node.token });
    assert.equal((await grant('default', enrolled.data.confirmationCode)).status, 200);
    assert.equal((await x.call('POST', '/api/terminal/devices', { label: 'Again' }, { cookie: cookies })).data.code, 'DEVICE_EXISTS');

    const path = '/api/terminal/devices/confirmation';
    assert.equal((await x.call('POST', path, {}, { cookie: enrolled.cookie })).data.code, 'UNAUTHORIZED');
    assert.equal((await x.call('POST', path, {}, { cookie: cookies, bearer: node.token })).data.code, 'ACCOUNT_LOGIN_REQUIRED');
    assert.equal((await x.call('POST', path, {}, { cookie: owner.cookie })).data.code, 'DEVICE_REQUIRED');
    assert.equal((await x.call('POST', path, {}, { cookie: `${other.cookie}; ${enrolled.cookie}` })).data.code, 'DEVICE_REQUIRED');
    assert.equal((await x.call('POST', path, {}, { cookie: `${cookies}; ${enrolled.cookie}` })).data.code, 'UNAUTHORIZED');
    assert.equal((await x.call('POST', path, {}, { cookie: cookies, requestOrigin: 'https://evil.example' })).data.code, 'ORIGIN');
    assert.equal((await x.call('POST', path, { deviceId: enrolled.data.deviceId }, { cookie: cookies })).data.code, 'INVALID_DEVICE');
    const rotated = await x.call('POST', path, {}, { cookie: cookies });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.cookie, undefined);
    assert.equal(rotated.data.deviceId, enrolled.data.deviceId);
    assert.notEqual(rotated.data.confirmationCode, enrolled.data.confirmationCode);
    assert.equal(rotated.data.expiresAt, clock + 600_000);
    assert.equal((await grant('new', enrolled.data.confirmationCode)).data.code, 'INVALID_CODE');
    assert.equal((await x.call('POST', path, {}, { cookie: cookies })).data.code, 'CONFIRMATION_RATE_LIMIT');
    const status = await x.call('GET', '/api/terminal/status', undefined, { cookie: cookies });
    assert.equal(status.data.device.deviceId, enrolled.data.deviceId);
    assert.equal(status.data.device.status, 'approved');
    assert.deepEqual(status.data.grants.map(item => item.profileId), ['default']);

    clock += 30_000;
    const replaced = await x.call('POST', path, {}, { cookie: cookies });
    assert.equal(replaced.status, 200);
    assert.equal((await grant('new', rotated.data.confirmationCode)).data.code, 'INVALID_CODE');
    clock += 600_000;
    assert.equal((await grant('new', replaced.data.confirmationCode)).data.code, 'INVALID_CODE');
    const fresh = await x.call('POST', path, {}, { cookie: cookies });
    assert.equal(fresh.status, 200);
    assert.equal((await grant('new', fresh.data.confirmationCode)).status, 200);
    const granted = await x.call('GET', '/api/terminal/status', undefined, { cookie: cookies });
    assert.deepEqual(new Set(granted.data.grants.map(item => item.profileId)), new Set(['default', 'new']));
    assert.equal((await x.call('POST', path, {}, { cookie: cookies })).status, 200,
      'a consumed code may be replaced immediately to approve another profile');
    assert.equal((await x.call('DELETE', `/api/terminal/devices/${enrolled.data.deviceId}`, undefined, { cookie: cookies })).status, 200);
    assert.equal((await x.call('POST', path, {}, { cookie: cookies })).data.code, 'DEVICE_REQUIRED');
    node.ws.close();
  } finally { await x.close(); }
});

test('resume binds the same account, device and node; logout ends the live stream', async () => {
  const x = await fixture();
  try {
    const owner = await x.register('terminalresume');
    const other = await x.register('terminalother');
    const node = await x.node(owner);
    const enrolled = await x.call('POST', '/api/terminal/devices', { label: 'Tablet' }, { cookie: owner.cookie });
    const cookies = `${owner.cookie}; ${enrolled.cookie}`;
    await x.call('POST', '/api/node/terminal/grants', { action: 'grant', deviceId: enrolled.data.deviceId,
      profileId: 'default', scopes: ['view', 'input'], confirmationCode: enrolled.data.confirmationCode }, { bearer: node.token });
    const firstTicket = await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default', scope: 'control' }, { cookie: cookies });
    const first = await x.browser(firstTicket.data.ticket, cookies);
    await first.response;
    const openedFrame = next(node.ws);
    first.ws.send(JSON.stringify({ type: 'open', v: 1, connectionId: firstTicket.data.connectionId, profileId: 'default', mode: 'tmux' }));
    await openedFrame;
    const firstReady = next(first.ws);
    node.ws.send(JSON.stringify({ type: 'terminal', v: 1, connectionId: firstTicket.data.connectionId,
      frame: { type: 'ready', v: 1, epoch: 1 } }));
    await firstReady;
    const firstInput = next(node.ws);
    first.ws.send(JSON.stringify({ type: 'input', v: 1, epoch: 1, seq: 7, data: 'YQ==' }));
    await firstInput;
    const suspended = next(node.ws);
    first.ws.close();
    assert.equal((await suspended).type, 'terminal-suspend');
    assert.equal((await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default', scope: 'control',
      resumeConnectionId: firstTicket.data.connectionId }, { cookie: `${other.cookie}; ${enrolled.cookie}` })).status, 401);
    const resumedTicket = await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default', scope: 'control',
      resumeConnectionId: firstTicket.data.connectionId }, { cookie: cookies });
    assert.equal(resumedTicket.data.connectionId, firstTicket.data.connectionId);
    const resumed = await x.browser(resumedTicket.data.ticket, cookies);
    assert.equal((await resumed.response).type, 'authenticated');
    const resumedReady = next(resumed.ws);
    node.ws.send(JSON.stringify({ type: 'terminal', v: 1, connectionId: firstTicket.data.connectionId,
      frame: { type: 'ready', v: 1, epoch: 1 } }));
    await resumedReady;
    const stale = next(resumed.ws);
    resumed.ws.send(JSON.stringify({ type: 'input', v: 1, epoch: 1, seq: 7, data: 'YQ==' }));
    assert.equal((await stale).code, 'INPUT_STALE');
    await closed(resumed.ws);
    const finalTicket = await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default', scope: 'control' }, { cookie: cookies });
    const final = await x.browser(finalTicket.data.ticket, cookies);
    assert.equal((await final.response).type, 'authenticated');
    x.accounts.logout(owner.sessionToken);
    const response = next(final.ws);
    final.ws.send(JSON.stringify({ type: 'list', v: 1, requestId: 'one' }));
    assert.equal((await response).code, 'UNAUTHORIZED');
    await closed(final.ws);
    node.ws.close();
  } finally { await x.close(); }
});

test('terminal scopes are checked per action', async () => {
  const x = await fixture();
  try {
    const account = await x.register('terminalscopes');
    const node = await x.node(account);
    const enrolled = await x.call('POST', '/api/terminal/devices', { label: 'Viewer' }, { cookie: account.cookie });
    const cookies = `${account.cookie}; ${enrolled.cookie}`;
    await x.call('POST', '/api/node/terminal/grants', { action: 'grant', deviceId: enrolled.data.deviceId,
      profileId: 'default', scopes: ['view', 'default'], confirmationCode: enrolled.data.confirmationCode }, { bearer: node.token });
    const ticket = await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default', scope: 'control' }, { cookie: cookies });
    assert.equal(ticket.status, 200);
    const browser = await x.browser(ticket.data.ticket, cookies);
    await browser.response;
    const forwarded = next(node.ws);
    browser.ws.send(JSON.stringify({ type: 'default', v: 1, requestId: 'default-1', sessionRef: { sessionId: '$1' } }));
    assert.equal((await forwarded).frame.type, 'default');
    const rejected = next(browser.ws);
    browser.ws.send(JSON.stringify({ type: 'input', v: 1, epoch: 1, seq: 1, data: 'YQ==' }));
    assert.equal((await rejected).code, 'GRANT_REQUIRED');
    await closed(browser.ws);
    node.ws.close();
  } finally { await x.close(); }
});

test('takeover scope gates all control actions and control replies omit authority tokens', async () => {
  const x = await fixture();
  try {
    const account = await x.register('terminalcontrol');
    const node = await x.node(account);
    for (const scope of ['view', 'create', 'default', 'takeover']) {
      const enrolled = await x.call('POST', '/api/terminal/devices', { label: scope }, { cookie: account.cookie });
      const cookies = `${account.cookie}; ${enrolled.cookie}`;
      const grant = await x.call('POST', '/api/node/terminal/grants', { action: 'grant', deviceId: enrolled.data.deviceId,
        profileId: 'default', scopes: scope === 'view' ? ['view'] : ['view', scope], confirmationCode: enrolled.data.confirmationCode }, { bearer: node.token });
      assert.equal(grant.status, 200);
      const ticket = await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default', scope: 'control' }, { cookie: cookies });
      if (scope === 'view') { assert.equal(ticket.status, 403); continue; }
      assert.equal(ticket.status, 200);
      const browser = await x.browser(ticket.data.ticket, cookies); await browser.response;
      if (scope === 'takeover') {
        const existingRef={serverName:'existing',instanceId:'a'.repeat(64),sessionId:'$1'};
        for (const frame of [{ type: 'takeover' }, { type: 'return', notes: 'done' },
          {type:'return-prepare',notes:'review before AI'},
          {type:'return-confirm',reviewId:'a'.repeat(64),expectedGeneration:2},
          {type:'return-cancel',reviewId:'a'.repeat(64),expectedGeneration:2},
          { type: 'reconcile-control', action: 'acquire' },
          { type: 'reconcile-control', action: 'release' },
          { type: 'reconcile-control', action: 'acquire', requestId: 'phone-recover-1' },
          { type: 'reconcile-control', action: 'release', requestId: 'phone-release-1' },
          {type:'takeover-existing',sessionRefs:[existingRef]},
          {type:'extend-existing',sessionRefs:[existingRef]}]) {
          const forwarded = next(node.ws);
          browser.ws.send(JSON.stringify({ v: 1, ...frame }));
          assert.deepEqual((await forwarded).frame, { v: 1, ...frame });
        }
        const reply = next(browser.ws);
        node.ws.send(JSON.stringify({ type: 'terminal', v: 1, connectionId: ticket.data.connectionId,
          frame: { type: 'control', v: 1, requestId: 'recover-owner-1', managed: true, owned: true, phase: 'human', reason: null,
            changes: [{ path: 'result.txt', kind: 'added', token: 'nested-secret' }], token: 'secret', snapshotScope:'git-tracked-and-nonignored-untracked' } }));
        assert.deepEqual(await reply, { type: 'control', v: 1, requestId: 'recover-owner-1', managed: true, owned: true, phase: 'human', generation:null, mode:null, authorizedSessionRefs:[], reason: null,
          requiresSessionSelection:true,canReconcileAcquire:false,
          changes: [{ path: 'result.txt', kind: 'added' }], snapshotScope:'git-tracked-and-nonignored-untracked' });
        const emptyRecovery=next(browser.ws);
        node.ws.send(JSON.stringify({type:'terminal',v:1,connectionId:ticket.data.connectionId,
          frame:{type:'control',v:1,managed:true,owned:false,phase:'unknown',mode:'managed',
            requiresSessionSelection:false,reason:'First takeover incomplete',changes:[]}}));
        const emptyHint=await emptyRecovery;
        assert.equal(emptyHint.requiresSessionSelection,false);
        assert.equal(emptyHint.owned,false,'an empty-session hint is not a control grant');
        assert.equal(emptyHint.phase,'unknown');
        const expanded=next(browser.ws);
        node.ws.send(JSON.stringify({type:'terminal',v:1,connectionId:ticket.data.connectionId,
          frame:{type:'control',v:1,managed:true,owned:true,phase:'human',mode:'existing',authorizedSessionRefs:[{...existingRef,token:'hidden'}],
            requiresSessionSelection:false,reason:null,changes:[],snapshotScope:null,token:'hidden'}}));
        const existingHint=await expanded;
        assert.deepEqual(existingHint.authorizedSessionRefs,[existingRef]);
        assert.equal(existingHint.requiresSessionSelection,true,'existing sessions cannot use the empty-managed hint');
        const reviewFrame=next(browser.ws),reviewId='b'.repeat(64);
        node.ws.send(JSON.stringify({type:'terminal',v:1,connectionId:ticket.data.connectionId,
          frame:{type:'control',v:1,managed:true,owned:true,phase:'return_review',generation:2,mode:'managed',
            reason:null,changes:[],snapshotScope:'directory-tree-excluding-git-metadata',token:'hidden',
            returnReview:{reviewId,expiresAt:Date.now()+60_000,generation:2,
              workspaceRelativeDirectories:[{sessionRef:existingRef,path:'.'}],changes:[{path:'changed.txt',kind:'modified'}],
              totalChanges:1,omittedChanges:0,snapshotScope:'directory-tree-excluding-git-metadata',
              parkedManagedSessions:1,unownedWorkspaceWriters:0,notes:'reviewed'}}}));
        const safeReview=await reviewFrame;
        assert.equal(safeReview.phase,'return_review');
        assert.equal(safeReview.returnReview.reviewId,reviewId);
        assert.equal(JSON.stringify(safeReview).includes('hidden'),false,'Hub rebuilds return review fields');
        const invalid=next(node.ws),nodeClosed=closed(node.ws);
        node.ws.send(JSON.stringify({type:'terminal',v:1,connectionId:ticket.data.connectionId,
          frame:{type:'control',v:1,managed:true,owned:false,phase:'unknown',mode:'managed',
            requiresSessionSelection:'false',reason:null,changes:[]}}));
        assert.equal((await invalid).code,'INVALID_FRAME');
        await nodeClosed;
      } else {
        const action = scope === 'create' ? { type: 'create', requestId: 'allowed', name: 'test' } :
          { type: 'default', requestId: 'allowed', sessionRef: { sessionId: '$1' } };
        const forwarded = next(node.ws);
        browser.ws.send(JSON.stringify({ v: 1, ...action }));
        assert.equal((await forwarded).frame.type, action.type);
        const denied = next(browser.ws);
        browser.ws.send(JSON.stringify({ type: 'takeover', v: 1 }));
        assert.equal((await denied).code, 'GRANT_REQUIRED');
        await closed(browser.ws);
      }
      if (browser.ws.readyState === WebSocket.OPEN) browser.ws.close();
    }
    node.ws.close();
  } finally { await x.close(); }
});

test('invalid control payloads fail before reaching the node', async () => {
  const x = await fixture();
  try {
    const account = await x.register('terminalpayload'); const node = await x.node(account);
    const forwarded = [];
    node.ws.on('message', raw => { const frame = JSON.parse(raw.toString()); if (frame.type === 'terminal') forwarded.push(frame); });
    const enrolled = await x.call('POST', '/api/terminal/devices', { label: 'Phone' }, { cookie: account.cookie });
    const cookies = `${account.cookie}; ${enrolled.cookie}`;
    await x.call('POST', '/api/node/terminal/grants', { action: 'grant', deviceId: enrolled.data.deviceId,
      profileId: 'default', scopes: ['view', 'takeover'], confirmationCode: enrolled.data.confirmationCode }, { bearer: node.token });
    for (const action of [{ type: 'return', notes: 'x'.repeat(2001) }, { type: 'return', notes: 1 },
      {type:'return-prepare',notes:'x'.repeat(2001)},
      {type:'return-confirm',reviewId:'bad',expectedGeneration:2},
      {type:'return-cancel',reviewId:'a'.repeat(64),expectedGeneration:0},
      {type:'return-confirm',reviewId:'a'.repeat(64),expectedGeneration:2,token:'forged'},
      { type: 'reconcile-control', action: 'erase' }, { type: 'takeover', token: 'forged' },
      { type: 'reconcile-control', action: 'acquire', requiresSessionSelection: false },
      ...[null, 1, {}, '', 'x'.repeat(101), 'not/a/request'].map(requestId =>
        ({ type: 'reconcile-control', action: 'acquire', requestId })),
      { type: 'reconcile-control', action: 'acquire', requestId: 'phone-owner-forgery',
        sessionRef: { serverName: 'existing', instanceId: 'a'.repeat(64), sessionId: '$1' } }]) {
      const ticket = await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default', scope: 'control' }, { cookie: cookies });
      const browser = await x.browser(ticket.data.ticket, cookies); await browser.response;
      const denied = next(browser.ws);
      browser.ws.send(JSON.stringify({ v: 1, ...action }));
      assert.equal((await denied).code, 'INVALID_FRAME');
      await closed(browser.ws);
    }
    assert.deepEqual(forwarded, [], 'invalid control payloads must not reach the executor');
    node.ws.close();
  } finally { await x.close(); }
});

test('transfer actions require both input and takeover plus a control ticket', async () => {
  const x = await fixture();
  try {
    const account = await x.register('transferscopes'), node = await x.node(account);
    for (const granted of [['view','input'], ['view','takeover'], ['view','input','takeover']]) {
      const enrolled = await x.call('POST','/api/terminal/devices',{label:'Transfer test'},{cookie:account.cookie});
      const cookie = `${account.cookie}; ${enrolled.cookie}`;
      assert.equal((await x.call('POST','/api/node/terminal/grants',{action:'grant',deviceId:enrolled.data.deviceId,
        profileId:'default',scopes:granted,confirmationCode:enrolled.data.confirmationCode},{bearer:node.token})).status,200);
      for (const scope of granted.length === 3 ? ['view','control'] : ['control']) {
        const ticket = await x.call('POST','/api/terminal/tickets',{nodeId:node.nodeId,profileId:'default',scope},{cookie});
        const browser = await x.browser(ticket.data.ticket,cookie);await browser.response;
        const action = {v:1,type:'list-control-targets',requestId:'list-transfer-1'};
        if (scope === 'control' && granted.length === 3) {
          for (const frame of [action,{v:1,type:'transfer-control',targetConnectionId:'other-connection',expectedGeneration:4,requestId:'transfer-1'},
            {v:1,type:'accept-control',transferId:'transfer-1'},{v:1,type:'cancel-transfer',transferId:'transfer-1',requestId:'cancel-1'}]) {
            const forwarded=next(node.ws);browser.ws.send(JSON.stringify(frame));
            const received=await forwarded;
            assert.deepEqual(received.frame,frame);
            assert.equal(received.deviceId,enrolled.data.deviceId);
            assert.equal(received.userId,account.user.id);
          }
          const gone=closed(browser.ws);browser.ws.close();await gone;
        } else {
          const response=next(browser.ws),gone=closed(browser.ws);
          browser.ws.send(JSON.stringify(action));
          assert.equal((await response).code,scope==='view'?'TERMINAL_FORBIDDEN':'GRANT_REQUIRED');
          await gone;
        }
      }
    }
  } finally {await x.close();}
});

test('malformed or authority-bearing transfer requests never reach the node', async () => {
  const x = await fixture();
  try {
    const account=await x.register('transferinvalid'),node=await x.node(account);
    const enrolled=await x.call('POST','/api/terminal/devices',{label:'Transfer test'},{cookie:account.cookie});
    const cookie=`${account.cookie}; ${enrolled.cookie}`;
    await x.call('POST','/api/node/terminal/grants',{action:'grant',deviceId:enrolled.data.deviceId,profileId:'default',
      scopes:['view','input','takeover'],confirmationCode:enrolled.data.confirmationCode},{bearer:node.token});
    const forwarded=[];node.ws.on('message',raw=>{const f=JSON.parse(raw.toString());if(f.type==='terminal')forwarded.push(f);});
    for (const frame of [{type:'list-control-targets',token:'forged'},
      {type:'transfer-control',targetConnectionId:'next',expectedGeneration:0},
      {type:'transfer-control',targetConnectionId:'next',expectedGeneration:Number.MAX_SAFE_INTEGER},
      {type:'transfer-control',targetConnectionId:'next',expectedGeneration:1,actorId:'local-owner'},
      {type:'transfer-control',targetConnectionId:'next'},
      {type:'accept-control',transferId:'invalid id'},
      {type:'cancel-transfer',transferId:'x',requestId:'x'.repeat(101)}]) {
      const ticket=await x.call('POST','/api/terminal/tickets',{nodeId:node.nodeId,profileId:'default',scope:'control'},{cookie});
      const browser=await x.browser(ticket.data.ticket,cookie);await browser.response;
      const denied=next(browser.ws),gone=closed(browser.ws);browser.ws.send(JSON.stringify({v:1,...frame}));
      assert.equal((await denied).code,'INVALID_FRAME');await gone;
    }
    assert.equal(forwarded.length,0);
  } finally {await x.close();}
});

test('transfer replies omit private metadata and old control or ready cannot reopen source input', async () => {
  const x=await fixture();
  try {
    const account=await x.register('transferreply'),node=await x.node(account);
    const enrolled=await x.call('POST','/api/terminal/devices',{label:'Transfer test'},{cookie:account.cookie});
    const cookie=`${account.cookie}; ${enrolled.cookie}`;
    await x.call('POST','/api/node/terminal/grants',{action:'grant',deviceId:enrolled.data.deviceId,profileId:'default',
      scopes:['view','input','takeover'],confirmationCode:enrolled.data.confirmationCode},{bearer:node.token});
    const ticket=await x.call('POST','/api/terminal/tickets',{nodeId:node.nodeId,profileId:'default',scope:'control'},{cookie});
    const browser=await x.browser(ticket.data.ticket,cookie);await browser.response;
    const relay=frame=>node.ws.send(JSON.stringify({type:'terminal',v:1,connectionId:ticket.data.connectionId,frame:{v:1,...frame}}));
    const control={type:'control',managed:true,owned:true,phase:'human',generation:4,reason:null,changes:[]};
    let received=next(browser.ws);relay(control);assert.equal((await received).generation,4);
    received=next(browser.ws);relay({type:'ready',epoch:1});await received;
    const base={transferId:'offer-1',requestId:'request-1'};
    for(const frame of [
      {type:'controlTargets',requestId:'targets-1',items:[{connectionId:'local-1',deviceId:null,local:true,label:'do not relay this',token:'hidden',cwd:'private'},
        {connectionId:'remote-1',deviceId:'device-1',local:false,token:'hidden'}]},
      {type:'controlOffer',...base,expiresAt:Date.now()+60_000,projectId:'project-1',profileId:'default',fromDeviceId:null},
      {type:'transferPending',...base,expiresAt:Date.now()+60_000,targetConnectionId:'remote-1',generation:5},
      {type:'transferAccepted',...base},{type:'transferCompleted',...base},
      {type:'transferEnded',...base,status:'unknown',reason:'Cancelled'}]) {
      received=next(browser.ws);relay({...frame,token:'private-control-token',baseline:{files:{secret:'private'}}});
      const result=await received;
      assert.equal(result.type,frame.type);
      assert.equal(JSON.stringify(result).includes('private'),false);
      assert.equal(JSON.stringify(result).includes('hidden'),false);
      if(frame.type==='controlTargets')assert.deepEqual(result.items,[
        {connectionId:'local-1',deviceId:null,local:true,label:'这台电脑'},
        {connectionId:'remote-1',deviceId:'device-1',local:false}]);
    }
    received=next(browser.ws);relay(control);await received;
    const forwarded=next(node.ws);browser.ws.send(JSON.stringify({v:1,type:'transfer-control',targetConnectionId:'remote-1',expectedGeneration:4}));await forwarded;
    const observed=[];browser.ws.on('message',raw=>observed.push(JSON.parse(raw.toString())));
    relay(control); // A delayed ownership update from before the transfer.
    received=next(browser.ws);relay({type:'ready',epoch:2});await received;
    assert.equal(observed.some(f=>f.type==='control'&&f.owned),false);
    const denied=next(browser.ws),gone=closed(browser.ws);
    browser.ws.send(JSON.stringify({v:1,type:'input',epoch:2,seq:1,data:'YQ=='}));
    assert.equal((await denied).code,'INPUT_STALE');await gone;
  } finally {await x.close();}
});

test('rejected transfer mutations close the frozen attachment and require a fresh ticket', async () => {
  const x=await fixture();
  try {
    const account=await x.register('transferreject'),node=await x.node(account);
    const enrolled=await x.call('POST','/api/terminal/devices',{label:'Transfer test'},{cookie:account.cookie});
    const cookie=`${account.cookie}; ${enrolled.cookie}`;
    await x.call('POST','/api/node/terminal/grants',{action:'grant',deviceId:enrolled.data.deviceId,profileId:'default',
      scopes:['view','input','takeover'],confirmationCode:enrolled.data.confirmationCode},{bearer:node.token});
    for (const action of [
      {type:'transfer-control',targetConnectionId:'gone',expectedGeneration:4,requestId:'rejected-begin'},
      {type:'accept-control',transferId:'stale',requestId:'rejected-accept'},
      {type:'cancel-transfer',transferId:'stale',requestId:'rejected-cancel'}]) {
      const ticket=await x.call('POST','/api/terminal/tickets',{nodeId:node.nodeId,profileId:'default',scope:'control'},{cookie});
      const browser=await x.browser(ticket.data.ticket,cookie);await browser.response;
      const relay=frame=>node.ws.send(JSON.stringify({type:'terminal',v:1,connectionId:ticket.data.connectionId,frame:{v:1,...frame}}));
      const forwarded=next(node.ws);browser.ws.send(JSON.stringify({v:1,...action}));await forwarded;
      const rejected=next(browser.ws),gone=closed(browser.ws),nodeClosed=next(node.ws);
      relay({type:'error',code:'CONTROL_STALE',message:'Transfer not started'});
      assert.equal((await rejected).code,'CONTROL_STALE');assert.equal(await gone,4003);
      assert.equal((await nodeClosed).type,'terminal-close');
      const resume=await x.call('POST','/api/terminal/tickets',{nodeId:node.nodeId,profileId:'default',scope:'control',resumeConnectionId:ticket.data.connectionId},{cookie});
      assert.equal(resume.status,409);
      const fresh=await x.call('POST','/api/terminal/tickets',{nodeId:node.nodeId,profileId:'default',scope:'control'},{cookie});
      assert.equal(fresh.status,200);assert.notEqual(fresh.data.connectionId,ticket.data.connectionId);
    }
  } finally {await x.close();}
});

test('status exposes only approved node profiles for the current device', async () => {
  const x = await fixture();
  try {
    const account = await x.register('terminalmetadata');
    const node = await x.node(account, [{ id: 'default', label: 'Approved' }, { id: 'private', label: 'Private profile' }]);
    const noDevice = await x.call('GET', '/api/terminal/status', undefined, { cookie: account.cookie });
    assert.deepEqual(noDevice.data.nodes, []);
    const enrolled = await x.call('POST', '/api/terminal/devices', { label: 'Phone' }, { cookie: account.cookie });
    const cookies = `${account.cookie}; ${enrolled.cookie}`;
    const pending = await x.call('GET', '/api/terminal/status', undefined, { cookie: cookies });
    assert.deepEqual(pending.data.nodes, []);
    assert.deepEqual(pending.data.grants, []);
    await x.call('POST', '/api/node/terminal/grants', { action: 'grant', deviceId: enrolled.data.deviceId,
      profileId: 'default', scopes: ['view'], confirmationCode: enrolled.data.confirmationCode }, { bearer: node.token });
    const approved = await x.call('GET', '/api/terminal/status', undefined, { cookie: cookies });
    assert.deepEqual(approved.data.nodes, [{ nodeId: node.nodeId, profiles: [{ id: 'default', label: 'Approved' }] }]);
    assert.equal(approved.data.device.status, 'approved');
    await x.call('POST', '/api/node/terminal/grants', { action: 'revoke', deviceId: enrolled.data.deviceId,
      profileId: 'default' }, { bearer: node.token });
    assert.deepEqual((await x.call('GET', '/api/terminal/status', undefined, { cookie: cookies })).data.nodes, []);
    node.ws.close();
  } finally { await x.close(); }
});

test('replaced browser socket cannot relay after a resume takes its connection', async () => {
  const x = await fixture();
  const originalClose = WebSocket.prototype.close;
  const held = [];
  try {
    const account = await x.register('terminalreplaced'); const node = await x.node(account);
    const enrolled = await x.call('POST', '/api/terminal/devices', { label: 'Phone' }, { cookie: account.cookie });
    const cookies = `${account.cookie}; ${enrolled.cookie}`;
    await x.call('POST', '/api/node/terminal/grants', { action: 'grant', deviceId: enrolled.data.deviceId,
      profileId: 'default', scopes: ['view'], confirmationCode: enrolled.data.confirmationCode }, { bearer: node.token });
    const ticket = await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default', scope: 'view' }, { cookie: cookies });
    const first = await x.browser(ticket.data.ticket, cookies); await first.response;
    WebSocket.prototype.close = function(code, reason) {
      if (code === 4001 && reason === 'Connection replaced') { held.push(this); return; }
      return originalClose.call(this, code, reason);
    };
    const resumedTicket = await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'default',
      scope: 'view', resumeConnectionId: ticket.data.connectionId }, { cookie: cookies });
    const second = await x.browser(resumedTicket.data.ticket, cookies); await second.response;
    assert.equal(held.length, 1);
    const relayed = [];
    const capture = data => relayed.push(JSON.parse(data.toString()));
    node.ws.on('message', capture);
    const oldError = next(first.ws);
    first.ws.send(JSON.stringify({ type: 'list', v: 1, requestId: 'old-socket' }));
    assert.equal((await oldError).code, 'CONNECTION_CHANGED');
    await closed(first.ws);
    assert.equal(relayed.some(frame => frame.frame?.requestId === 'old-socket'), false);
    node.ws.off('message', capture);
    second.ws.close(); node.ws.close();
  } finally { WebSocket.prototype.close = originalClose; for (const ws of held) originalClose.call(ws); await x.close(); }
});

test('silent WebSocket peer is disconnected after bounded ping timeout', async () => {
  const x = await fixture({ heartbeatIntervalMs: 30 });
  try {
    const account = await x.register('terminalheartbeat');
    const node = await x.node(account);
    node.ws.pong = () => {};
    await closed(node.ws);
  } finally { await x.close(); }
});

test('node ready omits account identity for a legacy tenant with no account binding', async () => {
  const x = await fixture();
  try {
    const bootstrap = x.store.bootstrap('legacy-terminal-tenant');
    const ownerToken = (await readFile(bootstrap.tokenPath, 'utf8')).trim();
    const pairing = x.store.createPairing(x.store.authenticate(ownerToken), { role: 'node', projectIds: ['test'] });
    const node = x.store.redeem(pairing.code);
    const socket = new WebSocket(x.origin.replace('http:', 'ws:') + '/api/terminal/node');
    await opened(socket);
    const reply = next(socket);
    socket.send(JSON.stringify({ type: 'auth', v: 1, nodeId: node.nodeId, token: node.token }));
    assert.equal(Object.hasOwn(await reply, 'ownerUserId'), false);
    socket.close();
  } finally { await x.close(); }
});

test('createHub serves terminal and board routes together and closes live WSS connections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-hub-network-'));
  const hub = await createHub({ dataDir: join(root, 'hub'), host: '127.0.0.1', port: 0 });
  let shutdown = false;
  const call = async (method, path, body, { cookie = '', bearer = '', origin = hub.url } = {}) => {
    const response = await fetch(hub.url + path, { method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    const registered = await call('POST', '/api/auth/register', { username: 'realhubterminal', password: 'correct horse long' });
    assert.equal(registered.status, 200);
    assert.equal((await call('GET', '/api/state', undefined, { cookie: registered.cookie })).status, 200);
    assert.equal((await call('GET', '/api/terminal/status', undefined, { cookie: registered.cookie })).data.device, null);
    const pairing = await call('POST', '/api/auth/node-pairing', { username: 'realhubterminal', password: 'correct horse long', projectIds: ['p1'] });
    assert.equal(pairing.status, 200);
    const redeemed = await call('POST', '/api/pairings/redeem', { code: pairing.data.code });
    assert.equal(redeemed.status, 200);
    const node = new WebSocket(hub.url.replace('http:', 'ws:') + '/api/terminal/node');
    await opened(node);
    const nodeReady = next(node);
    node.send(JSON.stringify({ type: 'auth', v: 1, nodeId: redeemed.data.nodeId, token: redeemed.data.token }));
    const nodeIdentity = await nodeReady;
    assert.equal(nodeIdentity.type, 'ready');
    assert.equal(nodeIdentity.ownerUserId, registered.data.user.id);
    const enrolled = await call('POST', '/api/terminal/devices', { label: 'Real browser' }, { cookie: registered.cookie });
    assert.equal(enrolled.status, 200);
    const cookies = `${registered.cookie}; ${enrolled.cookie}`;
    assert.equal((await call('POST', '/api/terminal/tickets', { nodeId: redeemed.data.nodeId, profileId: 'default', scope: 'view' }, { cookie: cookies })).status, 403);
    const granted = await call('POST', '/api/node/terminal/grants', { action: 'grant', deviceId: enrolled.data.deviceId,
      profileId: 'default', scopes: ['view', 'input'], confirmationCode: enrolled.data.confirmationCode }, { bearer: redeemed.data.token });
    assert.equal(granted.status, 200);
    const ticket = await call('POST', '/api/terminal/tickets', { nodeId: redeemed.data.nodeId, profileId: 'default', scope: 'control' }, { cookie: cookies });
    assert.equal(ticket.status, 200);
    const browser = new WebSocket(hub.url.replace('http:', 'ws:') + '/api/terminal/ws', { headers: { Cookie: cookies, Origin: hub.url } });
    await opened(browser);
    const authorized = next(browser);
    browser.send(JSON.stringify({ type: 'auth', v: 1, ticket: ticket.data.ticket }));
    assert.equal((await authorized).type, 'authenticated');
    const forwarded = next(node);
    browser.send(JSON.stringify({ type: 'list', v: 1, requestId: 'list-1' }));
    assert.equal((await forwarded).frame.type, 'list');
    const invalidOrigin = new WebSocket(hub.url.replace('http:', 'ws:') + '/api/terminal/ws',
      { headers: { Cookie: cookies, Origin: 'https://evil.example' } });
    await assert.rejects(opened(invalidOrigin));
    const invalidHost = new WebSocket(hub.url.replace('http:', 'ws:') + '/api/terminal/ws',
      { headers: { Cookie: cookies, Origin: hub.url, Host: 'evil.example' } });
    await assert.rejects(opened(invalidHost));
    const unauthenticated = new WebSocket(hub.url.replace('http:', 'ws:') + '/api/terminal/ws',
      { headers: { Cookie: cookies, Origin: hub.url } });
    await opened(unauthenticated);
    const browserClosed = closed(browser), nodeClosed = closed(node), unauthenticatedClosed = closed(unauthenticated);
    let timer;
    try {
      await Promise.race([Promise.all([hub.close(), browserClosed, nodeClosed, unauthenticatedClosed]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Hub close hung with WSS clients')), 3000); })]);
    } finally { clearTimeout(timer); }
    shutdown = true;
    assert.equal(browser.readyState, WebSocket.CLOSED);
    assert.equal(node.readyState, WebSocket.CLOSED);
  } finally {
    if (!shutdown) await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});
