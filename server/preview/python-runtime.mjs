import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const resources = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const digest = value => createHash('sha256').update(value).digest('hex');
const invalid = () => Object.assign(new Error('安装包中的预览执行环境不可用'), { code: 'BUILD_UNSUPPORTED' });
const relativePath = path => typeof path === 'string' && path.length > 0 &&
  !path.includes('\\') && !path.startsWith('/') &&
  path.split('/').every(part => part && part !== '.' && part !== '..');

/** Fixed module-relative resource only; never takes a project, PATH or RPC input. */
export function loadVerifiedPreviewPython() {
  try {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw invalid();
    const root = join(resources, 'preview-python');
    if (realpathSync(root) !== root) throw invalid();
    const path = join(root, 'manifest.json');
    if (!lstatSync(path).isFile() || realpathSync(path) !== path) throw invalid();
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const { runtimeDigest, ...body } = manifest;
    if (body.schema !== 1 || body.platform !== 'darwin' || body.arch !== 'arm64' ||
        body.version !== '3.12.15' || body.launcher !== 'bin/seqivo-python' ||
        body.sourceSha256 !== '8c7ac5f091c64111247e595c9fc8fecc38453e94a60323a3b66dbfca3c01414a' ||
        !Array.isArray(body.files) || body.files.length < 10 || body.files.length > 20000 ||
        runtimeDigest !== digest(JSON.stringify(body))) throw invalid();
    const expected = new Map();
    for (const row of body.files) {
      if (!relativePath(row.path) || expected.has(row.path) ||
          !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.size) || row.size < 0) throw invalid();
      const file = join(root, row.path), stat = lstatSync(file);
      if (!stat.isFile() || realpathSync(file) !== file || stat.size !== row.size ||
          digest(readFileSync(file)) !== row.sha256) throw invalid();
      expected.set(row.path, row);
    }
    // Extra source or binary files could influence module loading despite valid hashes.
    let count = 0;
    function walk(directory, prefix = '') {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++count > 30000) throw invalid();
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        const file = join(directory, entry.name), stat = lstatSync(file);
        if (stat.isSymbolicLink()) throw invalid();
        if (stat.isDirectory()) walk(file, name);
        else if (!stat.isFile() || name !== 'manifest.json' && !expected.has(name)) throw invalid();
      }
    }
    walk(root);
    if (!expected.has(body.launcher) || !expected.has('python/bin/python3.12') ||
        !body.files.some(row => row.path.startsWith('licenses/'))) throw invalid();
    const pythonPath = join(root, body.launcher);
    accessSync(pythonPath, constants.X_OK);
    accessSync(join(root, 'python/bin/python3.12'), constants.X_OK);
    return { pythonPath, runtimeDigest };
  } catch { throw invalid(); }
}
