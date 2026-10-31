import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { createCore } from '../server/core.mjs';
import { startHttp } from '../server/http.mjs';
import { createHub } from '../server/hub/http.mjs';
import { createTmuxAdapter } from '../server/terminal/tmux.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(25); }
  throw new Error('Transfer integration condition timed out');
}
async function socket(url, origin, ticket, cookie = '') {
  const ws = new WebSocket(url, { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
  const frames = [];
  ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
  await new Promise((done, fail) => { ws.once('open', done); ws.once('error', fail); });
  const result = { ws, frames, send: frame => ws.send(JSON.stringify({ v: 1, ...frame })),
    async wait(predicate, after = 0) {
      await until(() => frames.slice(after).some(predicate)).catch(error => {
        throw new Error(`${error.message}: ${JSON.stringify(frames.slice(-6).map(({type,code,phase,message,reason})=>({type,code,phase,message,reason})))}`);
      });
      return frames.slice(after).find(predicate);
    } };
  result.send({ type: 'auth', ticket }); await result.wait(f => f.type === 'authenticated');
  return result;
}

test('real Core and Hub transfer tmux from owner to phone and back without changing pane or enabling AI', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS writer inspection required'); return; }
  const tmux = process.env.TMUX_PATH || resolve('.tools/terminal-build/install/bin/tmux');
  try { accessSync(tmux, constants.X_OK); } catch { t.skip('real tmux unavailable'); return; }
  const root = await mkdtemp(join(tmpdir(), 'seqivo-transfer-live-')), workspace = join(root, 'workspace');
  await mkdir(workspace);
  const serverName = `seqivo_transfer_${process.pid}_${randomBytes(4).toString('hex')}`;
  const core = await createCore({ dataDir: join(root, 'core'), pluginDir: join(root, 'plugins'), files: false });
  const http = await startHttp({ core, dataDir: join(root, 'core'), distDir: root, port: 0 });
  const hub = await createHub({ dataDir: join(root, 'hub'), port: 0 });
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) s.ws.terminate();
    await http.close(); await core.close(); await hub.close();
    try { execFileSync(tmux, ['-L', serverName, 'kill-server'], { stdio: 'ignore', timeout: 5000 }); } catch { /* Only this test-owned server. */ }
    await rm(root, { recursive: true, force: true });
  });
  const project = core.store.project({ name: 'Disposable handover', directory: workspace });
  // No fake bound conversation: this test has no AI executor to retire.
  // The real scheduler's availability gate accepts unbound planned tasks,
  // so a true→false transition specifically observes human control fencing.
  const task = core.store.createTask({ projectId: project.id, title: 'AI scheduling eligibility probe' });
  assert.equal(core.leases.available({ taskId: task.id }), true);
  const assertAiFenced = () => {
    assert.equal(core.leases.available({ taskId: task.id }), false, 'human control prevents the scheduler from starting this workspace');
    assert.equal(core.leases.state().active.length, 0, 'the check never starts or reserves an AI execution');
  };
  await core.request('POST', '/api/terminal/profiles', { id: 'default', label: 'Disposable tmux',
    projectId: project.id, enabled: true, serverName, allowSharedServer: true, tmuxExecutable: tmux });
  const account = await hub.accounts.register({ username: 'transfer_live', password: 'Local-test-password-239', source: 'isolated' });
  const accountCookie = `hub_session=${account.sessionToken}`;
  const call = async (method, path, body, cookie = accountCookie) => {
    const response = await fetch(hub.url + path, { method, headers: { Origin: hub.url, Cookie: cookie,
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  await core.remote.login({ url: hub.url, username: 'transfer_live', password: 'Local-test-password-239', projectIds: [project.id] });
  await until(async () => (await core.request('GET', '/api/terminal/status')).link.status === 'online');
  const nodeId = core.remote.state().nodeId;
  const enrolled = await call('POST', '/api/terminal/devices', { label: 'Disposable phone' });
  assert.equal(enrolled.status, 200);
  await core.request('POST', '/api/terminal/grants', { deviceId: enrolled.data.deviceId, profileId: 'default',
    scopes: ['view', 'input', 'create', 'default', 'takeover'], confirmationCode: enrolled.data.confirmationCode });
  const phoneCookie = `${accountCookie}; ${enrolled.cookie}`;
  const ownerTicket = await core.request('POST', '/api/terminal/tickets', { profileId: 'default' });
  const owner = await socket(ownerTicket.wsUrl, `http://127.0.0.1:${http.port}`, ownerTicket.ticket); sockets.push(owner);
  owner.send({ type: 'open', mode: 'tmux', readOnly: false, cols: 80, rows: 24 });
  await owner.wait(f => f.type === 'sessions');
  owner.send({ type: 'takeover' }); await owner.wait(f => f.type === 'control' && f.phase === 'human' && f.owned);
  owner.send({ type: 'create', epoch: 0, name: 'A' });
  const initialReady = await owner.wait(f => f.type === 'ready');
  const a = initialReady.sessionRef, adapter = createTmuxAdapter({ executable: tmux, serverName });
  const initialPid = (await adapter.sessionPanes(a))[0].pid;
  const phoneTicket = await call('POST', '/api/terminal/tickets', { nodeId, profileId: 'default', scope: 'control' }, phoneCookie);
  assert.equal(phoneTicket.status, 200);
  let phone = await socket(hub.url.replace(/^http/, 'ws') + '/api/terminal/ws', hub.url, phoneTicket.data.ticket, phoneCookie); sockets.push(phone);
  phone.send({ type: 'open', mode: 'tmux', readOnly: false, cols: 80, rows: 24 });
  await phone.wait(f => f.type === 'sessions');
  owner.send({ type: 'list-control-targets', requestId: 'list-first' });
  const targets = await owner.wait(f => f.type === 'controlTargets' && f.requestId === 'list-first');
  assert.ok(targets.items.some(item => item.connectionId === phoneTicket.data.connectionId));
  const generation = owner.frames.filter(f => f.type === 'control' && f.phase === 'human').at(-1).generation;
  owner.send({ type: 'transfer-control', targetConnectionId: phoneTicket.data.connectionId, expectedGeneration: generation, requestId: 'move-first' });
  const offer = await phone.wait(f => f.type === 'controlOffer');
  await owner.wait(f => f.type === 'transferPending');
  assert.equal(JSON.parse(core.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.control.v1').value).entries[project.id].phase, 'transfer_pending');
  assertAiFenced();
  owner.send({ type: 'input', epoch: initialReady.epoch, seq: 0, data: Buffer.from('printf BAD > forbidden.txt\r').toString('base64') });
  await owner.wait(f => f.code === 'CONTROL_REQUIRED');
  phone.send({ type: 'accept-control', transferId: offer.transferId, requestId: 'accept-first' });
  const accepted = await phone.wait(f => f.type === 'transferAccepted');
  await phone.wait(f => f.type === 'control' && f.phase === 'human' && f.owned && f.generation > generation);
  assert.ok(phone.frames.indexOf(accepted) < phone.frames.findIndex(f => f.type === 'control' && f.owned));
  phone.send({ type: 'select', epoch: 0, sessionRef: a });
  const phoneReady = await phone.wait(f => f.type === 'ready');
  phone.send({ type: 'input', epoch: phoneReady.epoch, seq: 0, data: Buffer.from('printf PHONE > transfer.txt\r').toString('base64') });
  await phone.wait(f => f.type === 'inputAck' && f.seq === 0);
  await until(async () => { try { return await readFile(join(workspace, 'transfer.txt'), 'utf8') === 'PHONE'; } catch { return false; } });
  assert.equal((await adapter.sessionPanes(a))[0].pid, initialPid);
  phone.send({ type: 'create', epoch: phoneReady.epoch, name: 'B' });
  const bReady = await phone.wait(f => f.type === 'ready' && f.epoch > phoneReady.epoch);
  const b = bReady.sessionRef;
  phone.send({ type: 'default', sessionRef: b, expectedRevision: 0, requestId: 'set-b-default' });
  await phone.wait(f => f.type === 'sessions' && f.requestId === 'set-b-default' && f.defaultRevision === 1);
  phone.send({ type: 'input', epoch: bReady.epoch, seq: 0, data: Buffer.from('exit\r').toString('base64') });
  await phone.wait(f => f.type === 'inputAck' && f.epoch === bReady.epoch && f.seq === 0);
  await phone.wait(f => f.type === 'exit' && f.reason === 'process_exited' && f.epoch === bReady.epoch);
  await until(async () => !(await adapter.list()).sessions.some(item => item.sessionRef.sessionId === b.sessionId));
  phone.send({ type: 'detach', epoch: bReady.epoch, requestId: 'leave-ended-b' });
  await phone.wait(f => f.type === 'exit' && f.reason === 'detached' && f.requestId === 'leave-ended-b');
  await until(() => phone.ws.readyState === WebSocket.CLOSED);
  const renewedTicket = await call('POST', '/api/terminal/tickets', { nodeId, profileId: 'default', scope: 'control' }, phoneCookie);
  assert.equal(renewedTicket.status, 200);
  phone = await socket(hub.url.replace(/^http/, 'ws') + '/api/terminal/ws', hub.url, renewedTicket.data.ticket, phoneCookie); sockets.push(phone);
  phone.send({ type: 'open', mode: 'tmux', readOnly: false, cols: 80, rows: 24 });
  const unavailable = await phone.wait(f => f.type === 'sessions' && f.defaultAvailable === false);
  assert.deepEqual(unavailable.items.map(item => item.sessionRef.sessionId), [a.sessionId]);
  assert.deepEqual(unavailable.defaultRef, b);
  assert.equal((await phone.wait(f => f.type === 'control' && f.phase === 'human')).owned, false,
    'an expired default cannot silently reclaim the old controller');
  phone.send({ type: 'select', epoch: 0, sessionRef: a, requestId: 'recover-a' });
  let recoveredReady;
  try { recoveredReady = await phone.wait(f => f.type === 'ready' && f.sessionRef?.sessionId === a.sessionId); }
  catch (error) {
    const entry = JSON.parse(core.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.control.v1').value).entries[project.id];
    throw new Error(`${error.message}; persistedControl=${JSON.stringify({ phase: entry.phase, reason: entry.reason, generation: entry.generation })}`);
  }
  const recoveredControl = await phone.wait(f => f.type === 'control' && f.phase === 'human' && f.owned === true);
  assert.ok(recoveredControl.generation > generation, 'explicit A selection reports the newly proved ownership');
  phone.send({ type: 'input', epoch: recoveredReady.epoch, seq: 0,
    data: Buffer.from('printf RETURN >> transfer.txt\r').toString('base64') });
  await phone.wait(f => f.type === 'inputAck' && f.epoch === recoveredReady.epoch && f.seq === 0);
  await until(async () => await readFile(join(workspace, 'transfer.txt'), 'utf8') === 'PHONERETURN');
  assert.equal((await adapter.sessionPanes(a))[0].pid, initialPid);
  const backTicket = await core.request('POST', '/api/terminal/tickets', { profileId: 'default' });
  const back = await socket(backTicket.wsUrl, `http://127.0.0.1:${http.port}`, backTicket.ticket); sockets.push(back);
  back.send({ type: 'open', mode: 'tmux', readOnly: false, cols: 80, rows: 24 }); await back.wait(f => f.type === 'sessions');
  phone.send({ type: 'list-control-targets', requestId: 'list-back' });
  const backTargets = await phone.wait(f => f.type === 'controlTargets' && f.requestId === 'list-back');
  assert.ok(backTargets.items.some(item => item.connectionId === backTicket.connectionId && item.local === true));
  const phoneGeneration = phone.frames.filter(f => f.type === 'control' && f.owned).at(-1).generation;
  phone.send({ type: 'transfer-control', targetConnectionId: backTicket.connectionId, expectedGeneration: phoneGeneration, requestId: 'move-back' });
  const backOffer = await back.wait(f => f.type === 'controlOffer');
  await phone.wait(f => f.type === 'transferPending' && f.requestId === 'move-back');
  back.send({ type: 'accept-control', transferId: backOffer.transferId });
  await back.wait(f => f.type === 'control' && f.owned && f.generation > phoneGeneration);
  back.send({ type: 'select', epoch: 0, sessionRef: a }); const backReady = await back.wait(f => f.type === 'ready');
  back.send({ type: 'input', epoch: backReady.epoch, seq: 0, data: Buffer.from('printf MAC >> transfer.txt\r').toString('base64') });
  await until(async () => await readFile(join(workspace, 'transfer.txt'), 'utf8') === 'PHONERETURNMAC');
  assert.equal((await adapter.sessionPanes(a))[0].pid, initialPid);
  assertAiFenced();
  await assert.rejects(readFile(join(workspace, 'forbidden.txt')), { code: 'ENOENT' });
  phone.send({ type: 'input', epoch: recoveredReady.epoch, seq: 1, data: Buffer.from('printf BAD > forbidden.txt\r').toString('base64') });
  await phone.wait(f => f.code === 'INPUT_STALE');
  await assert.rejects(readFile(join(workspace, 'forbidden.txt')), { code: 'ENOENT' });
});
