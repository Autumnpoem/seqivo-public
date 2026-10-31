import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createExecutorJobCohortObserverForTest, observeExecutorJobCohort,
  prepareExecutorJob } from '../server/macos-executor-job.mjs';
import { readJobRecord } from '../server/macos-executor-job-record.mjs';

const args = Object.freeze({ recordRoot: '/private/test', recordId: 'record-a',
  taskId: 'task-a', workspace: '/private/project', pythonPath: '/private/python' });
const identity = (pid, uniqueid = String(pid)) => ({ pid, euid: 501, ruid: 501,
  startSec: pid + 1000, startUsec: 7, uniqueid, pidversion: pid + 100,
  coalition: { resource: 12345 } });
const leader = identity(101);
const member = identity(102);
const record = () => ({ recordId: args.recordId, taskId: args.taskId,
  workspace: args.workspace, recordRoot: args.recordRoot, generation: 3,
  phase: 'identity', attempted: true, ioFault: false,
  pythonPath: args.pythonPath, boot: 'boot-a', directory: '/private/job-a',
  label: 'label-a', rootIdentity: { dev: 1, ino: 2 },
  directoryIdentity: { dev: 1, ino: 3 }, identity: structuredClone(leader) });
const snapshot = (...members) => ({ verified: true, count: members.length,
  members: structuredClone(members) });

function fixture(samples, readRecord = async () => record()) {
  let observed = 0, reads = 0, sleeps = 0, time = 0;
  const observer = createExecutorJobCohortObserverForTest({
    platform: 'darwin', canonicalPython: async path => path,
    readRecord: async (...values) => { reads++; return readRecord(...values); },
    observe: async (_path, _coalition, timeoutMs) => {
      assert.ok(timeoutMs > 0 && timeoutMs <= 2000);
      return samples[observed++];
    },
    sleep: async ms => { sleeps++; time += ms; }, now: () => time
  });
  return { observer, counts: () => ({ observed, reads, sleeps }) };
}

test('complete membership growth admits only after adjacent stable samples', async () => {
  const a = fixture([snapshot(leader), snapshot(leader, member), snapshot(leader, member)]);
  const result = await a.observer(args);
  assert.equal(result.verified, true);
  assert.deepEqual(result.members.map(row => row.pid), [101, 102]);
  assert.deepEqual(a.counts(), { observed: 3, reads: 7, sleeps: 2 });
  assert.deepEqual(result.diagnostic, { stage: 'compare', detail: 'stable', samplesAttempted: 3,
    elapsedMs: 100, helperReason: null });
  assert.equal(JSON.stringify(result).includes('diagnostic'), false);
});

test('continued complete member changes remain unknown at the sample limit', async () => {
  const a = fixture([snapshot(leader), snapshot(leader, member),
    snapshot(leader, member, identity(103)),
    snapshot(leader, member, identity(103), identity(104))]);
  const result = await a.observer(args);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'job_current_cohort_unconfirmed');
  assert.deepEqual(a.counts(), { observed: 4, reads: 9, sleeps: 3 });
  assert.equal(result.diagnostic.detail, 'sample_limit');
  assert.equal(result.diagnostic.samplesAttempted, 4);
});

test('post-exec leader version can differ from its original durable identity', async () => {
  const currentLeader = { ...leader, pidversion: leader.pidversion + 1 };
  const a = fixture([snapshot(currentLeader, member), snapshot(currentLeader, member)]);
  const result = await a.observer(args);
  assert.equal(result.verified, true);
  assert.equal(result.members.find(row => row.pid === leader.pid).pidversion,
    currentLeader.pidversion);
  assert.deepEqual(a.counts(), { observed: 2, reads: 5, sleeps: 1 });
});

test('wrong leader birth, UID, unique ID or coalition rejects the first snapshot', async () => {
  for (const wrong of [
    { ...leader, startUsec: 8 }, { ...leader, euid: 502 },
    { ...leader, uniqueid: '999' },
    { ...leader, coalition: { resource: 456 } }
  ]) {
    const a = fixture([snapshot(wrong), snapshot(leader)]);
    const result = await a.observer(args);
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'job_current_cohort_unconfirmed');
    assert.deepEqual(a.counts(), { observed: 1, reads: 2, sleeps: 0 });
  }
});

test('leader pidversion changes between current samples remain unknown', async () => {
  const first = { ...leader, pidversion: leader.pidversion + 1 };
  const second = { ...leader, pidversion: leader.pidversion + 2 };
  const a = fixture([snapshot(first, member), snapshot(second, member),
    snapshot(second, member)]);
  const result = await a.observer(args);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'job_current_cohort_changed');
  assert.deepEqual(a.counts(), { observed: 2, reads: 5, sleeps: 1 });
});

