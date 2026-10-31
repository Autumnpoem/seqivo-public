import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSnapshot } from '../server/hub/projection.mjs';

const project = { id: 'project-1', name: 'Project' };
const task = { id: 'feedback-task', projectId: project.id, title: 'Feedback', revision: 1, contentVersion: 1 };
const lineage = { projectId: project.id, previewId: 'preview-1', sourceTaskId: 'source-task', sourceContentVersion: 2 };
const snapshot = previewFeedback => ({ projects: [project], tasks: [{ ...task, previewFeedback }] });

test('preview feedback lineage survives both Hub projections without private metadata', () => {
  const raw = snapshot({ ...lineage, feedbackId: 'private-feedback', artifactDigest: 'private-digest',
    environment: 'private-environment', dataMode: 'real', pagePath: 'private/page',
    summary: 'private-summary', criterionIds: ['private-criterion'],
    criterionItems: [{ id: 'private-criterion', text: 'private-text' }], reporterUserId: 'private-reporter',
    capability: 'private-capability' });
  const once = sanitizeSnapshot(raw);
  assert.deepEqual(once.tasks[0].previewFeedback, lineage);
  assert.deepEqual(sanitizeSnapshot(once), once);
  for (const secret of ['private-feedback', 'private-digest', 'private-environment', 'private/page',
    'private-summary', 'private-criterion', 'private-text', 'private-reporter', 'private-capability']) {
    assert.equal(JSON.stringify(once).includes(secret), false, secret);
  }
});

test('older tasks without preview feedback remain compatible', () => {
  const projected = sanitizeSnapshot({ projects: [project], tasks: [task] });
  assert.equal('previewFeedback' in projected.tasks[0], false);
  assert.deepEqual(sanitizeSnapshot(projected), projected);
});

test('malformed or cross-project preview feedback lineage is rejected', () => {
  const bad = [null, [], 'private', { ...lineage, projectId: 'other-project' },
    { ...lineage, projectId: '' }, { ...lineage, previewId: 'invalid/id' },
    { ...lineage, sourceTaskId: '' }, { ...lineage, sourceContentVersion: 0 },
    { ...lineage, sourceContentVersion: '2' }, { ...lineage, sourceContentVersion: Number.MAX_SAFE_INTEGER + 1 },
    { projectId: project.id, previewId: lineage.previewId, sourceContentVersion: 2 }];
  for (const value of bad) assert.throws(() => sanitizeSnapshot(snapshot(value)), undefined, JSON.stringify(value));
});
