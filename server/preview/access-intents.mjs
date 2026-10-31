import { randomBytes } from 'node:crypto';

export const INTENT_TTL = 10 * 60_000;
export const INTENT_RETENTION = 10 * 60_000;
export const MAX_ACTIVE_INTENTS = 20;
export const MAX_TERMINAL_INTENTS = 200;
export const INTENT_ID = /^[A-Za-z0-9_-]{43}$/;

export const newIntentId = () => randomBytes(32).toString('base64url');
export const emptyIntentBody = body => body !== null && typeof body === 'object' &&
  !Array.isArray(body) && Object.keys(body).length === 0;
export const intentState = (row, time, bootId) => {
  if (row.state === 'closed') return 'closed';
  if (row.expires_at <= time) return 'expired';
  if (bootId !== undefined && row.boot_id !== bootId) return 'invalidated';
  return row.state;
};
export const publicIntent = (row, state) => ({
  id: row.id, previewId: row.preview_id, projectId: row.project_id,
  taskId: row.task_id, state, expiresAt: row.expires_at,
});

export function sqliteTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = operation();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try { db.exec('ROLLBACK'); }
    catch (rollback) { throw new AggregateError([error, rollback], 'Preview intent transaction failed'); }
    throw error;
  }
}
