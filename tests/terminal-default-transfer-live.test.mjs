import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { createTerminalManager } from '../server/terminal/manager.mjs';
import { createTerminalControl } from '../server/terminal/control.mjs';
import { inspectWorkspaceWriters } from '../server/terminal/process-inspection.mjs';
import { createTmuxAdapter } from '../server/terminal/tmux.mjs';

const tmux = process.env.TMUX_TEST_EXECUTABLE || resolve('.tools/terminal-build/install/bin/tmux');
const last = (frames, type) => frames.filter(frame => frame.type === type).at(-1);
async function content(path, expected) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if (await readFile(path, 'utf8') === expected) return; } catch { /* Pane may not have written yet. */ }
    await new Promise(done => setTimeout(done, 25));
  }
  assert.equal(await readFile(path, 'utf8'), expected);
}

test('real tmux manager: default A, temporary B, reconnect A, set B, transfer to another device and revoke old input', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS process proof required'); return; }
  try { accessSync(tmux, constants.X_OK); } catch { t.skip('real tmux unavailable'); return; }

  // tmux has a short UNIX socket path limit. This directory and every server
  // name are unique to this test; no user's tmux server or application data is used.
  const socketRoot = await mkdtemp('/private/tmp/t996-sock-');
  const priorTmuxTmpdir = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = socketRoot;
  const root = await mkdtemp('/private/tmp/t996-data-');
  const serverName = `seqivo-t996-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run = (...args) => execFileSync(tmux, ['-L', serverName, ...args],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  const store = new Store(join(root, 'board.sqlite'));
  const project = store.project({ name: 'Exact terminal transfer fixture', directory: root });
  const clear = () => ({ verified: true, quiescent: true, unknown: false,
    livePids: [], scope: 'isolated-test-no-managed-executor' });
  let manager, bodyPassed = false;
  const control = createTerminalControl({ store, quiesce: async () => clear(),
    inspectWriters: inspectWorkspaceWriters,
    inspectExisting: input => manager.inspectExisting(input),
    sealHuman: input => manager.sealProject(input.projectId) });
  manager = createTerminalManager({ store, control });
  t.after(async () => {
    const failures = [];
    try { await manager.close(); } catch (error) { failures.push(error); }
    try { run('kill-server'); } catch (error) {
      if (!/no server running|error connecting|No such file/.test(String(error.stderr))) failures.push(error);
    }
    try { store.close(); } catch (error) { failures.push(error); }
    if (priorTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = priorTmuxTmpdir;
    if (bodyPassed && failures.length === 0) {
      await rm(root, { recursive: true, force: true });
      await rm(socketRoot, { recursive: true, force: true });
    } else t.diagnostic(`Retained isolated terminal fixture: ${root}, ${socketRoot}`);
    if (failures.length) throw new AggregateError(failures, 'Isolated terminal cleanup unconfirmed');
  });

  await manager.request('POST', '/api/terminal/profiles', { id: 'managed', label: 'Exact transfer',
    projectId: project.id, enabled: true, serverName, allowSharedServer: true, tmuxExecutable: tmux });
  // The Hub link is a local stub. The terminal manager, control store and tmux
  // process path are real; this test does not claim Hub network transport.
  let revision = 1;
  manager.setLink({ state: () => ({ nodeId: 'node', ownerUserId: 'owner', status: 'connected' }),
    pending: async () => ({ devices: [{ deviceId: 'phone', userId: 'owner' },
      { deviceId: 'tablet', userId: 'owner' }] }),
    grant: async () => ({ revision: revision++ }), refresh: () => {}, close: async () => {} });
  const grants = {};
  for (const deviceId of ['phone', 'tablet'])
    grants[deviceId] = await manager.request('POST', '/api/terminal/grants', { deviceId, profileId: 'managed',
      scopes: ['view', 'input', 'create', 'takeover', 'default'] });

  const phone = { nodeId: 'node', deviceId: 'phone', userId: 'owner', grantRevision: grants.phone.revision,
    profileId: 'managed', connectionId: 'phone-first', isCurrent: () => true };
  const first = [], sendFirst = frame => first.push(frame);
  const adapter = createTmuxAdapter({ executable: tmux, serverName });
  await manager.frame(phone, { v: 1, type: 'open', mode: 'tmux', readOnly: false, cols: 80, rows: 24 }, sendFirst);
  await manager.frame(phone, { v: 1, type: 'takeover' }, sendFirst);
  await manager.frame(phone, { v: 1, type: 'create', epoch: 0, name: 'A' }, sendFirst);
  const a = last(first, 'ready').sessionRef;
  const aPid = (await adapter.sessionPanes(a))[0].pid;
  await manager.frame(phone, { v: 1, type: 'default', sessionRef: a, expectedRevision: 0 }, sendFirst);
  await manager.frame(phone, { v: 1, type: 'create', epoch: last(first, 'ready').epoch, name: 'B' }, sendFirst);
  const b = last(first, 'ready').sessionRef;
  const bPid = (await adapter.sessionPanes(b))[0].pid;
  assert.notDeepEqual(a, b);
  assert.deepEqual(last(first, 'sessions').defaultRef, a, 'temporary B must leave A as default');

  await manager.frame(phone, { v: 1, type: 'detach', requestId: 'leave-temporary-b' }, sendFirst);
  const phoneNext = { ...phone, connectionId: 'phone-next' }, next = [], sendNext = frame => next.push(frame);
  await manager.frame(phoneNext, { v: 1, type: 'open', mode: 'tmux', readOnly: false,
    cols: 80, rows: 24 }, sendNext);
  assert.deepEqual(last(next, 'ready')?.sessionRef, a, 'new phone connection must reopen exact default A');
  await manager.frame(phoneNext, { v: 1, type: 'input', epoch: last(next, 'ready').epoch, seq: 0,
    data: Buffer.from('printf A-RECONNECT > a.txt\n').toString('base64') }, sendNext);
  await content(join(root, 'a.txt'), 'A-RECONNECT');
  await manager.frame(phoneNext, { v: 1, type: 'select', epoch: last(next, 'ready').epoch,
    sessionRef: b }, sendNext);
  assert.deepEqual(last(next, 'ready')?.sessionRef, b);
  await manager.frame(phoneNext, { v: 1, type: 'default', sessionRef: b, expectedRevision: 1 }, sendNext);
  assert.deepEqual(last(next, 'sessions').defaultRef, b, 'B becomes default only through explicit revision-1 action');

  const tablet = { ...phone, deviceId: 'tablet', grantRevision: grants.tablet.revision,
    connectionId: 'tablet-new' }, other = [], sendOther = frame => other.push(frame);
  await manager.frame(tablet, { v: 1, type: 'open', mode: 'tmux', readOnly: false,
    cols: 80, rows: 24 }, sendOther);
  assert.equal(other.some(frame => frame.type === 'ready'), false,
    'another device cannot inherit the live phone claim or autoattach B');
  await manager.frame(phoneNext, { v: 1, type: 'transfer-control',
    targetConnectionId: tablet.connectionId, expectedGeneration: control.state()[0].generation,
    requestId: 'phone-to-tablet' }, sendNext);
  const offer = last(other, 'controlOffer');
  assert.ok(offer?.transferId);
  const phoneEpoch = last(next, 'ready').epoch;
  await assert.rejects(manager.frame(phoneNext, { v: 1, type: 'input', epoch: phoneEpoch, seq: 0,
    data: Buffer.from('printf OLD > b.txt\n').toString('base64') }, sendNext),
  { code: 'CONTROL_REQUIRED' });
  await manager.frame(tablet, { v: 1, type: 'accept-control', transferId: offer.transferId,
    requestId: 'tablet-accept' }, sendOther);
  await manager.frame(tablet, { v: 1, type: 'select', epoch: 0, sessionRef: b }, sendOther);
  assert.deepEqual(last(other, 'ready')?.sessionRef, b, 'transferred device selects exact B');
  assert.equal(last(other, 'control')?.owned, true);
  await manager.frame(tablet, { v: 1, type: 'detach', requestId: 'tablet-close-first' }, sendOther);
  const tabletNext = { ...tablet, connectionId: 'tablet-new-connect' }, reopened = [],
    sendReopened = frame => reopened.push(frame);
  await manager.frame(tabletNext, { v: 1, type: 'open', mode: 'tmux', readOnly: false,
    cols: 80, rows: 24 }, sendReopened);
  assert.deepEqual(last(reopened, 'ready')?.sessionRef, b,
    'new connection on the other device autoattaches exact default B');
  await manager.frame(tabletNext, { v: 1, type: 'input', epoch: last(reopened, 'ready').epoch, seq: 0,
    data: Buffer.from('printf TABLET > b.txt\n').toString('base64') }, sendReopened);
  await content(join(root, 'b.txt'), 'TABLET');

  await manager.request('DELETE', '/api/terminal/grants/phone/managed');
  await assert.rejects(manager.frame(phoneNext, { v: 1, type: 'input', epoch: phoneEpoch, seq: 1,
    data: Buffer.from('printf REPLAY >> b.txt\n').toString('base64') }, sendNext),
  { code: 'GRANT_REQUIRED' });
  await new Promise(done => setTimeout(done, 100));
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'TABLET', 'revoked input must not replay');
  await manager.frame(tabletNext, { v: 1, type: 'list' }, sendReopened);
  assert.deepEqual(last(reopened, 'sessions')?.defaultRef, b, 'other-device control must not change default');
  assert.equal((await adapter.sessionPanes(a))[0].pid, aPid, 'A pane stays alive');
  assert.equal((await adapter.sessionPanes(b))[0].pid, bPid, 'B pane stays alive');
  assert.deepEqual(control.state()[0].authorizedSessionRefs, [a, b]);
  bodyPassed = true;
});
