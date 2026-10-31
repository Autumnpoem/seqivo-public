import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_RECORDS = 200;
const MAX_OPERATIONS_PER_SCOPE = 1000;
const MAX_OPERATIONS_TOTAL = 100000;
const scopeFields = ['previewId', 'projectId', 'taskId', 'contentVersion', 'artifactDigest', 'dataStoreId'];
const operationFields = ['operationId', 'tenantId', 'actorUserId', 'clientMutationId', 'payloadHash', 'admission'];
const admissionFields = ['nodeId', 'nodeEpoch', 'connectionGeneration', 'admissionSequence'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class PreviewRecordError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}
const fail = (message, status, code) => { throw new PreviewRecordError(message, status, code); };

function checkedScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) ||
    Object.keys(scope).length !== scopeFields.length ||
    scopeFields.some(key => !Object.hasOwn(scope, key)) ||
    ![scope.previewId, scope.projectId, scope.taskId, scope.dataStoreId].every(value => typeof value === 'string' && ID.test(value)) ||
    !Number.isSafeInteger(scope.contentVersion) || scope.contentVersion < 1 ||
    typeof scope.artifactDigest !== 'string' || !SHA.test(scope.artifactDigest))
    fail('Invalid preview record scope', 400, 'PREVIEW_RECORD_SCOPE');
  return scope;
}

function checkedInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).length !== 2 || !Object.hasOwn(input, 'clientMutationId') || !Object.hasOwn(input, 'title') ||
    typeof input.clientMutationId !== 'string' || !ID.test(input.clientMutationId) || typeof input.title !== 'string')
    fail('Invalid preview record input', 400, 'PREVIEW_RECORD_INPUT');
  const title = input.title.trim();
  if (!title || !title.isWellFormed() || Array.from(title).length > 120 || Buffer.byteLength(title) > 480 || /[\p{Cc}\p{Cf}]/u.test(title))
    fail('Invalid preview record title', 400, 'PREVIEW_RECORD_INPUT');
  return { clientMutationId: input.clientMutationId, title };
}

function checkedOperation(input, withTitle = false) {
  const fields = withTitle ? [...operationFields, 'title'] : operationFields;
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).length !== fields.length || fields.some(key => !Object.hasOwn(input, key)) ||
    ![input.operationId, input.tenantId, input.actorUserId, input.clientMutationId].every(value => typeof value === 'string' && ID.test(value)) ||
    typeof input.payloadHash !== 'string' || !SHA.test(input.payloadHash) ||
    !input.admission || typeof input.admission !== 'object' || Array.isArray(input.admission) ||
    Object.keys(input.admission).length !== admissionFields.length ||
    admissionFields.some(key => !Object.hasOwn(input.admission, key)) ||
    typeof input.admission.nodeId !== 'string' || !ID.test(input.admission.nodeId) ||
    [input.admission.nodeEpoch, input.admission.connectionGeneration, input.admission.admissionSequence]
      .some(value => !Number.isSafeInteger(value) || value < 1))
    fail('Invalid preview record operation', 400, 'PREVIEW_RECORD_OPERATION');
  if (!withTitle) return input;
  const { title } = checkedInput({ clientMutationId: input.clientMutationId, title: input.title });
  if (digest({ title }) !== input.payloadHash)
    fail('Preview record payload changed', 409, 'PREVIEW_RECORD_CONFLICT');
  return { ...input, title };
}

function privateDatabase(path) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const folder = lstatSync(directory);
  if (!folder.isDirectory() || (folder.mode & 0o077) || process.getuid?.() !== undefined && folder.uid !== process.getuid())
    fail('Preview record storage is not private', 500, 'PREVIEW_RECORD_STORAGE');
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) || process.getuid?.() !== undefined && file.uid !== process.getuid())
    fail('Preview record storage is not private', 500, 'PREVIEW_RECORD_STORAGE');
  return new DatabaseSync(path);
}

