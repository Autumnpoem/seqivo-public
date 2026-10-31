import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { captureExecutorBaseline, captureTaskExecutorTree, verifyTaskExecutorRetired } from '../server/executor-process-proof.mjs';

const pythonPath = process.env.TASKBOARD_TEST_PYTHON || 'python3';
const darwin = process.platform === 'darwin';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
async function until(fn, reason) { const until = Date.now() + 5000; while (Date.now() < until) { if (await fn()) return; await delay(25); } throw new Error(reason); }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'executor-retirement-'));
  const workspace = join(root, 'project'), elsewhere = join(root, 'elsewhere');
  await mkdir(workspace); await mkdir(elsewhere);
  const marker = join(root, 'pids.json'), go = join(root, 'go'), orphanFile = join(root, 'orphan');
  const appScript = join(root, 'app.py'), bridgeScript = join(root, 'bridge.py');
  await writeFile(appScript, `import os,time,json\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).write_text(json.dumps({'app':os.getpid()}))\nwhile not Path(${JSON.stringify(go)}).exists(): time.sleep(.02)\npid=os.fork()\nif pid:\n Path(${JSON.stringify(orphanFile)}).write_text(str(pid))\n os._exit(0)\nos.setsid()\nos.chdir(${JSON.stringify(elsewhere)})\ntime.sleep(120)\n`);
  await writeFile(bridgeScript, `import subprocess,time,sys\nchild=subprocess.Popen([sys.executable,'-B',${JSON.stringify(appScript)}])\nwhile True:\n child.poll()\n time.sleep(.02)\n`);
  let bridge, appPid, orphan;
  t.after(async () => {
    for (const pid of [orphan, appPid, bridge?.pid].filter(Boolean)) {
      if (!alive(pid)) continue;
      const command = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      assert.ok(command.includes(root), 'Cleanup PID no longer belongs to this fixture');
      process.kill(pid, 'SIGTERM');
    }
    if (bridge) await until(() => bridge.exitCode !== null || bridge.signalCode !== null, 'Fixture bridge failed to exit');
    await rm(root, { recursive: true, force: true });
  });
  const initial = await captureExecutorBaseline({ pythonPath });
  assert.equal(initial.verified, true, initial.reason);
  bridge = spawn(pythonPath, [bridgeScript], { cwd: workspace, stdio: 'ignore' });
  await until(async () => { try { appPid = JSON.parse(await readFile(marker, 'utf8')).app; return !!appPid; } catch { return false; } }, 'App did not start');
  const result = await captureTaskExecutorTree({ baseline: initial.baseline, taskId: 'task-A',
    bridgePid: bridge.pid, appServerPid: appPid, workspace, pythonPath });
  assert.equal(result.verified, true, result.reason);
  return { root, workspace, bridge, appPid, capture: result.capture,
    async verify(overrides = {}) { return verifyTaskExecutorRetired({ capture: result.capture,
      taskId: 'task-A', bridgePid: bridge.pid, appServerPid: appPid, workspace, pythonPath, ...overrides }); },
    async stop() {
      if (alive(appPid)) { process.kill(appPid, 'SIGTERM'); await until(() => !alive(appPid), 'App failed to exit'); }
      if (alive(bridge.pid)) { bridge.kill('SIGTERM'); await until(() => !alive(bridge.pid), 'Bridge failed to exit'); }
    },
    async orphanAfterCapture() {
      await writeFile(go, 'fork');
      await until(async () => { try { orphan = Number(await readFile(orphanFile, 'utf8')); return !!orphan; } catch { return false; } }, 'Orphan did not start');
      await until(() => !alive(appPid), 'Parent did not exit');
      return orphan;
    },
  };
}

test('live dedicated executor cannot be retired; gone executor is proved while unrelated process remains', { skip: !darwin }, async t => {
  const f = await fixture(t);
  // B is deliberately born after A's baseline, so exclusion must use its
  // stable outside ancestor rather than merely finding B in the baseline.
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGTERM'));
  const live = await f.verify();
  assert.equal(live.retired, false);
  assert.ok(live.liveIdentities.some(row => row.pid === f.appPid), JSON.stringify(live));
  await f.stop();
  const ended = await f.verify();
  assert.equal(ended.retired, true, JSON.stringify(ended));
  assert.equal(alive(other.pid), true);
});

test('a child born after capture, orphaned and outside workspace cannot produce a stopped-positive', { skip: !darwin }, async t => {
  const f = await fixture(t);
  const orphan = await f.orphanAfterCapture();
  await f.stop();
  const result = await f.verify();
  assert.equal(result.retired, false);
  assert.equal(result.unknown, true);
  assert.ok(result.unassignedIdentities?.some(row => row.pid === orphan), JSON.stringify(result));
  assert.equal(alive(orphan), true, 'Read-only proof must never terminate an unassigned process');
});

