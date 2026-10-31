import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync,
  readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const OTOOL = '/usr/bin/otool';
const INSTALL_NAME_TOOL = '/usr/bin/install_name_tool';
const CODESIGN = '/usr/bin/codesign';

function checkedFile(path, label, executable = false) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Error(`${label} must be an absolute path`);
  const real = realpathSync(path);
  if (!statSync(real).isFile()) throw Error(`${label} is not a file`);
  if (executable) accessSync(real, constants.X_OK);
  return real;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, ...options }).trim();
}

function linkedNames(path, dylib = false) {
  const lines = run(OTOOL, ['-L', path]).split('\n').slice(1);
  const names = lines.map(line => {
    const match = line.match(/^\s+(.+?) \((?:compatibility|current) version /);
    if (!match) throw Error(`Unrecognized Mach-O dependency: ${line}`);
    return match[1];
  });
  return dylib ? names.slice(1) : names;
}

function rpaths(path) {
  const lines = run(OTOOL, ['-l', path]).split('\n');
  const paths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== 'cmd LC_RPATH') continue;
    for (let next = index + 1; next < Math.min(index + 8, lines.length); next += 1) {
      const match = lines[next].match(/^\s+path (.+) \(offset \d+\)$/);
      if (match) { paths.push(match[1]); break; }
    }
  }
  return paths;
}

function resolveToken(token, loader, executable) {
  if (token.startsWith('@loader_path/')) return resolve(dirname(loader), token.slice('@loader_path/'.length));
  if (token.startsWith('@executable_path/')) return resolve(dirname(executable), token.slice('@executable_path/'.length));
  return token;
}

