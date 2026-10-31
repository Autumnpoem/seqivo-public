import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { createTerminalControl } from '../server/terminal/control.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', cwd, ...args],
  { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-save-core-')));
  const repo = join(root, 'repo'), dataDir = join(root, 'data'), pluginDir = join(root, 'empty-plugins');
  await mkdir(repo); await mkdir(pluginDir);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Isolated save test'); git(repo, 'config', 'user.email', 'save@example.invalid');
  await writeFile(join(repo, 'base.txt'), 'before\n');
  git(repo, 'add', '--', 'base.txt'); git(repo, 'commit', '-qm', 'base');
  let core = await createCore({ dataDir, pluginDir, files: false });
  t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
  const project = core.store.project({ name: 'Save route test', directory: repo });
  const task = core.store.createTask({ projectId: project.id, title: 'Change text', criteria: ['Review exact saved text'] });
  const base = git(repo, 'rev-parse', 'HEAD');
  const tree = await core.request('POST', '/api/worktrees', { projectId: project.id, taskId: task.id,
    role: 'worker', requestId: 'create-save-fixture', expectedBase: base });
  return { root, repo, project, task, tree, base, get core() { return core; },
    restart: async () => { await core.close(); core = await createCore({ dataDir, pluginDir, files: false }); } };
}
const saveInput = (preview, requestId) => ({ requestId, expectedHead: preview.head,
  expectedTaskRevision: preview.taskRevision, expectedContentVersion: preview.contentVersion,
  expectedSourceDigest: preview.sourceDigest });

test('all save endpoints reject non-owners before previewing or mutating Git', async t => {
  const f = await fixture(t), prefix = `/api/worktrees/${f.tree.id}`;
  await writeFile(join(f.tree.path, 'base.txt'), 'private draft\n');
  for (const role of ['viewer', 'reporter', 'remote-controller']) {
    for (const [method, suffix] of [['GET', '/save-preview'], ['GET', '/save?requestId=denied'], ['POST', '/save'], ['POST', '/save/reconcile']])
      await assert.rejects(f.core.request(method, prefix + suffix, { requestId: 'denied' }, role), { status: 403 });
  }
  assert.equal(git(f.tree.path, 'rev-parse', 'HEAD'), f.base);
  const absent = await f.core.request('GET', prefix + '/save?requestId=denied');
  assert.equal(absent.phase, 'not_found'); assert.equal(absent.requestId, 'denied');
});

test('owner saves tracked and new text through Core; lost response and restart keep one commit and task state', async t => {
  const f = await fixture(t), prefix = `/api/worktrees/${f.tree.id}`;
  await writeFile(join(f.tree.path, 'base.txt'), 'after\n');
  await writeFile(join(f.tree.path, 'added.txt'), 'new text\n');
  const before = structuredClone(f.core.store.getTask(f.task.id));
  const preview = await f.core.request('GET', prefix + '/save-preview');
  assert.equal(preview.saveable, true);
  assert.deepEqual(preview.changedFiles.map(row => row.path).sort(), ['added.txt', 'base.txt']);
  const input = saveInput(preview, 'owner-save-once');
  // The path selects the worktree. Body identity must not redirect the operation.
  const receipt = await f.core.request('POST', prefix + '/save', { ...input, id: 'body-must-not-override-route' });
  assert.equal(receipt.phase, 'ready');
  assert.notEqual(receipt.sourceHead, f.base);
  assert.equal(git(f.tree.path, 'show', 'HEAD:added.txt'), 'new text');
  assert.equal(git(f.tree.path, 'status', '--porcelain'), '');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.base);
  assert.deepEqual(f.core.store.getTask(f.task.id), before);
  await f.restart();
  const recovered = await f.core.request('GET', prefix + '/save?requestId=owner-save-once');
  assert.equal(recovered.phase, 'ready'); assert.equal(recovered.sourceHead, receipt.sourceHead);
  const duplicate = await f.core.request('POST', prefix + '/save', input);
  assert.equal(duplicate.sourceHead, receipt.sourceHead);
  assert.equal(git(f.tree.path, 'rev-list', '--count', `${f.base}..HEAD`), '1');
  assert.deepEqual(f.core.store.getTask(f.task.id), before);
  assert.equal(f.core.store.db.prepare('SELECT count(*) AS n FROM worktree_reviews').get().n, 0);
});

