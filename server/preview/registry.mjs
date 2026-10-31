import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_FILES = 1000;
const digest = data => createHash('sha256').update(data).digest('hex');
const fail = (message, code = 'PREVIEW_INVALID') => Object.assign(new Error(message), { code });
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };

export function previewPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.startsWith('/') ||
    value.includes('\\') || value.includes('%') || value.includes('\0') ||
    value.split('/').some(part => !part || part === '.' || part === '..')) throw fail('Invalid preview path', 'PREVIEW_PATH');
  return value;
}

export function previewPagePath(value) {
  if (value === '/') return value;
  if (typeof value !== 'string' || /^(?:\/)?api\//.test(value)) throw fail('Invalid preview page path', 'PREVIEW_PATH');
  previewPath(value.startsWith('/') ? value.slice(1) : value);
  return value;
}

export function previewEnvironment(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\p{Cc}\p{Cf}]/u.test(value))
    throw fail('Invalid preview environment', 'PREVIEW_ENVIRONMENT');
  return value;
}

function git(cwd, ...args) {
  try { return execFileSync('git', args, { cwd, timeout: 5000, maxBuffer: 16 * 1024 * 1024 }); }
  catch { throw fail('A readable Git source checkout is required', 'PREVIEW_SOURCE'); }
}

async function sourceIdentity(projectDir) {
  const sourceRoot = (await realpath(projectDir));
  const gitRoot = (await realpath(git(sourceRoot, 'rev-parse', '--show-toplevel').toString().trim()));
  if (!inside(gitRoot, sourceRoot)) throw fail('Project is outside Git checkout', 'PREVIEW_SOURCE');
  const commit = git(sourceRoot, 'rev-parse', 'HEAD').toString().trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw fail('Invalid source commit', 'PREVIEW_SOURCE');
  const changed = new Set([
    ...git(sourceRoot, 'diff', '--name-only', '-z', 'HEAD', '--', '.').toString().split('\0'),
    ...git(sourceRoot, 'ls-files', '--others', '--exclude-standard', '-z', '--', '.').toString().split('\0'),
  ].filter(Boolean));
  if (changed.size > 10_000) throw fail('Too many source changes', 'PREVIEW_SOURCE');
  const hash = createHash('sha256');
  for (const name of [...changed].sort()) {
    const path = resolve(sourceRoot, name);
    if (!inside(sourceRoot, path)) throw fail('Invalid source path', 'PREVIEW_SOURCE');
    hash.update(name).update('\0');
    let stat;
    try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') { hash.update('deleted\0'); continue; } throw error; }
    if (stat.isSymbolicLink()) hash.update('link\0').update(await readlink(path));
    else if (stat.isFile()) {
      if (stat.size > MAX_TOTAL) throw fail('Source change is too large to fingerprint', 'PREVIEW_SOURCE');
      hash.update('file\0').update(await readFile(path));
    } else throw fail('Unsupported source change', 'PREVIEW_SOURCE');
  }
  return { commit, dirtyDigest: hash.digest('hex'), dirty: changed.size > 0 };
}

