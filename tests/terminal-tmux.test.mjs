import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createTerminalRuntime } from '../server/terminal/runtime.mjs';
import { createTmuxAdapter } from '../server/terminal/tmux.mjs';

async function waitFor(check, message) {
  for (let i = 0; i < 50; i += 1) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}

test('missing tmux reports a real unavailable capability', async () => {
  const adapter = createTmuxAdapter({
    executable: '/nonexistent/seqivo-test-tmux',
    serverName: 'seqivo-test-missing',
    env: { PATH: '' },
  });
  assert.equal((await adapter.inspect()).available, false);
  assert.deepEqual((await adapter.list()).sessions, []);
  await assert.rejects(adapter.create({ name: 'new', cwd: tmpdir() }), { code: 'CAPABILITY_UNAVAILABLE' });
});

test('tmux rejects forged refs, unsafe names and stale instances', async () => {
  assert.throws(() => createTmuxAdapter({ serverName: '../foreign' }), { code: 'INVALID_NAME' });
  const adapter = createTmuxAdapter({ executable: '/nonexistent/tmux', serverName: 'seqivo-test-ref', env: { PATH: '' } });
  await assert.rejects(adapter.attachTarget({ sessionRef: { serverName: '../foreign', instanceId: 'x', sessionId: '$1' } }), { code: 'INVALID_SESSION_REF' });
  await assert.rejects(adapter.create({ name: '-unsafe', cwd: tmpdir() }), { code: 'INVALID_NAME' });
});

test('real tmux keeps A/B sessions across client closes and rejects stale refs', {
  skip: process.platform !== 'darwin' || !process.env.TMUX_TEST_EXECUTABLE,
}, async t => {
  const executable = process.env.TMUX_TEST_EXECUTABLE;
  const serverName = `seqivo-test-${process.pid}-${randomBytes(6).toString('hex')}`;
  const cwd = mkdtempSync(join(tmpdir(), 'seqivo-tmux-test-'));
  t.after(() => {
    try { execFileSync(executable, ['-L', serverName, 'kill-server'], { timeout: 3000, stdio: 'ignore' }); } catch { /* already gone */ }
    rmSync(cwd, { recursive: true, force: true });
  });
  const adapter = createTmuxAdapter({ executable, serverName, timeoutMs: 5000 });
  const before = await adapter.inspect();
  assert.equal(before.available, true);
  assert.equal(before.instanceId, null);

  const first = await adapter.create({ name: 'first', cwd });
  const second = await adapter.create({ name: 'second', cwd });
  const listing = await adapter.list();
  assert.equal(listing.sessions.length, 2);
  assert.notEqual(first.sessionRef.sessionId, second.sessionRef.sessionId);
  assert.equal(first.sessionRef.instanceId, second.sessionRef.instanceId);
  assert.equal(listing.instanceId, first.sessionRef.instanceId);

  const targetA = await adapter.attachTarget({ sessionRef: first.sessionRef });
  const targetB = await adapter.attachTarget({ sessionRef: second.sessionRef });
  const panesA=await adapter.sessionPanes(first.sessionRef);
  const panesB=await adapter.sessionPanes(second.sessionRef);
  assert.ok(panesA.every(pane=>pane.paneId.startsWith('%')&&pane.pid>0));
  assert.ok(panesB.every(pane=>pane.paneId.startsWith('%')&&pane.pid>0));
  assert.notEqual(panesA[0].pid,panesB[0].pid);
  assert.equal(targetA.command, executable);
  assert.deepEqual(targetA.args.slice(0, 3), ['-L', serverName, 'attach-session']);
  assert.ok(!targetA.args.includes('-d'));
  assert.ok(!targetB.args.includes('-d'));
  await assert.rejects(adapter.attachTarget({ sessionRef: { ...first.sessionRef, instanceId: '0'.repeat(64) } }), { code: 'STALE_SERVER' });
  await assert.rejects(adapter.attachTarget({ sessionRef: { ...first.sessionRef, sessionId: '$999999' } }), { code: 'SESSION_MISSING' });

  const outputB = [];
  const terminalA = createTerminalRuntime({ shell: targetA.command, args: targetA.args, env: targetA.env, cwd, cols: 80, rows: 24 });
  const terminalB = createTerminalRuntime({ shell: targetB.command, args: targetB.args, env: targetB.env, cwd, cols: 80, rows: 24,
    onData: data => outputB.push(data) });
  t.after(async () => {
    await terminalA.close().catch(() => {});
    await terminalB.close().catch(() => {});
  });
  await waitFor(async () => {
    const rows = (await adapter.list()).sessions;
    return rows.find(row => row.name === 'first')?.attached === 1
      && rows.find(row => row.name === 'second')?.attached === 1;
  }, 'Both tmux clients did not attach');

  terminalB.write("printf '\\344\\275\\240\\345\\245\\275\\360\\237\\231\\202\\n'\n");
  await waitFor(() => outputB.join('').includes('你好🙂'), 'Unicode terminal output was not observed');

  const exitA = await terminalA.close();
  assert.equal(typeof exitA.exitCode, 'number');
  await waitFor(async () => {
    const rows = (await adapter.list()).sessions;
    return rows.find(row => row.name === 'first')?.attached === 0
      && rows.find(row => row.name === 'second')?.attached === 1;
  }, 'Closing A detached B or removed a session');
  await terminalB.close();
  const after = await adapter.list();
  assert.deepEqual(after.sessions.map(row => row.name).sort(), ['first', 'second']);
  assert.equal(after.instanceId, before.instanceId ?? listing.instanceId);

  execFileSync(executable, ['-L', serverName, 'kill-session', '-t', first.sessionRef.sessionId], { timeout: 3000, stdio: 'ignore' });
  const replacement = await adapter.create({ name: 'first', cwd });
  assert.notEqual(replacement.sessionRef.sessionId, first.sessionRef.sessionId);
  await assert.rejects(adapter.attachTarget({ sessionRef: first.sessionRef }), { code: 'SESSION_MISSING' });
  assert.equal((await adapter.attachTarget({ sessionRef: replacement.sessionRef })).args.at(-1), replacement.sessionRef.sessionId);

  execFileSync(executable, ['-L', serverName, 'kill-server'], { timeout: 3000, stdio: 'ignore' });
  const restarted = await adapter.create({ name: 'first', cwd });
  assert.notEqual(restarted.sessionRef.instanceId, replacement.sessionRef.instanceId);
  await assert.rejects(adapter.attachTarget({ sessionRef: replacement.sessionRef }), { code: 'STALE_SERVER' });
});
