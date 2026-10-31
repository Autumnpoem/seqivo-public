import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ID = /^[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_FILES = 5000;
const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const MAX_RECEIPT = 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = MAX_FILES * 2 + 1;
const EXCLUDED_PARTS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', 'coverage']);
const LEGACY_EXCLUSION_RULES = ['.git', 'node_modules', 'dist', 'build', 'out', '.next', 'coverage', '*.srl'];
const EXCLUSION_RULES = [...LEGACY_EXCLUSION_RULES, 'root/.taskboard'];
const appMetadata = path => path.startsWith('.taskboard/');
const METADATA_PATHSPEC = ':(exclude).taskboard/**';
const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = data => createHash('sha256').update(data).digest('hex');
const inside = (root, path) => {
  const part = relative(root, path);
  return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
const sameStat = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino &&
  a.uid === b.uid && a.gid === b.gid && a.mode === b.mode && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const sameParents = (a, b) => a === null || b === null ? a === b :
  a.length === b.length && a.every((row, index) => sameStat(row, b[index]));
function checkedRelative(path) {
  if (typeof path !== 'string' || !path || Buffer.byteLength(path) > 1024 ||
    path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(path) ||
    path.split('/').some(part => !part || part === '.' || part === '..'))
    throw fail('PREVIEW_SOURCE_PATH', 'Source path is not supported');
  return path;
}
function exclusion(path, applicationMetadata = true) {
  const parts = path.split('/');
  if (applicationMetadata && appMetadata(path))
    return 'application_metadata';
  if (parts.some(part => EXCLUDED_PARTS.has(part))) return 'generated_or_dependency';
  if (parts.some(part => part.toLowerCase().endsWith('.srl'))) return 'private_serial';
  return null;
}
function checkedDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
}
async function privateRoot(dataDir, sourceRoot) {
  const data = await realpath(dataDir);
  if (inside(sourceRoot, data)) throw fail('PREVIEW_SOURCE_PATH', 'Snapshot storage is inside source');
  const root = join(data, 'preview-source-snapshots');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!checkedDirectory(stat) || await realpath(root) !== root)
    throw fail('PREVIEW_SOURCE_UNTRUSTED', 'Snapshot storage is not private');
  return root;
}
function gitEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}
async function git(cwd, ...args) {
  try {
    const { stdout } = await exec('/usr/bin/git', [
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args
    ], { encoding: 'buffer', timeout: 5000, maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true, env: gitEnvironment() });
    return stdout;
  } catch { throw fail('PREVIEW_SOURCE_UNAVAILABLE', 'Git source enumeration failed'); }
}
function gitText(buffer) {
  if (!buffer.length || buffer.at(-1) !== 10) throw fail('PREVIEW_SOURCE_UNAVAILABLE', 'Git result is incomplete');
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, -1));
}
function gitPaths(buffer) {
  if (buffer.length && buffer.at(-1) !== 0) throw fail('PREVIEW_SOURCE_UNAVAILABLE', 'Git file set is incomplete');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return (buffer.length ? buffer.subarray(0, -1).toString('binary').split('\0').map(value =>
    checkedRelative(decoder.decode(Buffer.from(value, 'binary')))) : []);
}
async function sourceSet(sourceRoot) {
  const head = gitText(await git(sourceRoot, 'rev-parse', 'HEAD'));
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw fail('PREVIEW_SOURCE_UNAVAILABLE', 'Git HEAD is invalid');
  const checkout = await realpath(gitText(await git(sourceRoot, 'rev-parse', '--show-toplevel')));
  if (!inside(checkout, sourceRoot)) throw fail('PREVIEW_SOURCE_PATH', 'Source is outside checkout');
  const tracked = gitPaths(await git(sourceRoot, 'ls-files', '-z', '--cached', '--', '.', METADATA_PATHSPEC));
  const untracked = gitPaths(await git(sourceRoot, 'ls-files', '-z', '--others', '--exclude-standard', '--', '.', METADATA_PATHSPEC));
  const paths = new Map();
  for (const path of tracked) if (!appMetadata(path)) paths.set(path, 'tracked');
  for (const path of untracked) {
    if (appMetadata(path)) continue;
    if (paths.has(path)) throw fail('PREVIEW_SOURCE_CHANGED', 'Source file set is ambiguous');
    paths.set(path, 'untracked');
  }
  if (paths.size > MAX_FILES) throw fail('PREVIEW_SOURCE_LIMIT', 'Source file count exceeds limit');
  const included = [], excluded = [];
  for (const [path, origin] of [...paths].sort(([a], [b]) => a.localeCompare(b))) {
    const reason = exclusion(path);
    (reason ? excluded : included).push(reason ? { path, reason } : { path, origin });
  }
  return { head, included, excluded };
}
async function checkedParents(root, path, allowMissing) {
  let current = root;
  const parents = [];
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    let row;
    try { row = await lstat(current); }
    catch (error) {
      if (error.code === 'ENOENT' && allowMissing) return null;
      throw fail('PREVIEW_SOURCE_CHANGED', 'Source parent disappeared');
    }
    if (!row.isDirectory() || row.isSymbolicLink())
      throw fail('PREVIEW_SOURCE_UNTRUSTED', 'Source parent is not a directory');
    parents.push(row);
  }
  return parents;
}
async function boundedFile(root, path, allowDeleted) {
  const parents = await checkedParents(root, path, allowDeleted);
  if (parents === null) return { kind: 'deleted', parents: null };
  const full = join(root, path);
  let before;
  try { before = await lstat(full); }
  catch (error) {
    if (error.code === 'ENOENT' && allowDeleted) return { kind: 'deleted', parents };
    throw fail('PREVIEW_SOURCE_CHANGED', 'Source file disappeared');
  }
  if (!before.isFile() || before.isSymbolicLink())
    throw fail('PREVIEW_SOURCE_UNTRUSTED', 'Source symlink or special file is not supported');
  if (before.size > MAX_FILE) throw fail('PREVIEW_SOURCE_LIMIT', 'Source file exceeds limit');
  if (!inside(root, await realpath(full))) throw fail('PREVIEW_SOURCE_UNTRUSTED', 'Source path escaped checkout');
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameStat(before, await handle.stat())) throw fail('PREVIEW_SOURCE_CHANGED', 'Source identity changed');
    const chunks = []; let size = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(65536, MAX_FILE + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_FILE) throw fail('PREVIEW_SOURCE_LIMIT', 'Source file exceeds limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (!sameStat(before, await handle.stat()) || !sameStat(before, await lstat(full)))
      throw fail('PREVIEW_SOURCE_CHANGED', 'Source changed while reading');
    const afterParents = await checkedParents(root, path, false);
    if (parents.length !== afterParents.length ||
      parents.some((row, index) => !sameStat(row, afterParents[index])))
      throw fail('PREVIEW_SOURCE_CHANGED', 'Source parent changed while reading');
    return { kind: 'file', bytes: Buffer.concat(chunks, size), stat: before, parents };
  } finally { await handle.close(); }
}
function receiptDigest(head, files, excluded, schemaVersion = 2) {
  const hash = createHash('sha256').update(`seqivo-preview-source-v${schemaVersion}\0`).update(head).update('\0');
  for (const item of files) hash.update(item.path).update('\0').update(item.origin).update('\0')
    .update(item.kind).update('\0')
    .update(String(item.size ?? 0)).update('\0').update(item.sha256 ?? '').update('\0');
  for (const item of excluded) hash.update('excluded\0').update(item.path).update('\0')
    .update(item.reason).update('\0');
  return hash.digest('hex');
}
function planSnapshotLayout(files) {
  const directories = new Set(); let fileCount = 0;
  for (const item of files) {
    if (item.kind !== 'file') continue;
    fileCount++;
    const parts = item.path.split('/');
    for (let n = 1; n < parts.length; n++)
      directories.add(parts.slice(0, n).join('/'));
    if (fileCount + directories.size > MAX_SNAPSHOT_ENTRIES)
      throw fail('PREVIEW_SOURCE_LIMIT', 'Source directory entry count exceeds limit');
  }
  return { directories, fileCount };
}
/** Pure local test seam for the same entry planner used before publication. */
export const planPreviewSourceSnapshotLayoutForTest = paths =>
  planSnapshotLayout(paths.map(path => ({ path: checkedRelative(path), kind: 'file' })));