test('nonretryable helper failure, malformed retry envelope and incomplete membership reject immediately', async () => {
  for (const bad of [{ verified: false, reason: 'coalition_member_changed' },
    { verified: false, reason: 'coalition_count_changed', members: [leader] },
    { verified: true, count: 3, members: [leader, member] },
    snapshot(leader, leader)]) {
    const a = fixture([bad, snapshot(leader)]);
    assert.equal((await a.observer(args)).verified, false);
    assert.equal(a.counts().observed, 1);
  }
});

test('only three fixed transient scans may retry; two later complete identical cohorts still decide admission', async () => {
  for (const reason of ['coalition_count_changed', 'native_identity_set_changed',
    'native_list_changed_during_scan']) {
    const a = fixture([{ verified: false, reason }, snapshot(leader, member), snapshot(leader, member)]);
    const result = await a.observer(args);
    assert.equal(result.verified, true, reason);
    assert.deepEqual(result.members.map(row => row.pid), [101, 102]);
    assert.deepEqual(a.counts(), { observed: 3, reads: 7, sleeps: 2 });
    assert.equal(result.diagnostic.samplesAttempted, 3);
    assert.equal(result.diagnostic.elapsedMs, 100);
  }
});

test('invalid scan resets consecutive stability but retains previously seen PID identity', async () => {
  const a = fixture([snapshot(leader, member), { verified: false, reason: 'coalition_count_changed' },
    snapshot(leader, member), snapshot(leader, member)]);
  const result = await a.observer(args);
  assert.equal(result.verified, true);
  assert.deepEqual(a.counts(), { observed: 4, reads: 9, sleeps: 3 });
  for (const changed of [{ ...member, startUsec: 8 },
    { ...member, uniqueid: '999' }, { ...member, pidversion: 999 }]) {
    const b = fixture([snapshot(leader, member), { verified: false, reason: 'coalition_count_changed' },
      snapshot(leader, changed), snapshot(leader, changed)]);
    const rejected = await b.observer(args);
    assert.equal(rejected.verified, false);
    assert.equal(rejected.reason, 'job_current_cohort_changed');
    assert.deepEqual(b.counts(), { observed: 3, reads: 7, sleeps: 2 });
  }
});

test('transient helper failures still consume the same four samples and original-record checks', async () => {
  const bad = { verified: false, reason: 'coalition_count_changed' };
  const exhausted = fixture([bad, bad, bad, bad, snapshot(leader), snapshot(leader)]);
  const result = await exhausted.observer(args);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'job_current_cohort_unconfirmed');
  assert.equal(result.diagnostic.detail, 'sample_limit');
  assert.equal(result.diagnostic.samplesAttempted, 4);
  assert.deepEqual(exhausted.counts(), { observed: 4, reads: 9, sleeps: 3 });
  let reads = 0;
  const replaced = fixture([bad, snapshot(leader), snapshot(leader)], async () => {
    reads++;
    return reads === 3 ? { ...record(), generation: 4 } : record();
  });
  const changed = await replaced.observer(args);
  assert.equal(changed.reason, 'job_startup_record_changed');
  assert.deepEqual(replaced.counts(), { observed: 1, reads: 3, sleeps: 0 });
});

test('a shared member with changed birth or unique ID is not a transient addition', async () => {
  for (const changed of [{ ...member, startUsec: 8 },
    { ...member, uniqueid: '999' }, { ...member, pidversion: 999 }]) {
    const a = fixture([snapshot(leader, member), snapshot(leader, changed),
      snapshot(leader, changed)]);
    const result = await a.observer(args);
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'job_current_cohort_changed');
    assert.deepEqual(a.counts(), { observed: 2, reads: 5, sleeps: 1 });
  }
});

test('record generation or phase replacement between valid samples is unknown', async () => {
  for (const change of [{ generation: 4 }, { phase: 'stop_intent' },
    { identity: { ...leader, uniqueid: '999' } }, { ioFault: true }]) {
    let reads = 0;
    const a = fixture([snapshot(leader), snapshot(leader)], async () => {
      reads++;
      return reads === 3 ? { ...record(), ...change } : record();
    });
    const result = await a.observer(args);
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'job_startup_record_changed');
    assert.deepEqual(a.counts(), { observed: 1, reads: 3, sleeps: 0 });
  }
});

