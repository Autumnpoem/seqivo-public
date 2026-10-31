import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { HubStore } from '../server/hub/store.mjs';
import { AccountService } from '../server/hub/accounts.mjs';
import { createTerminalHub } from '../server/hub/terminal.mjs';

const commands = [{ taskId: 'task_1', commandId: 'cmd:turn-1' }];

async function clientFixture() {
  const source = (await readFile(new URL('../src/terminal-client.ts', import.meta.url), 'utf8')).replace(
    "import {ApiError,request} from './api';",
    'class ApiError extends Error {}\nconst request=async()=>{throw Error("network disabled")};',
  );
  const compiled = stripTypeScriptTypes(source, { mode: 'transform' });
  const { TerminalClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  const sent = [], controls = [];
  class FakeSocket { static OPEN = 1; readyState = 1; send(raw) { sent.push(JSON.parse(raw)); } close() { this.readyState = 3; } }
  globalThis.WebSocket = FakeSocket;
  globalThis.window = { clearTimeout, setTimeout, location: { href: 'http://localhost/' } };
  const cb = new Proxy({ onControl: value => controls.push(value) }, { get: (obj, key) => obj[key] || (() => {}) });
  const client = new TerminalClient({ profileId: 'managed', mode: 'tmux', readOnly: false,
    ticketControl: true, inputAllowed: true, takeoverAllowed: true, projectId: null }, cb, () => ({ cols: 80, rows: 24 }));
  client.ws = new FakeSocket(); client.state = 'ready'; client.connectionId = 'fixture'; client.epoch = 1;
  return { client, sent, controls };
}

const next = ws => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { cleanup(); reject(new Error('WebSocket frame timeout')); }, 2000);
  function cleanup() { clearTimeout(timer); ws.off('message', message); ws.off('close', close); }
  function message(data) { cleanup(); resolve(JSON.parse(data.toString())); }
  function close(code) { cleanup(); reject(new Error(`WebSocket closed ${code}`)); }
  ws.once('message', message); ws.once('close', close);
});
const opened = ws => new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
async function hubFixture() {
  const root = await mkdtemp(join(tmpdir(), 'terminal-unknown-protocol-'));
  const store = new HubStore(join(root, 'hub'));
  const accounts = new AccountService(store);
  const terminal = createTerminalHub({ store, accounts });
  const hosts = new Set(), origins = new Set();
  const server = createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      let raw = ''; for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : {};
      if (!terminal.handleHttp({ req, res, method: req.method, path: new URL(req.url, 'http://localhost').pathname, body, send })) send(404, {});
    } catch (error) { send(error.status || 500, { code: error.code || 'ERROR' }); }
  });
  terminal.attachServer(server, { allowedHosts: hosts, allowedOrigins: origins });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`; hosts.add(new URL(origin).host); origins.add(origin);
  const call = async (method, path, body, { cookie = '', bearer = '' } = {}) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const register = async () => { const value = await accounts.register({ username: 'unknownowner', password: 'correct horse long', source: 'unknownowner' }); return { ...value, cookie: `hub_session=${value.sessionToken}` }; };
  const node = async (account, profiles = [{ id: 'managed', label: 'Managed' }]) => {
    const subject = store.db.prepare('SELECT * FROM subjects WHERE id=(SELECT owner_subject_id FROM account_users WHERE id=?)').get(account.user.id);
    const pairing = store.createPairing(subject, { role: 'node', projectIds: ['test'] }); const redeemed = store.redeem(pairing.code);
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/terminal/node'); await opened(ws);
    const response = next(ws); ws.send(JSON.stringify({ type: 'auth', v: 1, nodeId: redeemed.nodeId, token: redeemed.token,
      profiles })); assert.equal((await response).type, 'ready'); return { ...redeemed, ws };
  };
  const browser = async (ticket, cookie) => { const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/terminal/ws', { headers: { Cookie: cookie, Origin: origin } }); await opened(ws); const response = next(ws); ws.send(JSON.stringify({ type: 'auth', v: 1, ticket })); await response; return ws; };
  return { root, store, terminal, server, origin, call, register, node, browser,
    close: async () => { await terminal.close(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(root, { recursive: true, force: true }); } };
}

async function connectedHub({ scopes = ['view', 'input', 'takeover'], profiles } = {}) {
  const x = await hubFixture();
  const account = await x.register(); const node = await x.node(account, profiles);
  const device = await x.call('POST', '/api/terminal/devices', { label: 'Phone' }, { cookie: account.cookie });
  const grant = await x.call('POST', '/api/node/terminal/grants', { action: 'grant', deviceId: device.data.deviceId,
    profileId: 'managed', scopes, confirmationCode: device.data.confirmationCode }, { bearer: node.token });
  assert.equal(grant.status, 200);
  const ticket = await x.call('POST', '/api/terminal/tickets', { nodeId: node.nodeId, profileId: 'managed', scope: 'control' }, { cookie: `${account.cookie}; ${device.cookie}` });
  assert.equal(ticket.status, 200);
  const browser = await x.browser(ticket.data.ticket, `${account.cookie}; ${device.cookie}`);
  return { x, node, browser, ticket: ticket.data };
}

test('client sends exact unknown-command consent only on explicit takeover and normalizes control IDs', async () => {
  const { client, sent, controls } = await clientFixture();
  client.receive(JSON.stringify({ type: 'control', v: 1, managed: true, owned: false, phase: 'ai_ready', mode: 'managed', changes: [],
    unresolvedExecutions: commands }));
  assert.deepEqual(controls.at(-1).unresolvedExecutions, commands);
  assert.equal(client.requestTakeover([{ taskId: 'task_1', commandId: 'bad id' }]), false);
  assert.equal(client.requestTakeover([{ ...commands[0], token: 'must-not-be-accepted' }]), false);
  assert.equal(client.requestTakeover([{ taskId: 'task_2', commandId: 'cmd:turn-1' }]), false, 'intent must match the currently displayed IDs');
  assert.equal(client.requestTakeover([...commands, ...commands]), false);
  assert.equal(client.requestTakeover(Array.from({ length: 17 }, (_, i) => ({ taskId: `task_${i}`, commandId: `cmd:${i}` }))), false);
  assert.equal(sent.some(frame => frame.type === 'takeover'), false);
  assert.equal(client.requestTakeover(commands), true);
  assert.deepEqual(sent.at(-1), { v: 1, type: 'takeover', endUnknownCommands: commands });
  client.receive(JSON.stringify({ type: 'control', v: 1, managed: true, owned: false, phase: 'unknown', changes: [],
    unresolvedExecutions: [{ taskId: 'task_1', commandId: 'cmd:turn-1', token: 'must-not-escape' }] }));
  assert.deepEqual(controls.at(-1).unresolvedExecutions, commands);
  assert.equal(Object.hasOwn(controls.at(-1).unresolvedExecutions[0], 'token'), false);
  assert.equal(sent.filter(frame => frame.type === 'takeover').length, 1);
});

test('client preserves the original plain takeover frame when no disposition is selected', async () => {
  const { client, sent } = await clientFixture();
  client.receive(JSON.stringify({ type: 'control', v: 1, managed: true, owned: false, phase: 'ai_ready', mode: 'managed', changes: [], unresolvedExecutions: [] }));
  assert.equal(client.requestTakeover(), true);
  assert.deepEqual(sent.at(-1), { v: 1, type: 'takeover' });
});

test('Hub accepts the consent only on takeover and relays exact IDs without extra fields', async t => {
  const { x, node, browser, ticket } = await connectedHub();
  t.after(async () => { browser.close(); node.ws.close(); await x.close(); });
  const forwarded = next(node.ws);
  browser.send(JSON.stringify({ v: 1, type: 'takeover', endUnknownCommands: commands }));
  assert.deepEqual((await forwarded).frame, { v: 1, type: 'takeover', endUnknownCommands: commands });
  const control = next(browser);
  node.ws.send(JSON.stringify({ type: 'terminal', v: 1, connectionId: ticket.connectionId,
    frame: { type: 'control', v: 1, managed: true, owned: false, phase: 'unknown', reason: null, changes: [],
      unresolvedExecutions: [{ ...commands[0], token: 'secret' }] } }));
  assert.deepEqual((await control).unresolvedExecutions, commands);
});

test('Hub accepts an empty unresolved-executions list in ordinary control updates', async t => {
  const { x, node, browser, ticket } = await connectedHub();
  t.after(async () => { browser.close(); node.ws.close(); await x.close(); });
  const control = next(browser);
  node.ws.send(JSON.stringify({ type: 'terminal', v: 1, connectionId: ticket.connectionId,
    frame: { type: 'control', v: 1, managed: true, owned: false, phase: 'ai_ready', reason: null, changes: [], unresolvedExecutions: [] } }));
  assert.deepEqual((await control).unresolvedExecutions, []);
});

test('Hub rejects malformed, duplicate, over-limit, and non-takeover unknown dispositions', async t => {
  for (const intent of [
    { type: 'takeover', endUnknownCommands: [{ taskId: 'task_1', commandId: 'bad command' }] },
    { type: 'takeover', endUnknownCommands: [{ taskId: 'bad task', commandId: 'cmd:1' }] },
    { type: 'takeover', endUnknownCommands: [{ taskId: 'task_1', commandId: 'cmd:1', secret: 'reject' }] },
    { type: 'takeover', endUnknownCommands: [commands[0], commands[0]] },
    { type: 'takeover', endUnknownCommands: [{ taskId: 'task_1', commandId: 'a'.repeat(161) }] },
    { type: 'takeover', endUnknownCommands: Array.from({ length: 17 }, (_, i) => ({ taskId: `task_${i}`, commandId: `cmd:${i}` })) },
    { type: 'return', endUnknownCommands: commands },
  ]) {
    const { x, node, browser } = await connectedHub();
    t.after(async () => { node.ws.close(); await x.close(); });
    const rejected = next(browser);
    browser.send(JSON.stringify({ v: 1, ...intent }));
    assert.equal((await rejected).code, 'INVALID_FRAME');
    await new Promise(resolve => browser.once('close', resolve));
  }
});

test('Hub requires input and takeover grants and excludes WSL profiles from disposition', async t => {
  for (const options of [
    { scopes: ['view', 'takeover'] },
    { profiles: [{ id: 'managed', label: 'Managed', runtime: 'wsl' }] },
  ]) {
    const { x, node, browser } = await connectedHub(options);
    t.after(async () => { node.ws.close(); await x.close(); });
    const rejected = next(browser);
    browser.send(JSON.stringify({ v: 1, type: 'takeover', endUnknownCommands: commands }));
    const result = await rejected;
    assert.ok(['GRANT_REQUIRED', 'TAKEOVER_REQUIRED'].includes(result.code));
    await new Promise(resolve => browser.once('close', resolve));
  }
});
