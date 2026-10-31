import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, cpSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';

const SOURCE = Object.freeze({
  version: '3.12.15', release: '20261013', target: 'aarch64-apple-darwin',
  url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.12.15%2B20261013-aarch64-apple-darwin-pgo%2Blto-full.tar.zst',
  sha256: '8c7ac5f091c64111247e595c9fc8fecc38453e94a60323a3b66dbfca3c01414a',
});
const sha = value => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => { const r = relative(root, path); return !r || r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const command = (file, args, options = {}) => execFileSync(file, args, {
  encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options,
});
const systemLibrary = path => path.startsWith('/usr/lib/') || path.startsWith('/System/Library/');
function verifyMachOLinks(file, root) {
  const executable = join(root, 'python/bin/python3.12');
  const expand = token => token.startsWith('@loader_path/') ? resolve(dirname(file), token.slice(13)) :
    token.startsWith('@executable_path/') ? resolve(dirname(executable), token.slice(17)) : token;
  const lines = command('/usr/bin/otool', ['-l', file]).split('\n'), paths = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== 'cmd LC_RPATH') continue;
    const match = lines.slice(i + 1, i + 5).map(line => line.match(/^\s*path (.+) \(offset \d+\)$/)).find(Boolean);
    if (!match) throw Error('Unrecognized Python LC_RPATH');
    const path = expand(match[1]);
    if (!isAbsolute(path) || !inside(root, path) && !systemLibrary(path))
      throw Error('Python LC_RPATH escapes packaged runtime');
    paths.push(path);
  }
  const linked = command('/usr/bin/otool', ['-L', file]).split('\n').slice(1)
    .map(line => line.trim().split(' (')[0]).filter(Boolean);
  const ownId = command('/usr/bin/otool', ['-D', file]).split('\n').slice(1).find(line => line.trim());
  for (const name of linked) {
    if (name === ownId?.trim()) continue;
    const candidates = name.startsWith('@rpath/') ? paths.map(path => join(path, name.slice(7))) : [expand(name)];
    if (!candidates.some(path => isAbsolute(path) && (systemLibrary(path) ||
      inside(root, path) && existsSync(path) && inside(root, realpathSync(path)))))
      throw Error('Python dynamic dependency is not in the package or system');
  }
}

/** Offline packaging only. The explicit input must match the fixed upstream asset. */
export async function preparePreviewPython(resourcesDir, {
  archive = process.env.SEQIVO_PREVIEW_PYTHON_ARCHIVE,
} = {}) {
  if (!archive) return { bundled: false, reason: 'fixed_python_archive_not_supplied' };
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('此固定预览 Python 资源只适用于 macOS arm64');
  if (!isAbsolute(archive) || !lstatSync(archive).isFile() || sha(readFileSync(archive)) !== SOURCE.sha256)
    throw Error('预览 Python 安装归档与固定官方摘要不匹配');
  const resources = realpathSync(resourcesDir), root = join(resources, 'preview-python');
  const staging = await mkdtemp(join(tmpdir(), 'seqivo-preview-python-'));
  try {
    const tar = join(staging, 'runtime.tar');
    let bytes = 0;
    const limit = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > 1024 * 1024 * 1024 ? Error('Python archive exceeds limit') : null, chunk);
    } });
    await pipeline(createReadStream(archive), createZstdDecompress(), limit,
      createWriteStream(tar, { flags: 'wx', mode: 0o600 }));
    const names = command('/usr/bin/tar', ['-tf', tar]).trim().split('\n');
    if (names.some(path => !path.startsWith('python/') || path.includes('\\') ||
        path.split('/').some(part => part === '..' || part === '.')))
      throw Error('Python archive contains invalid paths');
    command('/usr/bin/tar', ['-xf', tar, '-C', staging,
      'python/install', 'python/licenses', 'python/PYTHON.json']);
    const metadata = JSON.parse(readFileSync(join(staging, 'python/PYTHON.json'), 'utf8'));
    if (metadata.python_version !== SOURCE.version || metadata.target_triple !== SOURCE.target ||
        metadata.license_path !== 'licenses/LICENSE.cpython.txt') throw Error('Python metadata mismatch');
    const source = realpathSync(join(staging, 'python/install'));
    // Reject external symlinks before dereferencing. All runtime files become plain files.
    const visiting = new Set();
    function copyTree(directory, output, boundary = source) {
      const real = realpathSync(directory);
      if (!inside(boundary, real) || visiting.has(real)) throw Error('Python resource link escapes or cycles');
      visiting.add(real);
      mkdirSync(output);
      for (const entry of readdirSync(real, { withFileTypes: true })) {
        const file = join(real, entry.name), resolved = realpathSync(file), stat = lstatSync(resolved);
        if (!inside(boundary, resolved)) throw Error('Python resource link escapes');
        if (stat.isDirectory()) copyTree(file, join(output, entry.name), boundary);
        else if (!stat.isFile()) throw Error('Python resource is not a regular file');
        else writeFileSync(join(output, entry.name), readFileSync(resolved), { flag: 'wx', mode: stat.mode & 0o777 });
      }
      visiting.delete(real);
    }
    mkdirSync(root); // Do not replace a previously built runtime or its identities.
    copyTree(source, join(root, 'python'));
    const licenses = realpathSync(join(staging, 'python/licenses'));
    copyTree(licenses, join(root, 'licenses'), licenses);
    cpSync(join(staging, 'python/PYTHON.json'), join(root, 'PYTHON.json'));
    mkdirSync(join(root, 'bin'));
    const launcher = join(root, 'bin/seqivo-python');
    command('/usr/bin/xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-Werror',
      resolve(import.meta.dirname, 'preview-python-launcher.c'), '-o', launcher]);
    chmodSync(launcher, 0o755);
    const files = [];
    function collect(directory, prefix = '') {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        const file = join(directory, entry.name), stat = lstatSync(file);
        if (stat.isSymbolicLink()) throw Error('Packaged Python contains a symlink');
        if (stat.isDirectory()) { collect(file, name); continue; }
        if (!stat.isFile()) throw Error('Packaged Python contains a special file');
        const magic = readFileSync(file).subarray(0, 4).toString('hex');
        if (['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(magic)) {
          command('/usr/bin/codesign', ['--force', '--sign', '-', file], { stdio: ['ignore', 'pipe', 'pipe'] });
          command('/usr/bin/codesign', ['--verify', '--strict', file]);
          verifyMachOLinks(file, root);
        }
        const data = readFileSync(file);
        files.push({ path: name, size: data.length, sha256: sha(data) });
      }
    }
    collect(root);
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const body = { schema: 1, platform: process.platform, arch: process.arch,
      version: SOURCE.version, sourceRelease: SOURCE.release, sourceUrl: SOURCE.url,
      sourceSha256: SOURCE.sha256, launcher: 'bin/seqivo-python', files };
    const runtimeDigest = sha(JSON.stringify(body));
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ ...body, runtimeDigest }, null, 2), { flag: 'wx' });
    return { bundled: true, version: SOURCE.version, runtimeDigest, fileCount: files.length };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