function dependencyPath(name, loader, executable) {
  if (isAbsolute(name)) return name;
  if (name.startsWith('@loader_path/') || name.startsWith('@executable_path/')) {
    return resolveToken(name, loader, executable);
  }
  if (name.startsWith('@rpath/')) {
    const relativeName = name.slice('@rpath/'.length);
    for (const entry of rpaths(loader)) {
      const base = resolveToken(entry, loader, executable);
      if (!isAbsolute(base)) continue;
      const candidate = join(base, relativeName);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw Error(`Cannot resolve Mach-O dependency ${name} from ${basename(loader)}`);
}

function systemLibrary(path) {
  return path.startsWith('/usr/lib/') || path.startsWith('/System/Library/');
}

function libraryLicense(name, licenses) {
  if (licenses[name]) return licenses[name];
  if (name.startsWith('libutf8proc.')) return licenses.utf8proc ?? process.env.SEQIVO_UTF8PROC_LICENSE;
  if (name.startsWith('libjemalloc.')) return licenses.jemalloc ?? process.env.SEQIVO_JEMALLOC_LICENSE;
  return undefined;
}

/**
 * Copy an explicitly configured macOS tmux runtime into generated app resources.
 * No configured input means an honest unbundled capability. A configured but
 * incomplete input fails the build instead of producing a broken runtime.
 */
export async function prepareTerminalRuntime(resourcesDir, {
  executable = process.env.SEQIVO_TMUX_BIN,
  licenses = {},
} = {}) {
  if (process.platform !== 'darwin') return { bundled: false, reason: 'UNSUPPORTED_PLATFORM' };
  if (!executable) return { bundled: false, reason: 'NOT_CONFIGURED' };
  if (typeof resourcesDir !== 'string' || !isAbsolute(resourcesDir)) {
    throw Error('resourcesDir must be an absolute path');
  }
  const source = checkedFile(executable, 'tmux executable', true);
  const libraryBySource = new Map();
  const libraryByName = new Map();
  const queue = [{ source, dylib: false }];
  const seen = new Set();
  const dependencies = new Map();
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current.source)) continue;
    seen.add(current.source);
    const edges = [];
    for (const name of linkedNames(current.source, current.dylib)) {
      const path = dependencyPath(name, current.source, source);
      if (systemLibrary(path)) continue;
      const real = checkedFile(path, `dependency ${name}`);
      const fileName = basename(real);
      if (!/^[A-Za-z0-9_.-]+\.dylib$/.test(fileName)) throw Error(`Unsupported dylib filename: ${fileName}`);
      const conflict = libraryByName.get(fileName);
      if (conflict && conflict !== real) throw Error(`Conflicting dylib names: ${fileName}`);
      libraryByName.set(fileName, real);
      libraryBySource.set(real, fileName);
      edges.push({ original: name, source: real });
      queue.push({ source: real, dylib: true });
    }
    dependencies.set(current.source, edges);
  }
  const names = [...libraryByName.keys()].sort();
  if (!names.some(name => name.startsWith('libutf8proc.')) || !names.some(name => name.startsWith('libjemalloc.'))) {
    throw Error('macOS tmux bundle requires utf8proc and jemalloc dependencies');
  }
  const licenseInputs = new Map([['tmux', licenses.tmux ?? process.env.SEQIVO_TMUX_LICENSE]]);
  // libevent may be linked statically, so it is not discoverable via otool.
  licenseInputs.set('libevent', licenses.libevent ?? process.env.SEQIVO_LIBEVENT_LICENSE);
  for (const name of names) licenseInputs.set(name, libraryLicense(name, licenses));
  for (const [name, path] of licenseInputs) {
    if (!path) throw Error(`Missing license path for ${name}`);
    checkedFile(path, `${name} license`);
  }

  mkdirSync(resourcesDir, { recursive: true });
  const stage = join(resourcesDir, `terminal-stage-${randomUUID()}`);
  const destination = join(resourcesDir, 'terminal');
  const stageBin = join(stage, 'bin', 'tmux');
  try {
    mkdirSync(join(stage, 'bin'), { recursive: true });
    mkdirSync(join(stage, 'lib'), { recursive: true });
    mkdirSync(join(stage, 'licenses'), { recursive: true });
    copyFileSync(source, stageBin);
    chmodSync(stageBin, 0o755);
    for (const [name, path] of libraryByName) {
      const target = join(stage, 'lib', name);
      copyFileSync(path, target);
      chmodSync(target, 0o755);
      run(INSTALL_NAME_TOOL, ['-id', `@loader_path/${name}`, target]);
    }
    for (const [origin, edges] of dependencies) {
      const target = origin === source ? stageBin : join(stage, 'lib', libraryBySource.get(origin));
      for (const edge of edges) {
        const name = libraryBySource.get(edge.source);
        const local = origin === source ? `@loader_path/../lib/${name}` : `@loader_path/${name}`;
        run(INSTALL_NAME_TOOL, ['-change', edge.original, local, target]);
      }
    }
    for (const name of names) run(CODESIGN, ['--force', '--sign', '-', '--timestamp=none', join(stage, 'lib', name)]);
    run(CODESIGN, ['--force', '--sign', '-', '--timestamp=none', stageBin]);
    for (const path of [stageBin, ...names.map(name => join(stage, 'lib', name))]) {
      run(CODESIGN, ['--verify', '--strict', path]);
      for (const name of linkedNames(path, path !== stageBin)) {
        if (isAbsolute(name) && !systemLibrary(name)) throw Error(`Non-system absolute dependency remains in ${basename(path)}`);
      }
    }
    const cleanEnv = { ...process.env };
    delete cleanEnv.DYLD_LIBRARY_PATH;
    delete cleanEnv.DYLD_FALLBACK_LIBRARY_PATH;
    delete cleanEnv.DYLD_INSERT_LIBRARIES;
    const version = run(stageBin, ['-V'], { env: cleanEnv });
    if (!/^tmux \d/.test(version)) throw Error('Bundled tmux version check failed');
    const licenseFiles = [];
    for (const [name, path] of licenseInputs) {
      const label = name === 'tmux' ? 'tmux-COPYING.txt' : `${name}-LICENSE.txt`;
      const content = readFileSync(path);
      if (content.length < 100) throw Error(`License appears incomplete: ${name}`);
      writeFileSync(join(stage, 'licenses', label), content);
      licenseFiles.push(label);
    }
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify({
      bundled: true, platform: 'darwin', architecture: process.arch, version,
      libraries: names, licenses: licenseFiles,
    }, null, 2));
    rmSync(destination, { recursive: true, force: true });
    renameSync(stage, destination);
    return { bundled: true, path: join(destination, 'bin', 'tmux'), version, libraries: names };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