test('record replacement between two otherwise stable samples cannot be admitted', async () => {
  let reads = 0;
  const a = fixture([snapshot(leader), snapshot(leader)], async () => {
    reads++;
    return reads === 4 ? { ...record(), generation: 4 } : record();
  });
  const result = await a.observer(args);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'job_startup_record_changed');
  assert.deepEqual(a.counts(), { observed: 1, reads: 4, sleeps: 1 });
});

test('short observation deadline does not turn continuing change into success', async () => {
  let time = 0, calls = 0;
  const observer = createExecutorJobCohortObserverForTest({
    platform: 'darwin', canonicalPython: async path => path,
    readRecord: async () => record(), now: () => time,
    sleep: async () => {},
    observe: async () => { calls++; time += 1100; return snapshot(leader); }
  });
  const result = await observer(args);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'job_current_cohort_unconfirmed');
  assert.equal(calls, 2);
  assert.equal(result.diagnostic.detail, 'deadline');
  assert.equal(result.diagnostic.elapsedMs, 2200);
});

test('nonretryable helper diagnostics preserve only fixed categories without public serialization', async () => {
  for (const reason of ['coalition_member_changed', '/private/secret token=never-log']) {
    const a = fixture([{ verified: false, reason }, snapshot(leader)]);
    const result = await a.observer(args);
    assert.equal(result.verified, false);
    assert.equal(result.diagnostic.stage, 'native_observe');
    assert.equal(result.diagnostic.detail, 'helper_unconfirmed');
    assert.equal(result.diagnostic.samplesAttempted, 1);
    assert.equal(result.diagnostic.helperReason, reason === 'coalition_member_changed' ? reason : null);
    assert.equal(a.counts().observed, 1);
    assert.equal(JSON.stringify(result).includes(reason), false);
    assert.equal(JSON.stringify(result.diagnostic).includes('/private/secret'), false);
  }
});

test('observer exception records its stage without recording exception messages', async () => {
  const a = fixture([], async () => { throw new Error('secret absolute path'); });
  const result = await a.observer(args);
  assert.equal(result.reason, 'job_current_cohort_unavailable');
  assert.deepEqual(result.diagnostic, { stage: 'original_record', detail: 'exception',
    samplesAttempted: 0, elapsedMs: 0, helperReason: null });
});

test('monotonic fractional clock passes an integer remaining timeout to the native helper', async () => {
  let time = 0;
  const timeouts = [];
  const observer = createExecutorJobCohortObserverForTest({
    platform: 'darwin', canonicalPython: async path => path,
    readRecord: async () => record(), now: () => { time += 0.125; return time; },
    sleep: async ms => { time += ms; },
    observe: async (_path, _coalition, timeoutMs) => {
      assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2000);
      timeouts.push(timeoutMs);
      return snapshot(leader);
    }
  });
  assert.equal((await observer(args)).verified, true);
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts[1] < timeouts[0]);
});

test('native /bin/cat retains the durable pre-exec birth after exec', {
  skip: process.platform !== 'darwin' || process.env.SEQIVO_TEST_NATIVE_COHORT !== '1'
}, async t => {
  const pythonPath = process.env.TASKBOARD_TEST_PYTHON;
  assert.match(pythonPath || '', /^\//, 'set the isolated absolute test Python');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-cohort-exec-')));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  let job;
  t.after(async () => {
    if (!job) { await rm(root, { recursive: true, force: true }); return; }
    const stopped = await job.stop();
    if (!stopped.retired) throw new Error('native_job_retirement_unconfirmed');
    await job.dispose();
    await rm(root, { recursive: true, force: true });
  });
  job = await prepareExecutorJob({ taskId: 'native-cohort-exec', command: '/bin/cat',
    cwd: workspace, pythonPath, recordRoot: root });
  const original = await job.spawn();
  const timeout = new AbortController();
  const output = Promise.race([once(job.stdout, 'data'),
    delay(5000, undefined, { signal: timeout.signal }).then(() => {
      throw new Error('cat_output_unconfirmed');
    })]);
  job.stdin.write('exec-verified\n');
  try { assert.match((await output)[0].toString(), /exec-verified/); }
  finally { timeout.abort(); }
  const durable = await readJobRecord(root, job.recordId, job.taskId, workspace);
  const observed = await observeExecutorJobCohort({ recordRoot: root, recordId: job.recordId,
    taskId: job.taskId, workspace, pythonPath });
  assert.equal(observed.verified, true, observed.reason);
  const current = observed.members.find(row => row.pid === original.identity.pid);
  assert.ok(current);
  assert.equal(current.uniqueid, durable.identity.uniqueid);
  assert.equal(current.startSec, durable.identity.startSec);
  assert.equal(current.startUsec, durable.identity.startUsec);
  assert.notEqual(current.pidversion, durable.identity.pidversion);
});
