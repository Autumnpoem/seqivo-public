import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createWorktreeManager } from '../server/worktrees.mjs';

const run = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
async function fixture(t, authorizeMerge) {
  const dir = await mkdtemp(join(tmpdir(), 'board-worktrees-'));
  const repo = join(dir, 'project'), rootDir = join(dir, 'owned-worktrees');
  await mkdir(repo); await mkdir(rootDir, { mode: 0o700 });
  run(repo, 'init', '-q', '-b', 'main');
  run(repo, 'config', 'user.name', 'Worktree Test');
  run(repo, 'config', 'user.email', 'worktree@example.test');
  await writeFile(join(repo, 'shared.txt'), 'base\n');
  run(repo, 'add', '.'); run(repo, 'commit', '-qm', 'base');
  const store = new Store(join(dir, 'board.sqlite'));
  const project = store.project({ name: 'Worktree project', directory: repo });
  const task = store.createTask({ projectId: project.id, title: 'Task', goal: 'Implement change', criteria: ['Reviewed change'] });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, repo, rootDir, store, project, task,
    manager: createWorktreeManager({ store, rootDir, authorizeMerge }), base: run(repo, 'rev-parse', 'HEAD') };
}

test('creates a task-bound codex branch, persists idempotency, and lists working differences', async t => {
  const f = await fixture(t);
  const input = { projectId: f.project.id, taskId: f.task.id, role: 'builder', requestId: 'request-1', expectedBase: f.base };
  const created = await f.manager.create(input);
  assert.equal(created.phase, 'ready');
  assert.equal(created.baseCommit, f.base);
  assert.match(created.branch, /^codex\/builder-/);
  assert.notEqual(created.path, f.repo);
  assert.equal(run(created.path, 'rev-parse', 'HEAD'), f.base);
  assert.equal((await f.manager.create(input)).id, created.id);
  const restarted = createWorktreeManager({ store: f.store, rootDir: f.rootDir });
  assert.equal((await restarted.reconcile(created.id)).id, created.id);
  await assert.rejects(f.manager.create({ ...input, role: 'reviewer' }), { code: 'WORKTREE_REQUEST_CONFLICT' });
  await writeFile(join(created.path, 'shared.txt'), 'uncommitted work\n');
  const detail = await f.manager.inspect(created.id);
  assert.equal(detail.dirty, true);
  assert.match(detail.nameStatus, /shared\.txt/);
  assert.match(detail.patch, /uncommitted work/);
  assert.equal(await readFile(join(f.repo, 'shared.txt'), 'utf8'), 'base\n');
  await assert.rejects(f.manager.cleanup(created.id), { code: 'WORKTREE_DIRTY' });
  await assert.rejects(f.manager.prepareMerge({ id: created.id, expectedTargetHead: f.base, reviewId: 'human-1' }), { code: 'WORKTREE_REVIEW_REQUIRED' });
});

test('review callback binds source and target HEAD; merge conflict remains for manual resolution', async t => {
  let authorized = false;
  const f = await fixture(t, async input => ({ authorized, reviewId: input.reviewId, sourceHead: input.sourceHead, targetHead: input.targetHead }));
  const item = await f.manager.create({ projectId: f.project.id, taskId: f.task.id, role: 'editor', requestId: 'request-2', expectedBase: f.base });
  await writeFile(join(item.path, 'shared.txt'), 'worktree change\n');
  run(item.path, 'add', '.'); run(item.path, 'commit', '-qm', 'worktree change');
  const sourceHead = run(item.path, 'rev-parse', 'HEAD');
  await assert.rejects(f.manager.prepareMerge({ id: item.id, expectedTargetHead: f.base, reviewId: 'human-2' }), { code: 'WORKTREE_REVIEW_REQUIRED' });
  authorized = true;
  await writeFile(join(f.repo, 'shared.txt'), 'target change\n');
  run(f.repo, 'add', '.'); run(f.repo, 'commit', '-qm', 'target change');
  const targetHead = run(f.repo, 'rev-parse', 'HEAD');
  const submitted=f.store.updateTask(f.task.id,{status:'submitted'},f.task.revision);
  const evidenced=f.store.addEvidence(f.task.id,{summary:'Source reviewed',reference:'Git commit',expectedRevision:submitted.revision});
  f.store.review(f.task.id,{decision:'pass',summary:'Accepted',expectedRevision:evidenced.revision});
  f.manager.recordReview({id:item.id,reviewId:'human-2',sourceHead,targetHead,actor:'owner'});
  await assert.rejects(f.manager.prepareMerge({ id: item.id, expectedTargetHead: f.base, reviewId: 'human-2' }), { code: 'WORKTREE_TARGET_CHANGED' });
  const conflict = await f.manager.prepareMerge({ id: item.id, expectedTargetHead: targetHead, reviewId: 'human-2' });
  assert.equal(conflict.phase, 'conflict');
  assert.equal(run(f.repo, 'rev-parse', 'MERGE_HEAD'), sourceHead);
  assert.match(await readFile(join(f.repo, 'shared.txt'), 'utf8'), /<<<<<<< HEAD/);
  assert.equal((await f.manager.reconcile(item.id)).phase, 'conflict');
  await assert.rejects(f.manager.cleanup(item.id), { code: 'WORKTREE_PHASE' });
  await writeFile(join(f.repo, 'shared.txt'), 'resolved together\n');
  run(f.repo, 'add', '.');
  await assert.rejects(f.manager.finalizeMerge({ id: item.id, expectedIndexTree: f.base }), { code: 'WORKTREE_INDEX_CHANGED' });
  const tree = run(f.repo, 'write-tree');
  const merged = await f.manager.finalizeMerge({ id: item.id, expectedIndexTree: tree });
  assert.equal(merged.phase, 'merged');
  assert.equal(run(f.repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
  const removed = await f.manager.cleanup(item.id);
  assert.equal(removed.phase, 'removed');
  assert.equal((await f.manager.cleanup(item.id)).phase, 'removed');
});

test('dirty main worktree and changed project binding block creation or reuse', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'untracked.txt'), 'user changes\n');
  await assert.rejects(f.manager.create({ projectId: f.project.id, taskId: f.task.id, role: 'builder', requestId: 'dirty', expectedBase: f.base }), { code: 'WORKTREE_DIRTY' });
  await rm(join(f.repo, 'untracked.txt'));
  const item = await f.manager.create({ projectId: f.project.id, taskId: f.task.id, role: 'builder', requestId: 'clean', expectedBase: f.base });
  const other = join(f.dir, 'other'); await mkdir(other);
  run(other, 'init', '-q', '-b', 'main');
  // A changed project binding must not redirect an existing worktree record.
  f.store.db.prepare('UPDATE projects SET directory=?, data=? WHERE id=?')
    .run(other, JSON.stringify({ ...f.project, directory: other }), f.project.id);
  await assert.rejects(f.manager.reconcile(item.id), { code: 'WORKTREE_BINDING_CHANGED' });
});

