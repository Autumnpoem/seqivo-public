import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, chmod, stat, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MacosExecutorJob, prepareExecutorJob, recoverExecutorJob, privateServer } from '../server/macos-executor-job.mjs';
import { writeJobRecord } from '../server/macos-executor-job-record.mjs';

const pythonPath = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';
const mac = process.platform === 'darwin';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = promisify(execFile);
async function output(stream, target, timeout = 3000) {
  return new Promise((resolve, reject) => {
    let value = '';
    const timer = setTimeout(() => { stream.off('data', data); reject(new Error(`output_timeout:${target}`)); }, timeout);
    const data = bytes => { value += bytes.toString(); if (value.includes(target)) {
      clearTimeout(timer); stream.off('data', data); resolve(value);
    } };
    stream.on('data', data);
    stream.once('error', error => { clearTimeout(timer); stream.off('data', data); reject(error); });
  });
}
async function eventuallyRetired(job, timeout = 4000) {
  const end = Date.now() + timeout;
  let state;
  do { state = await job.recheck(); if (state.retired) return state; await wait(100); }
  while (Date.now() < end);
  return state;
}

test('stop requested during startup prevents the original command ACK', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-start-stop-'));
  const marker = join(cwd, 'command-ran');
  const script = join(cwd, 'write.py');
  await writeFile(script, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('ran')\n`);
  const job = await prepareExecutorJob({ taskId: 'start-stop', command: pythonPath,
    args: [script], cwd, pythonPath, recordRoot: cwd });
  try {
    const starting = job.spawn();
    const stopping = job.stop();
    await assert.rejects(starting, /job_start_unconfirmed/);
    await stopping;
    await assert.rejects(access(marker), { code: 'ENOENT' });
    await assert.rejects(job.spawn(), /job_start_already_attempted|job_stop_already_requested/);
  } finally {
    try { await exec('/bin/launchctl', ['remove', job.label]); } catch {}
    await rm(job.directory, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test('stop at submitted and pre-ACK barriers never starts a command', { skip: !mac }, async () => {
  const prior = process.env.SEQIVO_JOB_TEST_FAILPOINTS;
  process.env.SEQIVO_JOB_TEST_FAILPOINTS = '1';
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-start-barrier-'));
  try {
    for (const stage of ['afterSubmit', 'beforeAck']) {
      const marker = join(cwd, `ran-${stage}`);
      const script = join(cwd, `${stage}.py`);
      await writeFile(script, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('ran')\n`);
      const job = await prepareExecutorJob({ taskId: `barrier-${stage}`,
        command: pythonPath, args: [script], cwd, pythonPath, recordRoot: cwd });
      let release, entered;
      const held = new Promise(resolve => { release = resolve; });
      const reached = new Promise(resolve => { entered = resolve; });
      try {
        const starting = job.spawn({ testBarrier: async current => {
          if (current === stage) { entered(); await held; }
        } });
        await Promise.race([reached, wait(4000).then(() => { throw new Error(`barrier_unreached:${stage}`); })]);
        const stopping = job.stop();
        release();
        await assert.rejects(starting, /job_start_unconfirmed/);
        await stopping;
        await assert.rejects(access(marker), { code: 'ENOENT' });
        await assert.rejects(job.spawn(), /job_start_already_attempted/);
        if (job.identity) assert.equal((await eventuallyRetired(job)).retired, true);
      } finally {
        release();
        try { await exec('/bin/launchctl', ['remove', job.label]); } catch {}
        await assert.rejects(exec('/bin/launchctl', ['list', job.label]));
        if (job.identity && (await eventuallyRetired(job)).retired) await job.dispose();
        else await rm(job.directory, { recursive: true, force: true });
      }
    }
  } finally {
    if (prior === undefined) delete process.env.SEQIVO_JOB_TEST_FAILPOINTS;
    else process.env.SEQIVO_JOB_TEST_FAILPOINTS = prior;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('stale durable record generation cannot overwrite a newer phase', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-record-cas-'));
  const job = await prepareExecutorJob({ taskId: 'cas', command: '/bin/cat',
    cwd, pythonPath, recordRoot: cwd });
  try {
    const path = join(job.recordRoot, `${job.recordId}.json`);
    const original = JSON.parse(await readFile(path, 'utf8'));
    const first = { ...original, phase: 'intent', attempted: true,
      generation: original.generation + 1 };
    await writeJobRecord(job.recordRoot, first, original.generation);
    await assert.rejects(writeJobRecord(job.recordRoot, { ...first, phase: 'prepared' },
      original.generation), /job_record_generation_changed/);
    const final = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(final.phase, 'intent');
    assert.equal(final.generation, first.generation);
  } finally {
    await job.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('only authenticated output socket closure counts as stream closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-job-socket-auth-'));
  let closed = 0, faults = 0;
  const path = join(root, 'stdout.sock');
  const endpoint = await privateServer(path, 'a'.repeat(64), () => { faults++; }, () => { closed++; });
  let valid;
  try {
    const bad = createConnection(path);
    await new Promise(resolve => bad.once('connect', resolve));
    const badClosed = new Promise(resolve => bad.once('close', resolve));
    bad.write('wrong\n');
    await assert.rejects(endpoint.connection, /unauthorized_socket/);
    await badClosed;
    assert.equal(closed, 0);
    assert.equal(faults, 0);
  } finally { endpoint.closeAll(); await rm(root, { recursive: true, force: true }); }

  const next = await mkdtemp(join(tmpdir(), 'seqivo-job-socket-extra-'));
  const endpoint2 = await privateServer(join(next, 'stderr.sock'), 'b'.repeat(64),
    () => { faults++; }, () => { closed++; });
  try {
    valid = createConnection(join(next, 'stderr.sock'));
    await new Promise(resolve => valid.once('connect', resolve));
    valid.write('b'.repeat(64) + '\n');
    await endpoint2.connection;
    const extra = createConnection(join(next, 'stderr.sock'));
    await new Promise(resolve => extra.once('connect', resolve));
    await new Promise(resolve => extra.once('close', resolve));
    assert.equal(closed, 0);
    assert.equal(faults, 0);
    const validClosed = new Promise(resolve => valid.once('close', resolve));
    valid.destroy(); await validClosed;
    assert.equal(closed, 1);
  } finally { valid?.destroy(); endpoint2.closeAll(); await rm(next, { recursive: true, force: true }); }
});

