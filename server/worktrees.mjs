import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { BoardError } from './store.mjs';
import { captureWorktreeSource, finishWorktreeSave, inspectWorktreeSave, prepareWorktreeSave,
  publishWorktreeSave, saveGit, saveGitSync } from './worktree-save.mjs';

const execFileAsync = promisify(execFile);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const fail = (message, code = 'WORKTREE_INVALID', status = 409) => { throw new BoardError(message, status, code); };
const safe = (value, label, max = 160) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(`${label}无效`);
  return value.trim();
};
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'role';

/** A project-bound Git worktree registry. The caller supplies a trusted, app-owned root directory. */
export function createWorktreeManager({ store, rootDir, gitExecutable = 'git', authorizeMerge, assertSaveAllowed = () => {}, now = Date.now } = {}) {
  if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('A Store is required');
  if (typeof rootDir !== 'string' || !isAbsolute(rootDir)) throw new TypeError('An absolute app-owned rootDir is required');
  const root = realpathSync(rootDir);
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || process.platform !== 'win32' && (rootInfo.mode & 0o077) !== 0)
    throw new TypeError('rootDir must be a pre-existing private directory');
  if (typeof assertSaveAllowed !== 'function') throw new TypeError('assertSaveAllowed must be a synchronous callback');
  store.db.exec('CREATE TABLE IF NOT EXISTS worktree_registry (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  store.db.exec('CREATE TABLE IF NOT EXISTS worktree_reviews (id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL, task_id TEXT NOT NULL, content_version INTEGER NOT NULL, source_head TEXT NOT NULL, target_head TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)');
  if (!store.db.prepare('PRAGMA table_info(worktree_reviews)').all().some(row => row.name === 'index_tree'))
    store.db.exec('ALTER TABLE worktree_reviews ADD COLUMN index_tree TEXT');
  store.db.exec('CREATE TABLE IF NOT EXISTS worktree_fences (project_id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL, operation TEXT NOT NULL, repo TEXT NOT NULL, created_at TEXT NOT NULL)');
  store.db.exec('CREATE TABLE IF NOT EXISTS worktree_saves (request_id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL, value TEXT NOT NULL)');
  if (!store.db.prepare('PRAGMA table_info(worktree_fences)').all().some(row => row.name === 'workspace'))
    store.db.exec('ALTER TABLE worktree_fences ADD COLUMN workspace TEXT');
  let serial = Promise.resolve();
  const enqueue = fn => { const pending = serial.then(fn); serial = pending.catch(() => {}); return pending; };
  const read = () => {
    const row = store.db.prepare('SELECT value FROM worktree_registry WHERE key=?').get('state');
    const image = row ? JSON.parse(row.value) : { version: 1, entries: [] };
    if (image.version !== 1 || !Array.isArray(image.entries)) fail('工作树登记版本无效', 'WORKTREE_STATE');
    return image;
  };
  const mutate = fn => store.transaction(() => {
    const image = read(), result = fn(image);
    store.db.prepare('INSERT INTO worktree_registry(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('state', JSON.stringify(image));
    return result;
  });
  const copy = value => structuredClone(value);
  const activeLeaseStatuses = new Set(['startup', 'reserved', 'running', 'unknown']);
  const knownLeaseStatuses = new Set([...activeLeaseStatuses, 'completed', 'failed', 'paused', 'not_started', 'waiting_quota']);
  const heldMemberStatuses = new Set(['sending', 'running', 'pausing', 'unknown']);
  const overlaps = (a, b) => inside(a, b) || inside(b, a);
  const metadata = key => { const row = store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; };
  const fenceWorkspace = fence => {
    const workspace = fence.workspace || read().entries.find(item => item.id === fence.worktree_id)?.path;
    if (typeof workspace !== 'string' || !isAbsolute(workspace)) fail('工作树围栏目录无法核验', 'EXECUTION_BUSY');
    return workspace;
  };
  function assertNoExecutions(entry) {
    // Build intents survive a metadata replay. An unresolved build whose
    // typed lease is missing must not become permission to rewrite its tree.
    const previewTable=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='preview_controlled_builds'").get();
    if(previewTable)for(const item of store.db.prepare('SELECT value FROM preview_controlled_builds').all()){
      let build;try{build=JSON.parse(item.value);}catch{fail('受控构建记录无法核验','EXECUTION_BUSY');}
      if(!['ready','failed_no_publish'].includes(build.state)&&
        (build.projectId===entry.projectId||!isAbsolute(build.workspace||'')||
          overlaps(build.workspace,entry.repo)||overlaps(build.workspace,entry.path)))
        fail('重叠目录受控构建尚未结清','EXECUTION_BUSY');
    }
    if (store.tasks(entry.projectId).some(task => task.status === 'running'))
      fail('项目仍有运行中任务', 'EXECUTION_BUSY');
    // A different project may be bound to the same real worktree directory.
    // Such a task is still a writer even when an old provider has no lease.
    for (const project of store.projects()) {
      if (project.id === entry.projectId || !store.tasks(project.id).some(task => task.status === 'running')) continue;
      let directory;
      try {
        directory = realpathSync(project.directory);
        if (directory !== project.directory) throw new Error('project binding changed');
      } catch { fail('其他运行中项目的目录无法核验', 'EXECUTION_WORKSPACE_CHANGED'); }
      if (overlaps(directory, entry.repo) || overlaps(directory, entry.path))
        fail('重叠项目仍有运行中任务', 'EXECUTION_BUSY');
    }
    const leases = metadata('execution.leases.v1');
    if (leases && (leases.version !== 1 || !Array.isArray(leases.reservations))) fail('执行租约无法核验', 'EXECUTION_BUSY');
    if (leases?.reservations.some(row => !knownLeaseStatuses.has(row.status))) fail('执行租约结果无法核验', 'EXECUTION_BUSY');
    if (leases?.reservations.some(row => activeLeaseStatuses.has(row.status) &&
      (row.projectId === entry.projectId || !isAbsolute(row.workspace || '') ||
       overlaps(row.workspace, entry.repo) || overlaps(row.workspace, entry.path))))
      fail('项目或重叠目录仍有活动执行租约', 'EXECUTION_BUSY');
    const workflow = metadata('workflow.v1');
    if (workflow && !Array.isArray(workflow.plans)) fail('协作状态无法核验', 'EXECUTION_BUSY');
    if (workflow?.plans.some(plan => !Array.isArray(plan.members))) fail('协作成员状态无法核验', 'EXECUTION_BUSY');
    if (workflow?.plans.some(plan => plan.members?.some(member => heldMemberStatuses.has(member.status) &&
      (plan.projectId === entry.projectId || !isAbsolute(member.workspace || '') ||
       overlaps(member.workspace, entry.repo) || overlaps(member.workspace, entry.path)))))
      fail('项目或重叠目录仍有协作执行者', 'EXECUTION_BUSY');
  }
  function assertMayExecute(projectId,extraRoots=[]) {
    const project = store.getProject(projectId);
    let directory;
    try { directory = realpathSync(project.directory); } catch { fail('项目目录无法核验', 'EXECUTION_BUSY'); }
    if(!Array.isArray(extraRoots)||extraRoots.some(path=>typeof path!=='string'||!isAbsolute(path)))
      fail('执行目录无法核验','EXECUTION_BUSY');
    const roots=[directory,...extraRoots.map(path=>{
      let actual;try{actual=realpathSync(path);}catch{fail('执行目录无法核验','EXECUTION_BUSY');}
      if(actual!==path)fail('执行目录真实身份已变化','EXECUTION_BUSY');
      return actual;
    })];
    for (const fence of store.db.prepare('SELECT * FROM worktree_fences').all())
      if (fence.project_id === projectId || roots.some(root=>
        overlaps(root, fence.repo) || overlaps(root, fenceWorkspace(fence))))
        fail('项目工作树操作尚未结清，不能启动执行', 'EXECUTION_BUSY');
  }
  function acquireFence(entry, operation, onAcquired) {
    return store.transaction(() => {
      assertNoExecutions(entry);
      for (const other of store.db.prepare('SELECT * FROM worktree_fences WHERE project_id<>?').all(entry.projectId))
        if (overlaps(entry.repo, other.repo) || overlaps(entry.repo, fenceWorkspace(other)) ||
            overlaps(entry.path, other.repo) || overlaps(entry.path, fenceWorkspace(other)))
          fail('重叠项目已有工作树操作', 'WORKTREE_FENCED');
      const prior = store.db.prepare('SELECT * FROM worktree_fences WHERE project_id=?').get(entry.projectId);
      if (prior) {
        if (prior.worktree_id !== entry.id || prior.operation !== operation || prior.repo !== entry.repo ||
            fenceWorkspace(prior) !== entry.path)
          fail('项目已有其他工作树操作', 'WORKTREE_FENCED');
        if (operation === 'save') fail('保存操作已有未结清的请求', 'WORKTREE_FENCED');
        return prior;
      }
      const fence = { project_id: entry.projectId, worktree_id: entry.id, operation, repo: entry.repo, workspace: entry.path,
        created_at: new Date(now()).toISOString() };
      store.db.prepare('INSERT INTO worktree_fences(project_id,worktree_id,operation,repo,created_at,workspace) VALUES(?,?,?,?,?,?)')
        .run(fence.project_id, fence.worktree_id, fence.operation, fence.repo, fence.created_at, fence.workspace);
      onAcquired?.();
      return fence;
    });
  }
  function requireFence(entry, operation) {
    const fence = store.db.prepare('SELECT * FROM worktree_fences WHERE project_id=?').get(entry.projectId);
    if (!fence || fence.worktree_id !== entry.id || fence.operation !== operation || fence.repo !== entry.repo ||
        fenceWorkspace(fence) !== entry.path)
      fail('工作树操作围栏身份不符', 'WORKTREE_FENCED');
  }
  function releaseFence(entry, operation) {
    store.transaction(() => {
      requireFence(entry, operation);
      store.db.prepare('DELETE FROM worktree_fences WHERE project_id=?').run(entry.projectId);
    });
  }
  const entryFor = id => { const entry = read().entries.find(item => item.id === id); if (!entry) fail('工作树不存在', 'WORKTREE_NOT_FOUND', 404); return entry; };
  function binding({ id, taskId, role } = {}) {
    const entry = entryFor(safe(id, '工作树 ID'));
    if (entry.phase !== 'ready' || entry.taskId !== taskId || role !== undefined && entry.role !== role)
      fail('工作树未就绪或与任务、角色不符', 'WORKTREE_BINDING_CHANGED');
    const project = store.getProject(entry.projectId);
    if (store.getTask(taskId).projectId !== entry.projectId || project.directory !== entry.repo ||
        realpathSync(entry.repo) !== entry.repo || entry.path !== join(root, entry.id) ||
        realpathSync(entry.path) !== entry.path)
      fail('工作树路径或项目绑定已变化', 'WORKTREE_BINDING_CHANGED');
    return copy(entry);
  }
  function recordReview({ id, reviewId, sourceHead, targetHead, actor, indexTree = null } = {}) {
    const entry = entryFor(safe(id, '工作树 ID'));
    safe(reviewId, '人工审查 ID'); safe(actor, '人工审查者');
    if (!hash(sourceHead) || !hash(targetHead)) fail('审查必须绑定精确源和目标提交', 'WORKTREE_REVIEW_REQUIRED');
    if (entry.phase === 'ready' && indexTree !== null ||
        ['merging', 'conflict'].includes(entry.phase) && (!hash(indexTree) || sourceHead !== entry.mergeSourceHead || targetHead !== entry.mergeTargetHead) ||
        !['ready', 'merging', 'conflict'].includes(entry.phase)) fail('审查阶段或索引版本不符', 'WORKTREE_REVIEW_REQUIRED');
    const project = store.getProject(entry.projectId);
    if (project.directory !== entry.repo || realpathSync(entry.repo) !== entry.repo ||
        entry.path !== join(root, entry.id) || realpathSync(entry.path) !== entry.path ||
        store.getTask(entry.taskId).projectId !== entry.projectId)
      fail('工作树路径或项目绑定已变化', 'WORKTREE_BINDING_CHANGED');
    const task = store.getTask(entry.taskId);
    if (task.acceptance !== 'passed' || task.review?.source !== 'human' || task.review.contentVersion !== task.contentVersion)
      fail('任务尚未由人工验收当前内容', 'WORKTREE_REVIEW_REQUIRED');
    const receipt = { reviewId, worktreeId: id, taskId: entry.taskId, contentVersion: task.contentVersion,
      sourceHead, targetHead, indexTree, actor, createdAt: new Date(now()).toISOString() };
    store.transaction(() => {
      const prior = store.db.prepare('SELECT * FROM worktree_reviews WHERE id=?').get(reviewId);
      if (prior) {
        if (prior.worktree_id !== id || prior.task_id !== entry.taskId || prior.content_version !== task.contentVersion ||
            prior.source_head !== sourceHead || prior.target_head !== targetHead || prior.index_tree !== indexTree || prior.actor !== actor)
          fail('审查 ID 已用于其他版本', 'WORKTREE_REVIEW_CONFLICT');
      } else store.db.prepare('INSERT INTO worktree_reviews(id,worktree_id,task_id,content_version,source_head,target_head,actor,created_at,index_tree) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(reviewId, id, entry.taskId, task.contentVersion, sourceHead, targetHead, actor, receipt.createdAt, indexTree);
      if (indexTree !== null) {
        requireFence(entry, 'merge');
        const image = read(), current = image.entries.find(item => item.id === id);
        if (!current || !['merging', 'conflict'].includes(current.phase)) fail('合入现场已变化', 'WORKTREE_PHASE');
        current.reviewId = reviewId;
        store.db.prepare('INSERT INTO worktree_registry(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run('state', JSON.stringify(image));
      }
    });
    return receipt;
  }
  function reviewDecision({ reviewId, taskId, sourceHead, targetHead, branch, baseCommit, projectId } = {}) {
    const row = store.db.prepare('SELECT * FROM worktree_reviews WHERE id=?').get(reviewId);
    if (!row) return { authorized: false };
    const entry = binding({ id: row.worktree_id, taskId });
    const task = store.getTask(taskId);
    const authorized = row.task_id === taskId && entry.projectId === projectId && entry.branch === branch &&
      entry.baseCommit === baseCommit && row.source_head === sourceHead && row.target_head === targetHead &&
      task.contentVersion === row.content_version && task.acceptance === 'passed' &&
      task.review?.source === 'human' && task.review.contentVersion === task.contentVersion;
    return { authorized, reviewId, sourceHead: row.source_head, targetHead: row.target_head };
  }
  function finalizeDecision({ entry, indexTree } = {}) {
    const row = store.db.prepare('SELECT * FROM worktree_reviews WHERE id=?').get(entry.reviewId);
    if (!row || row.worktree_id !== entry.id || row.task_id !== entry.taskId ||
        row.source_head !== entry.mergeSourceHead || row.target_head !== entry.mergeTargetHead)
      return { authorized: false, reason: 'missing_receipt', reviewId: entry.reviewId || null };
    const task = store.getTask(entry.taskId);
    if (task.projectId !== entry.projectId || task.contentVersion !== row.content_version ||
        task.acceptance !== 'passed' || task.review?.source !== 'human' ||
        task.review.contentVersion !== task.contentVersion)
      return { authorized: false, reason: 'task_review_stale', reviewId: entry.reviewId };
    if (!indexTree) return { authorized: false, reason: 'index_unresolved', reviewId: entry.reviewId };
    if (row.index_tree !== null && row.index_tree !== indexTree)
      return { authorized: false, reason: 'index_changed', reviewId: entry.reviewId };
    return { authorized: true, reason: null,
      reviewId: entry.reviewId, sourceHead: entry.mergeSourceHead, targetHead: entry.mergeTargetHead,
      indexTree };
  }
  const git = async (cwd, args, { allowFailure = false, maxBuffer = 2 * 1024 * 1024 } = {}) => {
    try {
      const result = await execFileAsync(gitExecutable, ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args],
        { encoding: 'utf8', timeout: 20_000, maxBuffer, windowsHide: true });
      return { ok: true, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (allowFailure) return { ok: false, stdout: error.stdout || '', stderr: error.stderr || '', code: error.code };
      fail(`Git 操作失败：${String(error.stderr || error.message).trim().slice(0, 400)}`, 'WORKTREE_GIT');
    }
  };
  const output = async (cwd, args) => (await git(cwd, args)).stdout.trim();
  const status = async cwd => (await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
  const branch = async cwd => output(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const head = async cwd => output(cwd, ['rev-parse', 'HEAD']);
  const common = async cwd => realpathSync(await output(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const registered = async repo => {
    const raw = (await git(repo, ['worktree', 'list', '--porcelain', '-z'])).stdout;
    return raw.split('\0\n').join('\0').split('\0').reduce((rows, field) => {
      if (field.startsWith('worktree ')) rows.push({ path: field.slice(9) });
      else if (rows.length && field.startsWith('HEAD ')) rows.at(-1).head = field.slice(5);
      else if (rows.length && field.startsWith('branch ')) rows.at(-1).branch = field.slice(7);
      return rows;
    }, []);
  };
  const projectRepo = async projectId => {
    const project = store.getProject(safe(projectId, '项目 ID'));
    if (!project.directory) fail('项目未绑定目录', 'WORKTREE_PROJECT');
    const repo = realpathSync(project.directory);
    if (inside(repo, root) || inside(root, repo)) fail('工作树存放目录与项目重叠', 'WORKTREE_ROOT_OVERLAP');
    if (realpathSync(await output(repo, ['rev-parse', '--show-toplevel'])) !== repo)
      fail('项目目录必须是 Git 仓库根目录', 'WORKTREE_REPO_ROOT');
    return { repo, commonDir: await common(repo) };
  };
  const bound = async entry => {
    const { repo, commonDir } = await projectRepo(entry.projectId);
    if (repo !== entry.repo || commonDir !== entry.commonDir || store.getTask(entry.taskId).projectId !== entry.projectId)
      fail('项目、任务或 Git 仓库身份已变化', 'WORKTREE_BINDING_CHANGED');
    const expected = join(root, entry.id);
    if (entry.path !== expected || !inside(root, expected)) fail('工作树登记路径无效', 'WORKTREE_PATH');
    return repo;
  };
  const observed = async entry => {
    const repo = await bound(entry), rows = await registered(repo);
    const row = rows.find(item => item.path === entry.path);
    if (row) {
      if (realpathSync(entry.path) !== entry.path || row.branch !== `refs/heads/${entry.branch}`)
        fail('Git 工作树路径或分支身份不符', 'WORKTREE_IDENTITY');
    } else {
      try { lstatSync(entry.path); fail('未登记路径上已有文件，保留现场', 'WORKTREE_UNKNOWN'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { repo, row };
  };
  const update = (id, fn) => mutate(image => {
    const entry = image.entries.find(item => item.id === id);
    if (!entry) fail('工作树不存在', 'WORKTREE_NOT_FOUND', 404);
    fn(entry); entry.updatedAt = new Date(now()).toISOString(); return copy(entry);
  });
  async function recover(id) {
    const entry = entryFor(id), { repo, row } = await observed(entry);
    if (entry.phase === 'saving') {
      requireFence(entry, 'save');
      return copy(entry);
    }
    if (entry.phase === 'creating') {
      if (row) {
        if (row.head !== entry.baseCommit) fail('创建期间工作树 HEAD 已变化，保留现场', 'WORKTREE_UNKNOWN');
      } else {
        const found = await git(repo, ['show-ref', '--verify', `refs/heads/${entry.branch}`], { allowFailure: true });
        if (found.ok) {
          if (await output(repo, ['rev-parse', `refs/heads/${entry.branch}`]) !== entry.baseCommit)
            fail('创建期间分支已变化，保留现场', 'WORKTREE_UNKNOWN');
          await git(repo, ['worktree', 'add', entry.path, entry.branch]);
        } else await git(repo, ['worktree', 'add', '-b', entry.branch, entry.path, entry.baseCommit]);
      }
      const verified = (await observed(entry)).row;
      if (!verified || verified.branch !== `refs/heads/${entry.branch}` || verified.head !== entry.baseCommit)
        fail('无法确认新工作树身份', 'WORKTREE_UNKNOWN');
      return update(id, item => { item.phase = 'ready'; item.reason = null; });
    }
    if (entry.phase === 'removing') {
      acquireFence(entry, 'cleanup');
      if (row) {
        if (await status(entry.path) || await head(entry.path) !== entry.cleanupHead)
          fail('清理期间工作树发生变化，保留现场', 'WORKTREE_CLEANUP_PENDING');
        await git(repo, ['worktree', 'remove', entry.path]);
      }
      const present = await git(repo, ['show-ref', '--verify', `refs/heads/${entry.branch}`], { allowFailure: true });
      if (present.ok) await git(repo, ['branch', '-d', entry.branch]);
      const removed = update(id, item => { item.phase = 'removed'; item.reason = null; });
      releaseFence(entry, 'cleanup');
      return removed;
    }
    if (entry.phase === 'merging' || entry.phase === 'conflict') {
      acquireFence(entry, 'merge');
      const mergeHead = await git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true });
      if (mergeHead.ok && mergeHead.stdout.trim() === entry.mergeSourceHead) return copy(entry);
      const parents = (await output(repo, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ');
      if (parents.length === 3 && parents[1] === entry.mergeTargetHead && parents[2] === entry.mergeSourceHead) {
        const merged = update(id, item => { item.phase = 'merged'; item.mergeCommit = parents[0]; item.reason = null; });
        releaseFence(entry, 'merge');
        return merged;
      }
      fail('合入现场与登记不符，保留索引和文件', 'WORKTREE_UNKNOWN');
    }
    if (entry.phase === 'merged') {
      if (!row) fail('已合入工作树已消失，保留围栏', 'WORKTREE_UNKNOWN');
      const fence = store.db.prepare('SELECT * FROM worktree_fences WHERE project_id=?').get(entry.projectId);
      if (fence?.worktree_id === entry.id && fence.operation === 'merge') {
        const parents = (await output(repo, ['rev-list', '--parents', '-n', '1', entry.mergeCommit])).split(' ');
        if (parents[0] !== entry.mergeCommit || parents[1] !== entry.mergeTargetHead || parents[2] !== entry.mergeSourceHead ||
            await head(repo) !== entry.mergeCommit) fail('已合入结果无法核验，保留围栏', 'WORKTREE_UNKNOWN');
        releaseFence(entry, 'merge');
      }
      return copy(entry);
    }
    if (entry.phase === 'ready') {
      if (!row) fail('工作树已消失但登记仍有效', 'WORKTREE_UNKNOWN');
      const fence = store.db.prepare('SELECT * FROM worktree_fences WHERE project_id=?').get(entry.projectId);
      if (fence?.worktree_id === entry.id) {
        // Both operations persist a different phase before their first Git write.
        // A ready entry after restart therefore represents a pre-write intent.
        if (!['merge', 'cleanup'].includes(fence.operation) ||
            (await git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true })).ok ||
            await status(repo) || await status(entry.path))
          fail('预写入围栏的现场无法核实，保留围栏', 'WORKTREE_UNKNOWN');
        releaseFence(entry, fence.operation);
      }
      return copy(entry);
    }
    if (entry.phase === 'removed') {
      const fence = store.db.prepare('SELECT * FROM worktree_fences WHERE project_id=?').get(entry.projectId);
      if (fence?.worktree_id === entry.id && fence.operation === 'cleanup') {
        const present = await git(repo, ['show-ref', '--verify', `refs/heads/${entry.branch}`], { allowFailure: true });
        if (row || present.ok) fail('清理结果无法核验，保留围栏', 'WORKTREE_UNKNOWN');
        releaseFence(entry, 'cleanup');
      }
    }
    return copy(entry);
  }
  async function create({ projectId, taskId, role, requestId, expectedBase } = {}) { return enqueue(async () => {
    safe(taskId, '任务 ID'); safe(role, '角色', 80); safe(requestId, '幂等请求 ID');
    if (!hash(expectedBase)) fail('需要完整的预期 base commit', 'WORKTREE_BASE');
    const { repo, commonDir } = await projectRepo(projectId);
    if (store.getTask(taskId).projectId !== projectId) fail('任务不属于项目', 'WORKTREE_TASK');
    const existing = read().entries.find(item => item.requestId === requestId);
    if (existing) {
      if (existing.projectId !== projectId || existing.taskId !== taskId || existing.role !== role || existing.baseCommit !== expectedBase)
        fail('幂等请求与原工作树参数不符', 'WORKTREE_REQUEST_CONFLICT');
      return recover(existing.id);
    }
    if (await head(repo) !== expectedBase) fail('项目 HEAD 已变化，请刷新 base', 'WORKTREE_BASE_CHANGED');
    if (await status(repo)) fail('主工作区存在未保存更改，请先处理后再建工作树', 'WORKTREE_DIRTY');
    const baseBranch = await branch(repo), id = randomUUID(), path = join(root, id);
    const entry = { id, requestId, projectId, taskId, role, repo, commonDir, path,
      branch: `codex/${slug(role)}-${id}`, baseBranch, baseCommit: expectedBase,
      phase: 'creating', createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(), reason: null };
    mutate(image => { if (image.entries.some(item => item.requestId === requestId)) fail('重复幂等请求', 'WORKTREE_REQUEST_CONFLICT'); image.entries.push(entry); });
    return recover(id);
  }); }
  async function projectBase(projectId) { return enqueue(async () => {
    const { repo } = await projectRepo(projectId);
    return { projectId, targetHead: await head(repo), targetBranch: await branch(repo), targetDirty: Boolean(await status(repo)) };
  }); }
  async function inspect(id) { return enqueue(async () => {
    const entry = await recover(id);
    if (entry.phase === 'removed') return { ...entry, registered: false };
    const { repo, row } = await observed(entry);
    if (!row) fail('工作树身份未核实', 'WORKTREE_UNKNOWN');
    const dirty = await status(entry.path), currentHead = await head(entry.path);
    const names = (await git(entry.path, ['diff', '--no-ext-diff', '--name-status', entry.baseCommit])).stdout;
    const patch = await git(entry.path, ['diff', '--no-ext-diff', '--no-color', '--binary', entry.baseCommit], { allowFailure: true, maxBuffer: 1024 * 1024 });
    const targetStatus = await status(repo);
    const conflictFiles = (await git(repo, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim().split('\n').filter(Boolean);
    const indexTreeResult = conflictFiles.length ? { ok: false } : await git(repo, ['write-tree'], { allowFailure: true });
    const stagedPatch = await git(repo, ['diff', '--cached', '--no-ext-diff', '--no-color', '--binary'], { allowFailure: true, maxBuffer: 1024 * 1024 });
    const cleanupEligible = !dirty && (entry.phase === 'ready' && currentHead === entry.baseCommit ||
      entry.phase === 'merged' && currentHead === entry.mergeSourceHead);
    const cleanupBlockedReason = cleanupEligible ? null : dirty ? '工作树存在未保存更改' :
      entry.phase === 'ready' && currentHead !== entry.baseCommit ? '工作树有尚未合入的提交' :
      entry.phase === 'merged' && currentHead !== entry.mergeSourceHead ? '合入后工作树新增了提交' : '当前阶段不能清理';
    return { ...entry, registered: true, head: currentHead, targetHead: await head(repo), targetBranch: await branch(repo),
      targetDirty: Boolean(targetStatus), targetStatus, dirty: Boolean(dirty), status: dirty,
      nameStatus: names, patch: patch.ok ? patch.stdout : null, patchTruncated: !patch.ok,
      conflictFiles, indexTree: indexTreeResult.ok ? indexTreeResult.stdout.trim() : null,
      reviewStatus: ['merging', 'conflict'].includes(entry.phase) ? (() => {
        const decision = finalizeDecision({ entry, indexTree: indexTreeResult.ok ? indexTreeResult.stdout.trim() : null });
        return { valid: decision.authorized, reason: decision.reason, reviewId: decision.reviewId };
      })() : null,
      stagedPatch: stagedPatch.ok ? stagedPatch.stdout : null, stagedPatchTruncated: !stagedPatch.ok,
      cleanupEligible, cleanupBlockedReason };
  }); }
  async function prepareMerge({ id, expectedTargetHead, reviewId } = {}) { return enqueue(async () => {
    safe(reviewId, '人工审查 ID');
    if (typeof authorizeMerge !== 'function') fail('人工审查核验未接线', 'WORKTREE_REVIEW_REQUIRED');
    if (!hash(expectedTargetHead)) fail('需要精确的目标 HEAD', 'WORKTREE_TARGET');
    const entry = await recover(id);
    if (entry.phase !== 'ready') fail('工作树不在可合入状态', 'WORKTREE_PHASE');
    const { repo, row } = await observed(entry);
    if (!row || await branch(repo) !== entry.baseBranch || await head(repo) !== expectedTargetHead)
      fail('目标分支或 HEAD 已变化', 'WORKTREE_TARGET_CHANGED');
    if (await status(repo) || await status(entry.path)) fail('合入前主工作区与工作树都必须干净', 'WORKTREE_DIRTY');
    const sourceHead = await head(entry.path);
    const ancestor = await git(repo, ['merge-base', '--is-ancestor', entry.baseCommit, sourceHead], { allowFailure: true });
    if (!ancestor.ok) fail('工作树已偏离登记 base', 'WORKTREE_DIVERGED');
    if (sourceHead === entry.baseCommit) fail('工作树没有可合入提交', 'WORKTREE_NO_COMMITS');
    if ((await git(repo, ['merge-base', '--is-ancestor', sourceHead, expectedTargetHead], { allowFailure: true })).ok)
      fail('目标分支已包含工作树提交', 'WORKTREE_ALREADY_INCLUDED');
    acquireFence(entry, 'merge');
    let started = false;
    try {
      const decision = await authorizeMerge({ reviewId, projectId: entry.projectId, taskId: entry.taskId,
        role: entry.role, branch: entry.branch, baseCommit: entry.baseCommit, sourceHead, targetHead: expectedTargetHead });
      if (decision?.authorized !== true || decision.reviewId !== reviewId ||
        decision.sourceHead !== sourceHead || decision.targetHead !== expectedTargetHead)
        fail('人工审查未批准当前源与目标版本', 'WORKTREE_REVIEW_REQUIRED');
      if (entryFor(id).phase !== 'ready' || await head(repo) !== expectedTargetHead || await head(entry.path) !== sourceHead ||
        await branch(repo) !== entry.baseBranch || await status(repo) || await status(entry.path))
        fail('审查期间源码或工作区已变化', 'WORKTREE_TARGET_CHANGED');
      update(id, item => { item.phase = 'merging'; item.reviewId = reviewId;
        item.mergeSourceHead = sourceHead; item.mergeTargetHead = expectedTargetHead; });
      started = true;
      const result = await git(repo, ['merge', '--no-ff', '--no-commit', sourceHead], { allowFailure: true });
      const mergeHead = await git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true });
      if (!mergeHead.ok || mergeHead.stdout.trim() !== sourceHead)
        fail('合入未形成可核对的 MERGE_HEAD，保留现场', 'WORKTREE_UNKNOWN');
      return update(id, item => { item.phase = result.ok ? 'merging' : 'conflict'; item.reason = result.ok ? null : '合入冲突保留在主工作区，需人工解决'; });
    } catch (error) {
      if (!started && entryFor(id).phase === 'ready' && await head(repo) === expectedTargetHead &&
          await head(entry.path) === sourceHead && !await status(repo) && !await status(entry.path))
        releaseFence(entry, 'merge');
      throw error;
    }
  }); }
  async function finalizeMerge({ id, expectedIndexTree } = {}) { return enqueue(async () => {
    if (!hash(expectedIndexTree)) fail('需要人工核对后的精确索引 tree', 'WORKTREE_INDEX');
    const entry = await recover(id);
    if (!['merging', 'conflict'].includes(entry.phase)) fail('没有待完成的合入', 'WORKTREE_PHASE');
    const repo = await bound(entry);
    if (await output(repo, ['rev-parse', 'MERGE_HEAD']) !== entry.mergeSourceHead ||
      await branch(repo) !== entry.baseBranch || await head(repo) !== entry.mergeTargetHead)
      fail('合入目标已变化', 'WORKTREE_TARGET_CHANGED');
    if ((await git(repo, ['diff', '--name-only', '--diff-filter=U'])).stdout ||
      !(await git(repo, ['diff', '--quiet'], { allowFailure: true })).ok ||
      (await git(repo, ['ls-files', '--others', '--exclude-standard'])).stdout)
      fail('仍有冲突、未暂存修改或未跟踪文件', 'WORKTREE_UNRESOLVED');
    if (await output(repo, ['write-tree']) !== expectedIndexTree) fail('索引已变化，请重新审查', 'WORKTREE_INDEX_CHANGED');
    // There is no await between the final receipt check and Git commit. BEGIN
    // IMMEDIATE excludes another Store writer while the app performs the commit.
    store.transaction(() => {
      requireFence(entry, 'merge');
      const current = entryFor(id);
      if (!['merging', 'conflict'].includes(current.phase) || current.reviewId !== entry.reviewId)
        fail('合入登记已变化', 'WORKTREE_PHASE');
      const syncAt = (cwd, args) => execFileSync(gitExecutable, ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args],
        { encoding: 'utf8', timeout: 20_000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const sync = args => syncAt(repo, args);
      try {
        if (sync(['rev-parse', 'MERGE_HEAD']) !== entry.mergeSourceHead ||
            sync(['rev-parse', 'HEAD']) !== entry.mergeTargetHead ||
            sync(['symbolic-ref', '--quiet', '--short', 'HEAD']) !== entry.baseBranch ||
            syncAt(entry.path, ['rev-parse', 'HEAD']) !== entry.mergeSourceHead)
          fail('合入目标已变化', 'WORKTREE_TARGET_CHANGED');
        if (sync(['diff', '--name-only', '--diff-filter=U']) ||
            sync(['ls-files', '--others', '--exclude-standard']) ||
            sync(['write-tree']) !== expectedIndexTree)
          fail('暂存区已变化，请重新审查', 'WORKTREE_INDEX_CHANGED');
        const quiet = execFileSync(gitExecutable, ['-c', 'core.hooksPath=/dev/null', '-C', repo, 'diff', '--quiet'],
          { timeout: 20_000, stdio: 'ignore' });
        void quiet;
        const decision = finalizeDecision({ entry: current, indexTree: expectedIndexTree });
        if (decision.authorized !== true) fail('原人工审查已失效，请重新验收并审查当前索引', 'WORKTREE_REVIEW_STALE');
        sync(['commit', '--no-edit']);
      } catch (error) {
        if (error instanceof BoardError) throw error;
        fail(`Git 合入核验或提交失败：${String(error.stderr || error.message).trim().slice(0, 400)}`, 'WORKTREE_GIT');
      }
    });
    return recover(id);
  }); }
  async function cleanup(id) { return enqueue(async () => {
    const entry = await recover(id);
    if (entry.phase === 'removed') return entry;
    if (entry.phase !== 'ready' && entry.phase !== 'merged') fail('冲突或未知现场不能清理', 'WORKTREE_PHASE');
    acquireFence(entry, 'cleanup');
    let started = false;
    try {
      const { repo, row } = await observed(entry);
      if (!row || await status(entry.path)) fail('工作树有未保存更改或身份未知', 'WORKTREE_DIRTY');
      const sourceHead = await head(entry.path);
      if (entry.phase === 'merged' && sourceHead !== entry.mergeSourceHead)
        fail('合入后工作树新增了提交，需重新审查', 'WORKTREE_UNMERGED');
      if (entry.phase !== 'merged' && sourceHead !== entry.baseCommit)
        fail('未合入提交需保留工作树', 'WORKTREE_UNMERGED');
      update(id, item => { item.phase = 'removing'; item.cleanupHead = sourceHead; });
      started = true;
      await git(repo, ['worktree', 'remove', entry.path]);
      return recover(id);
    } catch (error) {
      if (!started) releaseFence(entry, 'cleanup');
      throw error;
    }
  }); }
  const saveRow = requestId => {
    const row = store.db.prepare('SELECT value FROM worktree_saves WHERE request_id=?').get(requestId);
    return row ? JSON.parse(row.value) : null;
  };
  const putSave = record => store.db.prepare('INSERT INTO worktree_saves(request_id,worktree_id,value) VALUES(?,?,?) ON CONFLICT(request_id) DO UPDATE SET value=excluded.value')
    .run(record.requestId, record.worktreeId, JSON.stringify(record));
  const saveView = (record, requestId) => record ? record.status === 'ready' ? copy(record.receipt) : {
    phase: record.status, requestId: record.requestId, worktreeId: record.worktreeId,
    reason: record.reason || null
  } : { phase: 'not_found', requestId };
  const saveTask = (entry, record) => {
    const task = store.getTask(entry.taskId), project = store.getProject(entry.projectId);
    if (task.projectId !== entry.projectId || task.revision !== record.taskRevision ||
        task.contentVersion !== record.contentVersion || project.directory !== entry.repo ||
        entryFor(entry.id).phase !== 'saving' || entryFor(entry.id).saveRequestId !== record.requestId ||
        entryFor(entry.id).saveId !== record.saveId)
      fail('任务内容或工作树绑定已变化', 'WORKTREE_SAVE_CHANGED');
  };
  const saveAuthority = (entry, record) => {
    const verify = () => { requireFence(entry, 'save'); assertNoExecutions(entry); saveTask(entry, record); };
    verify();
    const result = assertSaveAllowed(copy(entry));
    if (result && typeof result.then === 'function') fail('保存权限检查必须同步完成', 'WORKTREE_SAVE_AUTHORITY');
    verify();
  };
  const saveOptions = { gitExecutable };
  function settleNotSaved(entry, record, reason) {
    // The ref CAS is synchronous inside a Store transaction, so this transaction
    // cannot race another authorized publisher of this same durable intent.
    return store.transaction(() => {
      requireFence(entry, 'save');
      assertNoExecutions(entry);
      const durable = saveRow(record.requestId);
      if (!durable || durable.saveId !== record.saveId || durable.status === 'ready' ||
          JSON.stringify(durable.plan) !== JSON.stringify(record.plan) || record.casAttempted || durable.casAttempted)
        fail('Git 引用更新曾被调用，不能仅凭旧引用认定未保存', 'WORKTREE_SAVE_UNKNOWN');
      if (entryFor(entry.id).phase !== 'saving' || entryFor(entry.id).saveRequestId !== record.requestId ||
          entryFor(entry.id).saveId !== record.saveId)
        fail('原保存意图身份已变化', 'WORKTREE_SAVE_CHANGED');
      if (record.plan) {
        const plan = record.plan;
        const original = lstatSync(plan.indexPath);
        if (saveGitSync(entry.path, ['rev-parse', plan.ref], saveOptions) !== plan.oldHead ||
            saveGitSync(entry.path, ['symbolic-ref', '-q', 'HEAD'], saveOptions) !== plan.ref ||
            createHash('sha256').update(readFileSync(plan.indexPath)).digest('hex') !== plan.originalIndex.digest ||
            [original.dev, original.ino, original.mode, original.size, original.mtimeMs, original.ctimeMs].join(':') !== plan.originalIndex.identity)
          fail('原分支或索引已变化，不能认定未保存', 'WORKTREE_SAVE_UNKNOWN');
        let lock;
        try { lock = lstatSync(`${plan.indexPath}.lock`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        let temp;
        try { temp = lstatSync(plan.tempIndex); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (temp && (temp.dev !== plan.desiredIndex.dev || temp.ino !== plan.desiredIndex.ino ||
            temp.size !== plan.desiredIndex.size || temp.isSymbolicLink() ||
            createHash('sha256').update(readFileSync(plan.tempIndex)).digest('hex') !== plan.desiredIndex.digest))
          fail('原私有索引无法精确清理', 'WORKTREE_SAVE_UNKNOWN');
        if (lock) {
          if (!temp || temp.dev !== plan.desiredIndex.dev || temp.ino !== plan.desiredIndex.ino ||
              lock.dev !== temp.dev || lock.ino !== temp.ino ||
              createHash('sha256').update(readFileSync(`${plan.indexPath}.lock`)).digest('hex') !== plan.desiredIndex.digest)
            fail('未知 Git 索引锁不可清理', 'WORKTREE_SAVE_UNKNOWN');
          unlinkSync(`${plan.indexPath}.lock`);
        }
        if (temp) unlinkSync(plan.tempIndex);
        const fd = openSync(dirname(plan.indexPath), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      } else {
        if (saveGitSync(entry.path, ['rev-parse', `refs/heads/${entry.branch}`], saveOptions) !== record.sourceHead ||
            saveGitSync(entry.path, ['symbolic-ref', '-q', 'HEAD'], saveOptions) !== `refs/heads/${entry.branch}`)
          fail('原分支已变化，不能认定未保存', 'WORKTREE_SAVE_UNKNOWN');
      }
      const image = read(), current = image.entries.find(item => item.id === entry.id);
      current.phase = 'ready'; current.reason = null; current.updatedAt = new Date(now()).toISOString();
      store.db.prepare('UPDATE worktree_registry SET value=? WHERE key=?').run(JSON.stringify(image), 'state');
      record.status = 'not_saved'; record.reason = reason; putSave(record);
      store.db.prepare('DELETE FROM worktree_fences WHERE project_id=? AND worktree_id=? AND operation=?')
        .run(entry.projectId, entry.id, 'save');
      return saveView(record, record.requestId);
    });
  }
  async function saveEntry(id) {
    const entry = entryFor(safe(id, '工作树 ID'));
    if (!['ready', 'saving'].includes(entry.phase)) fail('工作树不能建立保存版本', 'WORKTREE_PHASE');
    if (entry.path !== join(root, entry.id) || realpathSync(entry.path) !== entry.path ||
        realpathSync(entry.repo) !== entry.repo || store.getProject(entry.projectId).directory !== entry.repo ||
        store.getTask(entry.taskId).projectId !== entry.projectId)
      fail('工作树路径或项目绑定已变化', 'WORKTREE_BINDING_CHANGED');
    const top = (await saveGit(entry.path, ['rev-parse', '--show-toplevel'], saveOptions)).stdout.toString('utf8').trim();
    const commonDir = (await saveGit(entry.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], saveOptions)).stdout.toString('utf8').trim();
    if (top !== entry.path || realpathSync(commonDir) !== entry.commonDir)
      fail('Git 工作树登记身份已变化', 'WORKTREE_BINDING_CHANGED');
    const worktrees = (await saveGit(entry.repo, ['worktree', 'list', '--porcelain', '-z'], saveOptions)).stdout.toString('utf8');
    const rows = worktrees.split('\0\n').join('\0').split('\0');
    const found = rows.some((field, i) => field === `worktree ${entry.path}` &&
      rows.slice(i + 1, i + 4).includes(`branch refs/heads/${entry.branch}`));
    if (!found) fail('工作树未被 Git 原登记识别', 'WORKTREE_BINDING_CHANGED');
    return entry;
  }
  async function previewSave(id) {
    const entry = await saveEntry(id);
    if (entry.phase !== 'ready') fail('工作树不能建立新的保存版本', 'WORKTREE_PHASE');
    const task = store.getTask(entry.taskId);
    if (task.projectId !== entry.projectId) fail('任务与工作树已失去绑定', 'WORKTREE_BINDING_CHANGED');
    const source = await captureWorktreeSource(entry, saveOptions);
    return { entry, task, source };
  }
  async function advanceSave(record, { fresh = false } = {}) {
    const entry = entryFor(record.worktreeId);
    requireFence(entry, 'save');
    if (entry.phase !== 'saving') fail('保存意图阶段已变化', 'WORKTREE_SAVE_CHANGED');
    try {
      if (!record.plan) {
        if (!fresh) return settleNotSaved(entry, record, 'WORKTREE_SAVE_NOT_APPLIED');
        const source = await captureWorktreeSource(entry, saveOptions);
        if (source.head !== record.sourceHead || source.sourceDigest !== record.sourceDigest)
          fail('原保存源已变化', 'WORKTREE_SAVE_CHANGED');
        store.transaction(() => saveAuthority(entry, record));
        const plan = await prepareWorktreeSave(entry, source, { ...saveOptions, commitDate: record.createdAt });
        record.plan = plan;
        record.status = 'prepared';
        store.transaction(() => { saveAuthority(entry, record); putSave(record); });
      }
      const observed = await inspectWorktreeSave(entry, record.plan, saveOptions);
      if (observed.currentRef === record.plan.oldHead) {
        if (record.casAttempted) fail('原 Git 引用更新结果未知，不能重发', 'WORKTREE_SAVE_UNKNOWN');
        const source = await captureWorktreeSource(entry, saveOptions);
        if (source.head !== record.sourceHead || source.sourceDigest !== record.sourceDigest)
          fail('发布前原保存源已变化', 'WORKTREE_SAVE_CHANGED');
      }
      await publishWorktreeSave(entry, record.plan, { ...saveOptions, performCas: () =>
        {
        store.transaction(() => {
          saveAuthority(entry, record);
          if (saveGitSync(entry.path, ['rev-parse', record.plan.ref], saveOptions) !== record.plan.oldHead ||
              saveGitSync(entry.path, ['symbolic-ref', '-q', 'HEAD'], saveOptions) !== record.plan.ref)
            fail('发布前 Git 分支身份已变化', 'WORKTREE_SAVE_CHANGED');
          record.casAttempted = true;
          putSave(record);
        });
        // No await between the durable CAS intent and the synchronous Git operation.
        saveGitSync(entry.path, ['update-ref', record.plan.ref, record.plan.commit, record.plan.oldHead], saveOptions);
        } });
      await finishWorktreeSave(entry, record.plan, saveOptions);
      const receipt = { phase: 'ready', requestId: record.requestId, saveId: record.saveId,
        worktreeId: entry.id, sourceHead: record.plan.commit, previousHead: record.sourceHead,
        sourceDigest: record.sourceDigest, changedFileCount: record.changedFileCount };
      store.transaction(() => {
        requireFence(entry, 'save');
        if (saveGitSync(entry.path, ['rev-parse', record.plan.ref], saveOptions) !== record.plan.commit ||
            saveGitSync(entry.path, ['symbolic-ref', '-q', 'HEAD'], saveOptions) !== record.plan.ref ||
            saveGitSync(entry.path, ['rev-parse', 'HEAD'], saveOptions) !== record.plan.commit ||
            createHash('sha256').update(readFileSync(record.plan.indexPath)).digest('hex') !== record.plan.desiredIndex.digest)
          fail('保存提交在结算前发生变化', 'WORKTREE_SAVE_CHANGED');
        const image = read(), current = image.entries.find(item => item.id === entry.id);
        if (!current || current.phase !== 'saving' || current.saveRequestId !== record.requestId || current.saveId !== record.saveId)
          fail('保存登记身份已变化', 'WORKTREE_SAVE_CHANGED');
        current.phase = 'ready'; current.reason = null; current.savedHead = record.plan.commit;
        current.updatedAt = new Date(now()).toISOString();
        store.db.prepare('UPDATE worktree_registry SET value=? WHERE key=?').run(JSON.stringify(image), 'state');
        record.status = 'ready'; record.receipt = receipt; record.reason = null; putSave(record);
        store.db.prepare('DELETE FROM worktree_fences WHERE project_id=? AND worktree_id=? AND operation=?')
          .run(entry.projectId, entry.id, 'save');
      });
      return receipt;
    } catch (error) {
      try { return settleNotSaved(entry, record, error instanceof BoardError ? error.code : 'WORKTREE_SAVE_NOT_APPLIED'); }
      catch { /* Any incomplete proof retains the durable fence. */ }
      // Once intent exists, a failed or unreadable filesystem step cannot prove non-application.
      record.status = 'saving_unknown'; record.reason = error instanceof BoardError ? error.code : 'WORKTREE_SAVE_UNKNOWN';
      try { store.transaction(() => { requireFence(entry, 'save'); putSave(record); }); }
      catch (persistError) { throw new AggregateError([error, persistError], '保存现场与围栏均无法核实'); }
      return saveView(record, record.requestId);
    }
  }
  async function savePreview(id) { return enqueue(async () => {
    const entry = await saveEntry(id);
    if (entry.phase !== 'ready') fail('工作树不能建立新的保存版本', 'WORKTREE_PHASE');
    const task = store.getTask(entry.taskId);
    const head = (await saveGit(entry.path, ['rev-parse', 'HEAD'], saveOptions)).stdout.toString('utf8').trim();
    const base = { worktreeId: entry.id, head, taskRevision: task.revision, contentVersion: task.contentVersion };
    try {
      const source = await captureWorktreeSource(entry, saveOptions);
      if (source.head !== head) fail('预览期间 HEAD 已变化', 'WORKTREE_SAVE_CHANGED');
      return { ...base, sourceDigest: source.sourceDigest, changedFiles: source.changedFiles,
        patch: source.patch, saveable: true, blockedReason: null };
    } catch (error) {
      if (!(error instanceof BoardError) || !['WORKTREE_SAVE_STAGED', 'WORKTREE_SAVE_TEXT',
        'WORKTREE_SAVE_TYPE', 'WORKTREE_SAVE_LIMIT', 'WORKTREE_SAVE_FILTER', 'WORKTREE_SAVE_PATH',
        'WORKTREE_SAVE_EMPTY'].includes(error.code)) throw error;
      return { ...base, sourceDigest: null, changedFiles: [], patch: null,
        saveable: false, blockedReason: error.message };
    }
  }); }
  async function save(input = {}) { return enqueue(async () => {
    const id = safe(input.id, '工作树 ID'), requestId = safe(input.requestId, '幂等请求 ID');
    if (!hash(input.expectedHead) || !Number.isSafeInteger(input.expectedTaskRevision) ||
        !Number.isSafeInteger(input.expectedContentVersion) || !/^[a-f0-9]{64}$/.test(input.expectedSourceDigest || ''))
      fail('保存版本缺少精确预期身份', 'WORKTREE_SAVE_INPUT');
    const prior = saveRow(requestId);
    if (prior) {
      if (prior.worktreeId !== id || prior.sourceHead !== input.expectedHead ||
          prior.taskRevision !== input.expectedTaskRevision || prior.contentVersion !== input.expectedContentVersion ||
          prior.sourceDigest !== input.expectedSourceDigest)
        fail('保存请求 ID 已用于其他源版本', 'WORKTREE_SAVE_CONFLICT');
      return ['ready', 'not_saved'].includes(prior.status) ? saveView(prior, requestId) : advanceSave(prior);
    }
    const { entry, task, source } = await previewSave(id);
    if (source.head !== input.expectedHead || source.sourceDigest !== input.expectedSourceDigest ||
        task.revision !== input.expectedTaskRevision || task.contentVersion !== input.expectedContentVersion)
      fail('预览后源码或任务已变化', 'WORKTREE_SAVE_CHANGED');
    const record = { requestId, saveId: randomUUID(), worktreeId: id, projectId: entry.projectId,
      taskId: entry.taskId, taskRevision: task.revision, contentVersion: task.contentVersion,
      sourceHead: source.head, sourceDigest: source.sourceDigest, changedFileCount: source.changedFiles.length,
      status: 'prepared', plan: null, casAttempted: false, reason: null,
      createdAt: new Date(now()).toISOString() };
    acquireFence(entry, 'save', () => {
      const result = assertSaveAllowed(copy(entry));
      if (result && typeof result.then === 'function') fail('保存权限检查必须同步完成', 'WORKTREE_SAVE_AUTHORITY');
      const image = read(), current = image.entries.find(item => item.id === id);
      if (!current || current.phase !== 'ready' || current.taskId !== entry.taskId) fail('工作树阶段已变化', 'WORKTREE_PHASE');
      const fresh = store.getTask(entry.taskId);
      if (fresh.revision !== record.taskRevision || fresh.contentVersion !== record.contentVersion)
        fail('任务版本已变化', 'WORKTREE_SAVE_CHANGED');
      current.phase = 'saving'; current.saveRequestId = requestId; current.saveId = record.saveId;
      current.updatedAt = new Date(now()).toISOString();
      store.db.prepare('UPDATE worktree_registry SET value=? WHERE key=?').run(JSON.stringify(image), 'state');
      putSave(record);
    });
    return advanceSave(record, { fresh: true });
  }); }
  async function saveStatus({ id, requestId } = {}) { return enqueue(async () => {
    safe(id, '工作树 ID'); safe(requestId, '幂等请求 ID');
    const row = saveRow(requestId);
    if (row && row.worktreeId !== id) fail('保存请求不属于该工作树', 'WORKTREE_SAVE_CONFLICT');
    return saveView(row, requestId);
  }); }
  async function reconcileSave({ id, requestId } = {}) { return enqueue(async () => {
    safe(id, '工作树 ID'); safe(requestId, '幂等请求 ID');
    const row = saveRow(requestId);
    if (!row) return { phase: 'not_found', requestId };
    if (row.worktreeId !== id) fail('保存请求不属于该工作树', 'WORKTREE_SAVE_CONFLICT');
    return ['ready', 'not_saved'].includes(row.status) ? saveView(row, requestId) : advanceSave(row);
  }); }
  function list({ projectId } = {}) { return copy(read().entries.filter(item => !projectId || item.projectId === projectId)); }
  return { create, projectBase, reconcile: id => enqueue(() => recover(id)), inspect, list, binding, recordReview, reviewDecision,
    finalizeDecision, assertMayExecute, prepareMerge, finalizeMerge, cleanup,
    savePreview, save, saveStatus, reconcileSave };
}
