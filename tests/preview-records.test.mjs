import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPreviewRecords } from '../server/preview/records.mjs';

const scope = (changes = {}) => ({ previewId: 'preview1', projectId: 'project1', taskId: 'task1',
  contentVersion: 3, artifactDigest: 'a'.repeat(64), dataStoreId: 'store1', ...changes });
const payloadHash = title => createHash('sha256').update(JSON.stringify({ title })).digest('hex');
const operation = (changes = {}) => ({ operationId: 'op1', tenantId: 'tenant1', actorUserId: 'user1',
  clientMutationId: 'save1', payloadHash: payloadHash('One'),
  admission: { nodeId: 'node1', nodeEpoch: 2, connectionGeneration: 3, admissionSequence: 4 }, ...changes });
const write = (records, s, id, title) => records.createOperation(s, {
  ...operation({ operationId: `op-${id}`, clientMutationId: `save-${id}`, payloadHash: payloadHash(title.trim()) }), title,
});
const countRows = (path, table) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; }
  finally { db.close(); }
};

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'preview-records-'));
  const dbPath = join(root, 'private', 'records.sqlite');
  let records = createPreviewRecords({ dbPath, now: () => 1234, ...options });
  t.after(async () => {
    const errors = [];
    try { records?.close(); } catch (error) { errors.push(error); }
    if (!errors.length) try { await rm(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Preview records cleanup failed');
  });
  return { dbPath, get records() { return records; }, restart() {
    records.close(); records = createPreviewRecords({ dbPath, now: () => 5678, ...options });
  } };
}

test('real SQLite create is idempotent, conflicts on changed payload, and survives restart', async t => {
  const f = await fixture(t), s = scope();
  assert.deepEqual(f.records.bind(s), s);
  assert.equal('create' in f.records, false);
  assert.deepEqual(f.records.bind(s), s);
  const first = write(f.records, s, '1', '  第一条记录  ');
  assert.equal(first.operation.record.title, '第一条记录');
  assert.equal(first.operation.record.createdAt, 1234);
  assert.deepEqual(write(f.records, s, '1', '第一条记录'), first);
  assert.throws(() => write(f.records, s, '1', '替换'),
    { code: 'PREVIEW_RECORD_OPERATION_CONFLICT', status: 409 });
  assert.deepEqual(f.records.list(s), { records: [first.operation.record] });
  assert.equal((await stat(f.dbPath)).mode & 0o077, 0);
  f.restart();
  assert.deepEqual(f.records.list(s), { records: [first.operation.record] });
  assert.deepEqual(write(f.records, s, '1', '第一条记录'), first);
  const second = write(f.records, s, '2', '第二条记录');
  assert.notEqual(second.operation.record.id, first.operation.record.id);
  assert.deepEqual(f.records.list(s).records, [first.operation.record, second.operation.record]);
});

test('binding isolates preview, project, version, artifact and data store', async t => {
  const f = await fixture(t), s = scope();
  f.records.bind(s);
  write(f.records, s, '1', 'Private data');
  for (const changes of [{ projectId: 'project2' }, { taskId: 'task2' }, { contentVersion: 4 },
    { artifactDigest: 'b'.repeat(64) }, { dataStoreId: 'store2' }]) {
    assert.throws(() => f.records.list(scope(changes)), { code: 'PREVIEW_RECORD_FORBIDDEN', status: 403 });
    assert.throws(() => write(f.records, scope(changes), 'x', 'No'),
      { code: 'PREVIEW_RECORD_FORBIDDEN', status: 403 });
  }
  assert.throws(() => f.records.list(scope({ previewId: 'preview2' })),
    { code: 'PREVIEW_RECORD_NOT_FOUND', status: 404 });
  assert.throws(() => f.records.bind(scope({ previewId: 'preview2' })),
    { code: 'PREVIEW_RECORD_BINDING', status: 409 });
  assert.throws(() => f.records.bind(scope({ contentVersion: 4 })),
    { code: 'PREVIEW_RECORD_FORBIDDEN', status: 403 });
  assert.equal(f.records.list(s).records.length, 1);
});

test('record limits and input validation are enforced before any extra write', async t => {
  const f = await fixture(t), s = scope(); f.records.bind(s);
  assert.throws(() => write(f.records, s, 'bad', 'a'.repeat(121)),
    { code: 'PREVIEW_RECORD_INPUT', status: 400 });
  assert.throws(() => write(f.records, s, 'bad', 'x\nInjected'),
    { code: 'PREVIEW_RECORD_INPUT', status: 400 });
  assert.throws(() => f.records.createOperation(s, {
    ...operation({ clientMutationId: '../bad', payloadHash: payloadHash('No') }), title: 'No',
  }), { code: 'PREVIEW_RECORD_OPERATION', status: 400 });
  let first;
  for (let index = 0; index < 200; index++) {
    const result = write(f.records, s, String(index), `Record ${index}`);
    if (index === 0) first = result;
  }
  assert.equal(f.records.list(s).records.length, 200);
  assert.deepEqual(write(f.records, s, '0', 'Record 0'), first);
  assert.throws(() => write(f.records, s, '200', 'Overflow'),
    { code: 'PREVIEW_RECORD_LIMIT', status: 429 });
  assert.equal(f.records.list(s).records.length, 200);
});

test('invalid surrogate text is rejected while valid emoji round-trips through SQLite', async t => {
  const f = await fixture(t), s = scope(); f.records.bind(s);
  assert.throws(() => write(f.records, s, 'broken', `A${String.fromCharCode(0xD800)}B`),
    { code: 'PREVIEW_RECORD_INPUT', status: 400 });
  const saved = write(f.records, s, 'emoji', '已保存 😀');
  assert.equal(f.records.list(s).records[0].title, saved.operation.record.title);
  f.restart();
  assert.equal(f.records.list(s).records[0].title, '已保存 😀');
});

test('storage refuses a symlink database path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'preview-records-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'target.sqlite'), link = join(root, 'link.sqlite');
  const records = createPreviewRecords({ dbPath: target }); records.close();
  await symlink(target, link);
  assert.throws(() => createPreviewRecords({ dbPath: link }),
    { code: 'PREVIEW_RECORD_STORAGE', status: 500 });
});

