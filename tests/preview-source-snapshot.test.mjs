import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewSourceSnapshot, createPreviewSourceSnapshotForTest,
  planPreviewSourceSnapshotLayoutForTest,
  verifyPreviewSourceSnapshot } from '../server/preview/source-snapshot.mjs';
import { prepareControlledBuildView } from '../server/preview/controlled-build-profile.mjs';

const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args],
  { timeout: 5000, maxBuffer: 1024 * 1024 });

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-preview-snapshot-')));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'project'), dataDir = join(root, 'data');
  await mkdir(sourceDir); await mkdir(dataDir, { mode: 0o700 });
  git(sourceDir, 'init', '-q');
  git(sourceDir, 'config', 'user.name', 'Isolated Test');
  git(sourceDir, 'config', 'user.email', 'snapshot@example.test');
  await writeFile(join(sourceDir, '.gitignore'), '.env\n');
  await writeFile(join(sourceDir, 'index.html'), '<main>committed</main>');
  await writeFile(join(sourceDir, 'tracked.js'), 'export const value = 1;\n');
  git(sourceDir, 'add', '.'); git(sourceDir, 'commit', '-qm', 'fixture');
  return { root, sourceDir, dataDir };
}

test('dirty tracked and nonignored untracked bytes survive restart; ignored/output/private serial do not', async t => {
  const { sourceDir, dataDir } = await fixture(t);
  await writeFile(join(sourceDir, 'tracked.js'), 'export const value = 2;\n');
  await writeFile(join(sourceDir, 'new.js'), 'export const added = true;\n');
  await writeFile(join(sourceDir, '.env'), 'ignored fixture only');
  await writeFile(join(sourceDir, 'private.srl'), 'excluded fixture only');
  await mkdir(join(sourceDir, 'dist'));
  await writeFile(join(sourceDir, 'dist', 'bundle.js'), 'generated');
  const saved = await createPreviewSourceSnapshot({ sourceDir, dataDir });
  assert.match(saved.snapshotId, /^[a-f0-9]{32}$/);
  assert.equal(saved.receipt.files.some(item => item.path === 'tracked.js'), true);
  assert.equal(saved.receipt.files.some(item => item.path === 'new.js'), true);
  assert.equal(saved.receipt.files.some(item => item.path === '.env'), false);
  assert.equal(saved.receipt.files.some(item => item.path === 'dist/bundle.js'), false);
  assert.equal(saved.receipt.files.some(item => item.path === 'private.srl'), false);
  assert.equal(saved.receipt.excluded.some(item => item.path === 'private.srl' && item.reason === 'private_serial'), true);
  assert.equal(saved.receipt.ignoredFilesNotEnumerated, true);
  assert.equal(JSON.stringify(saved.publicReceipt).includes(sourceDir), false);
  assert.equal(JSON.stringify(saved.publicReceipt).includes('private.srl'), false);
  assert.equal(await readFile(join(saved.snapshotDir, 'tracked.js'), 'utf8'), 'export const value = 2;\n');
  await writeFile(join(sourceDir, 'tracked.js'), 'export const value = 3;\n');
  const checked = await verifyPreviewSourceSnapshot({ dataDir, snapshotId: saved.snapshotId,
    expectedSourceDigest: saved.receipt.sourceDigest });
  assert.equal(checked.receipt.sourceDigest, saved.receipt.sourceDigest);
  assert.equal(await readFile(join(checked.snapshotDir, 'tracked.js'), 'utf8'), 'export const value = 2;\n');
});