test('two launchd jobs have distinct coalitions and independent stdin/stdout', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-test-'));
  const a = await prepareExecutorJob({ taskId: 'A', command: '/bin/cat', cwd, pythonPath, recordRoot: cwd });
  const b = await prepareExecutorJob({ taskId: 'B', command: '/bin/cat', cwd, pythonPath, recordRoot: cwd });
  try {
    await a.spawn(); await b.spawn();
    assert.equal((await stat(a.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(a.directory, 'launch.json'))).mode & 0o777, 0o600);
    for (const name of ['control', 'stdin', 'stdout', 'stderr'])
      await assert.rejects(stat(join(a.directory, `${name}.sock`)), { code: 'ENOENT' });
    assert.throws(() => new MacosExecutorJob({ directory: cwd, label: b.label }), /job_must_be_prepared/);
    assert.throws(() => { a.label = b.label; }, TypeError);
    assert.throws(() => { a.directory = cwd; }, TypeError);
    assert.notEqual(a.identity.coalition.resource, b.identity.coalition.resource);
    const first = output(a.stdout, 'hello-A'); a.stdin.write('hello-A\n'); await first;
    const second = output(b.stdout, 'hello-B'); b.stdin.write('hello-B\n'); await second;
    const stoppedA = await a.stop();
    assert.ok(stoppedA.verified || stoppedA.unknown);
    assert.equal((await eventuallyRetired(a)).retired, true);
    const stillB = output(b.stdout, 'B-still-alive'); b.stdin.write('B-still-alive\n'); await stillB;
    assert.equal((await b.inspect()).count, 1);
    await b.stop();
    assert.equal((await eventuallyRetired(b)).retired, true);
  } finally {
    if (a.identity) { await a.stop(); if ((await eventuallyRetired(a)).retired) await a.dispose(); }
    if (b.identity) { await b.stop(); if ((await eventuallyRetired(b)).retired) await b.dispose(); }
    await rm(cwd, { recursive: true, force: true });
  }
});

