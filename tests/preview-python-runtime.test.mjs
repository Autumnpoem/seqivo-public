import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-python-manifest-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = join(root, 'server/preview/python-runtime.mjs');
  await mkdir(dirname(module), { recursive: true });
  await copyFile(new URL('../server/preview/python-runtime.mjs', import.meta.url), module);
  const runtime = join(root, 'preview-python');
  const rows = ['bin/seqivo-python', 'python/bin/python3.12', 'licenses/LICENSE.txt',
    ...Array.from({ length: 8 }, (_, n) => `python/lib/module${n}.py`)];
  const files = [];
  for (const path of rows) {
    const bytes = `fixture:${path}`;
    await mkdir(dirname(join(runtime, path)), { recursive: true });
    await writeFile(join(runtime, path), bytes, { mode: 0o755 });
    files.push({ path, size: Buffer.byteLength(bytes), sha256: sha(bytes) });
  }
  const body = { schema: 1, platform: 'darwin', arch: 'arm64', version: '3.12.15',
    sourceSha256: '8c7ac5f091c64111247e595c9fc8fecc38453e94a60323a3b66dbfca3c01414a',
    launcher: 'bin/seqivo-python', files };
  const manifest = () => ({ ...body, runtimeDigest: sha(JSON.stringify(body)) });
  const save = () => writeFile(join(runtime, 'manifest.json'), JSON.stringify(manifest()));
  await save();
  const { loadVerifiedPreviewPython: load } = await import(`${pathToFileURL(module)}?${randomUUID()}`);
  return { root, runtime, body, load, save };
}

test('preview Python requires its exact resource manifest; it never takes a PATH fallback', async t => {
  const f = await fixture(t);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    assert.throws(f.load, { code: 'BUILD_UNSUPPORTED' }); return;
  }
  assert.equal(f.load().pythonPath, join(f.runtime, 'bin/seqivo-python'));
  await rm(join(f.runtime, 'manifest.json'));
  assert.throws(f.load, { code: 'BUILD_UNSUPPORTED' });
});

test('preview Python rejects changed bytes, extra modules, external symlinks and wrong source', async t => {
  const f = await fixture(t);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    assert.throws(f.load, { code: 'BUILD_UNSUPPORTED' }); return;
  }
  const file = join(f.runtime, 'python/lib/module0.py'), original = await readFile(file);
  await writeFile(file, 'changed');
  assert.throws(f.load, { code: 'BUILD_UNSUPPORTED' });
  await writeFile(file, original);
  const extra = join(f.runtime, 'python/lib/sitecustomize.py');
  await writeFile(extra, 'raise RuntimeError()');
  assert.throws(f.load, { code: 'BUILD_UNSUPPORTED' });
  await rm(extra);
  const outside = join(f.root, 'outside.py');
  await writeFile(outside, original);
  await rm(file); await symlink(outside, file);
  assert.throws(f.load, { code: 'BUILD_UNSUPPORTED' });
  await rm(file); await writeFile(file, original);
  f.body.sourceSha256 = 'a'.repeat(64); await f.save();
  assert.throws(f.load, { code: 'BUILD_UNSUPPORTED' });
});

test('preview Python rejects path traversal and non-executable launchers', async t => {
  const f = await fixture(t);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    assert.throws(f.load, { code: 'BUILD_UNSUPPORTED' }); return;
  }
  await chmod(join(f.runtime, 'bin/seqivo-python'), 0o644);
  assert.throws(f.load, { code: 'BUILD_UNSUPPORTED' });
  await chmod(join(f.runtime, 'bin/seqivo-python'), 0o755);
  f.body.files[0].path = '../outside'; await f.save();
  assert.throws(f.load, { code: 'BUILD_UNSUPPORTED' });
});
