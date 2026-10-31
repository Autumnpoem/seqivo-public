import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStartupCohortDiagnostics } from '../server/executor-startup-diagnostics.mjs';

function fixture(t, observe) {
  const root = mkdtempSync(join(tmpdir(), 'seqivo-startup-diagnostics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = createStartupCohortDiagnostics({ dataDir: root, observe });
  return { root, writer, path: join(root, 'diagnostics', 'executor-startup.jsonl') };
}
function result(verified, detail) {
  const value = { verified, unknown: !verified, members: [{ pid: 98765, secret: 'never-log' }] };
  Object.defineProperty(value, 'diagnostic', { value: { stage: 'compare', detail,
    elapsedMs: 50, samplesAttempted: 2, helperReason: null } });
  return value;
}

test('private diagnostics retain failures followed by success without changing observation results', async t => {
  const results = [result(false, 'member_changed'), result(true, 'stable')];
  let calls = 0;
  const { root, writer, path } = fixture(t, async () => results[calls++]);
  const input = { recordId: 'private-record-secret', taskId: 'private-task-secret', workspace: '/private/workspace' };
  assert.equal(await writer.observe('confirm.first', input), results[0]);
  assert.equal(await writer.observe('revalidate.first', input), results[1]);
  writer.record('revalidate.cross_check', input.recordId, { verified: false });
  const raw = readFileSync(path, 'utf8');
  const rows = raw.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.verified), [false, true, false]);
  assert.deepEqual(rows.map(row => row.phase), ['confirm.first', 'revalidate.first', 'revalidate.cross_check']);
  assert.equal(rows[0].record, rows[1].record);
  assert.equal(rows[0].detail, 'member_changed');
  assert.doesNotMatch(raw, /98765|private-record|private-task|private\/workspace|never-log/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, 'diagnostics')).mode & 0o777, 0o700);
  assert.equal(calls, 2);
});

test('diagnostic failure cannot turn refused evidence into admission or change authority', async t => {
  const rejected = result(false, 'member_changed');
  const { root, writer } = fixture(t, async () => rejected);
  writeFileSync(join(root, 'diagnostics'), 'blocked path');
  assert.equal(await writer.observe('confirm.first', { recordId: 'same-record' }), rejected);
  assert.equal(rejected.verified, false);
  assert.equal(readFileSync(join(root, 'diagnostics'), 'utf8'), 'blocked path');
});

test('only fixed diagnostic fields are retained and storage rotates within two bounded files', t => {
  const { root, writer, path } = fixture(t);
  const malicious = { verified: false, diagnostic: { stage: '/private/token', detail: 'password',
    helperReason: 'password', samplesAttempted: 999999, elapsedMs: 999999, raw: 'never-log' } };
  writer.record('unknown phase', 'secret-record', malicious);
  assert.deepEqual(readdirSync(root), []);
  for (let i = 0; i < 1000; i++) writer.record('confirm.first', 'secret-record', malicious);
  const files = readdirSync(join(root, 'diagnostics')).sort();
  assert.deepEqual(files, ['executor-startup.jsonl', 'executor-startup.jsonl.previous']);
  for (const file of files) {
    const full = join(root, 'diagnostics', file);
    assert.ok(statSync(full).size <= 64 * 1024);
    assert.equal(statSync(full).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(full, 'utf8'), /password|private\/token|secret-record|never-log/);
  }
  const row = JSON.parse(readFileSync(path, 'utf8').trim().split('\n')[0]);
  assert.equal(row.stage, null); assert.equal(row.detail, null); assert.equal(row.helperReason, null);
  assert.equal(row.samplesAttempted, 4); assert.equal(row.elapsedMs, 60000);
});

test('diagnostics refuse a symlink destination and never overwrite its target', async t => {
  const accepted = result(true, 'stable');
  const { root, writer, path } = fixture(t, async () => accepted);
  writer.record('confirm.first', 'record', accepted);
  rmSync(path);
  const target = join(root, 'target'); writeFileSync(target, 'unchanged');
  symlinkSync(target, path);
  assert.equal(await writer.observe('confirm.second', { recordId: 'record' }), accepted);
  assert.equal(readFileSync(target, 'utf8'), 'unchanged');
});