test('serialized captures and post-spawn baselines cannot authorize retirement', { skip: !darwin }, async t => {
  const f = await fixture(t);
  const copied = await f.verify({ capture: JSON.parse(JSON.stringify(f.capture)) });
  assert.equal(copied.unknown, true);
  const wrongTask = await f.verify({ taskId: 'task-B' });
  assert.equal(wrongTask.unknown, true);
  assert.match(wrongTask.reason, /expected task/);
  const wrongProcess = await f.verify({ appServerPid: process.pid });
  assert.equal(wrongProcess.unknown, true);
  assert.match(wrongProcess.reason, /expected task/);
  const late = await captureExecutorBaseline({ pythonPath });
  assert.equal(late.verified, true, late.reason);
  const result = await captureTaskExecutorTree({ baseline: late.baseline, taskId: 'task-A',
    bridgePid: f.bridge.pid, appServerPid: f.appPid, workspace: f.workspace, pythonPath });
  assert.equal(result.verified, false);
  assert.match(result.reason, /newly spawned/);
});

test('unsupported platforms retain unknown without issuing an executor capability', async () => {
  const result = await captureExecutorBaseline({ pythonPath, platform: 'unsupported' });
  assert.equal(result.unknown, true); assert.equal(result.baseline, null);
});

test('Linux exact executor proof leaves a detached unassigned process alive and requires cooperative cleanup',
  { skip: process.platform !== 'linux' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'linux-executor-proof-'));
    const workspace = join(root, 'workspace'), elsewhere = join(root, 'elsewhere');
    await mkdir(workspace); await mkdir(elsewhere);
    const fixtureScript = fileURLToPath(new URL('./fixtures/linux-executor-tree.mjs', import.meta.url));
    const marker = name => join(root, name);
    let bridge, outsider, lines, bridgeIter, appPid = null, orphanPid = null;
    const waitFor = async (check, reason, timeout = 7000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await check()) return; await delay(25); }
      throw new Error(reason);
    };
    const procExists = async pid => { try { await access(`/proc/${pid}`); return true; } catch (error) {
      if (error.code === 'ENOENT') return false; throw error;
    } };
    t.after(async () => {
      // Every fixture process exits through a private stop marker. We deliberately
      // do not signal arbitrary PIDs or remove evidence while exit is uncertain.
      for (const name of ['app.stop', 'orphan.stop', 'outsider.stop'])
        await writeFile(marker(name), 'cleanup').catch(() => {});
      if (bridge?.exitCode === null && bridge?.signalCode === null) {
        bridge.stdin.write('stop\n');
        await new Promise(resolve => bridge.once('exit', resolve));
      }
      if (outsider && outsider.exitCode === null && outsider.signalCode === null)
        await new Promise(resolve => outsider.once('exit', resolve));
      if (orphanPid) await waitFor(() => readFile(marker('orphan.exited'), 'utf8').then(() => true, () => false),
        'Detached fixture did not acknowledge cooperative cleanup');
      const pending = [bridge?.pid, appPid, outsider?.pid, orphanPid].filter(Boolean);
      await waitFor(async () => (await Promise.all(pending.map(procExists))).every(value => !value),
        'Fixture process exit was not confirmed; retaining its private directory');
      await rm(root, { recursive: true, force: true });
    });

    outsider = spawn(process.execPath, [fixtureScript, 'outsider', root, elsewhere], {
      cwd: elsewhere, stdio: 'ignore',
    });
    await waitFor(() => readFile(marker('pid.outsider.marker'), 'utf8').then(() => true, () => false),
      'Unrelated fixture did not start');
    const initial = await captureExecutorBaseline({ pythonPath });
    assert.equal(initial.verified, true, initial.reason);
    bridge = spawn(process.execPath, [fixtureScript, 'bridge', root, workspace], {
      cwd: workspace, stdio: ['pipe', 'pipe', 'ignore'],
    });
    lines = createInterface({ input: bridge.stdout });
    bridgeIter = lines[Symbol.asyncIterator]();
    const ready = JSON.parse((await bridgeIter.next()).value);
    assert.equal(ready.type, 'ready');
    appPid = ready.appPid;
    const captured = await captureTaskExecutorTree({ baseline: initial.baseline, taskId: 'linux-task',
      bridgePid: ready.bridgePid, appServerPid: ready.appPid, workspace, pythonPath });
    assert.equal(captured.verified, true, captured.reason);
    assert.ok(captured.identities.some(row => row.pid === ready.appPid));
    const afterRestartMarker = await verifyTaskExecutorRetired({ capture: JSON.parse(JSON.stringify(captured.capture)),
      taskId: 'linux-task', bridgePid: ready.bridgePid, appServerPid: ready.appPid, workspace, pythonPath });
    assert.equal(afterRestartMarker.unknown, true,
      'a serialized/restarted marker without its in-memory capture capability stays unknown');

    const live = await verifyTaskExecutorRetired({ capture: captured.capture, taskId: 'linux-task',
      bridgePid: ready.bridgePid, appServerPid: ready.appPid, workspace, pythonPath });
    assert.equal(live.retired, false);
    assert.ok(live.liveIdentities.some(row => row.pid === ready.appPid));

    bridge.stdin.write('orphan\n');
    const orphan = JSON.parse((await bridgeIter.next()).value);
    assert.equal(orphan.type, 'orphan'); orphanPid = orphan.pid;
    bridge.stdin.write('stop\n');
    await new Promise((resolve, reject) => {
      bridge.once('exit', code => code === 0 ? resolve() : reject(new Error(`bridge exited ${code}`)));
    });
    await waitFor(() => readFile(marker('app.exited'), 'utf8').then(() => true, () => false),
      'Owned app server did not acknowledge cooperative stop');
    const unknown = await verifyTaskExecutorRetired({ capture: captured.capture, taskId: 'linux-task',
      bridgePid: ready.bridgePid, appServerPid: ready.appPid, workspace, pythonPath });
    assert.equal(unknown.retired, false);
    assert.equal(unknown.unknown, true);
    assert.ok(unknown.unassignedIdentities?.some(row => row.pid === orphanPid), JSON.stringify(unknown));
    assert.equal(await procExists(orphanPid), true, 'Proof must not terminate an unassigned process');

    await writeFile(marker('orphan.stop'), 'cooperative stop');
    await waitFor(() => readFile(marker('orphan.exited'), 'utf8').then(() => true, () => false),
      'Detached process did not acknowledge its own stop request');
    await waitFor(async () => !(await procExists(orphanPid)), 'Detached fixture exit was not observable');
    const retired = await verifyTaskExecutorRetired({ capture: captured.capture, taskId: 'linux-task',
      bridgePid: ready.bridgePid, appServerPid: ready.appPid, workspace, pythonPath });
    assert.equal(retired.retired, true, JSON.stringify(retired));
    assert.equal(retired.unknown, false);
    assert.equal(await procExists(outsider.pid), true, 'an unrelated baseline process remains live through retirement proof');
    await writeFile(marker('outsider.stop'), 'cooperative stop');
    await new Promise(resolve => outsider.once('exit', resolve));
  });