test('root app-generated .taskboard metadata stays outside source proof while ordinary README remains unsupported', async t => {
  const { root, sourceDir, dataDir } = await fixture(t);
  await rm(join(sourceDir, '.gitignore'));
  await rm(join(sourceDir, 'tracked.js'));
  await mkdir(join(sourceDir, '.taskboard'));
  await writeFile(join(sourceDir, '.taskboard', 'CONTEXT.md'), 'generated context');
  await writeFile(join(sourceDir, '.taskboard', 'tasks.json'), '{}');
  await mkdir(join(sourceDir, 'nested', '.taskboard'), { recursive: true });
  await writeFile(join(sourceDir, 'nested', '.taskboard', 'manual.js'), 'const nested = true;\n');
  const saved = await createPreviewSourceSnapshotForTest(async () => {
    await writeFile(join(sourceDir, '.taskboard', 'CONTEXT.md'), 'updated during capture');
    await writeFile(join(sourceDir, '.taskboard', 'receipts.json'), '{}');
  })({ sourceDir, dataDir });
  const generated = ['.taskboard/CONTEXT.md', '.taskboard/tasks.json'];
  for (const path of generated) {
    assert.equal(saved.receipt.files.some(item => item.path === path), false);
    assert.equal(saved.receipt.excluded.some(item => item.path === path), false);
  }
  assert.equal(saved.receipt.exclusionRules.includes('root/.taskboard'), true);
  assert.equal(saved.receipt.files.some(item => item.path === 'nested/.taskboard/manual.js'), true);
  assert.equal(saved.publicReceipt.files.some(item => generated.includes(item.path)), false);
  assert.equal(JSON.stringify(saved.receipt).includes('receipts.json'), false);
  assert.equal((await readdir(saved.snapshotDir)).includes('.taskboard'), false);
  const checked = await verifyPreviewSourceSnapshot({ dataDir, snapshotId: saved.snapshotId,
    expectedSourceDigest: saved.receipt.sourceDigest });
  assert.equal(checked.receipt.sourceDigest, saved.receipt.sourceDigest);
  await writeFile(join(sourceDir, '.taskboard', 'CONTEXT.md'), 'updated generated context');
  const again = await createPreviewSourceSnapshot({ sourceDir, dataDir });
  assert.equal(again.receipt.sourceDigest, saved.receipt.sourceDigest);
  await prepareControlledBuildView({ snapshotDir: saved.snapshotDir,
    receipt: saved.receipt, viewDir: join(root, 'profile-good') });
  await writeFile(join(sourceDir, 'README.md'), 'ordinary project readme');
  const withReadme = await createPreviewSourceSnapshot({ sourceDir, dataDir });
  assert.equal(withReadme.receipt.files.some(item => item.path === 'README.md'), true);
  await assert.rejects(prepareControlledBuildView({ snapshotDir: withReadme.snapshotDir,
    receipt: withReadme.receipt, viewDir: join(root, 'profile-view') }),
  { code: 'BUILD_SOURCE_INVALID' });
});

test('tracked deletion is an explicit receipt entry without resurrecting the file', async t => {
  const { sourceDir, dataDir } = await fixture(t);
  await mkdir(join(sourceDir, 'nested'));
  await writeFile(join(sourceDir, 'nested', 'removed.js'), 'tracked then removed');
  git(sourceDir, 'add', 'nested/removed.js');
  git(sourceDir, 'commit', '-qm', 'nested fixture');
  await rm(join(sourceDir, 'nested'), { recursive: true });
  const saved = await createPreviewSourceSnapshot({ sourceDir, dataDir });
  assert.deepEqual(saved.receipt.files.find(item => item.path === 'nested/removed.js'),
    { path: 'nested/removed.js', origin: 'tracked', kind: 'deleted' });
  const checked = await verifyPreviewSourceSnapshot({ dataDir, snapshotId: saved.snapshotId,
    expectedSourceDigest: saved.receipt.sourceDigest });
  assert.equal(checked.receipt.sourceDigest, saved.receipt.sourceDigest);
});