function publicReceipt(receipt) {
  return { schemaVersion: receipt.schemaVersion, sourceCommit: receipt.sourceCommit, sourceDigest: receipt.sourceDigest,
    fileCount: receipt.files.filter(item => item.kind === 'file').length,
    excludedCount: receipt.excluded.length, selection: receipt.selection,
    ignoredFilesNotEnumerated: true,
    files: receipt.files.map(item => ({ pathDigest: digest(item.path), origin: item.origin, kind: item.kind,
      size: item.size ?? 0, ...(item.sha256 ? { sha256: item.sha256 } : {}) })) };
}
async function writePrivate(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}
async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Core supplies only its fixed private data root and a canonical project/worktree source. */
async function capture({ sourceDir, dataDir } = {}, afterCopy = async () => {}) {
  if (typeof sourceDir !== 'string' || !isAbsolute(sourceDir) || typeof dataDir !== 'string' ||
    !isAbsolute(dataDir)) throw fail('PREVIEW_SOURCE_PATH', 'Canonical source and private data are required');
  const sourceRoot = await realpath(sourceDir);
  if (resolve(sourceDir) !== sourceRoot) throw fail('PREVIEW_SOURCE_PATH', 'Source must be canonical');
  const sourceIdentity = await lstat(sourceRoot);
  if (!sourceIdentity.isDirectory() || sourceIdentity.isSymbolicLink())
    throw fail('PREVIEW_SOURCE_UNTRUSTED', 'Source root is not a directory');
  const root = await privateRoot(dataDir, sourceRoot);
  const snapshotId = randomBytes(16).toString('hex');
  const staging = join(root, `.stage-${snapshotId}`), target = join(root, snapshotId);
  const first = await sourceSet(sourceRoot);
  try {
    const snapshotDir = join(staging, 'source');
    const files = [], copied = [], originalIdentity = new Map(); let total = 0;
    for (const item of first.included) {
      const source = await boundedFile(sourceRoot, item.path, item.origin === 'tracked');
      originalIdentity.set(item.path, { kind: source.kind,
        stat: source.stat ?? null, parents: source.parents });
      if (source.kind === 'deleted') {
        files.push({ path: item.path, origin: item.origin, kind: 'deleted' }); continue;
      }
      total += source.bytes.length;
      if (total > MAX_TOTAL) throw fail('PREVIEW_SOURCE_LIMIT', 'Source snapshot exceeds limit');
      copied.push({ path: item.path, bytes: source.bytes });
      files.push({ path: item.path, origin: item.origin, kind: 'file', size: source.bytes.length,
        sha256: digest(source.bytes) });
    }
    const layout = planSnapshotLayout(files);
    await mkdir(staging, { mode: 0o700 });
    await mkdir(snapshotDir, { mode: 0o700 });
    for (const path of layout.directories)
      await mkdir(join(snapshotDir, path), { recursive: true, mode: 0o700 });
    for (const item of copied)
      await writePrivate(join(snapshotDir, item.path), item.bytes);
    await afterCopy();
    const second = await sourceSet(sourceRoot);
    if (JSON.stringify(first) !== JSON.stringify(second))
      throw fail('PREVIEW_SOURCE_CHANGED', 'Source set changed during snapshot');
    if (!sameStat(sourceIdentity, await lstat(sourceRoot)) || await realpath(sourceRoot) !== sourceRoot)
      throw fail('PREVIEW_SOURCE_CHANGED', 'Source root changed during snapshot');
    for (const item of files) {
      const current = await boundedFile(sourceRoot, item.path, item.kind === 'deleted');
      const original = originalIdentity.get(item.path);
      if (current.kind !== item.kind || !sameParents(original.parents, current.parents) ||
        current.kind === 'file' && (!sameStat(original.stat, current.stat) ||
          current.bytes.length !== item.size || digest(current.bytes) !== item.sha256))
        throw fail('PREVIEW_SOURCE_CHANGED', 'Source bytes changed during snapshot');
    }
    const receipt = { schemaVersion: 2, snapshotId, sourceCommit: first.head,
      selection: 'git-cached-and-nonignored-untracked-under-canonical-source',
      ignoredFilesNotEnumerated: true,
      exclusionRules: EXCLUSION_RULES,
      excluded: first.excluded, files, sourceDigest: receiptDigest(first.head, files, first.excluded) };
    const encoded = JSON.stringify(receipt);
    if (Buffer.byteLength(encoded) > MAX_RECEIPT)
      throw fail('PREVIEW_SOURCE_LIMIT', 'Source receipt exceeds limit');
    await writePrivate(join(staging, 'receipt.json'), encoded);
    const directories = [...layout.directories].map(path => join(snapshotDir, path));
    directories.push(snapshotDir);
    for (const directory of directories.sort((a, b) => b.length - a.length))
      await syncDirectory(directory);
    await syncDirectory(staging);
    await rename(staging, target); await syncDirectory(root);
    return { snapshotId, snapshotDir: join(target, 'source'), receipt,
      publicReceipt: publicReceipt(receipt) };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

export const createPreviewSourceSnapshot = input => capture(input);

/** Local deterministic race seam; never accepted by the product capture API. */
export const createPreviewSourceSnapshotForTest = afterCopy => input => capture(input, afterCopy);

/** Recheck the private, owned snapshot immediately before a controlled build. */
export async function verifyPreviewSourceSnapshot({ dataDir, snapshotId, expectedSourceDigest } = {}) {
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || !ID.test(snapshotId) ||
    !SHA.test(expectedSourceDigest))
    throw fail('PREVIEW_SOURCE_PATH', 'Private snapshot identity is invalid');
  const data = await realpath(dataDir), root = join(data, 'preview-source-snapshots');
  if (!checkedDirectory(await lstat(root)) || await realpath(root) !== root)
    throw fail('PREVIEW_SOURCE_UNTRUSTED', 'Snapshot root is not private');
  const directory = join(root, snapshotId), source = join(directory, 'source');
  for (const path of [directory, source]) {
    if (!checkedDirectory(await lstat(path)) || await realpath(path) !== path)
      throw fail('PREVIEW_SOURCE_UNTRUSTED', 'Snapshot directory changed');
  }
  const receiptBytes = await boundedFile(directory, 'receipt.json', false);
  if (receiptBytes.kind !== 'file' || receiptBytes.bytes.length > MAX_RECEIPT ||
    receiptBytes.stat.uid !== process.getuid() || (receiptBytes.stat.mode & 0o777) !== 0o600)
    throw fail('PREVIEW_SOURCE_UNTRUSTED', 'Snapshot receipt is invalid');
  const receipt = JSON.parse(receiptBytes.bytes.toString('utf8'));
  const knownSchema = receipt.schemaVersion === 1 || receipt.schemaVersion === 2;
  const rules = receipt.schemaVersion === 1 ? LEGACY_EXCLUSION_RULES : EXCLUSION_RULES;
  if (!knownSchema || receipt.snapshotId !== snapshotId ||
    !/^[a-f0-9]{40,64}$/.test(receipt.sourceCommit) || !SHA.test(receipt.sourceDigest) ||
    receipt.sourceDigest !== expectedSourceDigest ||
    receipt.selection !== 'git-cached-and-nonignored-untracked-under-canonical-source' ||
    receipt.ignoredFilesNotEnumerated !== true ||
    JSON.stringify(receipt.exclusionRules) !== JSON.stringify(rules) ||
    !Array.isArray(receipt.files) || receipt.files.length > MAX_FILES ||
    !Array.isArray(receipt.excluded) || receipt.excluded.length > MAX_FILES ||
    receipt.excluded.some(item => !item || !checkedRelative(item.path) ||
      receipt.schemaVersion === 2 && appMetadata(item.path) ||
      !exclusion(item.path, receipt.schemaVersion === 2) ||
      exclusion(item.path, receipt.schemaVersion === 2) !== item.reason) ||
    receipt.sourceDigest !== receiptDigest(receipt.sourceCommit, receipt.files, receipt.excluded,
      receipt.schemaVersion))
    throw fail('PREVIEW_SOURCE_UNTRUSTED', 'Snapshot receipt changed');
  const expected = new Set(), expectedDirs = new Set(); let total = 0;
  for (const item of receipt.files) {
    checkedRelative(item.path);
    if (exclusion(item.path, receipt.schemaVersion === 2) || expected.has(item.path) ||
      !['tracked', 'untracked'].includes(item.origin) ||
      !['file', 'deleted'].includes(item.kind) ||
      item.kind === 'deleted' && item.origin !== 'tracked')
      throw fail('PREVIEW_SOURCE_UNTRUSTED', 'Snapshot file set is invalid');
    expected.add(item.path);
    const parts = item.path.split('/');
    for (let n = 1; n < parts.length; n++) expectedDirs.add(parts.slice(0, n).join('/'));
    if (item.kind === 'deleted') {
      if (item.size !== undefined || item.sha256 !== undefined) throw fail('PREVIEW_SOURCE_UNTRUSTED', 'Deleted entry changed');
      continue;
    }
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE || !SHA.test(item.sha256))
      throw fail('PREVIEW_SOURCE_UNTRUSTED', 'Snapshot file metadata is invalid');
    const current = await boundedFile(source, item.path, false);
    total += current.bytes.length;
    if (total > MAX_TOTAL || current.kind !== 'file' || current.stat.uid !== process.getuid() ||
      (current.stat.mode & 0o777) !== 0o600 || current.bytes.length !== item.size ||
      digest(current.bytes) !== item.sha256)
      throw fail('PREVIEW_SOURCE_CHANGED', 'Snapshot bytes changed');
  }
  const found = []; let visited = 0;
  async function visit(dir, prefix = '') {
    for await (const entry of await opendir(dir)) {
      if (++visited > MAX_SNAPSHOT_ENTRIES)
        throw fail('PREVIEW_SOURCE_LIMIT', 'Snapshot entry count exceeds limit');
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      checkedRelative(name);
      const stat = await lstat(join(dir, entry.name));
      if (stat.isDirectory() && !stat.isSymbolicLink() && checkedDirectory(stat)) {
        if (!expectedDirs.has(name)) throw fail('PREVIEW_SOURCE_CHANGED', 'Snapshot directory set changed');
        await visit(join(dir, entry.name), name);
      }
      else if (stat.isFile() && !stat.isSymbolicLink()) found.push(name);
      else throw fail('PREVIEW_SOURCE_UNTRUSTED', 'Snapshot contains a special file');
    }
  }
  await visit(source);
  if (found.length !== receipt.files.filter(item => item.kind === 'file').length ||
    found.some(path => !expected.has(path))) throw fail('PREVIEW_SOURCE_CHANGED', 'Snapshot file set changed');
  return { snapshotId, snapshotDir: source, receipt, publicReceipt: publicReceipt(receipt) };
}
