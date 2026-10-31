import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

async function clientFixture() {
  const path = new URL('../src/terminal-client.ts', import.meta.url);
  const source = (await readFile(path, 'utf8')).replace(
    "import {ApiError,request} from './api';",
    'class ApiError extends Error {}\nconst request=async()=>{throw Error("network disabled in pure client fixture")};',
  );
  const compiled = stripTypeScriptTypes(source, { mode: 'transform' });
  const { TerminalClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  const notices = [], states = [], sent = [], controls = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    send(raw) { sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = FakeSocket;
  globalThis.window = { clearTimeout, setTimeout, location: { href: 'http://localhost/' } };
  const callbacks = new Proxy({ onNotice: message => notices.push(message), onState: (state, message) => states.push({ state, message }), onControl: control => controls.push(control) }, {
    get(target, property) { return target[property] || (() => {}); },
  });
  const client = new TerminalClient({ profileId: 'test', mode: 'tmux', readOnly: false,
    ticketControl: true, inputAllowed: true, takeoverAllowed: true, projectId: null },
  callbacks, () => ({ cols: 80, rows: 24 }));
  client.ws = new FakeSocket();
  client.state = 'ready';
  client.connectionId = 'fixture-connection';
  client.epoch = 1;
  return { client, sent, notices, states, controls };
}

test('input window admits fast keys without sending more than eight unacknowledged frames', async () => {
  const { client, sent } = await clientFixture();
  for (let index = 0; index < 40; index++) assert.equal(client.input('x'), true);
  assert.equal(sent.filter(frame => frame.type === 'input').length, 8);
  client.receive(JSON.stringify({ type: 'inputAck', v: 1, epoch: 1, seq: 999, status: 'written' }));
  client.receive(JSON.stringify({ type: 'inputAck', v: 1, epoch: 2, seq: 1, status: 'written' }));
  assert.equal(sent.filter(frame => frame.type === 'input').length, 8, 'invalid ACK cannot drain the queue');
  client.receive(JSON.stringify({ type: 'inputAck', v: 1, epoch: 1, seq: 1, status: 'written' }));
  assert.deepEqual(sent.filter(frame => frame.type === 'input').map(frame => frame.seq), [1,2,3,4,5,6,7,8,9]);
});

test('a recoverable unknown snapshot keeps input locked and explicit acquire waits for session selection', async () => {
  const {client,sent,states,controls}=await clientFixture();
  client.state='opening';
  client.receive(JSON.stringify({type:'control',v:1,managed:true,phase:'unknown',generation:9,
    mode:'managed',owned:false,canReconcileAcquire:true,authorizedSessionRefs:[],requiresSessionSelection:true,
    reason:'进程快照尚未核实'}));
  assert.equal(client.canInput,false);
  assert.equal(controls.at(-1).canReconcileAcquire,true);
  client.receive(JSON.stringify({type:'error',v:1,code:'CONTROL_REQUIRED',message:'请明确核对执行权'}));
  assert.equal(states.at(-1).state,'control_wait');
  assert.equal(client.reconcileControl('acquire'),true);
  const request=sent.find(frame=>frame.type==='reconcile-control');
  assert.equal(request.sessionRef,undefined);
  const ref={serverName:'test',instanceId:'a'.repeat(64),sessionId:'$1'};
  client.receive(JSON.stringify({type:'control',v:1,managed:true,phase:'human',generation:10,
    mode:'managed',owned:true,canReconcileAcquire:false,authorizedSessionRefs:[ref],requestId:request.requestId}));
  assert.equal(sent.some(frame=>frame.type==='open'||frame.type==='select'),false,'no default or original ref is autoattached');
  assert.equal(client.canInput,false);
  assert.equal(states.at(-1).state,'selecting');
});

test('switching attachments drops unsent input and late ACK cannot replay it', async () => {
  const { client, sent, notices } = await clientFixture();
  for (let index = 0; index < 40; index++) client.input('x');
  const before = sent.filter(frame => frame.type === 'input').length;
  client.select({ serverName: 'test', instanceId: 'a'.repeat(64), sessionId: '$1' });
  client.receive(JSON.stringify({ type: 'inputAck', v: 1, epoch: 1, seq: 1, status: 'written' }));
  assert.equal(sent.filter(frame => frame.type === 'input').length, before);
  assert.ok(notices.some(message => message.includes('未发送的输入已丢弃')));
});

test('capacity rejects one whole input callback without sending a prefix', async () => {
  const { client, sent, notices } = await clientFixture();
  for (let index = 0; index < 8; index++) assert.equal(client.input('x'.repeat(16384)), true);
  assert.equal(sent.filter(frame => frame.type === 'input').length, 8);
  assert.equal(client.input('界'.repeat(21845)), true); // 65,535 UTF-8 bytes queued.
  const before = sent.length;
  assert.equal(client.input('z'.repeat(2)), false);
  assert.equal(sent.length, before);
  assert.ok(notices.some(message => message.includes('整段未发送')));
});

test('UTF-8 chunks preserve whole scalars and each frame stays within the byte limit', async () => {
  const { client, sent } = await clientFixture();
  assert.equal(client.input('界'.repeat(20000)), true);
  const frames = sent.filter(frame => frame.type === 'input');
  assert.ok(frames.length >= 2);
  const chunks = frames.map(frame => Buffer.from(frame.data, 'base64'));
  assert.ok(chunks.every(chunk => chunk.length <= 16384));
  assert.equal(Buffer.concat(chunks).toString('utf8'), '界'.repeat(20000));
});

test('a control generation change drops pending input; late ACK cannot drain it', async () => {
  const { client, sent, notices } = await clientFixture();
  const pasteContext = client.inputContext;
  assert.ok(pasteContext);
  for (let index = 0; index < 40; index++) client.input('x');
  client.receive(JSON.stringify({ type: 'control', v: 1, phase: 'human', managed: true,
    owned: true, mode: 'managed', generation: 8, authorizedSessionRefs: [] }));
  const before = sent.filter(frame => frame.type === 'input').length;
  client.receive(JSON.stringify({ type: 'inputAck', v: 1, epoch: 1, seq: 1, status: 'written' }));
  assert.equal(sent.filter(frame => frame.type === 'input').length, before);
  assert.equal(client.matchesInputContext(pasteContext), false, 'an approved paste cannot cross a control generation');
  assert.ok(notices.some(message => message.includes('未发送的输入已丢弃')));
});

test('offline loss discards queued keys and a late old-epoch ACK cannot replay them', async () => {
  const { client, sent, notices } = await clientFixture();
  for (let index = 0; index < 40; index++) client.input('x');
  const before = sent.filter(frame => frame.type === 'input').length;
  client.pauseForOffline();
  client.receive(JSON.stringify({ type: 'inputAck', v: 1, epoch: 1, seq: 1, status: 'written' }));
  assert.equal(sent.filter(frame => frame.type === 'input').length, before);
  assert.ok(notices.some(message => message.includes('未发送的输入已丢弃')));
  assert.equal(client.canInput, false);
});

test('new attachment epoch rejects old ACK and does not resend the old queue', async () => {
  const { client, sent } = await clientFixture();
  for (let index = 0; index < 40; index++) client.input('x');
  const before = sent.filter(frame => frame.type === 'input').length;
  client.state = 'opening';
  client.receive(JSON.stringify({ type: 'ready', v: 1, connectionId: 'fixture-connection', epoch: 2,
    sessionRef: null, offset: 0, lastInputSeq: 0 }));
  client.receive(JSON.stringify({ type: 'inputAck', v: 1, epoch: 1, seq: 1, status: 'written' }));
  assert.equal(sent.filter(frame => frame.type === 'input').length, before);
  assert.equal(client.input('n'), true);
  assert.deepEqual(sent.filter(frame => frame.type === 'input').at(-1).seq, 1);
});

test('error and dispose each drop queued input without allowing an ACK to drain it', async () => {
  for (const boundary of ['error', 'dispose']) {
    const { client, sent, notices } = await clientFixture();
    for (let index = 0; index < 40; index++) client.input('x');
    const before = sent.filter(frame => frame.type === 'input').length;
    if (boundary === 'error') client.receive(JSON.stringify({ type: 'error', v: 1, code: 'INPUT_STALE', message: 'stale' }));
    else client.dispose();
    client.receive(JSON.stringify({ type: 'inputAck', v: 1, epoch: 1, seq: 1, status: 'written' }));
    assert.equal(sent.filter(frame => frame.type === 'input').length, before);
    assert.ok(notices.some(message => message.includes('未发送的输入已丢弃')));
  }
});

test('process proof failure freezes an attached writer, drops queued keys, and never replays them', async () => {
  const { client, sent, notices, states } = await clientFixture();
  for (let index = 0; index < 40; index++) assert.equal(client.input('x'), true);
  const before = sent.filter(frame => frame.type === 'input').length;
  const oldContext = client.inputContext;
  assert.equal(before, 8);
  client.receive(JSON.stringify({ type: 'error', v: 1, code: 'PROCESS_PROOF_UNAVAILABLE', message: '现场证明不可用' }));
  assert.equal(client.canInput, false);
  assert.equal(client.ws, null, 'the failed attachment is retired, not left writable');
  assert.equal(client.intentional, true, 'the old attachment cannot auto-resume after a proof failure');
  assert.equal(client.input('y'), false);
  client.receive(JSON.stringify({ type: 'inputAck', v: 1, epoch: 1, seq: 1, status: 'written' }));
  assert.equal(sent.filter(frame => frame.type === 'input').length, before);
  assert.equal(client.matchesInputContext(oldContext), false);
  assert.ok(notices.some(message => message.includes('未发送的输入已丢弃')));
  assert.ok(notices.some(message => message.includes('已发送但未确认')));
  assert.ok(states.some(entry => entry.state === 'error' && entry.message.includes('重新连接')));
});

test('a late ready or control frame cannot reopen input after a process-proof failure', async () => {
  const { client, sent } = await clientFixture();
  client.receive(JSON.stringify({ type: 'error', v: 1, code: 'MANAGED_PANE_UNKNOWN', message: '受管进程未核实' }));
  client.receive(JSON.stringify({ type: 'control', v: 1, phase: 'human', managed: true,
    owned: true, mode: 'managed', generation: 8, authorizedSessionRefs: [] }));
  client.receive(JSON.stringify({ type: 'ready', v: 1, connectionId: 'fixture-connection', epoch: 2,
    sessionRef: null, offset: 0, lastInputSeq: 0 }));
  assert.equal(client.canInput, false);
  assert.equal(client.input('z'), false);
  assert.equal(sent.filter(frame => frame.type === 'input').length, 0);
});

test('a default revision conflict does not freeze a still-authorized input attachment', async () => {
  const { client, sent } = await clientFixture();
  client.receive(JSON.stringify({ type: 'error', v: 1, code: 'DEFAULT_CONFLICT', message: 'default changed' }));
  assert.equal(client.canInput, true);
  assert.equal(client.input('n'), true);
  assert.equal(sent.filter(frame => frame.type === 'input').length, 1);
});

test('an ordinary list error does not freeze the current writer', async () => {
  const { client, sent } = await clientFixture();
  client.receive(JSON.stringify({ type: 'error', v: 1, code: 'TERMINAL_FAILED', message: 'list failed' }));
  assert.equal(client.canInput, true);
  assert.equal(client.input('n'), true);
  assert.equal(sent.filter(frame => frame.type === 'input').length, 1);
});
