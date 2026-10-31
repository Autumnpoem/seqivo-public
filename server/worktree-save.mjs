import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { link, lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { BoardError } from './store.mjs';

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CHANGED_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, code = 'WORKTREE_SAVE_UNSAFE') => { throw new BoardError(message, 409, code); };
const gitEnv = () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  return env;
};
const gitArgs = (cwd, args) => ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgsign=false', '-C', cwd, ...args];
export async function saveGit(cwd, args, { gitExecutable = 'git', input, indexFile, envExtra = {}, allowFailure = false, maxBuffer = 8 * 1024 * 1024 } = {}) {
  const env = gitEnv();
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  Object.assign(env, envExtra);
  const result = await new Promise(resolve => {
    const child = spawn(gitExecutable, gitArgs(cwd, args), { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [], stderr = []; let size = 0, settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill(); finish({ ok: false, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: 'TIMEOUT' }); }, 20_000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maxBuffer) child.kill(); else stdout.push(chunk); });
    child.stderr.on('data', chunk => { size += chunk.length; if (size > maxBuffer) child.kill(); else stderr.push(chunk); });
    child.on('error', error => finish({ ok: false, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: error.code || 'SPAWN' }));
    child.on('close', code => finish({ ok: code === 0 && size <= maxBuffer, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code }));
    child.stdin.on('error', () => {});
    child.stdin.end(input || Buffer.alloc(0));
  });
  if (!result.ok && !allowFailure) fail('Git 保存操作未能核实', 'WORKTREE_SAVE_GIT');
  return result;
}
export function saveGitSync(cwd, args, { gitExecutable = 'git', input, indexFile, envExtra = {} } = {}) {
  const env = gitEnv(); if (indexFile) env.GIT_INDEX_FILE = indexFile;
  Object.assign(env, envExtra);
  const result = spawnSync(gitExecutable, gitArgs(cwd, args), { env, input, timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) fail('Git 保存操作未能核实', 'WORKTREE_SAVE_GIT');
  return result.stdout.toString('utf8').trim();
}
const out = async (cwd, args, options) => (await saveGit(cwd, args, options)).stdout.toString('utf8').trim();
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const text = bytes => {
  if (bytes.includes(0)) fail('保存版本只支持 UTF-8 文本文件', 'WORKTREE_SAVE_TEXT');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('保存版本只支持 UTF-8 文本文件', 'WORKTREE_SAVE_TEXT'); }
};
const identity = s => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs].join(':');
const directoryIdentity = s => [s.dev, s.ino, s.mode].join(':');
const parsedTree = bytes => bytes.toString('utf8').split('\0').filter(Boolean).map(item => {
  const tab = item.indexOf('\t'), prefix = item.slice(0, tab).split(' ');
  if (tab < 0 || prefix.length !== 3) fail('Git tree 格式无法核验');
  return { mode: prefix[0], type: prefix[1], oid: prefix[2], path: item.slice(tab + 1) };
});
const parsedIndex = bytes => bytes.toString('utf8').split('\0').filter(Boolean).map(item => {
  const tab = item.indexOf('\t'), prefix = item.slice(0, tab).split(' ');
  if (tab < 0 || prefix.length !== 3) fail('Git 索引格式无法核验');
  return { mode: prefix[0], oid: prefix[1], stage: prefix[2], path: item.slice(tab + 1) };
});
const safePath = path => {
  if (!path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || part === 'node_modules' || part === '.gitattributes' || /\.srl$/i.test(part)) || path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(path))
    fail('变更包含不允许保存的路径', 'WORKTREE_SAVE_PATH');
  return path;
};
async function readSource(root, path) {
  safePath(path);
  const parts = path.split('/'); let parent = root; const parents = [];
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('源码目录身份不确定', 'WORKTREE_SAVE_PATH');
    parents.push({ path: parent, identity: identity(info) });
  }
  const target = join(root, path);
  let fd;
  try {
    const namedBefore = await lstat(target);
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) fail('源码文件类型不受支持', 'WORKTREE_SAVE_TYPE');
    fd = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await fd.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES) fail('源码文件类型或大小不受支持', 'WORKTREE_SAVE_LIMIT');
    const bytes = await fd.readFile();
    const after = await fd.stat();
    const named = await lstat(target);
    if (identity(before) !== identity(after) || identity(before) !== identity(namedBefore) || identity(before) !== identity(named))
      fail('源码读取期间发生变化', 'WORKTREE_SAVE_CHANGED');
    for (const item of parents) if (identity(await lstat(item.path)) !== item.identity)
      fail('源码父目录读取期间发生变化', 'WORKTREE_SAVE_CHANGED');
    return { bytes, stat: identity(before) };
  } finally { await fd?.close(); }
}

