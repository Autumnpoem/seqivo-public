import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVerifiedPreviewToolchainForTest, previewToolchainBuildContract } from '../server/preview/toolchain.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-preview-toolchain-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = [];
  for (const path of previewToolchainBuildContract.sourceFiles) {
    const absolute = join(root, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    const bytes = Buffer.from(`fixed ${path}\n`);
    await writeFile(absolute, bytes);
    sources.push({ path, sha256: hash(bytes) });
  }

  const toolRoot = join(root, 'preview-toolchain');
  const packages = [];
  const addPackage = async (name, version, files) => {
    const packageRoot = join(toolRoot, 'node_modules', ...name.split('/'));
    await mkdir(packageRoot, { recursive: true });
    const rows = [];
    for (const [path, text] of files) {
      const absolute = join(packageRoot, path);
      await mkdir(join(absolute, '..'), { recursive: true });
      const bytes = Buffer.from(text);
      await writeFile(absolute, bytes);
      rows.push({ path, size: bytes.length, sha256: hash(bytes) });
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));
    packages.push({ name, version, path: `node_modules/${name}`, files: rows });
  };
  const native = previewToolchainBuildContract.expectedNativeNames(process.platform, process.arch);
  const rolldown = Array.isArray(native.rolldown) ? native.rolldown[0] : native.rolldown;
  const lightningcss = Array.isArray(native.lightningcss) ? native.lightningcss[0] : native.lightningcss;
  const versions = { ...previewToolchainBuildContract.coreVersions, [rolldown]: '1.2.10', [lightningcss]: '1.33.0' };
  for (const [name, version] of Object.entries(versions)) {
    const files = [['package.json', JSON.stringify({ name, version })]];
    if (name === 'vite') files.push(['dist/node/index.js', 'export const build = async () => {};\n']);
    if (name === rolldown || name === lightningcss) files.push(['binding.node', 'test native placeholder']);
    await addPackage(name, version, files);
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  const manifest = {
    schema: previewToolchainBuildContract.schema,
    viteVersion: previewToolchainBuildContract.viteVersion,
    platform: process.platform,
    arch: process.arch,
    entry: previewToolchainBuildContract.viteEntry,
    packages,
    sources,
  };
  manifest.toolDigest = previewToolchainBuildContract.digestManifest(manifest);
  await mkdir(toolRoot, { recursive: true });
  await writeFile(join(toolRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { root, toolRoot, manifest, viteEntry: join(toolRoot, manifest.entry) };
}

test('loads only the fixed Vite entry and returns a digest bound to the closure', async t => {
  const x = await fixture(t);
  const loaded = loadVerifiedPreviewToolchainForTest(x.root);
  assert.equal(loaded.viteEntry, x.viteEntry);
  assert.equal(loaded.toolDigest, x.manifest.toolDigest);
  assert.equal((await realpath(loaded.viteEntry)), loaded.viteEntry);
});

test('a missing manifest fails closed', async t => {
  const x = await fixture(t);
  await rm(join(x.toolRoot, 'manifest.json'));
  assert.throws(() => loadVerifiedPreviewToolchainForTest(x.root), { code: 'BUILD_UNSUPPORTED' });
});

test('a changed fixed worker/profile source fails closed', async t => {
  const x = await fixture(t);
  await writeFile(join(x.root, previewToolchainBuildContract.sourceFiles[0]), 'changed');
  assert.throws(() => loadVerifiedPreviewToolchainForTest(x.root), { code: 'BUILD_UNSUPPORTED' });
});

test('content not represented by the manifest is rejected', async t => {
  const x = await fixture(t);
  await writeFile(join(x.toolRoot, x.manifest.entry), 'tampered');
  assert.throws(() => loadVerifiedPreviewToolchainForTest(x.root), { code: 'BUILD_UNSUPPORTED' });
});

test('a modified manifest cannot escape its fixed resource root', async t => {
  const x = await fixture(t);
  x.manifest.entry = '../outside.mjs';
  x.manifest.toolDigest = previewToolchainBuildContract.digestManifest(x.manifest);
  await writeFile(join(x.toolRoot, 'manifest.json'), JSON.stringify(x.manifest));
  assert.throws(() => loadVerifiedPreviewToolchainForTest(x.root), { code: 'BUILD_UNSUPPORTED' });
});

test('a self-consistent manifest with the wrong pinned Vite version is rejected', async t => {
  const x = await fixture(t);
  x.manifest.viteVersion = '8.3.2';
  x.manifest.toolDigest = previewToolchainBuildContract.digestManifest(x.manifest);
  await writeFile(join(x.toolRoot, 'manifest.json'), JSON.stringify(x.manifest));
  assert.throws(() => loadVerifiedPreviewToolchainForTest(x.root), { code: 'BUILD_UNSUPPORTED' });
});

test('package symlinks and unmanifested package files are rejected', async t => {
  const x = await fixture(t);
  const viteRoot = join(x.toolRoot, 'node_modules/vite');
  await writeFile(join(viteRoot, 'extra.js'), 'unmanifested');
  assert.throws(() => loadVerifiedPreviewToolchainForTest(x.root), { code: 'BUILD_UNSUPPORTED' });
  await rm(join(viteRoot, 'extra.js'));
  const escape = join(x.root, 'outside.js');
  await writeFile(escape, 'outside');
  const target = join(viteRoot, 'linked.js');
  await symlink(escape, target);
  assert.equal((await lstat(target)).isSymbolicLink(), true);
  assert.throws(() => loadVerifiedPreviewToolchainForTest(x.root), { code: 'BUILD_UNSUPPORTED' });
});
