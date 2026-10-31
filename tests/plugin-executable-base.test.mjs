import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const pythonPath = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';
const repo = fileURLToPath(new URL('../', import.meta.url));
const bridgeScript = join(repo, 'plugins/codex-autocontinue/bridge.py');
const fakeSource = join(repo, 'tests/plugin-fake-codex.py');

async function readResponse(iterator, id, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let timer;
    const next = await Promise.race([iterator.next(), new Promise(resolve => {
      timer = setTimeout(() => resolve({ timedOut: true }), remaining);
    })]);
    clearTimeout(timer);
    if (next.timedOut) throw new Error('Bridge response timed out');
    if (next.done) throw new Error('Bridge exited before responding');
    let message;
    try { message = JSON.parse(next.value); } catch { continue; }
    if (message.id === id) return message;
  }
  throw new Error('Bridge response timed out');
}

test('bridge resolves config.toml executable paths against the original Core cwd', async t => {
  await access(pythonPath);
  const root = await mkdtemp(join(tmpdir(), 'codex-executable-base-'));
  const originalCwd = join(root, 'original-cwd'), workerCwd = join(root, 'private-worker');
  const home = join(root, 'home'), fixtureBin = join(root, 'bin');
  const fakeCodex = join(originalCwd, 'fake-codex.py');
  const scenarioPath = join(root, 'scenario.json'), logPath = join(root, 'appserver.jsonl');
  const pidPath = join(root, 'appserver.pid');
  await Promise.all([mkdir(originalCwd), mkdir(workerCwd), mkdir(join(home, '.codex'), { recursive: true }), mkdir(fixtureBin)]);
  await cp(fakeSource, fakeCodex);
  await chmod(fakeCodex, 0o700);
  await writeFile(join(home, '.codex', 'config.toml'), "CODEX_CLI_PATH = 'fake-codex.py'\n");
  await writeFile(join(fixtureBin, 'codex'), '#!/bin/sh\nexit 97\n', { mode: 0o700 });
  await writeFile(scenarioPath, JSON.stringify({}));

  let bridge = null, iterator = null, bridgeExited = false;
  t.after(async () => {
    if (bridge && !bridgeExited && bridge.exitCode === null && bridge.signalCode === null) {
      const exitPromise = once(bridge, 'exit').then(() => true);
      try {
        bridge.stdin.write(`${JSON.stringify({ id: 2, method: 'close' })}\n`);
        bridge.stdin.end();
      } catch { /* The owned fixture may already have closed its input. */ }
      const exited = await Promise.race([
        exitPromise,
        delay(15000, undefined, { ref: false }).then(() => false),
      ]);
      if (!exited) {
        process.stderr.write('Bridge fixture exit was not confirmed; retaining private temp fixture.\n');
        throw new Error('Owned bridge fixture did not close within the test deadline');
      }
      bridgeExited = true;
    }
    if (!bridge || bridgeExited || bridge.exitCode !== null || bridge.signalCode !== null)
      await rm(root, { recursive: true, force: true });
  });

  const { CODEX_CLI_PATH: _ignoredCodexPath, ...parentEnv } = process.env;
  bridge = spawn(pythonPath, ['-B', bridgeScript], {
    cwd: workerCwd,
    env: {
      ...parentEnv,
      HOME: home,
      PATH: fixtureBin,
      TASKBOARD_FAKE_SCENARIO: scenarioPath,
      TASKBOARD_FAKE_LOG: logPath,
      TASKBOARD_FAKE_PID: pidPath,
      TASKBOARD_FAKE_CWD: originalCwd,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  bridge.stderr.on('data', () => {}); // Keep the bounded test fixture stderr drained.
  const lines = createInterface({ input: bridge.stdout });
  iterator = lines[Symbol.asyncIterator]();
  const spawnError = new Promise((_, reject) => bridge.once('error', reject));
  const opening = readResponse(iterator, 1);
  bridge.stdin.write(`${JSON.stringify({ id: 1, method: 'open', codexPath: null,
    executableBaseDirectory: originalCwd, timeoutSeconds: 8 })}\n`);
  const opened = await Promise.race([opening, spawnError]);
  assert.equal(opened.result?.available, true,
    `expected fake app-server open; got ${opened.error?.type || 'no result'}: ${String(opened.error?.message || '').replaceAll(root, '<fixture>').slice(0, 400)}`);
  assert.ok(Number.isSafeInteger(opened.result.appServerPid) && opened.result.appServerPid > 1);
  const fakePid = Number((await readFile(pidPath, 'utf8')).trim());
  assert.equal(fakePid, opened.result.appServerPid, 'the configured fixture executable launched');
});
