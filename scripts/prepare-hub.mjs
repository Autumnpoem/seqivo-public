import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, chmod, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT_PACKAGES = ['ws', 'ssh2'];
const OMIT_PACKAGE_DIRS = new Set(['test', 'tests', 'fixture', 'fixtures', 'example', 'examples', 'benchmark', 'benchmarks', 'native', 'build']);
const RUNTIME_CONDITIONS = new Set(['import', 'require', 'node', 'default']);
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;
const COMMIT = /^[a-f0-9]{40}$/;
const FORBIDDEN_SOURCE_PARTS = new Set(['test', 'tests', '__tests__', 'fixture', 'fixtures', 'keys', 'native']);
const FORBIDDEN_SOURCE_FILE = /(?:^|[/\\])\.env(?:\..*)?$|(?:\.srl|\.pem|\.key|\.p12|\.pfx|\.sqlite|\.db|\.token|\.env|\.node|\.so|\.dylib)$/i;

const inside = (root, path) => path === root || (!relative(root, path).startsWith('..' + sep) && relative(root, path) !== '..' && !isAbsolute(relative(root, path)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function existingDirectory(path, label) {
  const actual = await realpath(resolve(path));
  if (!(await lstat(actual)).isDirectory()) throw new Error(`${label} must be a directory`);
  return actual;
}

async function safeNewOutput(outputDir, inputRoots) {
  if (!outputDir) throw new Error('--output is required');
  const requested = resolve(outputDir);
  const parent = await existingDirectory(dirname(requested), 'output parent');
  const output = join(parent, basename(requested));
  if (inputRoots.some(root => inside(root, output) || inside(output, root))) throw new Error('Output overlaps an input directory');
  try { await lstat(requested); throw new Error('Output already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (requested !== output) {
    try { await lstat(output); throw new Error('Output already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(output, { mode: 0o700 });
  return output;
}

async function copyRegular(from, to) {
  const info = await lstat(from);
  if (!info.isFile()) throw new Error('Input must be a regular file');
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  await copyFile(from, to);
  await chmod(to, 0o600);
}

async function copyTree(from, to, filter = () => true) {
  const info = await lstat(from);
  if (!info.isDirectory()) throw new Error('Input must be a directory');
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name.startsWith('._')) continue;
    const source = join(from, entry.name);
    if (!filter(source, entry)) continue;
    if (entry.isDirectory()) await copyTree(source, join(to, entry.name), filter);
    else if (entry.isFile()) await copyRegular(source, join(to, entry.name));
    else throw new Error('Input contains a symlink or special file');
  }
}

function runtimeTargets(value, targets = new Set(), kind = 'condition') {
  if (typeof value === 'string') { targets.add(value); return targets; }
  if (value == null) return targets;
  if (Array.isArray(value)) { for (const entry of value) runtimeTargets(entry, targets, kind); return targets; }
  if (!value || typeof value !== 'object') throw new Error('Unsupported package target');
  for (const [key, entry] of Object.entries(value)) {
    if (kind === 'exports-root' && key.startsWith('.')) {
      if (key.includes('*')) throw new Error('Wildcard package exports are unsupported');
      runtimeTargets(entry, targets);
    } else if (kind === 'imports-root' && key.startsWith('#')) {
      if (key.includes('*')) throw new Error('Wildcard package imports are unsupported');
      runtimeTargets(entry, targets);
    } else if (RUNTIME_CONDITIONS.has(key)) runtimeTargets(entry, targets);
    else if (kind === 'condition' && key.startsWith('.')) throw new Error('Unexpected package subpath');
  }
  return targets;
}

async function dependencyClosure(modulesDir) {
  const requireFrom = createRequire(join(modulesDir, '__package_probe__.cjs'));
  const packages = new Map();
  const packagePath = (name, resolver) => {
    try { return resolver.resolve(`${name}/package.json`); }
    catch {
      let dir = dirname(resolver.resolve(name));
      while (inside(modulesDir, dir)) {
        const candidate = join(dir, 'package.json');
        try { return resolver.resolve(candidate); } catch { dir = dirname(dir); }
      }
      throw new Error(`Cannot locate dependency metadata: ${name}`);
    }
  };
  const visit = async (name, resolver) => {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw new Error('Invalid dependency name');
    const pkgPath = await realpath(packagePath(name, resolver));
    if (!inside(modulesDir, pkgPath)) throw new Error(`Dependency escapes modules directory: ${name}`);
    const pkgDir = dirname(pkgPath);
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    if (pkg.name !== name || typeof pkg.version !== 'string') throw new Error(`Invalid dependency package: ${name}`);
    if (packages.has(name)) {
      if (packages.get(name).pkg.version !== pkg.version) throw new Error(`Conflicting dependency versions: ${name}`);
      return;
    }
    packages.set(name, { pkgDir, pkgPath, pkg });
    const childResolver = createRequire(pkgPath);
    for (const dependency of Object.keys(pkg.dependencies ?? {}).sort()) await visit(dependency, childResolver);
  };
  for (const name of ROOT_PACKAGES) await visit(name, requireFrom);
  return packages;
}

async function copyRuntimePackage(output, name, { pkgDir, pkgPath, pkg }) {
  const destination = join(output, 'node_modules', name);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await copyRegular(pkgPath, join(destination, 'package.json'));
  const copyTarget = async target => {
    if (target.startsWith('node:')) return;
    if (!target.startsWith('./') || target.includes('*')) throw new Error(`Unsupported package target in ${name}`);
    const source = resolve(pkgDir, target);
    if (!inside(pkgDir, source) || source === pkgDir) throw new Error(`Package target escapes ${name}`);
    const rel = relative(pkgDir, source);
    if (rel.split(sep).some(part => OMIT_PACKAGE_DIRS.has(part.toLowerCase()))) throw new Error(`Package target is excluded in ${name}`);
    if (FORBIDDEN_SOURCE_FILE.test(rel)) throw new Error(`Non-JavaScript package target in ${name}`);
    const info = await lstat(source);
    if (!info.isFile()) throw new Error(`Package target must be a regular file in ${name}`);
    await copyRegular(source, join(destination, rel));
  };
  await copyTarget(`./${String(pkg.main ?? 'index.js').replace(/^\.\//, '')}`);
  for (const entry of await readdir(pkgDir, { withFileTypes: true })) {
    if (entry.isFile() && LICENSE_FILE.test(entry.name)) await copyRegular(join(pkgDir, entry.name), join(destination, entry.name));
  }
  const lib = join(pkgDir, 'lib');
  try {
    if ((await lstat(lib)).isDirectory()) await copyTree(lib, join(destination, 'lib'), (path, entry) => {
      if (entry.isSymbolicLink()) throw new Error(`Package lib contains a symlink in ${name}`);
      if (entry.isDirectory()) return !OMIT_PACKAGE_DIRS.has(entry.name.toLowerCase());
      return /\.(?:cjs|mjs|js|json)$/.test(entry.name);
    });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const target of runtimeTargets(pkg.exports, new Set(), 'exports-root')) await copyTarget(target);
  for (const target of runtimeTargets(pkg.imports, new Set(), 'imports-root')) {
    if (target.startsWith('./') || target.startsWith('node:')) await copyTarget(target);
    else {
      const external = target.startsWith('@') ? target.split('/').slice(0, 2).join('/') : target.split('/')[0];
      if (!(external in (pkg.dependencies ?? {}))) throw new Error(`Undeclared package import in ${name}`);
    }
  }
}

async function manifestFiles(output) {
  const files = {};
  const collect = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) files[relative(output, path).split(sep).join('/')] = sha256(await readFile(path));
      else throw new Error('Output contains a symlink or special file');
    }
  };
  await collect(output);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export async function prepareHub({ sourceDir = process.cwd(), distDir, modulesDir, outputDir, sourceCommit } = {}) {
  if (!COMMIT.test(sourceCommit ?? '')) throw new Error('--source-commit must be a 40-character Git commit');
  const source = await existingDirectory(sourceDir, 'source');
  const dist = await existingDirectory(distDir ?? join(source, 'dist'), 'dist');
  const modules = await existingDirectory(modulesDir ?? join(source, 'node_modules'), 'modules');
  const output = await safeNewOutput(outputDir, [source, dist, modules]);
  const publicRuntimeOnly = (path, entry) => {
    if (entry.name.startsWith('.') || FORBIDDEN_SOURCE_PARTS.has(entry.name.toLowerCase()) || (entry.isFile() && FORBIDDEN_SOURCE_FILE.test(entry.name))) {
      throw new Error('Source contains a forbidden runtime path');
    }
    return true;
  };
  await copyTree(join(source, 'server'), join(output, 'server'), publicRuntimeOnly);
  await copyTree(dist, join(output, 'dist'), publicRuntimeOnly);
  await copyRegular(join(source, 'scripts', 'hub-backup.mjs'), join(output, 'scripts', 'hub-backup.mjs'));
  await writeFile(join(output, 'package.json'), `${JSON.stringify({ name: 'seqivo-hub-runtime', private: true, type: 'module' }, null, 2)}\n`, { mode: 0o600 });
  const packages = await dependencyClosure(modules);
  for (const [name, pkg] of packages) await copyRuntimePackage(output, name, pkg);
  const files = await manifestFiles(output);
  const release = {
    format: 'seqivo-hub-release', version: 1, commit: sourceCommit,
    files,
    dependencies: Object.fromEntries([...packages].map(([name, { pkg }]) => [name, pkg.version]).sort(([a], [b]) => a.localeCompare(b))),
  };
  await writeFile(join(output, 'seqivo-release.json'), `${JSON.stringify(release, null, 2)}\n`, { mode: 0o600 });
  return { output, fileCount: Object.keys(files).length + 1, release };
}

function parseArguments(args) {
  const allowed = new Set(['source-dir', 'dist-dir', 'modules-dir', 'output', 'source-commit']);
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !allowed.has(key) || key in values || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Expected unique --source-dir/--dist-dir/--modules-dir/--output/--source-commit value pairs');
    values[key] = args[i + 1];
  }
  return { sourceDir: values['source-dir'], distDir: values['dist-dir'], modulesDir: values['modules-dir'], outputDir: values.output, sourceCommit: values['source-commit'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await prepareHub(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ output: result.output, fileCount: result.fileCount, commit: result.release.commit })}\n`);
  } catch (error) {
    process.stderr.write(`prepare-hub: ${error.message}\n`);
    process.exitCode = 1;
  }
}
