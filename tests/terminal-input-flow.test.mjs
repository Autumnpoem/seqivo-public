import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { HubStore } from '../server/hub/store.mjs';
import { AccountService } from '../server/hub/accounts.mjs';
import { createTerminalHub } from '../server/hub/terminal.mjs';
import { createTerminalNodeLink } from '../server/terminal/node-link.mjs';

const waitFor = async (check, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('isolated terminal condition timed out');
};
const open = ws => new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

test('new node falls back to old Hub terminal frames without retiring the shared link', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/api/terminal/node' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const received = [], frames = [], closedConnections = [], postBarrierCurrent = [];
  let legacySocket = null, releaseInputs;
  const blockedInputs = new Promise(resolve => { releaseInputs = resolve; });
  wss.on('connection', socket => {
    legacySocket = socket;
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      received.push(frame);
      if (frame.type === 'auth') socket.send(JSON.stringify({ type: 'ready', v: 1, nodeId: 'legacy-node', epoch: 1 }));
    });
  });
  const manager = {
    profiles: () => [{ id: 'default', label: 'Terminal' }],
    bindOwner: async () => {}, closeRemote: async () => {},
    closeConnection: async connectionId => { closedConnections.push(connectionId); },
    disconnect: () => {},
    frame: async (ctx, frame) => {
      frames.push({ connectionId: ctx.connectionId, type: frame.type });
      if (frame.type === 'input') { await blockedInputs; postBarrierCurrent.push(ctx.isCurrent()); }
    },
  };
  const link = createTerminalNodeLink({ manager, credentials: () => ({ url: origin,
    token: 'isolated-test-token', nodeId: 'legacy-node', epoch: 1 }) });
  let testError;
  try {
    await link.refresh();
    await waitFor(() => link.state().status === 'online' && legacySocket);
    const send = (connectionId, frame) => legacySocket.send(JSON.stringify({ type: 'terminal', v: 1,
      nodeEpoch: 1, connectionId, deviceId: 'device', userId: 'user', profileId: 'default',
      grantRevision: 1, frame }));
    for (let seq = 0; seq < 33; seq++) send('first', { type: 'input', v: 1, epoch: 1, seq, data: 'eA==' });
    await waitFor(() => received.some(frame => frame.type === 'terminal' && frame.connectionId === 'first' && frame.frame.type === 'exit'));
    assert.equal(legacySocket.readyState, WebSocket.OPEN);
    assert.equal(received.some(frame => frame.type === 'terminal-attachment-close'), false, 'old Hub cannot parse the new top-level event');
    send('second', { type: 'open', v: 1 });
    await waitFor(() => frames.some(frame => frame.connectionId === 'second' && frame.type === 'open'));
    assert.ok(closedConnections.includes('first'));
    assert.ok(!closedConnections.includes('second'));
    releaseInputs();
    await waitFor(() => postBarrierCurrent.length === 32);
    assert.ok(postBarrierCurrent.every(value => value === false));
  } catch (error) { testError = error; }
  const cleanupErrors = [];
  releaseInputs();
  for (const cleanup of [() => link.close(), () => new Promise((resolve, reject) => wss.close(error => error ? reject(error) : resolve())),
    () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))]) {
    try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
  }
  if (testError || cleanupErrors.length) throw new AggregateError([...(testError ? [testError] : []), ...cleanupErrors], 'old-Hub fallback or cleanup failed');
});
const next = ws => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('isolated frame timed out')), 3000);
  ws.once('message', data => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
});