/** A bounded, raw-byte source capture. It never executes Git filters, hooks or project scripts. */
export async function captureWorktreeSource(entry, { gitExecutable = 'git' } = {}) {
  const cwd = entry.path;
  const rootBefore = await lstat(cwd);
  if (!rootBefore.isDirectory() || await realpath(cwd) !== cwd) fail('工作树目录身份无效');
  const head = await out(cwd, ['rev-parse', 'HEAD'], { gitExecutable });
  const ref = await out(cwd, ['symbolic-ref', '-q', 'HEAD'], { gitExecutable });
  if (ref !== `refs/heads/${entry.branch}`) fail('工作树分支身份已变化');
  const filterConfig = await saveGit(cwd, ['config', '--local', '--get-regexp', '^filter\\.'], { gitExecutable, allowFailure: true });
  if (filterConfig.ok || filterConfig.code !== 1) fail('仓库配置了当前保存流程不支持的 Git 过滤器', 'WORKTREE_SAVE_FILTER');
  const indexPath = await worktreeIndexPath(entry, { gitExecutable });
  const indexBefore = await indexIdentity(indexPath);
  const tree = parsedTree((await saveGit(cwd, ['ls-tree', '-rz', '--full-tree', 'HEAD'], { gitExecutable })).stdout);
  const index = parsedIndex((await saveGit(cwd, ['ls-files', '--stage', '-z'], { gitExecutable })).stdout);
  const untracked = (await saveGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], { gitExecutable })).stdout
    .toString('utf8').split('\0').filter(Boolean);
  if (tree.length + untracked.length > MAX_FILES || index.length !== tree.length) fail('文件数量超过保存上限或索引含暂存变更', 'WORKTREE_SAVE_LIMIT');
  const byPath = new Map(tree.map(item => [safePath(item.path), item]));
  if (byPath.size !== tree.length) fail('Git 文件列表存在重复路径');
  for (const item of index) {
    const prior = byPath.get(safePath(item.path));
    if (item.stage !== '0' || !prior || item.mode !== prior.mode || item.oid !== prior.oid)
      fail('已有暂存或未合并的改动，请先处理', 'WORKTREE_SAVE_STAGED');
  }
  const paths = [...byPath.keys(), ...untracked.map(safePath)];
  if (new Set(paths).size !== paths.length) fail('Git 文件列表身份不一致');
  const current = [], seen = []; let totalBytes = 0;
  for (const path of paths.sort()) {
    const prior = byPath.get(path);
    if (prior && (prior.type !== 'blob' || !['100644', '100755'].includes(prior.mode)))
      fail('保存版本不支持符号链接或子模块', 'WORKTREE_SAVE_TYPE');
    let source;
    try { source = await readSource(cwd, path); }
    catch (error) { if (error.code !== 'ENOENT' || !prior) throw error; }
    if (!source && !prior) fail('未跟踪文件已消失', 'WORKTREE_SAVE_CHANGED');
    if (!source) { seen.push({ path, deleted: true }); current.push({ path, kind: 'deleted', oldOid: prior.oid, mode: prior.mode, bytes: null }); continue; }
    totalBytes += source.bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) fail('源码总量超过保存上限', 'WORKTREE_SAVE_LIMIT');
    const blob = await out(cwd, ['hash-object', '--stdin'], { gitExecutable, input: source.bytes });
    const mode = (await lstat(join(cwd, path))).mode & 0o111 ? '100755' : '100644';
    seen.push({ path, stat: source.stat, fileDigest: digest(source.bytes) });
    if (prior?.oid === blob && prior.mode === mode) continue;
    if (source.bytes.length > MAX_CHANGED_TEXT_BYTES) fail('变更文本文件超过保存上限', 'WORKTREE_SAVE_LIMIT');
    text(source.bytes);
    current.push({ path, kind: prior ? 'modified' : 'added', oldOid: prior?.oid || null, mode, bytes: source.bytes,
      fileDigest: digest(source.bytes), stat: source.stat });
  }
  if (!current.length) fail('没有可保存的源码变更', 'WORKTREE_SAVE_EMPTY');
  let patch = '';
  for (const file of current) {
    // Full current text, including untracked bytes; it is an inspection record, not a Git patch to apply.
    const old = file.oldOid ? text((await saveGit(cwd, ['cat-file', 'blob', file.oldOid], { gitExecutable })).stdout) : '';
    patch += `--- before/${file.path}\n${old}\n+++ after/${file.path}\n${file.kind === 'deleted' ? '' : text(file.bytes)}\n`;
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) fail('完整预览超过上限，不能保存不完整的审查版本', 'WORKTREE_SAVE_LIMIT');
  }
  const afterTree = (await saveGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], { gitExecutable })).stdout.toString('utf8').split('\0').filter(Boolean).sort();
  if (JSON.stringify(afterTree) !== JSON.stringify([...untracked].sort()) || identity(await lstat(cwd)) !== identity(rootBefore) ||
      JSON.stringify(await indexIdentity(indexPath)) !== JSON.stringify(indexBefore) ||
      await out(cwd, ['rev-parse', 'HEAD'], { gitExecutable }) !== head ||
      await out(cwd, ['symbolic-ref', '-q', 'HEAD'], { gitExecutable }) !== ref)
    fail('源码集合或工作树身份已变化', 'WORKTREE_SAVE_CHANGED');
  for (const file of seen) {
    if (file.deleted) { try { await lstat(join(cwd, file.path)); fail('删除的文件已重新出现', 'WORKTREE_SAVE_CHANGED'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    else { const reread = await readSource(cwd, file.path); if (reread.stat !== file.stat || digest(reread.bytes) !== file.fileDigest) fail('源码读取后发生变化', 'WORKTREE_SAVE_CHANGED'); }
  }
  const sourceDigest = digest(Buffer.from(JSON.stringify([head, current.map(file => [file.path, file.kind, file.mode, file.oldOid, file.fileDigest])])));
  return { head, ref, sourceDigest, changedFiles: current.map(({ path, kind, bytes }) => ({ path, kind, bytes: bytes?.length || 0 })), patch, files: current };
}

export async function worktreeIndexPath(entry, { gitExecutable = 'git' } = {}) {
  const path = await out(entry.path, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { gitExecutable });
  if (!isAbsolute(path) || basename(path) !== 'index') fail('Git 索引路径无法核验');
  return path;
}
export const worktreeSaveDigest = digest;

const indexIdentity = async path => {
  let fd;
  try {
    const namedBefore = await lstat(path);
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) fail('Git 索引类型无法核验');
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await fd.stat(), bytes = await fd.readFile(), after = await fd.stat(), namedAfter = await lstat(path);
    if (identity(before) !== identity(namedBefore) || identity(before) !== identity(after) ||
        identity(before) !== identity(namedAfter)) fail('Git 索引读取期间发生变化');
    return { identity: identity(before), digest: digest(bytes), dev: before.dev, ino: before.ino, size: before.size };
  } finally { await fd?.close(); }
};

/** Prepare only unreachable Git objects and a private alternate index. No branch or user index is changed. */
export async function prepareWorktreeSave(entry, capture, { gitExecutable = 'git', commitDate } = {}) {
  if (typeof commitDate !== 'string' || !Number.isFinite(Date.parse(commitDate)) ||
      new Date(commitDate).toISOString() !== commitDate) fail('原保存时间戳无法核验');
  const indexPath = await worktreeIndexPath(entry, { gitExecutable });
  const indexDir = await realpath(dirname(indexPath));
  if (!inside(entry.commonDir, indexDir)) fail('Git 索引不在原工作树登记范围');
  const indexDirIdentity = directoryIdentity(await lstat(indexDir));
  const originalIndex = await indexIdentity(indexPath);
  const tempIndex = join(indexDir, `seqivo-save-${randomUUID()}.index`);
  const options = { gitExecutable, indexFile: tempIndex };
  try {
    await saveGit(entry.path, ['read-tree', capture.head], options);
    const lines = [];
    for (const file of capture.files) {
      let oid = '0'.repeat(capture.head.length);
      if (file.kind !== 'deleted') oid = await out(entry.path, ['hash-object', '-w', '--stdin'], { gitExecutable, input: file.bytes });
      lines.push(`${file.kind === 'deleted' ? '0' : file.mode} ${oid}\t${file.path}\0`);
    }
    await saveGit(entry.path, ['update-index', '-z', '--index-info'], { ...options, input: Buffer.from(lines.join('')) });
    const tree = await out(entry.path, ['write-tree'], options);
    const commit = await out(entry.path, ['commit-tree', tree, '-p', capture.head], {
      gitExecutable, input: Buffer.from('Save review version\n'), envExtra: {
        GIT_AUTHOR_NAME: 'Seqivo', GIT_AUTHOR_EMAIL: 'save@seqivo.invalid',
        GIT_COMMITTER_NAME: 'Seqivo', GIT_COMMITTER_EMAIL: 'save@seqivo.invalid',
        GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate
      }
    });
    const desiredIndex = await indexIdentity(tempIndex);
    const fd = await open(tempIndex, 'r'); try { await fd.sync(); } finally { await fd.close(); }
    const dirFd = await open(indexDir, 'r'); try { await dirFd.sync(); } finally { await dirFd.close(); }
    if (directoryIdentity(await lstat(indexDir)) !== indexDirIdentity) fail('Git 私有索引目录已变化');
    return { indexPath, tempIndex, indexDirIdentity, originalIndex, desiredIndex, tree, commit, oldHead: capture.head, ref: capture.ref };
  } catch (error) {
    try { await unlink(tempIndex); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw new AggregateError([error, cleanup], 'Private index cleanup failed'); }
    throw error;
  }
}

export async function inspectWorktreeSave(entry, plan, { gitExecutable = 'git' } = {}) {
  const expectedIndex = await worktreeIndexPath(entry, { gitExecutable });
  if (!inside(entry.commonDir, await realpath(dirname(expectedIndex)))) fail('Git 索引不在原工作树登记范围');
  if (plan.indexPath !== expectedIndex || typeof plan.tempIndex !== 'string' ||
      dirname(plan.tempIndex) !== dirname(expectedIndex) || !/^seqivo-save-[a-f0-9-]+\.index$/.test(basename(plan.tempIndex)))
    fail('原私有索引记录无法核验');
  if (directoryIdentity(await lstat(dirname(expectedIndex))) !== plan.indexDirIdentity)
    fail('Git 私有索引目录身份已变化');
  const currentRef = await out(entry.path, ['rev-parse', plan.ref], { gitExecutable });
  const currentSymbolic = await out(entry.path, ['symbolic-ref', '-q', 'HEAD'], { gitExecutable });
  const currentHead = await out(entry.path, ['rev-parse', 'HEAD'], { gitExecutable });
  const index = await indexIdentity(plan.indexPath);
  let ownLock = false;
  try {
    const lock = await lstat(`${plan.indexPath}.lock`), temp = await lstat(plan.tempIndex);
    ownLock = temp.dev === plan.desiredIndex.dev && temp.ino === plan.desiredIndex.ino &&
      lock.dev === temp.dev && lock.ino === temp.ino &&
      digest(await readFile(`${plan.indexPath}.lock`)) === plan.desiredIndex.digest;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { currentRef, currentSymbolic, currentHead, index, ownLock };
}

/** Link a prepared index as Git's own lock, CAS the exact ref, then atomically install that index. */
export async function publishWorktreeSave(entry, plan, { gitExecutable = 'git', performCas } = {}) {
  const before = await inspectWorktreeSave(entry, plan, { gitExecutable });
  if (before.currentSymbolic !== plan.ref || before.currentHead !== before.currentRef)
    fail('工作树 HEAD 身份已变化', 'WORKTREE_SAVE_CHANGED');
  if (before.currentRef === plan.commit && before.index.digest === plan.desiredIndex.digest && !before.ownLock)
    return before;
  if (![plan.oldHead, plan.commit].includes(before.currentRef) || before.index.identity !== plan.originalIndex.identity ||
      before.index.digest !== plan.originalIndex.digest) fail('原分支或索引已变化', 'WORKTREE_SAVE_CHANGED');
  if (!before.ownLock) {
    try { await link(plan.tempIndex, `${plan.indexPath}.lock`); }
    catch { fail('Git 索引锁已被占用或无法建立', 'WORKTREE_SAVE_LOCKED'); }
  }
  const locked = await inspectWorktreeSave(entry, plan, { gitExecutable });
  if (!locked.ownLock || locked.currentRef !== before.currentRef || locked.currentSymbolic !== plan.ref ||
      locked.currentHead !== locked.currentRef || locked.index.digest !== plan.originalIndex.digest ||
      locked.index.identity !== plan.originalIndex.identity) fail('发布前 Git 身份已变化', 'WORKTREE_SAVE_CHANGED');
  if (before.currentRef === plan.oldHead) {
    if (typeof performCas !== 'function') fail('Git 保存缺少原子授权回调');
    performCas();
  }
  const afterCas = await inspectWorktreeSave(entry, plan, { gitExecutable });
  if (!afterCas.ownLock || afterCas.currentRef !== plan.commit || afterCas.currentSymbolic !== plan.ref ||
      afterCas.currentHead !== plan.commit || afterCas.index.digest !== plan.originalIndex.digest ||
      afterCas.index.identity !== plan.originalIndex.identity) fail('提交后索引现场无法核验，保留锁和围栏', 'WORKTREE_SAVE_CHANGED');
  await rename(`${plan.indexPath}.lock`, plan.indexPath);
  const dirFd = await open(dirname(plan.indexPath), 'r'); try { await dirFd.sync(); } finally { await dirFd.close(); }
  const final = await inspectWorktreeSave(entry, plan, { gitExecutable });
  if (final.currentRef !== plan.commit || final.currentSymbolic !== plan.ref || final.currentHead !== plan.commit ||
      final.index.digest !== plan.desiredIndex.digest)
    fail('保存结果无法核验，保留围栏');
  return final;
}

export async function finishWorktreeSave(entry, plan, { gitExecutable = 'git' } = {}) {
  const observed = await inspectWorktreeSave(entry, plan, { gitExecutable });
  if (observed.currentRef !== plan.commit || observed.currentSymbolic !== plan.ref || observed.currentHead !== plan.commit ||
      observed.index.digest !== plan.desiredIndex.digest || observed.ownLock)
    fail('保存结果尚未完整确认，保留围栏');
  // An unreachable private index file can be removed only after the exact branch and installed index are verified.
  try {
    const privateIndex = await indexIdentity(plan.tempIndex);
    if (privateIndex.dev !== plan.desiredIndex.dev || privateIndex.ino !== plan.desiredIndex.ino ||
        privateIndex.size !== plan.desiredIndex.size || privateIndex.digest !== plan.desiredIndex.digest)
      fail('私有索引身份已变化，不能清理', 'WORKTREE_SAVE_UNKNOWN');
    await unlink(plan.tempIndex);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return observed;
}