test('Core operation receipt and real record commit atomically and survive restart', async t => {
  const f = await fixture(t), s = scope(), op = operation(); f.records.bind(s);
  assert.deepEqual(f.records.readOperation(s, op), { operation: { status: 'unknown' } });
  assert.equal(countRows(f.dbPath, 'preview_record_operations'), 0);
  const created = f.records.createOperation(s, { ...op, title: 'One' });
  assert.equal(created.operation.status, 'confirmed');
  assert.equal(created.operation.record.title, 'One');
  assert.deepEqual(f.records.createOperation(s, { ...op, title: 'One' }), created);
  assert.deepEqual(f.records.readOperation(s, op), created);
  assert.deepEqual(f.records.reconcileOperation(s, op), created);
  assert.equal(countRows(f.dbPath, 'preview_records'), 1);
  assert.equal(countRows(f.dbPath, 'preview_record_operations'), 1);
  f.restart();
  assert.deepEqual(f.records.readOperation(s, op), created);
  assert.deepEqual(f.records.list(s).records, [created.operation.record]);
});

test('reconcile first durably fences a late create; create first stays confirmed', async t => {
  const f = await fixture(t), s = scope(), op = operation(); f.records.bind(s);
  assert.deepEqual(f.records.readOperation(s, op), { operation: { status: 'unknown' } });
  const fenced = f.records.reconcileOperation(s, op);
  assert.deepEqual(fenced, { operation: { id: op.operationId, status: 'not_applied' } });
  assert.deepEqual(f.records.reconcileOperation(s, op), fenced);
  assert.throws(() => f.records.createOperation(s, { ...op, title: 'One' }),
    { code: 'PREVIEW_RECORD_NOT_APPLIED', status: 409 });
  assert.equal(f.records.list(s).records.length, 0);
  f.restart();
  assert.deepEqual(f.records.readOperation(s, op), fenced);
  assert.throws(() => f.records.createOperation(s, { ...op, title: 'One' }),
    { code: 'PREVIEW_RECORD_NOT_APPLIED', status: 409 });
  const other = operation({ operationId: 'op2', clientMutationId: 'save2', payloadHash: payloadHash('Two') });
  const created = f.records.createOperation(s, { ...other, title: 'Two' });
  assert.deepEqual(f.records.reconcileOperation(s, other), created);
  assert.equal(f.records.list(s).records.length, 1);
});