test('symlink and over-limit source files reject before publishing a snapshot', async t => {
  const { sourceDir, dataDir } = await fixture(t);
  await symlink('/etc/passwd', join(sourceDir, 'shortcut'));
  await assert.rejects(createPreviewSourceSnapshot({ sourceDir, dataDir }),
    { code: 'PREVIEW_SOURCE_UNTRUSTED' });
  await rm(join(sourceDir, 'shortcut'));
  await writeFile(join(sourceDir, 'large.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(createPreviewSourceSnapshot({ sourceDir, dataDir }),
    { code: 'PREVIEW_SOURCE_LIMIT' });
  assert.deepEqual((await readdir(join(dataDir, 'preview-source-snapshots'))).filter(name => !name.startsWith('.')), []);
});

test('source byte and file-set changes during capture fail closed', async t => {
  const { sourceDir, dataDir } = await fixture(t);
  const changedBytes = createPreviewSourceSnapshotForTest(() =>
    writeFile(join(sourceDir, 'tracked.js'), 'changed during capture'));
  await assert.rejects(changedBytes({ sourceDir, dataDir }),
    { code: 'PREVIEW_SOURCE_CHANGED' });
  const changedSet = createPreviewSourceSnapshotForTest(() =>
    writeFile(join(sourceDir, 'new.js'), 'new during capture'));
  await assert.rejects(changedSet({ sourceDir, dataDir }),
    { code: 'PREVIEW_SOURCE_CHANGED' });
  assert.deepEqual((await readdir(join(dataDir, 'preview-source-snapshots'))).filter(name => !name.startsWith('.')), []);
});

test('same-byte inode replacement during capture is not accepted as the original file', async t => {
  const { sourceDir, dataDir } = await fixture(t);
  await mkdir(join(sourceDir, 'src'));
  await writeFile(join(sourceDir, 'src', 'stable.js'), 'same bytes');
  const replace = createPreviewSourceSnapshotForTest(async () => {
    await writeFile(join(sourceDir, 'src', 'replacement'), 'same bytes');
    await rename(join(sourceDir, 'src', 'replacement'), join(sourceDir, 'src', 'stable.js'));
  });
  await assert.rejects(replace({ sourceDir, dataDir }),
    { code: 'PREVIEW_SOURCE_CHANGED' });
});

test('replacing the source root with an equivalent checkout is not accepted', async t => {
  const { root, sourceDir, dataDir } = await fixture(t);
  const replacement = join(root, 'replacement');
  await cp(sourceDir, replacement, { recursive: true });
  const replace = createPreviewSourceSnapshotForTest(async () => {
    await rename(sourceDir, join(root, 'original'));
    await rename(replacement, sourceDir);
  });
  await assert.rejects(replace({ sourceDir, dataDir }),
    { code: 'PREVIEW_SOURCE_CHANGED' });
  assert.deepEqual((await readdir(join(dataDir, 'preview-source-snapshots'))).filter(name => !name.startsWith('.')), []);
});

test('published receipt limit rejects oversized metadata before a snapshot is visible', async t => {
  const { sourceDir, dataDir } = await fixture(t);
  const long = 'x'.repeat(230);
  for (let n = 0; n < 4200; n++)
    await writeFile(join(sourceDir, `${String(n).padStart(4, '0')}-${long}`), '');
  await assert.rejects(createPreviewSourceSnapshot({ sourceDir, dataDir }),
    { code: 'PREVIEW_SOURCE_LIMIT' });
  assert.deepEqual((await readdir(join(dataDir, 'preview-source-snapshots'))).filter(name => !name.startsWith('.')), []);
});

test('publication uses the verifier entry limit before creating snapshot directories', () => {
  const paths = Array.from({ length: 3000 }, (_, n) => {
    const id = String(n).padStart(4, '0');
    return `${id}/a/b/file.js`;
  });
  assert.throws(() => planPreviewSourceSnapshotLayoutForTest(paths),
    { code: 'PREVIEW_SOURCE_LIMIT' });
  assert.deepEqual(planPreviewSourceSnapshotLayoutForTest(['src/a.js', 'src/b.js']),
    { directories: new Set(['src']), fileCount: 2 });
});

test('private snapshot tamper, added files and wrong external digest cannot be verified', async t => {
  const { sourceDir, dataDir } = await fixture(t);
  const saved = await createPreviewSourceSnapshot({ sourceDir, dataDir });
  const scope = { dataDir, snapshotId: saved.snapshotId, expectedSourceDigest: saved.receipt.sourceDigest };
  await assert.rejects(verifyPreviewSourceSnapshot({ ...scope, expectedSourceDigest: '0'.repeat(64) }),
    { code: 'PREVIEW_SOURCE_UNTRUSTED' });
  await mkdir(join(saved.snapshotDir, 'extra-dir'), { mode: 0o700 });
  await assert.rejects(verifyPreviewSourceSnapshot(scope), { code: 'PREVIEW_SOURCE_CHANGED' });
  await rm(join(saved.snapshotDir, 'extra-dir'), { recursive: true });
  await writeFile(join(saved.snapshotDir, 'extra.js'), 'extra');
  await assert.rejects(verifyPreviewSourceSnapshot(scope), { code: 'PREVIEW_SOURCE_CHANGED' });
  await rm(join(saved.snapshotDir, 'extra.js'));
  await writeFile(join(saved.snapshotDir, 'index.html'), '<main>tampered</main>');
  await assert.rejects(verifyPreviewSourceSnapshot(scope), { code: 'PREVIEW_SOURCE_CHANGED' });
});
