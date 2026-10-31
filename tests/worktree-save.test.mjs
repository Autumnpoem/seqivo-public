import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createWorktreeManager } from '../server/worktrees.mjs';
import { captureWorktreeSource, prepareWorktreeSave, publishWorktreeSave, saveGitSync } from '../server/worktree-save.mjs';

const run = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe']
}).trim();

async function fixture(t, assertSaveAllowed = () => {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-worktree-save-')));
  const repo = join(root, 'project'), rootDir = join(root, 'worktrees');
  await mkdir(repo); await mkdir(rootDir, { mode: 0o700 });
  run(repo, 'init', '-q', '-b', 'main');
  run(repo, 'config', 'user.name', 'Save Test');
  run(repo, 'config', 'user.email', 'save@example.test');
  await writeFile(join(repo, 'tracked.txt'), 'base\n');
  await writeFile(join(repo, 'deleted.txt'), 'delete me\n');
  run(repo, 'add', '.'); run(repo, 'commit', '-qm', 'base');
  const store = new Store(join(root, 'board.sqlite'));
  const project = store.project({ name: 'Save project', directory: repo });
  const task = store.createTask({ projectId: project.id, title: 'Task', goal: 'Save the source', criteria: ['Reviewed'] });
  const manager = createWorktreeManager({ store, rootDir, assertSaveAllowed });
  const item = await manager.create({ projectId: project.id, taskId: task.id, role: 'builder',
    requestId: 'create-1', expectedBase: run(repo, 'rev-parse', 'HEAD') });
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  return { root, repo, rootDir, store, project, task, manager, item };
}

async function changed(f) {
  await writeFile(join(f.item.path, 'tracked.txt'), 'changed\n');
  await writeFile(join(f.item.path, 'new.txt'), 'new UTF-8 🙂\n');
  await rm(join(f.item.path, 'deleted.txt'));
}

async function durablePreparedSave(f, requestId, casAttempted = false) {
  const capture = await captureWorktreeSource(f.item);
  const createdAt = new Date().toISOString();
  const plan = await prepareWorktreeSave(f.item, capture, { commitDate: createdAt });
  const saveId = randomUUID();
  const record = { requestId, saveId, worktreeId: f.item.id, projectId: f.project.id, taskId: f.task.id,
    taskRevision: f.store.getTask(f.task.id).revision, contentVersion: f.store.getTask(f.task.id).contentVersion,
    sourceHead: capture.head, sourceDigest: capture.sourceDigest, changedFileCount: capture.changedFiles.length,
    status: 'prepared', plan, casAttempted, reason: null, createdAt };
  f.store.transaction(() => {
    const row = f.store.db.prepare('SELECT value FROM worktree_registry WHERE key=?').get('state');
    const image = JSON.parse(row.value);
    const entry = image.entries.find(item => item.id === f.item.id);
    entry.phase = 'saving'; entry.saveRequestId = requestId; entry.saveId = saveId;
    f.store.db.prepare('UPDATE worktree_registry SET value=? WHERE key=?').run(JSON.stringify(image), 'state');
    f.store.db.prepare('INSERT INTO worktree_fences(project_id,worktree_id,operation,repo,workspace,created_at) VALUES(?,?,?,?,?,?)')
      .run(f.project.id, f.item.id, 'save', f.item.repo, f.item.path, createdAt);
    f.store.db.prepare('INSERT INTO worktree_saves(request_id,worktree_id,value) VALUES(?,?,?)')
      .run(requestId, f.item.id, JSON.stringify(record));
  });
  return { record, plan, capture };
}

test('save previews and commits all tracked, untracked and deleted text without changing source bytes', async t => {
  const f = await fixture(t);
  await changed(f);
  const before = await Promise.all(['tracked.txt', 'new.txt'].map(name => readFile(join(f.item.path, name))));
  const preview = await f.manager.savePreview(f.item.id);
  assert.deepEqual(preview.changedFiles.map(row => [row.path, row.kind]), [
    ['deleted.txt', 'deleted'], ['new.txt', 'added'], ['tracked.txt', 'modified']
  ]);
  assert.match(preview.patch, /new UTF-8/);
  const result = await f.manager.save({ id: f.item.id, requestId: 'save-1', expectedHead: preview.head,
    expectedTaskRevision: preview.taskRevision, expectedContentVersion: preview.contentVersion,
    expectedSourceDigest: preview.sourceDigest });
  assert.equal(result.phase, 'ready');
  assert.equal(result.changedFileCount, 3);
  assert.equal(run(f.item.path, 'rev-parse', 'HEAD'), result.sourceHead);
  assert.equal(run(f.item.path, 'status', '--porcelain'), '');
  assert.equal(run(f.item.path, 'ls-tree', '-r', '--name-only', 'HEAD').includes('deleted.txt'), false);
  assert.deepEqual(await Promise.all(['tracked.txt', 'new.txt'].map(name => readFile(join(f.item.path, name)))), before);
  assert.deepEqual(await f.manager.saveStatus({ id: f.item.id, requestId: 'save-1' }), result);
  assert.deepEqual(await f.manager.save({ id: f.item.id, requestId: 'save-1', expectedHead: preview.head,
    expectedTaskRevision: preview.taskRevision, expectedContentVersion: preview.contentVersion,
    expectedSourceDigest: preview.sourceDigest }), result);
  const restarted = createWorktreeManager({ store: f.store, rootDir: f.rootDir });
  assert.deepEqual(await restarted.reconcileSave({ id: f.item.id, requestId: 'save-1' }), result);
  assert.equal((await restarted.inspect(f.item.id)).phase, 'ready');
});

test('source or task change after preview rejects without acquiring a save fence', async t => {
  const f = await fixture(t);
  await changed(f);
  const preview = await f.manager.savePreview(f.item.id);
  await writeFile(join(f.item.path, 'new.txt'), 'changed after preview\n');
  await assert.rejects(f.manager.save({ id: f.item.id, requestId: 'changed', expectedHead: preview.head,
    expectedTaskRevision: preview.taskRevision, expectedContentVersion: preview.contentVersion,
    expectedSourceDigest: preview.sourceDigest }), { code: 'WORKTREE_SAVE_CHANGED' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM worktree_fences').get().n, 0);
  assert.equal(run(f.item.path, 'rev-parse', 'HEAD'), preview.head);
});

test('staged changes, symlinks and binary additions never become partial saved versions', async t => {
  const f = await fixture(t);
  await writeFile(join(f.item.path, 'new.txt'), 'safe\n');
  run(f.item.path, 'add', 'new.txt');
  assert.equal((await f.manager.savePreview(f.item.id)).saveable, false);
  run(f.item.path, 'reset', '-q', 'HEAD', '--', 'new.txt');
  await symlink('tracked.txt', join(f.item.path, 'link.txt'));
  assert.equal((await f.manager.savePreview(f.item.id)).saveable, false);
  await rm(join(f.item.path, 'link.txt'));
  await writeFile(join(f.item.path, 'binary.bin'), Buffer.from([0, 1, 2]));
  assert.equal((await f.manager.savePreview(f.item.id)).saveable, false);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM worktree_saves').get().n, 0);
});

test('synchronous control admission veto prevents save, and an active execution blocks the fence', async t => {
  let allow = false;
  const f = await fixture(t, () => { if (!allow) throw new Error('control blocked'); });
  await writeFile(join(f.item.path, 'tracked.txt'), 'changed\n');
  const preview = await f.manager.savePreview(f.item.id);
  const input = { id: f.item.id, requestId: 'blocked', expectedHead: preview.head,
    expectedTaskRevision: preview.taskRevision, expectedContentVersion: preview.contentVersion,
    expectedSourceDigest: preview.sourceDigest };
  await assert.rejects(f.manager.save(input), /control blocked/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM worktree_fences').get().n, 0);
  allow = true;
  const running = f.store.updateTask(f.task.id, { status: 'running' }, f.task.revision);
  const runningPreview = await f.manager.savePreview(f.item.id);
  assert.equal(runningPreview.taskRevision, running.revision);
  await assert.rejects(f.manager.save({ ...input, expectedTaskRevision: runningPreview.taskRevision,
    expectedContentVersion: runningPreview.contentVersion, expectedSourceDigest: runningPreview.sourceDigest }), { code: 'EXECUTION_BUSY' });
  assert.equal(run(f.item.path, 'rev-parse', 'HEAD'), preview.head);
});

test('a known unrelated startup lease does not block this save, but an overlapping startup does', async t => {
  const f = await fixture(t);
  await writeFile(join(f.item.path, 'tracked.txt'), 'changed\n');
  const preview = await f.manager.savePreview(f.item.id);
  const setLease = workspace => f.store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('execution.leases.v1', JSON.stringify({ version: 1, reservations: [{ status: 'startup',
      projectId: 'other-project', workspace }] }));
  setLease(f.item.path);
  const input = { id: f.item.id, requestId: 'startup-overlap', expectedHead: preview.head,
    expectedTaskRevision: preview.taskRevision, expectedContentVersion: preview.contentVersion,
    expectedSourceDigest: preview.sourceDigest };
  await assert.rejects(f.manager.save(input), { code: 'EXECUTION_BUSY' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM worktree_fences').get().n, 0);
  const unrelated = join(f.root, 'unrelated-project'); await mkdir(unrelated);
  setLease(unrelated);
  const saved = await f.manager.save({ ...input, requestId: 'startup-unrelated' });
  assert.equal(saved.phase, 'ready');
});

test('configured repository filters are rejected before Git can execute a project command', async t => {
  const f = await fixture(t);
  await writeFile(join(f.item.path, 'tracked.txt'), 'changed\n');
  const marker = join(f.root, 'filter-ran');
  await writeFile(join(f.item.path, '.gitattributes'), 'tracked.txt filter=attack\n');
  run(f.item.path, 'config', 'filter.attack.clean', `touch ${marker}`);
  assert.equal((await f.manager.savePreview(f.item.id)).saveable, false);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM worktree_fences').get().n, 0);
});

test('control characters in a changed path block the complete save preview', async t => {
  const f = await fixture(t);
  await writeFile(join(f.item.path, 'bad\nname.txt'), 'not safe for a review path\n');
  const preview = await f.manager.savePreview(f.item.id);
  assert.equal(preview.worktreeId, f.item.id);
  assert.equal(preview.saveable, false);
  assert.equal(preview.sourceDigest, null);
  assert.equal(preview.patch, null);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM worktree_saves').get().n, 0);
});

test('a replaced durable save intent cannot authorize the old request to publish', async t => {
  let calls = 0, f;
  f = await fixture(t, () => {
    if (++calls !== 4) return;
    const row = f.store.db.prepare('SELECT value FROM worktree_registry WHERE key=?').get('state');
    const image = JSON.parse(row.value);
    image.entries[0].saveId = 'replaced-save-id';
    f.store.db.prepare('UPDATE worktree_registry SET value=? WHERE key=?').run(JSON.stringify(image), 'state');
  });
  await writeFile(join(f.item.path, 'tracked.txt'), 'changed\n');
  const preview = await f.manager.savePreview(f.item.id);
  const result = await f.manager.save({ id: f.item.id, requestId: 'intent-replaced', expectedHead: preview.head,
    expectedTaskRevision: preview.taskRevision, expectedContentVersion: preview.contentVersion,
    expectedSourceDigest: preview.sourceDigest });
  assert.equal(result.phase, 'not_saved');
  assert.equal(run(f.item.path, 'rev-parse', 'HEAD'), preview.head);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM worktree_fences').get().n, 0);
});

test('changing symbolic HEAD after CAS cannot be reported as ready', async t => {
  const f = await fixture(t);
  await writeFile(join(f.item.path, 'tracked.txt'), 'changed\n');
  run(f.item.path, 'branch', 'divert');
  const capture = await captureWorktreeSource(f.item);
  const plan = await prepareWorktreeSave(f.item, capture, { commitDate: new Date().toISOString() });
  await assert.rejects(publishWorktreeSave(f.item, plan, { performCas: () => {
    saveGitSync(f.item.path, ['update-ref', plan.ref, plan.commit, plan.oldHead]);
    saveGitSync(f.item.path, ['symbolic-ref', 'HEAD', 'refs/heads/divert']);
  } }), { code: 'WORKTREE_SAVE_CHANGED' });
  assert.equal(run(f.item.path, 'symbolic-ref', 'HEAD'), 'refs/heads/divert');
  assert.equal(run(f.item.path, 'rev-parse', plan.ref), plan.commit);
});

test('task edit before any CAS settles the original prepared request as not_saved', async t => {
  const f = await fixture(t);
  await writeFile(join(f.item.path, 'tracked.txt'), 'changed\n');
  const { plan, capture } = await durablePreparedSave(f, 'pre-cas-edit');
  const edited = f.store.updateTask(f.task.id, { goal: 'Edited while saving' }, f.task.revision);
  const result = await f.manager.reconcileSave({ id: f.item.id, requestId: 'pre-cas-edit' });
  assert.equal(result.phase, 'not_saved');
  assert.equal(run(f.item.path, 'rev-parse', 'HEAD'), capture.head);
  assert.equal(f.store.getTask(f.task.id).revision, edited.revision);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM worktree_fences').get().n, 0);
  await assert.rejects(readFile(plan.tempIndex), { code: 'ENOENT' });
});

test('exact CAS and installed index yield historical ready receipt after task edit', async t => {
  const f = await fixture(t);
  await writeFile(join(f.item.path, 'tracked.txt'), 'changed\n');
  const { plan } = await durablePreparedSave(f, 'post-cas-edit', true);
  await publishWorktreeSave(f.item, plan, { performCas: () =>
    saveGitSync(f.item.path, ['update-ref', plan.ref, plan.commit, plan.oldHead]) });
  const edited = f.store.updateTask(f.task.id, { goal: 'Edited after Git save' }, f.task.revision);
  const result = await f.manager.reconcileSave({ id: f.item.id, requestId: 'post-cas-edit' });
  assert.equal(result.phase, 'ready');
  assert.equal(result.sourceHead, plan.commit);
  assert.equal(f.store.getTask(f.task.id).revision, edited.revision);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM worktree_fences').get().n, 0);
});

test('durable uncertain CAS with old ref remains unknown and never calls Git CAS again', async t => {
  const f = await fixture(t);
  await writeFile(join(f.item.path, 'tracked.txt'), 'changed\n');
  const { capture } = await durablePreparedSave(f, 'cas-uncertain', true);
  const first = await f.manager.reconcileSave({ id: f.item.id, requestId: 'cas-uncertain' });
  const second = await f.manager.reconcileSave({ id: f.item.id, requestId: 'cas-uncertain' });
  assert.equal(first.phase, 'saving_unknown');
  assert.equal(second.phase, 'saving_unknown');
  assert.equal(run(f.item.path, 'rev-parse', 'HEAD'), capture.head);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM worktree_fences').get().n, 1);
  await assert.rejects(f.manager.savePreview(f.item.id), { code: 'WORKTREE_PHASE' });
});