test('operation identity, admission and payload cannot be rebound; actors do not share a mutation receipt', async t => {
  const f = await fixture(t), s = scope(), op = operation(); f.records.bind(s);
  const first = f.records.createOperation(s, { ...op, title: 'One' });
  const secondActor = operation({ operationId: 'op2', actorUserId: 'user2' });
  const second = f.records.createOperation(s, { ...secondActor, title: 'One' });
  assert.notEqual(second.operation.record.id, first.operation.record.id);
  assert.equal(f.records.list(s).records.length, 2);
  for (const changed of [
    { actorUserId: 'user2' }, { clientMutationId: 'other' }, { tenantId: 'tenant2' },
    { admission: { ...op.admission, connectionGeneration: 5 } },
    { payloadHash: payloadHash('Changed') },
  ]) {
    assert.throws(() => f.records.readOperation(s, { ...op, ...changed }),
      { code: 'PREVIEW_RECORD_OPERATION_CONFLICT', status: 409 });
  }
  assert.throws(() => f.records.createOperation(s, { ...op, title: 'Changed', payloadHash: payloadHash('Changed') }),
    { code: 'PREVIEW_RECORD_OPERATION_CONFLICT', status: 409 });
  assert.throws(() => f.records.createOperation(s, { ...op, operationId: 'op3', title: 'One' }),
    { code: 'PREVIEW_RECORD_OPERATION_CONFLICT', status: 409 });
  const otherScope = scope({ previewId: 'preview2', dataStoreId: 'store2' }); f.records.bind(otherScope);
  assert.throws(() => f.records.reconcileOperation(otherScope, op),
    { code: 'PREVIEW_RECORD_OPERATION_CONFLICT', status: 409 });
  assert.equal(countRows(f.dbPath, 'preview_record_operations'), 2);
  assert.equal(countRows(f.dbPath, 'preview_records'), 2);
});

