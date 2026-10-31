import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { prepareHub } from '../scripts/prepare-hub.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts', 'prepare-hub.mjs');
const modules = join(repo, 'node_modules');
const commit = 'a'.repeat(40);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-hub-package-')));
  let success = false;
  t.after(async () => { if (success) await rm(root, { recursive: true, force: true }); });
  const source = join(root, 'source');
  const dist = join(source, 'dist');
  await mkdir(join(source, 'server'), { recursive: true });
  await mkdir(join(source, 'scripts'));
  await mkdir(dist);
  await writeFile(join(source, 'server', 'check.mjs'), "import WebSocket from 'ws'; import ssh2 from 'ssh2'; export const checks = [typeof WebSocket, typeof ssh2.Client];\n");
  await writeFile(join(source, 'scripts', 'hub-backup.mjs'), 'export const backup = true;\n');
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Hub</title>');
  return { root, source, dist, markSuccess: () => { success = true; } };
}

test('prepareHub creates a private, exact, self-contained ESM Hub stage', async t => {
  const fx = await fixture(t);
  const output = join(fx.root, 'release');
  const result = await prepareHub({ sourceDir: fx.source, modulesDir: modules, outputDir: output, sourceCommit: commit });
  assert.equal(result.output, output);
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(output, 'seqivo-release.json'))).mode & 0o777, 0o600);
  const release = JSON.parse(await readFile(join(output, 'seqivo-release.json'), 'utf8'));
  assert.equal(release.commit, commit);
  assert.equal(release.format, 'seqivo-hub-release');
  assert.equal(release.files['server/check.mjs'], digest(await readFile(join(fx.source, 'server', 'check.mjs'))));
  assert.equal(release.files['dist/index.html'], digest(await readFile(join(fx.dist, 'index.html'))));
  assert.ok(release.files['node_modules/ws/wrapper.mjs'], 'ESM wrapper must be copied');
  assert.ok(release.files['node_modules/ws/index.js']);
  assert.ok(release.files['node_modules/ssh2/package.json']);
  assert.ok(!Object.keys(release.files).some(name => /(?:^|\/)(?:tests?|fixtures?|keys?|native)(?:\/|$)|\.(?:node|key|pem)$/i.test(name)));
  for (const [relative, sha] of Object.entries(release.files)) {
    assert.match(sha, /^[a-f0-9]{64}$/);
    assert.equal(digest(await readFile(join(output, relative))), sha, relative);
  }
  const staged = [];
  const walk = async (dir, prefix = '') => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${rel}/`);
      else staged.push(rel);
    }
  };
  await walk(output);
  assert.deepEqual(staged.filter(path => path !== 'seqivo-release.json').sort(), Object.keys(release.files).sort());
  assert.deepEqual(await readdir(join(output, 'node_modules')), Object.keys(release.dependencies).sort());
  const loaded = await import(pathToFileURL(join(output, 'server', 'check.mjs')).href);
  assert.deepEqual(loaded.checks, ['function', 'function']);
  await assert.rejects(prepareHub({ sourceDir: fx.source, modulesDir: modules, outputDir: output, sourceCommit: commit }), /already exists/);
  fx.markSuccess();
});

test('prepareHub refuses overlapping output and leaves every input untouched', async t => {
  const fx = await fixture(t);
  const original = await readFile(join(fx.source, 'server', 'check.mjs'));
  await assert.rejects(prepareHub({ sourceDir: fx.source, modulesDir: modules, outputDir: join(fx.source, 'release'), sourceCommit: commit }), /overlaps/);
  await assert.rejects(prepareHub({ sourceDir: fx.source, modulesDir: modules, outputDir: fx.root, sourceCommit: commit }), /overlaps/);
  await assert.rejects(prepareHub({ sourceDir: fx.source, modulesDir: modules, outputDir: join(fx.root, 'release'), sourceCommit: 'unknown' }), /source-commit/);
  assert.deepEqual(await readFile(join(fx.source, 'server', 'check.mjs')), original);
  fx.markSuccess();
});

test('CLI accepts explicit source, dist and modules paths without network or service startup', async t => {
  const fx = await fixture(t);
  const output = join(fx.root, 'cli-output');
  const raw = execFileSync(process.execPath, [script, '--source-dir', fx.source, '--dist-dir', fx.dist, '--modules-dir', modules, '--output', output, '--source-commit', commit], { encoding: 'utf8' });
  const reply = JSON.parse(raw);
  assert.equal(reply.output, output);
  assert.equal(reply.commit, commit);
  assert.equal(JSON.parse(await readFile(join(output, 'seqivo-release.json'), 'utf8')).commit, commit);
  const defaultOutput = join(fx.root, 'default-output');
  const defaultRaw = execFileSync(process.execPath, [script, '--modules-dir', modules, '--output', defaultOutput, '--source-commit', commit], { cwd: fx.source, encoding: 'utf8' });
  assert.equal(JSON.parse(defaultRaw).output, defaultOutput);
  fx.markSuccess();
});

test('source fixture and key paths fail closed instead of entering a release', async t => {
  const fx = await fixture(t);
  await mkdir(join(fx.source, 'server', 'fixtures'));
  await writeFile(join(fx.source, 'server', 'fixtures', 'private.key'), 'test-only');
  const output = join(fx.root, 'forbidden-output');
  await assert.rejects(prepareHub({ sourceDir: fx.source, modulesDir: modules, outputDir: output, sourceCommit: commit }), /forbidden runtime path/);
  await assert.rejects(readFile(join(output, 'server', 'fixtures', 'private.key')));
  fx.markSuccess();
});

test('dotenv variants and hidden runtime paths cannot enter the deployable tree', async t => {
  for (const name of ['server/.env.local', 'dist/.env.production', 'server/.npmrc']) {
    const fx = await fixture(t);
    const input = join(fx.source, name);
    const contents = 'DISPOSABLE_SECRET_DO_NOT_PACKAGE';
    await writeFile(input, contents);
    const output = join(fx.root, 'rejected-release');
    await assert.rejects(prepareHub({ sourceDir: fx.source, modulesDir: modules, outputDir: output, sourceCommit: commit }), /forbidden runtime path/);
    await assert.rejects(readFile(join(output, name)));
    await assert.rejects(readFile(join(output, 'seqivo-release.json')));
    assert.equal(await readFile(input, 'utf8'), contents);
    fx.markSuccess();
  }
});
