import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyExecutorHelperFailureForTest, startupObservationForTest } from '../server/macos-executor-job.mjs';

const exec = promisify(execFile);

const failed = (reply, overrides = {}) => Object.assign(new Error('private path and token must not escape'), {
  code: 2, killed: false, signal: null, stdout: JSON.stringify(reply),
  stderr: 'private path and token must not escape', ...overrides,
});
const unavailable = { verified: false, reason: 'helper_unavailable' };

test('exit 2 preserves only fixed failed helper reasons', () => {
  for (const reason of ['native_identity_set_changed', 'native_list_changed_during_scan',
    'native_pid_info_incomplete',
    'coalition_count_changed', 'member_identity_changed']) {
    assert.deepEqual(classifyExecutorHelperFailureForTest(failed({ verified: false, reason })),
      { verified: false, reason });
  }
});

test('real execFile exit 2 exposes the bounded failure envelope shape', async () => {
  const reply = { verified: false, reason: 'native_identity_set_changed' };
  let rejection;
  try {
    await exec(process.execPath, ['-e',
      'process.stdout.write(JSON.stringify({verified:false,reason:"native_identity_set_changed"}));process.exit(2)'],
    { timeout: 1000, maxBuffer: 1024 });
  } catch (error) { rejection = error; }
  assert.equal(rejection?.code, 2);
  assert.equal(rejection?.killed, false);
  assert.equal(rejection?.signal, null);
  assert.deepEqual(classifyExecutorHelperFailureForTest(rejection), reply);
});

test('actual helper/startup caller retries both fixed scan-change codes at most three times', async () => {
  for (const reason of ['native_identity_set_changed', 'native_list_changed_during_scan']) {
    let calls = 0;
    const execute = async (_path, _args, options) => {
      assert.equal(options.timeout, 15000);
      calls++;
      if (calls < 3) throw failed({ verified: false, reason });
      return { stdout: JSON.stringify({ verified: true, scope: 'complete' }) };
    };
    assert.deepEqual(await startupObservationForTest(execute), { verified: true, scope: 'complete' });
    assert.equal(calls, 3);
    calls = 0;
    const stillChanging = async () => { calls++; throw failed({ verified: false, reason }); };
    assert.deepEqual(await startupObservationForTest(stillChanging), { verified: false, reason });
    assert.equal(calls, 3);
  }
  let calls = 0;
  const nonRetry = async () => { calls++; throw failed({ verified: false, reason: 'native_pid_info_incomplete' }); };
  assert.deepEqual(await startupObservationForTest(nonRetry),
    { verified: false, reason: 'native_pid_info_incomplete' });
  assert.equal(calls, 1);
});

test('malformed, unknown, extra and success-shaped replies fail closed', () => {
  for (const value of [
    failed({ verified: true, reason: 'native_identity_set_changed' }),
    failed({ verified: false, reason: '/private/secret token=hidden' }),
    failed({ verified: false, reason: 'native_identity_set_changed', detail: 'secret' }),
    failed({ verified: false, reason: 'native_identity_set_changed' }, { stdout: '{not json' }),
    failed({ verified: false, reason: 'native_identity_set_changed' }, { stdout: 42 }),
    failed({ verified: false, reason: 'native_identity_set_changed' }, { stdout: ' '.repeat(513) }),
  ]) {
    const result = classifyExecutorHelperFailureForTest(value);
    assert.deepEqual(result, unavailable);
    assert.doesNotMatch(JSON.stringify(result), /secret|private|hidden/);
  }
});

test('signal, timeout and launch errors cannot carry an exit-2 failure envelope', () => {
  const reply = { verified: false, reason: 'native_identity_set_changed' };
  for (const value of [
    failed(reply, { code: 'ENOENT' }), failed(reply, { code: 'ETIMEDOUT' }),
    failed(reply, { code: 2, killed: true }), failed(reply, { code: 2, signal: 'SIGTERM' }),
    failed(reply, { code: 1 }), failed(reply, { code: '2' }),
  ]) assert.deepEqual(classifyExecutorHelperFailureForTest(value), unavailable);
});
