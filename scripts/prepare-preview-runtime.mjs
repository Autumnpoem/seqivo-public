import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewToolchainBuildContract } from '../server/preview/toolchain.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT), '..');
const VERSION = '8.3.1';
const SCHEMA = 'seqivo.preview-toolchain.v1';
const SOURCE_FILES = [
  'server/preview/controlled-build-worker.mjs',
  'server/preview/controlled-build-runner.mjs',
  'server/preview/controlled-build-profile.mjs',
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const unsupported = message => Object.assign(new Error(message || 'BUILD_UNSUPPORTED'), { code: 'BUILD_UNSUPPORTED' });
const packageNamePattern = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;

function packageRootFromEntry(entry, expectedName) {
  let current = dirname(realpathSync(entry));
  while (within(REPO_ROOT, current)) {
    const manifest = join(current, 'package.json');
    try {
      const value = JSON.parse(readFileSync(manifest, 'utf8'));
      if (value.name === expectedName) return { root: realpathSync(current), manifest: value };
    } catch { /* Continue toward the trusted repository package root. */ }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw unsupported(`无法解析固定依赖包 ${expectedName}`);
}

function lockContains(name, version, lockText) {
  const wanted = `${name}@${version}`;
  return lockText.split(/\r?\n/).some(line => {
    let key = line.trim();
    if (!key.endsWith(':')) return false;
    key = key.slice(0, -1);
    if (key.startsWith("'")) key = key.slice(1, -1);
    return key === wanted || key.startsWith(`${wanted}(`);
  });
}

function nativeNames(platform, arch) {
  if (platform === 'darwin' || platform === 'win32') {
    const suffix = platform === 'darwin' ? `${platform}-${arch}` : `${platform}-${arch}-msvc`;
    return { rolldown: `@rolldown/binding-${suffix}`, lightningcss: `lightningcss-${suffix}` };
  }
  if (platform === 'linux') {
    return { rolldown: [`@rolldown/binding-linux-${arch}-gnu`, `@rolldown/binding-linux-${arch}-musl`],
      lightningcss: [`lightningcss-linux-${arch}-gnu`, `lightningcss-linux-${arch}-musl`] };
  }
  throw unsupported('当前系统没有固定的 Vite 原生工具包');
}

function resolvePackage(name, fromDirectory) {
  if (!packageNamePattern.test(name)) throw unsupported('依赖包名无效');
  const require = createRequire(join(fromDirectory, 'package.json'));
  let found;
  let entry;
  let packageManifestEntry;
  try { packageManifestEntry = realpathSync(require.resolve(`${name}/package.json`)); }
  catch { /* Exports may hide package.json; use the runtime entry below. */ }
  if (packageManifestEntry) {
    found = packageRootFromEntry(packageManifestEntry, name);
    try { entry = realpathSync(require.resolve(name)); }
    catch { entry = packageManifestEntry; }
  } else {
    try { entry = realpathSync(require.resolve(name)); }
    catch { return null; }
    found = packageRootFromEntry(entry, name);
  }
  const installedRoot = realpathSync(join(REPO_ROOT, 'node_modules'));
  if (!within(installedRoot, found.root)) throw unsupported(`依赖包不在本机锁定安装树内：${name}`);
  return { ...found, entry };
}

function copyPackageTree(sourceRoot, destinationRoot) {
  const files = [];
  const active = new Set();
  const visit = (input, output, relativePath = '') => {
    let real = realpathSync(input);
    if (!within(sourceRoot, real)) throw unsupported('依赖包含越界符号链接');
    const stat = lstatSync(input);
    if (stat.isSymbolicLink()) {
      const target = lstatSync(real);
      if (!target.isFile() && !target.isDirectory()) throw unsupported('依赖包含不受支持的链接目标');
    }
    const realStat = lstatSync(real);
    if (realStat.isDirectory()) {
      if (active.has(real)) throw unsupported('依赖目录存在符号链接循环');
      active.add(real);
      mkdirSync(output, { recursive: true, mode: 0o755 });
      for (const child of readdirSync(real).sort()) {
        if (child === 'node_modules') continue;
        visit(join(real, child), join(output, child), relativePath ? `${relativePath}/${child}` : child);
      }
      active.delete(real);
      return;
    }
    if (!realStat.isFile()) throw unsupported('依赖包含非普通文件');
    const bytes = readFileSync(real);
    mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
    writeFileSync(output, bytes, { mode: realStat.mode & 0o111 ? 0o755 : 0o644 });
    files.push({ path: relativePath, size: bytes.length, sha256: hash(bytes) });
  };
  visit(sourceRoot, destinationRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function canonicalBody(manifest) {
  return { schema: manifest.schema, viteVersion: manifest.viteVersion, platform: manifest.platform,
    arch: manifest.arch, entry: manifest.entry, packages: manifest.packages, sources: manifest.sources };
}

function sourceRows(productRoot) {
  return SOURCE_FILES.map(path => {
    const source = join(REPO_ROOT, path);
    const packaged = join(productRoot, path);
    const sourceBytes = readFileSync(source);
    if (productRoot !== REPO_ROOT && hash(readFileSync(packaged)) !== hash(sourceBytes))
      throw unsupported(`桌面资源中的预览执行文件与本轮源码不一致：${path}`);
    return { path, sha256: hash(sourceBytes) };
  });
}

function preparePreviewRuntimeUnchecked({ productRoot, target = null } = {}) {
  if (typeof productRoot !== 'string' || !isAbsolute(productRoot))
    throw unsupported('预览工具链目标必须是绝对路径');
  const product = resolve(productRoot);
  if (target && !targetMatchesHost(target)) throw unsupported('Rust 目标与已安装的 Vite 原生包不一致');

  const lockText = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
  const rootPackage = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (rootPackage.devDependencies?.vite !== VERSION) throw unsupported('项目未固定使用 Vite 8.3.1');
  const rootVite = resolvePackage('vite', REPO_ROOT);
  if (!rootVite || rootVite.manifest.version !== VERSION || !lockContains('vite', VERSION, lockText))
    throw unsupported('未找到锁定版本 Vite 8.3.1');

  const queue = [{ name: 'vite', ...rootVite }];
  const byName = new Map();
  const native = nativeNames(process.platform, process.arch);
  const isTargetNative = (packageName, candidate) => (Array.isArray(candidate) ? candidate : [candidate]).includes(packageName);
  while (queue.length) {
    const item = queue.shift();
    const prior = byName.get(item.name);
    if (prior) {
      if (prior.manifest.version !== item.manifest.version || prior.root !== item.root)
        throw unsupported(`依赖闭包中存在同名异版本冲突：${item.name}`);
      continue;
    }
    if (!lockContains(item.name, item.manifest.version, lockText))
      throw unsupported(`依赖不在 pnpm 锁定清单中：${item.name}`);
    byName.set(item.name, item);
    const required = Object.keys(item.manifest.dependencies || {});
    const optional = Object.keys(item.manifest.optionalDependencies || {}).filter(dependency =>
      item.name === 'rolldown' && isTargetNative(dependency, native.rolldown) ||
      item.name === 'lightningcss' && isTargetNative(dependency, native.lightningcss));
    for (const dependency of [...required, ...optional].sort()) {
      const resolved = resolvePackage(dependency, item.root);
      if (!resolved) {
        if (required.includes(dependency)) throw unsupported(`缺少 Vite 必需依赖：${dependency}`);
        continue;
      }
      queue.push({ name: dependency, ...resolved });
    }
  }
  const expected = new Map(Object.entries(previewToolchainBuildContract.coreVersions));
  const foundNative = (candidates, version) => {
    const found = [...byName.keys()].filter(name => isTargetNative(name, candidates));
    if (!found.length) return false;
    for (const name of found) expected.set(name, version);
    return true;
  };
  if (!foundNative(native.rolldown, '1.2.10') || !foundNative(native.lightningcss, '1.33.0') ||
      [...byName.keys()].some(name => !expected.has(name)) ||
      [...expected].some(([name, version]) => byName.get(name)?.manifest.version !== version))
    throw unsupported('缺少当前平台匹配的 Vite 原生构建依赖');

  const stage = join(product, `.preview-toolchain-stage-${randomUUID()}`);
  const stageModules = join(stage, 'node_modules');
  const packageRows = [];
  let phase = 'create-stage';
  try {
    mkdirSync(stageModules, { recursive: true, mode: 0o755 });
    for (const item of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      phase = `copy-package:${item.name}`;
      const relativePackage = `node_modules/${item.name}`;
      const destination = join(stage, relativePackage);
      const files = copyPackageTree(item.root, destination);
      if (!files.length) throw unsupported(`依赖包为空：${item.name}`);
      packageRows.push({ name: item.name, version: item.manifest.version,
        path: relativePackage, files });
    }
    phase = 'validate-vite-entry';
    const entryRelative = relative(rootVite.root, rootVite.entry).split(sep).join('/');
    if (entryRelative !== 'dist/node/index.js') throw unsupported('Vite 导出入口与固定配置不一致');
    phase = 'validate-packaged-sources';
    const sources = sourceRows(product);
    const manifest = { schema: SCHEMA, viteVersion: VERSION, platform: process.platform,
      arch: process.arch, entry: previewToolchainBuildContract.viteEntry,
      packages: packageRows, sources };
    manifest.toolDigest = hash(Buffer.from(JSON.stringify(canonicalBody(manifest))));
    phase = 'write-manifest';
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o644 });

    phase = 'commit-toolchain-directory';
    const destination = join(product, 'preview-toolchain');
    const backup = join(product, `.preview-toolchain-old-${randomUUID()}`);
    if (lstatSyncSafe(destination)) renameSync(destination, backup);
    try { renameSync(stage, destination); }
    catch (error) {
      if (lstatSyncSafe(backup)) renameSync(backup, destination);
      throw error;
    }
    phase = 'remove-old-toolchain-backup';
    rmSync(backup, { recursive: true, force: true });
    return { viteVersion: VERSION, toolDigest: manifest.toolDigest,
      manifest: 'preview-toolchain/manifest.json', packageCount: packageRows.length };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (error?.code === 'BUILD_UNSUPPORTED') throw error;
    const diagnostic = { phase, code: error?.code || null, name: error?.name || 'Error',
      message: String(error?.message || 'unknown'), stack: String(error?.stack || '') };
    try {
      const diagnosticRoot = join(REPO_ROOT, '.runtime/impl372');
      mkdirSync(diagnosticRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(diagnosticRoot, 'prepare-failure.txt'), JSON.stringify(diagnostic, null, 2),
        { mode: 0o600 });
    } catch { /* Preserve the product-facing failure if private diagnostics cannot be written. */ }
    throw Object.assign(new Error('BUILD_UNSUPPORTED', { cause: error }), { code: 'BUILD_UNSUPPORTED' });
  }
}

export function preparePreviewRuntime(options = {}) {
  try { return preparePreviewRuntimeUnchecked(options); }
  catch (error) { if (error?.code === 'BUILD_UNSUPPORTED') throw error; throw unsupported(); }
}

function lstatSyncSafe(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function targetMatchesHost(target) {
  const mappings = {
    'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
  };
  return mappings[`${process.platform}-${process.arch}`] === target;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  const productRoot = process.argv[2] === '--output' && process.argv.length === 4 ? process.argv[3] : null;
  if (!productRoot || !isAbsolute(productRoot)) throw unsupported('用法：--output <绝对输出目录>');
  console.log(JSON.stringify(preparePreviewRuntime({ productRoot })));
}