test('restart reconciles a recorded creation and refuses a path replaced by a symlink', async t => {
  const f = await fixture(t);
  const item = await f.manager.create({ projectId: f.project.id, taskId: f.task.id, role: 'builder', requestId: 'recovery', expectedBase: f.base });
  const row = f.store.db.prepare('SELECT value FROM worktree_registry WHERE key=?').get('state');
  const image = JSON.parse(row.value);
  image.entries[0].phase = 'creating';
  f.store.db.prepare('UPDATE worktree_registry SET value=? WHERE key=?').run(JSON.stringify(image), 'state');
  const restarted = createWorktreeManager({ store: f.store, rootDir: f.rootDir });
  assert.equal((await restarted.reconcile(item.id)).phase, 'ready');
  await writeFile(join(item.path, 'saved.txt'), 'committed work\n');
  run(item.path, 'add', '.'); run(item.path, 'commit', '-qm', 'saved work');
  await assert.rejects(restarted.cleanup(item.id), { code: 'WORKTREE_UNMERGED' });
  const outside = join(f.dir, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'keep\n');
  await rename(item.path, `${item.path}.moved`);
  await symlink(outside, item.path);
  await assert.rejects(restarted.cleanup(item.id), { code: 'WORKTREE_IDENTITY' });
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep\n');
});

test('cleanup interrupted after durable intent resumes only for the same clean worktree HEAD', async t => {
  const f = await fixture(t);
  const item = await f.manager.create({ projectId: f.project.id, taskId: f.task.id, role: 'builder', requestId: 'cleanup-crash', expectedBase: f.base });
  const row = f.store.db.prepare('SELECT value FROM worktree_registry WHERE key=?').get('state');
  const image = JSON.parse(row.value);
  image.entries[0].phase = 'removing'; image.entries[0].cleanupHead = f.base;
  f.store.db.prepare('UPDATE worktree_registry SET value=? WHERE key=?').run(JSON.stringify(image), 'state');
  const restarted = createWorktreeManager({ store: f.store, rootDir: f.rootDir });
  assert.equal((await restarted.reconcile(item.id)).phase, 'removed');
  assert.equal((await restarted.reconcile(item.id)).phase, 'removed');
});

test('restart clears only a verified pre-write fence and retains uncertain workspace evidence', async t => {
  const f=await fixture(t);
  const item=await f.manager.create({projectId:f.project.id,taskId:f.task.id,role:'builder',requestId:'fence-crash',expectedBase:f.base});
  const insert=f.store.db.prepare('INSERT INTO worktree_fences(project_id,worktree_id,operation,repo,created_at) VALUES(?,?,?,?,?)');
  insert.run(f.project.id,item.id,'merge',item.repo,new Date().toISOString());
  const restarted=createWorktreeManager({store:f.store,rootDir:f.rootDir});
  assert.equal((await restarted.reconcile(item.id)).phase,'ready');
  assert.equal(f.store.db.prepare('SELECT * FROM worktree_fences WHERE project_id=?').get(f.project.id),undefined);
  insert.run(f.project.id,item.id,'merge',item.repo,new Date().toISOString());
  await writeFile(join(f.repo,'untracked.txt'),'unknown writer\n');
  await assert.rejects(restarted.reconcile(item.id),{code:'WORKTREE_UNKNOWN'});
  assert.throws(()=>restarted.assertMayExecute(f.project.id),{code:'EXECUTION_BUSY'});
  assert.equal(f.store.db.prepare('SELECT operation FROM worktree_fences WHERE project_id=?').get(f.project.id).operation,'merge');
});