test('one fast input burst cannot retire the node and another connection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-input-flow-'));
  const store = new HubStore(join(root, 'hub'));
  const accounts = new AccountService(store);
  const hub = createTerminalHub({ store, accounts });
  const hosts = new Set(), origins = new Set();
  const server = createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const path = new URL(req.url, 'http://localhost').pathname;
      if (!hub.handleHttp({ req, res, method: req.method, path, body: raw ? JSON.parse(raw) : {}, send }))
        send(404, { code: 'NOT_FOUND' });
    } catch (error) { send(error.status || 500, { code: error.code || 'ERROR' }); }
  });
  hub.attachServer(server, { allowedHosts: hosts, allowedOrigins: origins });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  hosts.add(new URL(origin).host); origins.add(origin);
  const account = await accounts.register({ username: 'burstowner', password: 'correct horse long', source: 'test' });
  const subject = store.db.prepare('SELECT * FROM subjects WHERE id=(SELECT owner_subject_id FROM account_users WHERE id=?)').get(account.user.id);
  const pairing = store.createPairing(subject, { role: 'node', projectIds: ['test'] });
  const node = store.redeem(pairing.code);
  const managerFrames = [], postBarrierCurrent = [], closedConnections = [];
  let releaseInputs;
  const blockedInputs = new Promise(resolve => { releaseInputs = resolve; });
  const manager = {
    profiles: () => [{ id: 'default', label: 'Terminal' }],
    bindOwner: async () => {}, closeRemote: async () => {},
    closeConnection: async connectionId => { closedConnections.push(connectionId); },
    disconnect: () => {},
    frame: async (ctx, frame, send) => {
      managerFrames.push(frame.type);
      if (frame.type === 'open') { send({ type: 'ready', v: 1, epoch: 1 }); return; }
      if (frame.type === 'input') { await blockedInputs; postBarrierCurrent.push(ctx.isCurrent()); }
    },
  };
  const link = createTerminalNodeLink({ manager, credentials: () => ({
    url: origin, token: node.token, nodeId: node.nodeId, epoch: node.epoch,
  }) });
  const sockets = [];
  const originalEmit = WebSocket.prototype.emit;
  let nodeClose = null;
  WebSocket.prototype.emit = function (event, ...args) {
    if (event === 'close' && this.url?.endsWith('/api/terminal/node'))
      nodeClose = { code: args[0], reason: args[1]?.toString() || '' };
    return originalEmit.call(this, event, ...args);
  };
  const call = async (path, body, { cookie = '', bearer = '' } = {}) => {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      Origin: origin, 'Content-Type': 'application/json',
    }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  let testError;
  try {
    await link.refresh();
    await waitFor(() => link.state().status === 'online');
    const userCookie = `hub_session=${account.sessionToken}`;
    const device = await call('/api/terminal/devices', { label: 'Phone' }, { cookie: userCookie });
    assert.equal(device.status, 200);
    const cookie = `${userCookie}; ${device.cookie}`;
    const grant = await call('/api/node/terminal/grants', {
      action: 'grant', deviceId: device.data.deviceId, profileId: 'default',
      scopes: ['view', 'input'], confirmationCode: device.data.confirmationCode,
    }, { bearer: node.token });
    assert.equal(grant.status, 200);
    const browser = async () => {
      const ticket = await call('/api/terminal/tickets', {
        nodeId: node.nodeId, profileId: 'default', scope: 'control',
      }, { cookie });
      assert.equal(ticket.status, 200);
      const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/api/terminal/ws`, {
        headers: { Cookie: cookie, Origin: origin },
      });
      sockets.push(ws);
      await open(ws);
      const authenticated = next(ws);
      ws.send(JSON.stringify({ type: 'auth', v: 1, ticket: ticket.data.ticket }));
      assert.equal((await authenticated).type, 'authenticated');
      const ready = next(ws);
      ws.send(JSON.stringify({ type: 'open', v: 1, mode: 'tmux', cols: 80, rows: 24 }));
      assert.equal((await ready).type, 'ready');
      return { ws, connectionId: ticket.data.connectionId };
    };
    const first = await browser(), second = await browser();
    let other = null;
    second.ws.once('close', (code, reason) => { other = { code, reason: reason.toString() }; });
    const firstClose = new Promise(resolve => first.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    for (let seq = 0; seq < 33; seq++) first.ws.send(JSON.stringify({
      type: 'input', v: 1, epoch: 1, seq, data: Buffer.from('x').toString('base64'),
    }));
    await waitFor(() => managerFrames.filter(type => type === 'input').length >= 32);
    const overloaded = await firstClose;
    assert.equal(overloaded.code, 4003, 'only the overloaded browser attachment must close');
    await new Promise(resolve => setTimeout(resolve, 100));
    const ticketAfter = await call('/api/terminal/tickets', {
      nodeId: node.nodeId, profileId: 'default', scope: 'control',
    }, { cookie });
    t.diagnostic(JSON.stringify({ nodeClose, other, ticketAfter: {
      status: ticketAfter.status, code: ticketAfter.data.code,
    }, receivedInputs: managerFrames.filter(type => type === 'input').length }));
    assert.equal(nodeClose, null, 'overload of one connection must not close the node');
    assert.equal(other, null, 'the second connection must remain open');
    assert.equal(second.ws.readyState, WebSocket.OPEN);
    assert.equal(ticketAfter.status, 200, 'new tickets for unaffected connections must remain available');
    releaseInputs();
    await waitFor(() => postBarrierCurrent.length === 32);
    assert.ok(postBarrierCurrent.every(value => value === false), 'queued writes must lose the original attachment identity');
    assert.ok(closedConnections.includes(first.connectionId), 'the overloaded attachment must be closed');
    assert.ok(!closedConnections.includes(second.connectionId), 'the unaffected attachment must stay open');
  } catch (error) { testError = error; }
  const cleanupErrors = [];
  try {
    releaseInputs();
    WebSocket.prototype.emit = originalEmit;
    for (const ws of sockets) ws.terminate();
  } catch (error) { cleanupErrors.push(error); }
  for (const cleanup of [() => link.close(), () => hub.close(), () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    () => store.close(), () => rm(root, { recursive: true, force: true })]) {
    try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
  }
  if (testError || cleanupErrors.length) throw new AggregateError([...(testError ? [testError] : []), ...cleanupErrors], 'terminal input flow or cleanup failed');
});