test('save fence prevents managed and existing-session takeovers without changing control state', async t => {
  const f = await fixture(t); let stops = 0;
  const alias = f.core.store.project({ name: 'Overlapping worktree', directory: f.tree.path });
  const control = createTerminalControl({ store: f.core.store,
    beforeAcquire: id => f.core.worktrees.assertMayExecute(id),
    quiesce: async () => { stops++; throw Error('Must not reach a process'); } });
  f.core.store.db.prepare('INSERT INTO worktree_fences(project_id,worktree_id,operation,repo,created_at,workspace) VALUES(?,?,?,?,?,?)')
    .run(f.project.id, f.tree.id, 'save', f.tree.repo, new Date().toISOString(), f.tree.path);
  for (const projectId of [f.project.id, alias.id]) {
    await assert.rejects(control.acquire({ projectId, actorId: 'owner' }), { code: 'EXECUTION_BUSY' });
    await assert.rejects(control.acquireExisting({ projectId, actorId: 'owner', profileId: 'test',
      sessionRefs: [{ serverName: 'test', instanceId: 'a'.repeat(64), sessionId: '$0' }] }), { code: 'EXECUTION_BUSY' });
  }
  assert.deepEqual(control.state(), []); assert.equal(stops, 0);
  assert.equal(f.core.store.db.prepare('SELECT operation FROM worktree_fences').get().operation, 'save');
});

test('human or uncertain control denies saving before any source commit is created', async t => {
  const f = await fixture(t), prefix = `/api/worktrees/${f.tree.id}`;
  await writeFile(join(f.tree.path, 'base.txt'), 'after\n');
  const preview = await f.core.request('GET', prefix + '/save-preview');
  for (const phase of ['human', 'unknown', 'transfer_pending']) {
    f.core.store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('terminal.control.v1',
      JSON.stringify({ version: 1, entries: { [f.project.id]: { projectId: f.project.id,
        workspace: f.tree.repo, phase, generation: 1 } } }));
    await assert.rejects(f.core.request('POST', prefix + '/save', saveInput(preview, `blocked-${phase}`)),
      { code: 'CONTROL_BUSY' });
    assert.equal(git(f.tree.path, 'rev-parse', 'HEAD'), f.base);
  }
});

test('a human controlling an overlapping worktree alias blocks save, then ai_ready permits the same exact draft', async t => {
  const f = await fixture(t), prefix = `/api/worktrees/${f.tree.id}`;
  await writeFile(join(f.tree.path, 'base.txt'), 'after alias check\n');
  const nested = join(f.tree.path, 'nested'); await mkdir(nested);
  const alias = f.core.store.project({ name: 'Worktree alias', directory: f.tree.path });
  const preview = await f.core.request('GET', prefix + '/save-preview');
  for (const [index, workspace] of [f.tree.path, nested, join(f.tree.path, '..')].entries()) {
    f.core.store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('terminal.control.v1',
      JSON.stringify({ version: 1, entries: { [alias.id]: { projectId: alias.id,
        workspace: await realpath(workspace), phase: 'human', generation: 1 } } }));
    await assert.rejects(f.core.request('POST', prefix + '/save', saveInput(preview, `alias-blocked-${index}`)),
      { code: 'CONTROL_BUSY' });
    assert.equal(git(f.tree.path, 'rev-parse', 'HEAD'), f.base);
  }
  f.core.store.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify({ version: 1,
    entries: { [alias.id]: { projectId: alias.id, workspace: f.tree.path, phase: 'ai_ready', generation: 2 } } }),
  'terminal.control.v1');
  const saved = await f.core.request('POST', prefix + '/save', saveInput(preview, 'alias-released'));
  assert.equal(saved.phase, 'ready'); assert.notEqual(saved.sourceHead, f.base);
});