test('original setsid orphan is retired by exact coalition member identity', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-orphan-'));
  const script = join(cwd, 'orphan.py');
  await writeFile(script, `import os,time\nif os.fork()==0:\n os.setsid()\n if os.fork()!=0: os._exit(0)\n print('orphan-ready',flush=True)\n time.sleep(2)\n os._exit(0)\ntime.sleep(8)\n`);
  const job = await prepareExecutorJob({ taskId: 'orphan', command: pythonPath,
    args: [script], cwd, pythonPath, recordRoot: cwd });
  try {
    await job.spawn();
    await output(job.stdout, 'orphan-ready');
    const before = await job.inspect();
    assert.ok(before.count >= 2);
    const first = await job.stop();
    assert.ok(first.retired || first.unknown);
    assert.equal((await eventuallyRetired(job, 5000)).retired, true);
    assert.equal((await job.recheck()).retired, true);
  } finally {
    if (job.identity) { await job.stop(); if ((await eventuallyRetired(job, 5000)).retired) await job.dispose(); }
    await rm(cwd, { recursive: true, force: true });
  }
});

test('native member signal rejects wrong cohort, unique identity and exec version; A stop preserves B', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-token-'));
  const a = await prepareExecutorJob({ taskId: 'token-A', command: '/bin/cat', cwd, pythonPath, recordRoot: cwd });
  const b = await prepareExecutorJob({ taskId: 'token-B', command: '/bin/cat', cwd, pythonPath, recordRoot: cwd });
  try {
    await a.spawn(); await b.spawn();
    const state = await a.inspect();
    assert.equal(state.count, 1);
    const member = state.members[0];
    assert.equal(typeof member.uniqueid, 'string');
    assert.ok(member.pidversion > 0);
    assert.notEqual(member.pidversion, a.identity.pidversion, 'exec changed the wrapper version');
    const target = { pid: member.pid, euid: member.euid, ruid: member.ruid,
      startSec: member.startSec, startUsec: member.startUsec,
      uniqueid: member.uniqueid, pidversion: member.pidversion,
      resource: a.identity.coalition.resource, signal: 15 };
    const helper = join(process.cwd(), 'plugins/codex-autocontinue/executor_job.py');
    for (const changed of [
      { resource: b.identity.coalition.resource },
      { uniqueid: String(BigInt(member.uniqueid) + 1n) },
      { pidversion: member.pidversion + 1 }
    ]) {
      let response;
      try { response = await exec(pythonPath, [helper, 'signal-member', JSON.stringify({ ...target, ...changed })]); }
      catch (error) { response = error; }
      assert.equal(JSON.parse(response.stdout).verified, false);
      assert.equal((await a.inspect()).count, 1);
      assert.equal((await b.inspect()).count, 1);
    }
    assert.equal((await a.stop()).retired || (await eventuallyRetired(a)).retired, true);
    const bEcho = output(b.stdout, 'other-job-alive');
    b.stdin.write('other-job-alive\n'); await bEcho;
  } finally {
    for (const job of [a, b]) {
      if (job.identity) { await job.stop(); if ((await eventuallyRetired(job)).retired) await job.dispose(); }
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test('signal API unavailable leaves original member live until a fresh verified stop', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-signal-error-'));
  const runner = join(cwd, 'runner.py'), marker = join(cwd, 'signal-unavailable');
  const orphan = join(cwd, 'orphan.py');
  await writeFile(orphan, `import os,time\nif os.fork()==0:\n os.setsid()\n if os.fork()!=0: os._exit(0)\n print('signal-test-orphan',flush=True)\n time.sleep(12)\n os._exit(0)\nos._exit(0)\n`);
  await writeFile(runner, `#!${pythonPath}\nimport os,sys\n`
    + `if len(sys.argv)>3 and sys.argv[1]=='-B' and sys.argv[3]=='signal-member' and os.path.exists(${JSON.stringify(marker)}):\n`
    + ` print('{"verified":false,"reason":"audit_token_signal_unsupported"}'); sys.exit(0)\n`
    + `os.execv(${JSON.stringify(pythonPath)},[${JSON.stringify(pythonPath)},*sys.argv[1:]])\n`);
  await chmod(runner, 0o700);
  const job = await prepareExecutorJob({ taskId: 'signal-error', command: pythonPath,
    args: [orphan], cwd, pythonPath: runner, recordRoot: cwd });
  try {
    await job.spawn();
    await output(job.stdout, 'signal-test-orphan');
    await writeFile(marker, '1');
    const denied = await job.stop();
    assert.equal(denied.unknown, true);
    assert.equal(denied.reason, 'audit_token_signal_unsupported');
    assert.equal((await job.inspect()).count, 1);
    await rm(marker);
    assert.equal((await job.stop()).retired || (await eventuallyRetired(job)).retired, true);
  } finally {
    await rm(marker, { force: true });
    if (job.identity) { await job.stop(); if ((await eventuallyRetired(job)).retired) await job.dispose(); }
    await rm(cwd, { recursive: true, force: true });
  }
});

test('leader exit leaves original setsid member to stop by coalition', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-leader-exit-'));
  const script = join(cwd, 'orphan.py');
  await writeFile(script, `import os,time\nif os.fork()==0:\n os.setsid()\n if os.fork()!=0: os._exit(0)\n print('orphan-live',flush=True)\n time.sleep(12)\n os._exit(0)\nos._exit(0)\n`);
  const job = await prepareExecutorJob({ taskId: 'leader-exit', command: pythonPath,
    args: [script], cwd, pythonPath, recordRoot: cwd });
  try {
    await job.spawn();
    await output(job.stdout, 'orphan-live');
    const before = await job.inspect();
    assert.ok(before.count >= 1);
    assert.equal(before.members.some(member => member.pid !== job.identity.pid), true);
    const result = await job.stop();
    assert.equal(result.retired || (await eventuallyRetired(job)).retired, true, JSON.stringify(result));
  } finally {
    if (job.identity) { await job.stop(); if ((await eventuallyRetired(job)).retired) await job.dispose(); }
    await rm(cwd, { recursive: true, force: true });
  }
});

test('TERM-resistant original orphan needs identity-bound KILL and cannot write late; B survives', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-kill-escalation-'));
  const marker = join(cwd, 'late-write');
  const script = join(cwd, 'resistant.py');
  await writeFile(script, `import os,signal,time\nif os.fork()==0:\n os.setsid()\n if os.fork()!=0: os._exit(0)\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n print('resistant-ready',flush=True)\n time.sleep(4)\n open(${JSON.stringify(marker)},'w').write('late')\n os._exit(0)\nos._exit(0)\n`);
  const a = await prepareExecutorJob({ taskId: 'kill-A', command: pythonPath,
    args: [script], cwd, pythonPath, recordRoot: cwd });
  const b = await prepareExecutorJob({ taskId: 'kill-B', command: '/bin/cat',
    cwd, pythonPath, recordRoot: cwd });
  try {
    await a.spawn(); await b.spawn();
    await output(a.stdout, 'resistant-ready');
    const before = await a.inspect();
    assert.equal(before.members.some(member => member.pid !== a.identity.pid), true);
    const start = Date.now();
    const stopped = await a.stop();
    assert.equal(stopped.retired || (await eventuallyRetired(a)).retired, true, JSON.stringify(stopped));
    assert.ok(Date.now() - start < 4000, 'retired before the delayed write window');
    const bEcho = output(b.stdout, 'B-after-kill'); b.stdin.write('B-after-kill\n'); await bEcho;
    assert.equal((await b.inspect()).count, 1);
    await wait(4200);
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally {
    for (const job of [a, b]) {
      if (job.identity) { await job.stop(); if ((await eventuallyRetired(job)).retired) await job.dispose(); }
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test('naturally completed short job can still prove coalition retirement', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-short-'));
  const job = await prepareExecutorJob({ taskId: 'short', command: '/bin/echo',
    args: ['short-complete'], cwd, pythonPath, recordRoot: cwd });
  try {
    try { await job.spawn(); } catch (error) { throw new Error(`short_start:${error.reason}`); }
    await output(job.stdout, 'short-complete');
    await wait(200);
    const stopped = await job.stop();
    assert.equal(stopped.retired || (await eventuallyRetired(job)).retired, true);
  } finally {
    if (job.identity) { await job.stop(); if ((await eventuallyRetired(job)).retired) await job.dispose(); }
    else {
      await job.stop();
      try { await exec('/bin/launchctl', ['remove', job.label]); } catch {}
      await assert.rejects(exec('/bin/launchctl', ['list', job.label]));
      await rm(job.directory, { recursive: true, force: true });
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test('invalid prelaunch path leaves no job', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-invalid-'));
  try {
    await assert.rejects(prepareExecutorJob({ taskId: 'bad', command: join(cwd, 'absent'),
      cwd, pythonPath, recordRoot: cwd }));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('launch command inherits blocking stdin after delayed input', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-blocking-'));
  const script = join(cwd, 'blocking.py'), marker = join(cwd, 'flags.json');
  await writeFile(script, `import fcntl,json,os,sys,time\n`
    + `flags=[bool(fcntl.fcntl(i,fcntl.F_GETFL)&os.O_NONBLOCK) for i in range(3)]\n`
    + `open(${JSON.stringify(marker)},'w').write(json.dumps({'flags':flags}))\n`
    + `try: value=sys.stdin.readline(); outcome={'value':value}\n`
    + `except Exception as exc: outcome={'error':type(exc).__name__}\n`
    + `open(${JSON.stringify(marker)},'w').write(json.dumps({'flags':flags,**outcome}))\n`
    + `print('stdout-ok',flush=True); print('stderr-ok',file=sys.stderr,flush=True)\n`
    + `time.sleep(3)\n`);
  const job = await prepareExecutorJob({ taskId: 'blocking', command: pythonPath,
    args: [script], cwd, pythonPath, recordRoot: cwd });
  try {
    await job.spawn(); await wait(350);
    const before = JSON.parse(await readFile(marker, 'utf8'));
    assert.deepEqual(before.flags, [false, false, false]);
    job.stdin.write('after-delay\n'); await wait(100);
    const after = JSON.parse(await readFile(marker, 'utf8'));
    assert.equal(after.value, 'after-delay\n');
    await output(job.stdout, 'stdout-ok');
    await output(job.stderr, 'stderr-ok');
  } finally {
    if (job.identity) { await job.stop(); if ((await eventuallyRetired(job)).retired) await job.dispose(); }
    await rm(cwd, { recursive: true, force: true });
  }
});

test('observer read failure and replaced leader identity remain unknown', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-observer-'));
  const runner = join(cwd, 'runner.py'), marker = join(cwd, 'observer-mode');
  await writeFile(runner, `#!${pythonPath}\nimport json,os,subprocess,sys\n`
    + `real=${JSON.stringify(pythonPath)}\nmarker=${JSON.stringify(marker)}\n`
    + `mode=open(marker).read().strip() if os.path.exists(marker) else ''\n`
    + `if len(sys.argv)>3 and sys.argv[1]=='-B' and sys.argv[3]=='observe' and mode:\n`
    + ` if mode=='read-error': print(json.dumps({'verified':False,'reason':'forced_read_failure'})); sys.exit(2)\n`
    + ` result=subprocess.run([real,*sys.argv[1:]],capture_output=True,text=True)\n`
    + ` data=json.loads(result.stdout)\n`
    + ` if mode=='replace' and data.get('verified') and data.get('members'):\n`
    + `  data['members'][0]['startUsec']+=1\n`
    + ` print(json.dumps(data)); sys.exit(result.returncode)\n`
    + `os.execv(real,[real,*sys.argv[1:]])\n`);
  await chmod(runner, 0o700);
  const job = await prepareExecutorJob({ taskId: 'observer', command: '/bin/cat', cwd,
    pythonPath: runner, recordRoot: cwd });
  try {
    await job.spawn();
    await writeFile(marker, 'read-error');
    assert.equal((await job.inspect()).unknown, true);
    await writeFile(marker, 'replace');
    const replaced = await job.inspect();
    assert.equal(replaced.unknown, true);
    assert.equal(replaced.reason, 'job_pid_identity_changed');
    await rm(marker);
    await job.stop();
    assert.equal((await eventuallyRetired(job)).retired, true);
  } finally {
    await rm(marker, { force: true });
    if (job.identity) { await job.stop(); if ((await eventuallyRetired(job)).retired) await job.dispose(); }
    await rm(cwd, { recursive: true, force: true });
  }
});

test('unknown submitted startup cannot retry or serialize recovery capability', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-start-fail-'));
  const runner = join(cwd, 'exit-launch.py');
  await writeFile(runner, `#!${pythonPath}\nimport os,sys\n`
    + `if len(sys.argv)>3 and sys.argv[1]=='-B' and sys.argv[3]=='launch': sys.exit(0)\n`
    + `real=${JSON.stringify(pythonPath)}\nos.execv(real,[real,*sys.argv[1:]])\n`);
  await chmod(runner, 0o700);
  const job = await prepareExecutorJob({ taskId: 'start-fail', command: '/bin/cat', cwd,
    pythonPath: runner, recordRoot: cwd });
  try {
    let failure;
    try { await job.spawn(); } catch (error) { failure = error; }
    assert.equal(failure?.message, 'job_start_unconfirmed');
    assert.equal(failure.recovery, job);
    assert.equal(Object.prototype.propertyIsEnumerable.call(failure, 'recovery'), false);
    assert.equal(JSON.stringify(failure).includes(job.directory), false);
    assert.deepEqual(JSON.parse(JSON.stringify(job)), { state: 'unconfirmed' });
    await assert.rejects(job.spawn(), /job_start_already_attempted/);
    assert.equal((await job.stop()).unknown, true);
    assert.equal((await job.recheck()).unknown, true);
  } finally {
    // This fixture exits without forking; the test alone verifies launchd no
    // longer has its unique label before cleaning its private test directory.
    try { await exec('/bin/launchctl', ['remove', job.label]); } catch {}
    await assert.rejects(exec('/bin/launchctl', ['list', job.label]));
    await rm(job.directory, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test('runtime socket error is handled and leaves process result unknown', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-socket-error-'));
  const job = await prepareExecutorJob({ taskId: 'socket-error', command: '/bin/cat',
    cwd, pythonPath, recordRoot: cwd });
  try {
    await job.spawn();
    job.stdin.destroy(new Error('fixture_socket_error'));
    await wait(50);
    const state = await job.inspect();
    assert.equal(state.verified, true);
    assert.equal(state.ioFault, true);
    await job.stop();
    const retired = await eventuallyRetired(job);
    assert.equal(retired.retired, true, JSON.stringify(retired));
    assert.equal(retired.ioFault, true);
    assert.equal(retired.resultUnknown, true);
    await job.dispose();
  } finally {
    if (job.identity && !(await job.recheck()).retired) {
      await job.stop();
      if ((await eventuallyRetired(job)).retired) await job.dispose();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test('separate creator exit recovers only its original job and preserves B', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-recover-'));
  const b = await prepareExecutorJob({ taskId: 'recover-B', command: '/bin/cat',
    cwd, pythonPath, recordRoot: cwd });
  let recordId, recovered;
  try {
    await b.spawn();
    const script = `import { prepareExecutorJob } from './server/macos-executor-job.mjs';\n`
      + `const job=await prepareExecutorJob({taskId:'recover-A',command:'/bin/sleep',args:['12'],`
      + `cwd:${JSON.stringify(cwd)},recordRoot:${JSON.stringify(cwd)},`
      + `pythonPath:${JSON.stringify(pythonPath)}});\n`
      + `await job.spawn();process.stdout.write(JSON.stringify({recordId:job.recordId})+'\\n',()=>process.exit(0));`;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script],
      { cwd: process.cwd(), timeout: 8000 });
    recordId = JSON.parse(stdout.trim()).recordId;
    assert.equal((await recoverExecutorJob({ recordRoot: cwd, recordId,
      taskId: 'wrong-task', cwd, pythonPath })).unknown, true);
    recovered = await recoverExecutorJob({ recordRoot: cwd, recordId,
      taskId: 'recover-A', cwd, pythonPath });
    assert.equal(recovered.verified, true);
    const stale = await recoverExecutorJob({ recordRoot: cwd, recordId,
      taskId: 'recover-A', cwd, pythonPath });
    assert.equal(stale.verified, true);
    await assert.rejects(recovered.job.spawn(), /job_start_already_attempted|job_recovery_cannot_spawn/);
    await recovered.job.stop();
    const retired = await eventuallyRetired(recovered.job);
    assert.equal(retired.retired, true, JSON.stringify(retired));
    assert.equal(retired.resultUnknown, true);
    assert.equal(retired.streamStatus, 'unobserved_after_owner_exit');
    const aliveB = output(b.stdout, 'B-survived-recovery');
    b.stdin.write('B-survived-recovery\n'); await aliveB;
    await recovered.job.dispose();
    const tombstone = await readFile(join(cwd, `${recordId}.json`), 'utf8');
    assert.equal((await stale.job.stop()).unknown, true);
    assert.equal(JSON.parse(await readFile(join(cwd, `${recordId}.json`), 'utf8')).phase, 'retired');
    assert.equal(tombstone.includes('capability'), false);
    assert.equal(tombstone.includes('env'), false);
    const again = await recoverExecutorJob({ recordRoot: cwd, recordId,
      taskId: 'recover-A', cwd, pythonPath });
    assert.equal(again.verified, true);
    await assert.rejects(again.job.spawn(), /job_start_already_attempted|job_recovery_cannot_spawn/);
    await again.job.dispose();
  } finally {
    if (recovered?.job && !recovered.job.toJSON().state.includes('retired')) {
      await recovered.job.stop();
      if ((await eventuallyRetired(recovered.job)).retired) await recovered.job.dispose();
    }
    if (recordId && !recovered?.job) {
      try { await exec('/bin/launchctl', ['remove', `com.seqivo.executor.${recordId}`]); } catch {}
    }
    await b.stop(); if ((await eventuallyRetired(b)).retired) await b.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('durable failpoints never ACK or re-submit an unknown command', { skip: !mac }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'seqivo-job-failpoints-'));
  const command = join(cwd, 'write-marker.py');
  try {
    for (const stage of ['beforeSubmit', 'afterSubmit', 'beforeIdentityCommit']) {
      const marker = join(cwd, `executed-${stage}`);
      await writeFile(command, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('executed')\n`);
      const taskId = `fail-${stage}`;
      const script = `import { prepareExecutorJob } from './server/macos-executor-job.mjs';\n`
        + `const job=await prepareExecutorJob({taskId:${JSON.stringify(taskId)},`
        + `command:${JSON.stringify(pythonPath)},args:[${JSON.stringify(command)}],`
        + `cwd:${JSON.stringify(cwd)},recordRoot:${JSON.stringify(cwd)},`
        + `pythonPath:${JSON.stringify(pythonPath)}});\n`
        + `let failed=false;try{await job.spawn({testFailpoint:${JSON.stringify(stage)}})}`
        + `catch{failed=true}process.stdout.write(JSON.stringify({recordId:job.recordId,failed})+'\\n',()=>process.exit(0));`;
      const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script],
        { cwd: process.cwd(), env: { ...process.env, SEQIVO_JOB_TEST_FAILPOINTS: '1' }, timeout: 10000 });
      const result = JSON.parse(stdout.trim());
      assert.equal(result.failed, true, stage);
      const record = JSON.parse(await readFile(join(cwd, `${result.recordId}.json`), 'utf8'));
      assert.equal(record.attempted, true, stage);
      assert.equal(record.identity, null, stage);
      assert.equal(JSON.stringify(record).includes('capability'), false);
      await assert.rejects(access(marker), { code: 'ENOENT' });
      const recovered = await recoverExecutorJob({ recordRoot: cwd, recordId: result.recordId,
        taskId, cwd, pythonPath });
      assert.equal(recovered.verified, true, stage);
      await assert.rejects(recovered.job.spawn(), /job_start_already_attempted|job_recovery_cannot_spawn/);
      assert.equal((await recovered.job.stop()).unknown, true);
      await assert.rejects(exec('/bin/launchctl', ['list', record.label]));
      // Test-owned fixture never received execution ACK, so its private
      // launch config can be removed after the unique label is absent.
      await rm(record.directory, { recursive: true, force: true });
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
