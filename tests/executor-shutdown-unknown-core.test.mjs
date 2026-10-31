import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createCore } from '../server/core.mjs';
import { Store } from '../server/store.mjs';
import { bootIdentity, readJobRecord, writeJobRecord } from '../server/macos-executor-job-record.mjs';

const pluginDir = fileURLToPath(new URL('../plugins/', import.meta.url));
const fakeSource = new URL('./plugin-fake-codex.py', import.meta.url);
const hostState = dataDir => join(dataDir, 'plugins', 'codex-autocontinue', 'codex-autocontinue.json');
const fakeLog = root => join(root, 'fake-provider.jsonl');
const ownerResult = root => join(root, 'owner-phase.json');
const ownerError = root => join(root, 'owner-error.json');
const recoveryResult = root => join(root, 'recovery-result.json');
function diskLeaseImage(dataDir) {
  const db = new DatabaseSync(join(dataDir, 'board.sqlite'), { readOnly: true });
  try { return JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='execution.leases.v1'").get().value); }
  finally { db.close(); }
}
function updateDiskLeaseImage(dataDir, update) {
  const store = new Store(join(dataDir, 'board.sqlite'));
  const db = store.db;
  try {
    store.transaction(() => {
      const row = db.prepare("SELECT value FROM metadata WHERE key='execution.leases.v1'").get();
      const image = JSON.parse(row.value);
      update(image);
      const result = db.prepare("UPDATE metadata SET value=? WHERE key='execution.leases.v1' AND value=?")
        .run(JSON.stringify(image), row.value);
      assert.equal(result.changes, 1, 'the isolated fixture must change only its original lease image');
    });
  } finally { store.close(); }
}
const invalidReceipt = variant =>
  ['historical-missing-core-receipt', 'historical-wrong-core-receipt'].includes(variant);
const requests = async root => (await readFile(fakeLog(root), 'utf8')).trim().split('\n')
  .filter(Boolean).map(JSON.parse);

async function eventually(read, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (predicate(last)) return last;
    } catch { /* Wait for the atomic host-state write. */ }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function safeFailureText(value) {
  return String(value ?? '')
    .replace(/(bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/((?:token|password|secret|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;"']+/gi, '$1[redacted]')
    .replace(/("(?:token|password|secret|authorization|api[_-]?key)"\s*:\s*")[^"]*/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .slice(0, 6000);
}

function describeError(error) {
  const entries = [];
  const seen = new Set(), pending = [{ error, relation: 'root' }];
  while (pending.length && entries.length < 8) {
    const { error: current, relation } = pending.shift();
    if (!current || (typeof current !== 'object' && typeof current !== 'function') || seen.has(current)) continue;
    seen.add(current);
    entries.push({ relation, name: safeFailureText(current.name), code: safeFailureText(current.code),
      message: safeFailureText(current.message), stack: safeFailureText(current.stack) });
    if (current.cause) pending.push({ error: current.cause, relation: 'cause' });
    if (Array.isArray(current.errors)) {
      for (const nested of current.errors.slice(0, 8)) {
        if (pending.length + entries.length >= 8) break;
        pending.push({ error: nested, relation: 'aggregate-error' });
      }
    }
  }
  return entries;
}

async function firstOwnerPhase(root, variant = 'same-boot') {
  const pythonPath = process.env.TASKBOARD_TEST_PYTHON;
  assert.match(pythonPath || '', /^\//, 'Set an absolute TASKBOARD_TEST_PYTHON for native job proof');
  const dataDir = join(root, 'data'), workspace = join(root, 'workspace');
  const fake = join(root, 'fake-codex.py');
  let core = null;
  try {
    core = await createCore({ dataDir, pluginDir, files: false, managedPythonPath: pythonPath });
    const project = core.store.project({ name: 'Disposable shutdown-unknown fixture', directory: workspace });
    const created = core.store.createTask({ projectId: project.id, title: 'One in-flight fake-provider turn',
      executionProvider: 'codex-autocontinue' });
    const task = core.store.updateTask(created.id, { status: 'blocked' }, created.revision);
    await core.plugin.configure({ pythonPath, codexPath: fake, pollSeconds: 86400 });
    const session = await core.request('POST', `/api/tasks/${task.id}/session`, {
      expectedRevision: task.revision, commandId: 'shutdown-unknown-session', workspaceWrite: false,
    });
    assert.equal(session.status, 'created');
    assert.equal(core.store.getTask(task.id).conversationId, session.threadId);
    const commandId = 'shutdown-unknown-turn';
    const liveTask = core.store.getTask(task.id);
    const earlyTurn = variant === 'approval-early-turn';
    const startedPromise = core.request('POST', `/api/tasks/${task.id}/continue`, {
      expectedRevision: liveTask.revision, commandId,
    }).then(value => ({ value }), error => ({ error }));
    const approval = variant === 'approval-exact-turn';
    const missingTurn = variant === 'approval-missing-turn';
    if (!earlyTurn) {
      const started = await startedPromise;
      if (started.error) throw started.error;
      assert.ok(variant.startsWith('approval-')
        ? ['running', 'unknown', 'awaiting_approval'].includes(started.value.status)
        : started.value.status === 'running');
    }
    if (approval) {
      await eventually(async () => JSON.parse(await readFile(hostState(dataDir), 'utf8')),
        image => {
          const command = image.commands?.[`${task.id}:${commandId}`];
          const marker = image.executors?.[`task:${task.id}`];
          return marker?.status === 'starting' && command?.status === 'running' &&
            typeof command.turnId === 'string' &&
            Number.isSafeInteger(command.taskRevision) && command.taskRevision > 0 &&
            Number.isSafeInteger(command.startedContentVersion) && command.startedContentVersion > 0;
        }, 'durably running original turn before approval');
      await writeFile(join(root, 'approval-gate'), 'ready', { mode: 0o600, flag: 'wx' });
    }
    const running = await eventually(async () => JSON.parse(await readFile(hostState(dataDir), 'utf8')),
      image => {
        const command = image.commands?.[`${task.id}:${commandId}`];
        const marker = image.executors?.[`task:${task.id}`];
        return command?.turnCompleteEvent !== true &&
          (approval ? command.status === 'unknown' && marker?.status === 'stopped_unknown' &&
            core.store.getTask(task.id)?.status === 'blocked' && typeof command.turnId === 'string'
            : missingTurn || earlyTurn ? marker?.status === 'retirement_unknown'
              : command.status === 'running' && typeof command.turnId === 'string');
      }, approval ? 'approval stop with exact durable unknown receipt'
        : missingTurn || earlyTurn ? 'early or missing-turn approval remains unconfirmed'
          : 'one running fake turn with no final provider event');
    if (earlyTurn) await startedPromise;
    const turnId = running.commands[`${task.id}:${commandId}`].turnId || null;
    if (approval) {
      assert.equal(running.executors[`task:${task.id}`].shutdownStopIntent.stopCause, 'provider_approval');
      assert.equal(core.store.getTask(task.id).status, 'blocked', 'approval outcome must be visible as blocked');
    }
    if (missingTurn || earlyTurn) {
      assert.equal(running.executors[`task:${task.id}`].shutdownStopIntent, undefined,
        'an approval without its original turn id cannot claim a stopped-unknown receipt');
      await assert.rejects(core.close());
      core = null;
      await writeFile(ownerResult(root), JSON.stringify({ taskId: task.id, projectId: project.id,
        commandId, turnId, closed: false }), { mode: 0o600, flag: 'wx' });
      return;
    }
    await core.close();
    core = null;
    await writeFile(ownerResult(root), JSON.stringify({ taskId: task.id, projectId: project.id,
      commandId, turnId, closed: true }), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (core) {
      try { await core.close(); } catch { /* Keep the isolated fixture and its process evidence. */ }
      core = null;
    }
    await writeFile(ownerError(root), JSON.stringify({ errors: describeError(error) }),
      { mode: 0o600 }).catch(() => {});
    throw error;
  }
}

async function recoveryOwnerPhase(root, variant) {
  const pythonPath = process.env.TASKBOARD_TEST_PYTHON;
  assert.match(pythonPath || '', /^\//, 'Set an absolute TASKBOARD_TEST_PYTHON for native job proof');
  let core = null, closeError = null;
  try {
    core = await createCore({ dataDir: join(root, 'data'), pluginDir, files: false, managedPythonPath: pythonPath });
    const owner = JSON.parse(await readFile(ownerResult(root), 'utf8'));
    const active = core.leases.state().active.find(row =>
      row.taskId === owner.taskId && row.commandId === owner.commandId);
    assert.equal(active?.status, 'unknown', 'the original lease stays active after reopening');
    if (!invalidReceipt(variant))
      assert.equal((await core.leases.reconcile()).released, 0,
        'generic reconciliation must not release the shutdown receipt');
    const competing = core.store.createTask({ projectId: owner.projectId,
      title: 'Competing task must stay fenced' });
    assert.equal(core.leases.available({ taskId: competing.id, workspace: join(root, 'workspace') }), false,
      'reopening must not grant another task write access to the same workspace');
    try { await core.close(); } catch (error) { closeError = error; }
    core = null;
    const image = JSON.parse(await readFile(hostState(join(root, 'data')), 'utf8'));
    const lease = diskLeaseImage(join(root, 'data')).reservations.find(row =>
      row.taskId === owner.taskId && row.commandId === owner.commandId);
    await writeFile(recoveryResult(root), JSON.stringify({ variant, closeRejected: !!closeError,
      closeError: closeError ? describeError(closeError) : [],
      marker: image.executors[`task:${owner.taskId}`],
      command: image.commands[`${owner.taskId}:${owner.commandId}`], lease,
      turnStartCount: (await requests(root)).filter(row => row.method === 'turn/start').length,
    }), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (core) {
      try { await core.close(); } catch { /* Keep the isolated fixture and its process evidence. */ }
      core = null;
    }
    await writeFile(ownerError(root), JSON.stringify({ errors: describeError(error) }),
      { mode: 0o600 }).catch(() => {});
    throw error;
  }
}

async function spawnOwner(root, phase, variant = 'same-boot') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, SEQIVO_TEST_SHUTDOWN_UNKNOWN_PHASE: phase,
      SEQIVO_TEST_SHUTDOWN_UNKNOWN_ROOT: root, SEQIVO_TEST_SHUTDOWN_UNKNOWN_VARIANT: variant },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let childStdout = '', childStderr = '', timedOut = false;
  const appendBounded = (current, chunk) => current.length >= 16000
    ? current : current + chunk.toString('utf8').slice(0, 16000 - current.length);
  child.stdout.on('data', chunk => { childStdout = appendBounded(childStdout, chunk); });
  child.stderr.on('data', chunk => { childStderr = appendBounded(childStderr, chunk); });
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, 60000);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  const suffix = phase === 'first' ? 'owner' : `recovery-${variant}`;
  await Promise.all([
    writeFile(join(root, `${suffix}-stdout.log`), safeFailureText(childStdout), { mode: 0o600 }),
    writeFile(join(root, `${suffix}-stderr.log`), safeFailureText(childStderr), { mode: 0o600 }),
  ]);
  return { ...exit, timedOut };
}

async function prepareRoot(t) {
  const pythonPath = process.env.TASKBOARD_TEST_PYTHON;
  assert.match(pythonPath || '', /^\//, 'Set an absolute TASKBOARD_TEST_PYTHON for native job proof');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-shutdown-unknown-core-')));
  const dataDir = join(root, 'data'), workspace = join(root, 'workspace');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  const fake = join(root, 'fake-codex.py');
  const fakeText = (await readFile(fakeSource, 'utf8')).replace(/^#![^\n]*/, `#!${pythonPath}`);
  await writeFile(fake, fakeText, { mode: 0o700 });
  await chmod(fake, 0o700);
  const env = { TASKBOARD_FAKE_SCENARIO: join(root, 'scenario.json'), TASKBOARD_FAKE_LOG: fakeLog(root),
    TASKBOARD_FAKE_PID: join(root, 'provider.pid'), TASKBOARD_FAKE_CWD: workspace,
    TASKBOARD_FAKE_APPROVAL_GATE: join(root, 'approval-gate') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  await writeFile(env.TASKBOARD_FAKE_SCENARIO, '{}', { mode: 0o600 });
  await writeFile(env.TASKBOARD_FAKE_LOG, '', { mode: 0o600 });
  Object.assign(process.env, env);
  let cleanupConfirmed = false;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (cleanupConfirmed) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Retained shutdown-unknown fixture for diagnosis: ${root}`);
  });
  return { root, dataDir, workspace, pythonPath, setCleanupConfirmed: () => { cleanupConfirmed = true; } };
}

async function assertFirstOwnerClosed(root, workspace) {
  const owner = JSON.parse(await readFile(ownerResult(root), 'utf8'));
  assert.equal(owner.closed, true);
  const stopped = JSON.parse(await readFile(hostState(join(root, 'data')), 'utf8'));
  const marker = stopped.executors[`task:${owner.taskId}`];
  assert.equal(marker.status, 'stopped_unknown');
  assert.deepEqual(marker.shutdownStoppedReceipt, marker.shutdownStopProof);
  assert.equal(marker.shutdownStopIntent.commandId, owner.commandId);
  assert.equal(stopped.commands[`${owner.taskId}:${owner.commandId}`].status, 'unknown');
  assert.notEqual(stopped.commands[`${owner.taskId}:${owner.commandId}`].stopProof?.status, 'verified');
  assert.equal(stopped.commands[`${owner.taskId}:${owner.commandId}`].turnId, owner.turnId);
  assert.equal((await readJobRecord(marker.recordRoot, marker.recordId, owner.taskId, workspace)).phase, 'retired');
  assert.equal((await requests(root)).filter(row => row.method === 'turn/start').length, 1);
  return { owner, marker };
}

async function simulateHistoricalCrash(root, workspace, variant) {
  // Model only the persisted crash window: this does not reboot or terminate
  // the host. The second Core owner must consume the CAS-updated old-boot tombstone.
  const dataDir = join(root, 'data'), owner = JSON.parse(await readFile(ownerResult(root), 'utf8'));
  const path = hostState(dataDir), image = JSON.parse(await readFile(path, 'utf8'));
  const marker = image.executors[`task:${owner.taskId}`];
  const command = image.commands[`${owner.taskId}:${owner.commandId}`];
  assert.equal(marker.shutdownStopProof.commandId, owner.commandId);
  const originalLease = diskLeaseImage(dataDir).reservations.find(row =>
    row.taskId === owner.taskId && row.commandId === owner.commandId);
  assert.equal(originalLease?.status, 'unknown');
  assert.deepEqual(originalLease?.shutdownStoppedReceipt, marker.shutdownStopProof,
    'historical recovery fixture begins with the exact persisted Core receipt');
  delete marker.shutdownStoppedReceipt;
  marker.status = 'stopping';
  command.status = 'running';
  await writeFile(path, JSON.stringify(image), { mode: 0o600 });

  const job = await readJobRecord(marker.recordRoot, marker.recordId, owner.taskId, workspace);
  const currentBoot = await bootIdentity();
  const [seconds] = currentBoot.split(':');
  const simulatedPriorBoot = `${Math.max(1, Number(seconds) - 1)}:0`;
  assert.notEqual(simulatedPriorBoot, currentBoot);
  await writeJobRecord(marker.recordRoot, { ...job, boot: simulatedPriorBoot,
    generation: job.generation + 1 }, job.generation);
  if (invalidReceipt(variant)) {
    updateDiskLeaseImage(dataDir, lease => {
      const record = lease.reservations.find(row => row.taskId === owner.taskId && row.commandId === owner.commandId);
      assert.equal(record?.status, 'unknown');
      if (variant === 'historical-missing-core-receipt') delete record.shutdownStoppedReceipt;
      else record.shutdownStoppedReceipt.turnId = 'different-original-turn';
    });
  }
  const crashImage = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(crashImage.executors[`task:${owner.taskId}`].status, 'stopping');
  assert.equal(crashImage.executors[`task:${owner.taskId}`].shutdownStoppedReceipt, undefined);
  assert.equal(crashImage.commands[`${owner.taskId}:${owner.commandId}`].status, 'running');
  assert.equal(crashImage.executors[`task:${owner.taskId}`].shutdownStopProof.commandId, owner.commandId);
}

if (process.env.SEQIVO_TEST_SHUTDOWN_UNKNOWN_PHASE === 'first') {
  try {
    await firstOwnerPhase(process.env.SEQIVO_TEST_SHUTDOWN_UNKNOWN_ROOT,
      process.env.SEQIVO_TEST_SHUTDOWN_UNKNOWN_VARIANT || 'same-boot');
    process.exit(0);
  } catch {
    process.exit(1);
  }
} else if (process.env.SEQIVO_TEST_SHUTDOWN_UNKNOWN_PHASE === 'recover') {
  try {
    await recoveryOwnerPhase(process.env.SEQIVO_TEST_SHUTDOWN_UNKNOWN_ROOT,
      process.env.SEQIVO_TEST_SHUTDOWN_UNKNOWN_VARIANT || 'same-boot');
    process.exit(0);
  } catch {
    process.exit(1);
  }
} else if (!process.env.SEQIVO_TEST_SHUTDOWN_UNKNOWN_PHASE) {
  for (const variant of ['same-boot', 'historical-exact-receipt', 'approval-exact-turn',
    'historical-missing-core-receipt', 'historical-wrong-core-receipt']) {
    test(`real Core close/reopen preserves shutdown-unknown fence (${variant})`, {
      skip: process.platform !== 'darwin',
    }, async t => {
      const fixture = await prepareRoot(t);
      if (variant === 'approval-exact-turn')
        await writeFile(join(fixture.root, 'scenario.json'),
          JSON.stringify({ approval: true, approvalWithTurnId: true, approvalAfterGate: true }), { mode: 0o600 });
      const firstExit = await spawnOwner(fixture.root, 'first', variant);
      assert.deepEqual(firstExit, { code: 0, signal: null, timedOut: false },
        `first owner failed; inspect private owner-error.json under ${fixture.root}`);
      await assertFirstOwnerClosed(fixture.root, fixture.workspace);
      if (variant.startsWith('historical-'))
        await simulateHistoricalCrash(fixture.root, fixture.workspace, variant);

      const recoveryExit = await spawnOwner(fixture.root, 'recover', variant);
      assert.deepEqual(recoveryExit, { code: 0, signal: null, timedOut: false },
        `recovery owner failed; inspect private recovery logs under ${fixture.root}`);
      const result = JSON.parse(await readFile(recoveryResult(fixture.root), 'utf8'));
      assert.equal(result.variant, variant);
      assert.equal(result.turnStartCount, 1, 'recovery must not send a new fake-provider turn');
      const owner = JSON.parse(await readFile(ownerResult(fixture.root), 'utf8'));
      const dbLease = diskLeaseImage(fixture.dataDir).reservations.find(row =>
        row.taskId === owner.taskId && row.commandId === owner.commandId);

      if (invalidReceipt(variant)) {
        assert.equal(result.closeRejected, true, 'Core must reject the incomplete historical receipt');
        assert.equal(dbLease?.status, 'unknown');
        if (variant === 'historical-missing-core-receipt')
          assert.equal(dbLease?.shutdownStoppedReceipt, undefined, 'Core must not mint a missing lease receipt');
        else assert.equal(dbLease?.shutdownStoppedReceipt?.turnId, 'different-original-turn',
          'Core must not replace a mismatched receipt with the host claim');
        assert.equal(result.marker.shutdownStoppedReceipt, undefined, 'host must not fill the final receipt after Core rejects');
        assert.equal(result.marker.shutdownStopProof?.commandId, owner.commandId,
          'the earlier durable host proof is preserved');
        assert.equal(result.command.status, 'running', 'the crash image is not rewritten as completed');
        t.diagnostic(`Expected close rejection retained its isolated fixture: ${fixture.root}`);
        return;
      }

      assert.equal(result.closeRejected, false, 'exact prior Core receipt should allow historical close reconciliation');
      assert.equal(result.marker.status, 'stopped_unknown');
      assert.deepEqual(result.marker.shutdownStoppedReceipt, result.marker.shutdownStopProof);
      assert.equal(result.command.status, 'unknown');
      assert.notEqual(result.command.stopProof?.status, 'verified');
      assert.equal(dbLease?.status, 'unknown');
      assert.deepEqual(dbLease?.shutdownStoppedReceipt, result.marker.shutdownStoppedReceipt);
      assert.equal(result.marker.shutdownStoppedReceipt.commandId, owner.commandId);
      assert.equal(result.marker.shutdownStoppedReceipt.turnId, owner.turnId);
      fixture.setCleanupConfirmed();
    });
  }
  test('provider request without an exact turn id never claims an unknown-outcome receipt', {
    skip: process.platform !== 'darwin',
  }, async t => {
    const fixture = await prepareRoot(t);
    await writeFile(join(fixture.root, 'scenario.json'), JSON.stringify({ approval: true }), { mode: 0o600 });
    const firstExit = await spawnOwner(fixture.root, 'first', 'approval-missing-turn');
    assert.deepEqual(firstExit, { code: 0, signal: null, timedOut: false },
      `missing-turn owner failed; inspect private owner-error.json under ${fixture.root}`);
    const owner = JSON.parse(await readFile(ownerResult(fixture.root), 'utf8'));
    assert.equal(owner.closed, false);
    const image = JSON.parse(await readFile(hostState(fixture.dataDir), 'utf8'));
    const marker = image.executors[`task:${owner.taskId}`];
    assert.equal(marker.status, 'retirement_unknown');
    assert.equal(marker.shutdownStopIntent, undefined);
    assert.equal(marker.shutdownStoppedReceipt, undefined);
    const lease = diskLeaseImage(fixture.dataDir).reservations.find(row =>
      row.taskId === owner.taskId && row.commandId === owner.commandId);
    assert.equal(lease?.shutdownStoppedReceipt, undefined);
    assert.equal((await requests(fixture.root)).filter(row => row.method === 'turn/start').length, 1);
  });
  test('approval before the original turn is durably running cannot claim a stopped-outcome receipt', {
    skip: process.platform !== 'darwin',
  }, async t => {
    const fixture = await prepareRoot(t);
    await writeFile(join(fixture.root, 'scenario.json'),
      JSON.stringify({ approval: true, approvalBeforeTurnReply: true }), { mode: 0o600 });
    const firstExit = await spawnOwner(fixture.root, 'first', 'approval-early-turn');
    assert.deepEqual(firstExit, { code: 0, signal: null, timedOut: false },
      `early-approval owner failed; inspect private owner-error.json under ${fixture.root}`);
    const owner = JSON.parse(await readFile(ownerResult(fixture.root), 'utf8'));
    assert.equal(owner.closed, false);
    const image = JSON.parse(await readFile(hostState(fixture.dataDir), 'utf8'));
    const marker = image.executors[`task:${owner.taskId}`];
    assert.equal(marker.status, 'retirement_unknown');
    assert.equal(marker.shutdownStopIntent, undefined);
    assert.equal(marker.shutdownStoppedReceipt, undefined);
    const lease = diskLeaseImage(fixture.dataDir).reservations.find(row =>
      row.taskId === owner.taskId && row.commandId === owner.commandId);
    assert.equal(lease?.shutdownStoppedReceipt, undefined);
    assert.equal((await requests(fixture.root)).filter(row => row.method === 'turn/start').length, 1);
  });
}