async function collect(root) {
  const files = [];
  let total = 0;
  async function visit(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      previewPath(name);
      if (/(?:^|\/)[^/]*\.map[.\s]*$/i.test(name)) throw fail('Source maps are not supported in preview builds', 'PREVIEW_SOURCEMAP');
      const path = join(dir, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw fail('Preview build cannot contain symbolic links', 'PREVIEW_SYMLINK');
      if (stat.isDirectory()) { await visit(path, name); continue; }
      if (!stat.isFile()) throw fail('Preview build contains a special file', 'PREVIEW_FILE');
      if (stat.size > MAX_FILE || (total += stat.size) > MAX_TOTAL || files.length >= MAX_FILES)
        throw fail('Preview build exceeds limits', 'PREVIEW_LIMIT');
      const bytes = await readFile(path);
      // Each asset is already capped at 4 MiB above, so a single linear scan is bounded.
      // Reject external and data: sourceMappingURL directives, including JS/CSS comment variants.
      if (/sourceMappingURL\s*[:=]/i.test(bytes.toString('utf8')))
        throw fail('Source map references are not supported in preview builds', 'PREVIEW_SOURCEMAP');
      files.push({ path: name, bytes });
    }
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/** Imports an already built Vite dist as a private, immutable static snapshot. It does not execute project scripts. */
export function createPreviewRegistry({ dataDir } = {}) {
  if (!dataDir) throw new TypeError('Preview registry requires dataDir');
  const root = resolve(dataDir, 'preview-builds');
  const records = new Map();
  async function register({ projectId, taskId, contentVersion, projectDir, distDir, environment, dataMode,
    apiTarget = 'static', dataStoreId = null }) {
    if (![projectId, taskId].every(value => ID.test(value)) || !Number.isSafeInteger(contentVersion) || contentVersion < 1 ||
      !['real', 'simulated'].includes(dataMode) || !['static', 'records-v1'].includes(apiTarget) ||
      (apiTarget === 'records-v1' ? !ID.test(dataStoreId) : dataStoreId !== null)) throw fail('Invalid preview registration');
    previewEnvironment(environment);
    const projectRoot = await realpath(projectDir);
    const buildRoot = await realpath(distDir);
    if (!inside(projectRoot, buildRoot)) throw fail('Build must belong to project', 'PREVIEW_BUILD_PATH');
    if (inside(projectRoot, root)) throw fail('Preview storage must be outside the source checkout', 'PREVIEW_BUILD_PATH');
    const source = await sourceIdentity(projectRoot);
    const files = await collect(buildRoot);
    const index = files.find(item => item.path === 'index.html');
    if (!index) throw fail('Vite index.html missing', 'PREVIEW_BUILD');
    const html = index.bytes.toString('utf8');
    if (!/<(?:script|link)\b/i.test(html) || /(?:src|href)\s*=\s*["']\//i.test(html))
      throw fail("A Vite build with base './' is required", 'PREVIEW_BASE');
    const artifactHash = createHash('sha256');
    const entries = files.map(item => {
      const sha256 = digest(item.bytes);
      artifactHash.update(item.path).update('\0').update(sha256).update('\0');
      return { path: item.path, size: item.bytes.length, sha256 };
    });
    const manifest = { v: apiTarget === 'records-v1' ? 2 : 1, previewId: randomUUID(), projectId, taskId, contentVersion,
      sourceCommit: source.commit, dirtyDigest: source.dirtyDigest, dirty: source.dirty,
      artifactDigest: artifactHash.digest('hex'), environment, dataMode,
      capability: apiTarget === 'records-v1' ? 'records-v1' : 'static-interactive',
      backendApi: apiTarget === 'records-v1' ? 'records-v1' : 'unsupported',
      ...(apiTarget === 'records-v1' ? { apiTarget, dataStoreId } : {}),
      files: entries, createdAt: new Date().toISOString() };
    await mkdir(root, { recursive: true, mode: 0o700 });
    const staging = join(root, `.stage-${manifest.previewId}`);
    const target = join(root, manifest.previewId);
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const item of files) {
        const path = join(staging, item.path);
        await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
        await writeFile(path, item.bytes, { flag: 'wx', mode: 0o600 });
      }
      await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      await rename(staging, target);
      records.set(manifest.previewId, manifest);
      return manifest;
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  }
  async function registerManaged({ previewId, projectId, taskId, contentVersion, sourceTaskRevision, distDir,
    sourceCommit, provenance, dataMode, apiTarget, dataStoreId = null }) {
    if (![previewId, projectId, taskId].every(value => ID.test(value)) ||
      !Number.isSafeInteger(contentVersion) || contentVersion < 1 ||
      !Number.isSafeInteger(sourceTaskRevision) || sourceTaskRevision < 1 ||
      !/^[a-f0-9]{40,64}$/.test(sourceCommit) ||
      provenance?.kind !== 'managed-vite-vanilla-v1' ||
      Object.keys(provenance).sort().join('|') !== ['kind','sourceDigest','inputDigest','buildReceiptDigest','toolDigest','profileDigest'].sort().join('|') ||
      !['sourceDigest','inputDigest','buildReceiptDigest','toolDigest','profileDigest']
        .every(key => SHA.test(provenance[key])) ||
      !['real','simulated'].includes(dataMode) || !['static','records-v1'].includes(apiTarget) ||
      (apiTarget === 'records-v1' ? !ID.test(dataStoreId) : dataStoreId !== null))
      throw fail('Invalid managed preview receipt', 'PREVIEW_MANIFEST');
    const files = await collect(await realpath(distDir));
    const index = files.find(item => item.path === 'index.html');
    if (!index) throw fail('Vite index.html missing', 'PREVIEW_BUILD');
    const html = index.bytes.toString('utf8');
    if (!/<(?:script|link)\b/i.test(html) || /(?:src|href)\s*=\s*["']\//i.test(html))
      throw fail("A Vite build with base './' is required", 'PREVIEW_BASE');
    const artifactHash = createHash('sha256');
    const entries = files.map(item => { const sha256 = digest(item.bytes);
      artifactHash.update(item.path).update('\0').update(sha256).update('\0');
      return { path: item.path, size: item.bytes.length, sha256 }; });
    const manifest = { v: apiTarget === 'records-v1' ? 2 : 1, previewId, projectId, taskId,
      contentVersion, sourceTaskRevision, sourceCommit, provenance, artifactDigest: artifactHash.digest('hex'),
      environment: '受控构建 · 隔离预览', dataMode,
      capability: apiTarget === 'records-v1' ? 'records-v1' : 'static-interactive',
      backendApi: apiTarget === 'records-v1' ? 'records-v1' : 'unsupported',
      ...(apiTarget === 'records-v1' ? { apiTarget, dataStoreId } : {}),
      files: entries, createdAt: new Date().toISOString() };
    const prior = await get(previewId);
    if (prior) {
      if (JSON.stringify(prior.provenance)!==JSON.stringify(provenance) ||
        prior.artifactDigest !== manifest.artifactDigest || prior.taskId !== taskId ||
        prior.projectId !== projectId || prior.contentVersion !== contentVersion ||
        prior.sourceTaskRevision !== sourceTaskRevision ||
        prior.sourceCommit !== sourceCommit || prior.dataMode !== dataMode ||
        (prior.apiTarget||'static') !== apiTarget || (prior.dataStoreId||null)!==dataStoreId)
        throw fail('Managed preview identity changed', 'PREVIEW_MANIFEST');
      return prior;
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    const staging = join(root, `.stage-${previewId}`), target = join(root, previewId);
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const item of files) {
        const path = join(staging, item.path);
        await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
        await writeFile(path, item.bytes, { flag: 'wx', mode: 0o600 });
      }
      await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      await rename(staging, target);
      records.set(previewId, manifest);
      return manifest;
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  }
  async function get(previewId) {
    if (!ID.test(previewId)) throw fail('Invalid preview ID', 'PREVIEW_ID');
    if (records.has(previewId)) return records.get(previewId);
    let record;
    try { record = JSON.parse(await readFile(join(root, previewId, 'manifest.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (record.previewId !== previewId || !SHA.test(record.artifactDigest) || !Array.isArray(record.files))
      throw fail('Preview manifest is invalid', 'PREVIEW_MANIFEST');
    records.set(previewId, record);
    return record;
  }
  async function markRegistered(previewId) {
    if (!await get(previewId)) throw fail('Preview unavailable', 'PREVIEW_NOT_FOUND');
    await writeFile(join(root, previewId, '.hub-registered'), 'v1\n', { flag: 'w', mode: 0o600 });
  }
  async function isRegistered(previewId) {
    if (!await get(previewId)) return false;
    try { return (await readFile(join(root, previewId, '.hub-registered'), 'utf8')) === 'v1\n'; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function listRegistered(taskId) {
    if (!ID.test(taskId)) throw fail('Invalid task ID', 'PREVIEW_TASK');
    let names;
    try { names = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (names.length > 5000) throw fail('Too many preview builds', 'PREVIEW_LIMIT');
    const found=[];
    for (const name of names) {
      if (!ID.test(name)) continue;
      const manifest=await get(name);
      if (manifest?.taskId===taskId && await isRegistered(name)) found.push(manifest);
    }
    return found.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,30);
  }
  async function read(previewId, relativePath) {
    const manifest = await get(previewId);
    if (!manifest) throw fail('Preview unavailable', 'PREVIEW_NOT_FOUND');
    const path = previewPath(relativePath);
    const entry = manifest.files.find(item => item.path === path);
    if (!entry || entry.size > MAX_FILE || !SHA.test(entry.sha256)) throw fail('Preview asset unavailable', 'PREVIEW_NOT_FOUND');
    const file = join(root, previewId, path);
    const snapshotRoot = await realpath(join(root, previewId));
    if (!inside(snapshotRoot, await realpath(file))) throw fail('Preview asset escaped snapshot', 'PREVIEW_PATH');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size) throw fail('Preview asset changed', 'PREVIEW_CHANGED');
    const bytes = await readFile(file);
    if (digest(bytes) !== entry.sha256) throw fail('Preview asset changed', 'PREVIEW_CHANGED');
    return { bytes, entry, manifest };
  }
  return { register, registerManaged, get, read, markRegistered, isRegistered, listRegistered };
}
