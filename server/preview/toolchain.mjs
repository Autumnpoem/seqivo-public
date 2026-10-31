import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '8.3.1';
const SCHEMA = 'seqivo.preview-toolchain.v1';
const VITE_ENTRY = 'node_modules/vite/dist/node/index.js';
const SOURCE_FILES = [
  'server/preview/controlled-build-worker.mjs',
  'server/preview/controlled-build-runner.mjs',
  'server/preview/controlled-build-profile.mjs',
];
const CORE_VERSIONS = Object.freeze({
  '@oxc-project/types': '0.151.0', '@rolldown/pluginutils': '1.0.1',
  'detect-libc': '2.1.2', fdir: '6.5.0', lightningcss: '1.33.0',
  nanoid: '3.3.19', picocolors: '1.1.1', picomatch: '4.0.7',
  postcss: '8.5.28', rolldown: '1.2.10', 'source-map-js': '1.2.1',
  tinyglobby: '0.2.17', vite: VERSION,
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const fail = () => Object.assign(new Error('固定预览构建工具链不可用或校验失败'), { code: 'BUILD_UNSUPPORTED' });
const productRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const toolchainRoot = root => join(root, 'preview-toolchain');
const isRel = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') &&
  !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..');

function manifestBody(manifest) {
  return {
    schema: manifest.schema,
    viteVersion: manifest.viteVersion,
    platform: manifest.platform,
    arch: manifest.arch,
    entry: manifest.entry,
    packages: manifest.packages,
    sources: manifest.sources,
  };
}

function expectedNativeNames(platform, arch) {
  const target = platform === 'darwin' ? `darwin-${arch}` :
    platform === 'win32' ? `win32-${arch}-msvc` :
      platform === 'linux' ? `linux-${arch}-` : null;
  if (!target) throw fail();
  return platform === 'linux'
    ? { rolldown: [`@rolldown/binding-${target}gnu`, `@rolldown/binding-${target}musl`],
      lightningcss: [`lightningcss-${target}gnu`, `lightningcss-${target}musl`] }
    : { rolldown: [`@rolldown/binding-${target}`], lightningcss: [`lightningcss-${target}`] };
}

function expectedPackageVersions(manifest) {
  const native = expectedNativeNames(manifest.platform, manifest.arch);
  const versions = { ...CORE_VERSIONS };
  const names = manifest.packages.map(item => item?.name);
  const role = (candidates, version) => {
    const found = names.filter(name => (Array.isArray(candidates) ? candidates : [candidates]).includes(name));
    if (!found.length) throw fail();
    for (const name of found) versions[name] = version;
  };
  role(native.rolldown, '1.2.10');
  role(native.lightningcss, '1.33.0');
  return versions;
}

function actualFiles(root) {
  const files = [];
  const walk = (directory, prefix = '') => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
    for (const name of readdirSync(directory).sort()) {
      if (name === 'node_modules') throw fail();
      const absolute = join(directory, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const child = lstatSync(absolute);
      if (child.isSymbolicLink()) throw fail();
      if (child.isDirectory()) walk(absolute, rel);
      else if (child.isFile()) files.push({ path: rel, size: child.size, sha256: hash(readFileSync(absolute)) });
      else throw fail();
    }
  };
  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function validateManifest(root, manifest) {
  const keys = ['schema', 'viteVersion', 'platform', 'arch', 'entry', 'packages', 'sources', 'toolDigest'];
  if (!manifest || Object.keys(manifest).sort().join('|') !== keys.sort().join('|') ||
      manifest.schema !== SCHEMA || manifest.viteVersion !== VERSION ||
      manifest.platform !== process.platform || manifest.arch !== process.arch ||
      manifest.entry !== VITE_ENTRY || !isRel(manifest.entry) || !Array.isArray(manifest.packages) || !Array.isArray(manifest.sources) ||
      !/^[a-f0-9]{64}$/.test(manifest.toolDigest || '')) throw fail();
  if (hash(Buffer.from(JSON.stringify(manifestBody(manifest)))) !== manifest.toolDigest) throw fail();

  const rootReal = realpathSync(root);
  const toolRoot = realpathSync(toolchainRoot(root));
  if (!within(rootReal, toolRoot) || toolRoot !== resolve(rootReal, 'preview-toolchain')) throw fail();
  const packageNames = new Set();
  let viteEntry;
  for (const item of manifest.packages) {
    if (!item || Object.keys(item).sort().join('|') !== 'files|name|path|version' ||
        !/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(item.name || '') ||
        item.path !== `node_modules/${item.name}` || !isRel(item.path) ||
        typeof item.version !== 'string' || !Array.isArray(item.files) || packageNames.has(item.name)) throw fail();
    packageNames.add(item.name);
    const packageRoot = resolve(toolRoot, item.path);
    if (!within(toolRoot, packageRoot) || realpathSync(packageRoot) !== packageRoot) throw fail();
    const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    if (packageManifest.name !== item.name || packageManifest.version !== item.version) throw fail();
    const actual = actualFiles(packageRoot);
    const expected = item.files;
    for (const row of expected) {
      if (!row || Object.keys(row).sort().join('|') !== 'path|sha256|size' || !isRel(row.path) ||
          !Number.isSafeInteger(row.size) || row.size < 0 || !/^[a-f0-9]{64}$/.test(row.sha256 || '')) throw fail();
    }
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort((a, b) => a.path.localeCompare(b.path)))) throw fail();
    if (item.name === 'vite') {
      if (item.version !== VERSION || !expected.some(row => `${item.path}/${row.path}` === manifest.entry)) throw fail();
      viteEntry = resolve(toolRoot, manifest.entry);
    }
  }
  if (!packageNames.has('vite') || !viteEntry || realpathSync(viteEntry) !== viteEntry) throw fail();
  const expectedVersions = expectedPackageVersions(manifest);
  if (JSON.stringify([...packageNames].sort()) !== JSON.stringify(Object.keys(expectedVersions).sort()) ||
      manifest.packages.some(item => expectedVersions[item.name] !== item.version)) throw fail();
  const native = expectedNativeNames(manifest.platform, manifest.arch);
  if (!(Array.isArray(native.rolldown) ? native.rolldown : [native.rolldown]).some(name => packageNames.has(name)) ||
      !(Array.isArray(native.lightningcss) ? native.lightningcss : [native.lightningcss]).some(name => packageNames.has(name))) throw fail();

  if (manifest.sources.length !== SOURCE_FILES.length) throw fail();
  for (let index = 0; index < SOURCE_FILES.length; index += 1) {
    const row = manifest.sources[index];
    if (!row || Object.keys(row).sort().join('|') !== 'path|sha256' || row.path !== SOURCE_FILES[index] ||
        !/^[a-f0-9]{64}$/.test(row.sha256 || '')) throw fail();
    const sourcePath = resolve(rootReal, row.path);
    if (!within(rootReal, sourcePath) || realpathSync(sourcePath) !== sourcePath ||
        hash(readFileSync(sourcePath)) !== row.sha256) throw fail();
  }
  return { viteEntry, toolDigest: manifest.toolDigest };
}

/** Load only the fixed, module-relative product toolchain; no caller paths or fallback. */
export function loadVerifiedPreviewToolchain() {
  try {
    const root = realpathSync(productRoot());
    const manifestPath = join(toolchainRoot(root), 'manifest.json');
    const manifestStat = lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 16 * 1024 * 1024) throw fail();
    return validateManifest(root, JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch {
    throw fail();
  }
}

/** Test-only hook: exercises the exact loader against an isolated product root. */
export function loadVerifiedPreviewToolchainForTest(root) {
  try {
    if (typeof root !== 'string' || !isAbsolute(root)) throw fail();
    const product = realpathSync(root);
    const manifestPath = join(toolchainRoot(product), 'manifest.json');
    const manifestStat = lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 16 * 1024 * 1024) throw fail();
    return validateManifest(product, JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch {
    throw fail();
  }
}

export const previewToolchainBuildContract = Object.freeze({
  schema: SCHEMA,
  viteVersion: VERSION,
  viteEntry: VITE_ENTRY,
  coreVersions: CORE_VERSIONS,
  sourceFiles: SOURCE_FILES,
  expectedNativeNames,
  expectedPackageVersions,
  digestManifest: manifest => hash(Buffer.from(JSON.stringify(manifestBody(manifest)))),
});