/** Private persistence only. Authentication and network capabilities belong to the caller. */
export function createPreviewRecords({ dbPath, now = Date.now, operationLimits } = {}) {
  if (typeof dbPath !== 'string' || !dbPath || typeof now !== 'function') throw new TypeError('Preview records require dbPath and clock');
  const limits = operationLimits ?? { perScope: MAX_OPERATIONS_PER_SCOPE, total: MAX_OPERATIONS_TOTAL };
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).length !== 2 ||
    !Object.hasOwn(limits, 'perScope') || !Object.hasOwn(limits, 'total') ||
    !Number.isSafeInteger(limits.perScope) || limits.perScope < 1 || limits.perScope > MAX_OPERATIONS_PER_SCOPE ||
    !Number.isSafeInteger(limits.total) || limits.total < 1 || limits.total > MAX_OPERATIONS_TOTAL)
    throw new TypeError('Preview record operation limits must be positive and no higher than production limits');
  const db = privateDatabase(resolve(dbPath));
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS preview_record_scopes(
        preview_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
        content_version INTEGER NOT NULL, artifact_digest TEXT NOT NULL, data_store_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS preview_records(
        preview_id TEXT NOT NULL REFERENCES preview_record_scopes(preview_id),
        record_id TEXT NOT NULL, client_mutation_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
        title TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(preview_id,record_id), UNIQUE(preview_id,client_mutation_id));
      CREATE TABLE IF NOT EXISTS preview_record_operations(
        operation_id TEXT PRIMARY KEY,
        preview_id TEXT NOT NULL REFERENCES preview_record_scopes(preview_id),
        data_store_id TEXT NOT NULL, tenant_id TEXT NOT NULL, actor_user_id TEXT NOT NULL,
        client_mutation_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
        node_id TEXT NOT NULL, node_epoch INTEGER NOT NULL,
        connection_generation INTEGER NOT NULL, admission_sequence INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('confirmed','not_applied')),
        record_id TEXT, created_at INTEGER NOT NULL,
        UNIQUE(preview_id,data_store_id,tenant_id,actor_user_id,client_mutation_id),
        FOREIGN KEY(preview_id,record_id) REFERENCES preview_records(preview_id,record_id));`);
  } catch (error) { db.close(); throw error; }
  let closed = false;
  const ready = () => { if (closed) fail('Preview record storage closed', 503, 'PREVIEW_RECORD_CLOSED'); };
  const transaction = operation => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); db.exec('COMMIT'); return result; }
    catch (error) {
      try { db.exec('ROLLBACK'); }
      catch (rollback) { throw new AggregateError([error, rollback], 'Preview record transaction failed'); }
      throw error;
    }
  };
  const rowFor = scope => {
    const row = db.prepare('SELECT * FROM preview_record_scopes WHERE preview_id=?').get(scope.previewId);
    if (!row) fail('Preview record scope unavailable', 404, 'PREVIEW_RECORD_NOT_FOUND');
    if (row.project_id !== scope.projectId || row.task_id !== scope.taskId ||
      row.content_version !== scope.contentVersion || row.artifact_digest !== scope.artifactDigest ||
      row.data_store_id !== scope.dataStoreId)
      fail('Preview record scope changed', 403, 'PREVIEW_RECORD_FORBIDDEN');
    return row;
  };
  const publicRecord = row => ({ id: row.record_id, title: row.title, createdAt: row.created_at });
  function bind(input) {
    ready(); const scope = checkedScope(input);
    return transaction(() => {
      const existing = db.prepare('SELECT * FROM preview_record_scopes WHERE preview_id=? OR data_store_id=?')
        .all(scope.previewId, scope.dataStoreId);
      if (existing.length) {
        if (existing.length !== 1 || existing[0].preview_id !== scope.previewId)
          fail('Preview record scope already bound', 409, 'PREVIEW_RECORD_BINDING');
        rowFor(scope);
        return { ...scope };
      }
      db.prepare(`INSERT INTO preview_record_scopes
        (preview_id,project_id,task_id,content_version,artifact_digest,data_store_id) VALUES(?,?,?,?,?,?)`)
        .run(scope.previewId, scope.projectId, scope.taskId, scope.contentVersion, scope.artifactDigest, scope.dataStoreId);
      return { ...scope };
    });
  }
  function list(scopeInput) {
    ready(); const scope = checkedScope(scopeInput); rowFor(scope);
    const rows = db.prepare('SELECT record_id,title,created_at FROM preview_records WHERE preview_id=? ORDER BY created_at, rowid LIMIT ?')
      .all(scope.previewId, MAX_RECORDS);
    return { records: rows.map(publicRecord) };
  }
  const operationRow = (scope, value) => {
    const byId = db.prepare('SELECT * FROM preview_record_operations WHERE operation_id=?').get(value.operationId);
    const byKey = db.prepare(`SELECT * FROM preview_record_operations WHERE preview_id=? AND data_store_id=?
      AND tenant_id=? AND actor_user_id=? AND client_mutation_id=?`)
      .get(scope.previewId, scope.dataStoreId, value.tenantId, value.actorUserId, value.clientMutationId);
    if (byId && byKey && byId.operation_id !== byKey.operation_id)
      fail('Preview operation identity changed', 409, 'PREVIEW_RECORD_OPERATION_CONFLICT');
    const row = byId || byKey;
    if (row && (row.operation_id !== value.operationId || row.preview_id !== scope.previewId ||
      row.data_store_id !== scope.dataStoreId || row.tenant_id !== value.tenantId ||
      row.actor_user_id !== value.actorUserId || row.client_mutation_id !== value.clientMutationId ||
      row.payload_hash !== value.payloadHash || row.node_id !== value.admission.nodeId ||
      row.node_epoch !== value.admission.nodeEpoch ||
      row.connection_generation !== value.admission.connectionGeneration ||
      row.admission_sequence !== value.admission.admissionSequence))
      fail('Preview operation identity changed', 409, 'PREVIEW_RECORD_OPERATION_CONFLICT');
    return row;
  };
  const operationResult = row => {
    if (!row) return { operation: { status: 'unknown' } };
    const internalKey = digest([row.tenant_id, row.actor_user_id, row.data_store_id, row.client_mutation_id]);
    if (row.status === 'not_applied') {
      if (db.prepare('SELECT record_id FROM preview_records WHERE preview_id=? AND client_mutation_id=?')
        .get(row.preview_id, internalKey))
        fail('Preview operation fence conflicts with a record', 503, 'PREVIEW_RECORD_INTEGRITY');
      return { operation: { id: row.operation_id, status: 'not_applied' } };
    }
    const record = db.prepare(`SELECT record_id,client_mutation_id,payload_hash,title,created_at
      FROM preview_records WHERE preview_id=? AND record_id=?`)
      .get(row.preview_id, row.record_id);
    if (row.status !== 'confirmed' || !record || record.client_mutation_id !== internalKey ||
      record.payload_hash !== row.payload_hash || digest({ title: record.title }) !== row.payload_hash)
      fail('Preview operation receipt unavailable', 503, 'PREVIEW_RECORD_INTEGRITY');
    return { operation: { id: row.operation_id, status: 'confirmed', record: publicRecord(record) } };
  };
  const insertOperation = (scope, value, status, recordId) => {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) fail('Invalid preview record clock', 500, 'PREVIEW_RECORD_CLOCK');
    db.prepare(`INSERT INTO preview_record_operations
      (operation_id,preview_id,data_store_id,tenant_id,actor_user_id,client_mutation_id,payload_hash,
        node_id,node_epoch,connection_generation,admission_sequence,status,record_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(value.operationId, scope.previewId, scope.dataStoreId, value.tenantId, value.actorUserId,
        value.clientMutationId, value.payloadHash, value.admission.nodeId, value.admission.nodeEpoch,
        value.admission.connectionGeneration, value.admission.admissionSequence, status, recordId, time);
  };
  const requireOperationCapacity = scope => {
    const perScope = db.prepare('SELECT count(*) AS n FROM preview_record_operations WHERE preview_id=? AND data_store_id=?')
      .get(scope.previewId, scope.dataStoreId).n;
    const total = db.prepare('SELECT count(*) AS n FROM preview_record_operations').get().n;
    if (perScope >= limits.perScope || total >= limits.total)
      fail('Preview operation capacity reached; prior outcomes remain available', 429, 'PREVIEW_RECORD_OPERATION_LIMIT');
  };
  function createOperation(scopeInput, input) {
    ready(); const scope = checkedScope(scopeInput), value = checkedOperation(input, true);
    return transaction(() => {
      rowFor(scope);
      const prior = operationRow(scope, value);
      if (prior) {
        if (prior.status === 'not_applied') {
          operationResult(prior);
          fail('Preview operation was fenced', 409, 'PREVIEW_RECORD_NOT_APPLIED');
        }
        return operationResult(prior);
      }
      const internalKey = digest([value.tenantId, value.actorUserId, scope.dataStoreId, value.clientMutationId]);
      const existing = db.prepare('SELECT record_id FROM preview_records WHERE preview_id=? AND client_mutation_id=?')
        .get(scope.previewId, internalKey);
      if (existing) fail('Preview operation receipt missing', 503, 'PREVIEW_RECORD_INTEGRITY');
      requireOperationCapacity(scope);
      const count = db.prepare('SELECT count(*) AS n FROM preview_records WHERE preview_id=?').get(scope.previewId).n;
      if (count >= MAX_RECORDS) fail('Preview record limit reached', 429, 'PREVIEW_RECORD_LIMIT');
      const createdAt = now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail('Invalid preview record clock', 500, 'PREVIEW_RECORD_CLOCK');
      const recordId = randomUUID();
      db.prepare(`INSERT INTO preview_records
        (preview_id,record_id,client_mutation_id,payload_hash,title,created_at) VALUES(?,?,?,?,?,?)`)
        .run(scope.previewId, recordId, internalKey, value.payloadHash, value.title, createdAt);
      insertOperation(scope, value, 'confirmed', recordId);
      return operationResult(operationRow(scope, value));
    });
  }
  function readOperation(scopeInput, input) {
    ready(); const scope = checkedScope(scopeInput), value = checkedOperation(input);
    rowFor(scope);
    return operationResult(operationRow(scope, value));
  }
  function reconcileOperation(scopeInput, input) {
    ready(); const scope = checkedScope(scopeInput), value = checkedOperation(input);
    return transaction(() => {
      rowFor(scope);
      const prior = operationRow(scope, value);
      if (prior) return operationResult(prior);
      const internalKey = digest([value.tenantId, value.actorUserId, scope.dataStoreId, value.clientMutationId]);
      if (db.prepare('SELECT record_id FROM preview_records WHERE preview_id=? AND client_mutation_id=?')
        .get(scope.previewId, internalKey))
        fail('Preview operation receipt missing', 503, 'PREVIEW_RECORD_INTEGRITY');
      requireOperationCapacity(scope);
      insertOperation(scope, value, 'not_applied', null);
      return operationResult(operationRow(scope, value));
    });
  }
  function close() { if (!closed) { db.close(); closed = true; } }
  return { bind, list, createOperation, readOperation, reconcileOperation, close };
}