test('failed receipt insert rolls back the real record and can be retried after repair', async t => {
  const f = await fixture(t), s = scope(), op = operation(); f.records.bind(s);
  const fault = new DatabaseSync(f.dbPath);
  try {
    fault.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON preview_record_operations
      BEGIN SELECT RAISE(ABORT, 'receipt fault'); END;`);
    assert.throws(() => f.records.createOperation(s, { ...op, title: 'One' }), /receipt fault/);
    assert.equal(countRows(f.dbPath, 'preview_records'), 0);
    assert.equal(countRows(f.dbPath, 'preview_record_operations'), 0);
    assert.deepEqual(f.records.readOperation(s, op), { operation: { status: 'unknown' } });
    fault.exec('DROP TRIGGER reject_receipt');
    const result = f.records.createOperation(s, { ...op, title: 'One' });
    assert.equal(result.operation.status, 'confirmed');
    assert.equal(countRows(f.dbPath, 'preview_records'), 1);
    assert.equal(countRows(f.dbPath, 'preview_record_operations'), 1);
  } finally { fault.close(); }
});

test('a mismatched restored record cannot impersonate a confirmed operation receipt', async t => {
  const f = await fixture(t), s = scope(), op = operation(); f.records.bind(s);
  const created = f.records.createOperation(s, { ...op, title: 'One' });
  const db = new DatabaseSync(f.dbPath);
  try {
    db.prepare('UPDATE preview_records SET title=? WHERE preview_id=? AND record_id=?')
      .run('Unrelated', s.previewId, created.operation.record.id);
    assert.throws(() => f.records.readOperation(s, op),
      { code: 'PREVIEW_RECORD_INTEGRITY', status: 503 });
    assert.throws(() => f.records.reconcileOperation(s, op),
      { code: 'PREVIEW_RECORD_INTEGRITY', status: 503 });
    assert.equal(countRows(f.dbPath, 'preview_record_operations'), 1);
  } finally { db.close(); }
});

test('reconcile refuses to fence a real record whose operation receipt is missing', async t => {
  const f = await fixture(t), s = scope(), op = operation(); f.records.bind(s);
  const internalKey = createHash('sha256').update(JSON.stringify([
    op.tenantId, op.actorUserId, s.dataStoreId, op.clientMutationId,
  ])).digest('hex');
  const existing = { id: randomUUID(), title: 'One', createdAt: 1234 };
  const db = new DatabaseSync(f.dbPath);
  try {
    db.prepare(`INSERT INTO preview_records
      (preview_id,record_id,client_mutation_id,payload_hash,title,created_at) VALUES(?,?,?,?,?,?)`)
      .run(s.previewId, existing.id, internalKey, op.payloadHash, existing.title, existing.createdAt);
  } finally { db.close(); }
  assert.equal(countRows(f.dbPath, 'preview_records'), 1);
  assert.equal(countRows(f.dbPath, 'preview_record_operations'), 0);
  assert.throws(() => f.records.reconcileOperation(s, op),
    { code: 'PREVIEW_RECORD_INTEGRITY', status: 503 });
  assert.deepEqual(f.records.readOperation(s, op), { operation: { status: 'unknown' } });
  assert.deepEqual(f.records.list(s).records, [existing]);
  assert.equal(countRows(f.dbPath, 'preview_records'), 1);
  assert.equal(countRows(f.dbPath, 'preview_record_operations'), 0);
  f.restart();
  assert.throws(() => f.records.reconcileOperation(s, op),
    { code: 'PREVIEW_RECORD_INTEGRITY', status: 503 });
  assert.equal(countRows(f.dbPath, 'preview_record_operations'), 0);
});

test('a contradictory not-applied fence and record remains unknown on every operation path', async t => {
  const f = await fixture(t), s = scope(), op = operation(); f.records.bind(s);
  assert.equal(f.records.reconcileOperation(s, op).operation.status, 'not_applied');
  const internalKey = createHash('sha256').update(JSON.stringify([
    op.tenantId, op.actorUserId, s.dataStoreId, op.clientMutationId,
  ])).digest('hex');
  const db = new DatabaseSync(f.dbPath);
  try {
    db.prepare(`INSERT INTO preview_records
      (preview_id,record_id,client_mutation_id,payload_hash,title,created_at) VALUES(?,?,?,?,?,?)`)
      .run(s.previewId, randomUUID(), internalKey, op.payloadHash, 'One', 1234);
  } finally { db.close(); }
  for (const inspect of [
    () => f.records.readOperation(s, op),
    () => f.records.reconcileOperation(s, op),
    () => f.records.createOperation(s, { ...op, title: 'One' }),
  ]) assert.throws(inspect, { code: 'PREVIEW_RECORD_INTEGRITY', status: 503 });
  assert.equal(countRows(f.dbPath, 'preview_records'), 1);
  assert.equal(countRows(f.dbPath, 'preview_record_operations'), 1);
  f.restart();
  assert.throws(() => f.records.readOperation(s, op),
    { code: 'PREVIEW_RECORD_INTEGRITY', status: 503 });
});

test('persistent per-scope and total operation caps preserve old receipts and fences', async t => {
  const f = await fixture(t, { operationLimits: { perScope: 2, total: 3 } });
  const firstScope = scope(), secondScope = scope({ previewId: 'preview2', dataStoreId: 'store2' });
  f.records.bind(firstScope); f.records.bind(secondScope);
  const created = f.records.createOperation(firstScope, { ...operation(), title: 'One' });
  const fencedOp = operation({ operationId: 'op2', clientMutationId: 'save2', payloadHash: payloadHash('Two') });
  const fenced = f.records.reconcileOperation(firstScope, fencedOp);
  const blockedScope = operation({ operationId: 'op3', clientMutationId: 'save3', payloadHash: payloadHash('Three') });
  assert.throws(() => f.records.createOperation(firstScope, { ...blockedScope, title: 'Three' }),
    { code: 'PREVIEW_RECORD_OPERATION_LIMIT', status: 429 });
  assert.throws(() => f.records.reconcileOperation(firstScope, blockedScope),
    { code: 'PREVIEW_RECORD_OPERATION_LIMIT', status: 429 });
  assert.deepEqual(f.records.readOperation(firstScope, blockedScope), { operation: { status: 'unknown' } });
  const otherOp = operation({ operationId: 'op4', clientMutationId: 'save4' });
  const other = f.records.createOperation(secondScope, { ...otherOp, title: 'One' });
  const blockedTotal = operation({ operationId: 'op5', clientMutationId: 'save5', payloadHash: payloadHash('Five') });
  assert.throws(() => f.records.reconcileOperation(secondScope, blockedTotal),
    { code: 'PREVIEW_RECORD_OPERATION_LIMIT', status: 429 });
  assert.equal(countRows(f.dbPath, 'preview_record_operations'), 3);
  assert.equal(countRows(f.dbPath, 'preview_records'), 2);
  f.restart();
  assert.deepEqual(f.records.readOperation(firstScope, operation()), created);
  assert.deepEqual(f.records.reconcileOperation(firstScope, fencedOp), fenced);
  assert.deepEqual(f.records.createOperation(secondScope, { ...otherOp, title: 'One' }), other);
  assert.throws(() => f.records.createOperation(firstScope, { ...fencedOp, title: 'Two' }),
    { code: 'PREVIEW_RECORD_NOT_APPLIED', status: 409 });
  assert.deepEqual(f.records.readOperation(secondScope, blockedTotal), { operation: { status: 'unknown' } });
  assert.equal(countRows(f.dbPath, 'preview_record_operations'), 3);
});