test('prelaunch baseline retries only incomplete changing lists, with a strict three-read limit', { skip: !darwin }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'executor-baseline-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const helper = join(dir, 'native-stub'), counter = join(dir, 'count');
  async function prepare(reasons) {
    await writeFile(counter, '0');
    await writeFile(helper, `#!${process.execPath}\nconst fs=require('node:fs');
const file=${JSON.stringify(counter)},n=Number(fs.readFileSync(file,'utf8'));fs.writeFileSync(file,String(n+1));
const reason=${JSON.stringify(reasons)}[n]??null;
const output={schemaVersion:1,uid:process.geteuid(),observerPid:process.pid,ignoredObserverPid:process.pid,
 scope:'macos-all-visible-exact-births-two-observed-enumerations',verified:!reason,reason,attempts:2,rows:[]};
process.stdout.write(JSON.stringify(output));process.exit(reason?2:0);\n`, { mode: 0o700 });
  }
  await prepare(['identity_set_changed', 'list_changed_during_scan']);
  const complete = await captureExecutorBaseline({ pythonPath: helper });
  assert.equal(complete.verified, true); assert.equal(complete.attempts, 3);
  assert.equal(await readFile(counter, 'utf8'), '3');
  await prepare(Array(4).fill('identity_set_changed'));
  const unstable = await captureExecutorBaseline({ pythonPath: helper });
  assert.equal(unstable.unknown, true); assert.equal(unstable.baseline, null);
  assert.equal(await readFile(counter, 'utf8'), '3');
  for (const reason of ['abi_mismatch', 'pid_info_incomplete', 'pid_identity_changed']) {
    await prepare([reason]);
    const failed = await captureExecutorBaseline({ pythonPath: helper });
    assert.equal(failed.unknown, true); assert.equal(failed.baseline, null);
    assert.equal(await readFile(counter, 'utf8'), '1');
  }
});
