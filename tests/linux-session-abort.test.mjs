import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const controller = fileURLToPath(new URL('./fixtures/linux-session-abort-controller.mjs', import.meta.url));
const pythonPath = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';
const linux = { skip: process.platform !== 'linux', timeout: 120000 };

async function runScenario(t, scenario) {
  try { await access(pythonPath, constants.X_OK); }
  catch { t.skip('A Linux Python runtime is required for the original job integration'); return; }
  const root = await mkdtemp(join(tmpdir(), 'seqivo-linux-session-abort-'));
  const dataDir = join(root, 'data');
  const workspace = join(root, 'workspace');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  let successful = false;
  t.after(async () => {
    if (successful) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Linux session-abort fixture retained for inspection: ${root}`);
  });
  const child = spawn(process.execPath, [controller, root, dataDir, workspace, scenario], {
    cwd: workspace,
    env: { ...process.env, TASKBOARD_TEST_PYTHON: pythonPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const output = Buffer.concat(stdout).toString('utf8');
  const errors = Buffer.concat(stderr).toString('utf8');
  assert.equal(exit.code, 0, `original Core fixture failed: ${errors.slice(0, 4000)}\n${output.slice(0, 2000)}`);
  assert.equal(exit.signal, null);
  const result = JSON.parse(output.trim().split('\n').at(-1));
  assert.equal(result.scenario, scenario);
  assert.equal(result.phase, 'retired-and-recreated');
  assert.notEqual(result.originalRecordId, result.newRecordId);
  assert.equal(result.providerSessionStarts, 1);
  assert.equal(result.rejectedRetirements, 2);
  assert.equal(result.cleanupConfirmed, true);
  successful = true;
}

test('Linux Core retires a real job when provider initialization fails before admission', linux,
  t => runScenario(t, 'before-initialize'));

test('Linux Core retires a real job when session admission rejects before provider dispatch', linux,
  t => runScenario(t, 'before-admission'));

test('Linux Core retires the already admitted job when session revalidation rejects before provider dispatch', linux,
  t => runScenario(t, 'after-revalidate'));
