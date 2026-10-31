import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw Error('Usage: node scripts/verify-packaged-preview-python.mjs <resources-dir>');
const resources = resolve(process.argv[2]);
const { loadVerifiedPreviewPython } = await import(pathToFileURL(join(resources, 'server/preview/python-runtime.mjs')));
const { pythonPath, runtimeDigest } = loadVerifiedPreviewPython();
const temp = await mkdtemp(join(tmpdir(), 'seqivo-preview-python-probe-'));
try {
  const poison = join(temp, 'poison'), marker = join(temp, 'site-executed');
  await mkdir(poison);
  await writeFile(join(poison, 'sitecustomize.py'), `open(${JSON.stringify(marker)}, 'w').write('unexpected')\n`);
  const env = { ...process.env, PYTHONHOME: poison, PYTHONPATH: poison, PYTHONSTARTUP: join(poison, 'sitecustomize.py'),
    PYTHONUSERBASE: poison, PATH: '/usr/bin:/bin' };
  const output = execFileSync(pythonPath, ['-c',
    'import ctypes,json,os,pathlib,socket,stat,struct,sys;print(json.dumps({"version":list(sys.version_info[:3]),"ignore_env":sys.flags.ignore_environment,"no_site":sys.flags.no_site,"no_bytecode":sys.dont_write_bytecode,"python_env":any(k.startswith("PYTHON") for k in os.environ)}))'],
  { cwd: temp, env, encoding: 'utf8', timeout: 15000 });
  const observed = JSON.parse(output);
  assert.deepEqual(observed.version, [3, 12, 15]);
  assert.equal(observed.ignore_env, 1); assert.equal(observed.no_site, 1);
  assert.equal(observed.no_bytecode, true); assert.equal(observed.python_env, false);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const identity = JSON.parse(execFileSync(pythonPath,
    [join(resources, 'plugins/codex-autocontinue/executor_job.py'), 'inspect', String(process.pid)],
    { cwd: temp, env, encoding: 'utf8', timeout: 15000 }));
  assert.equal(identity.verified, true, 'packaged Python imports the original adjacent process snapshot helper');
  assert.equal(loadVerifiedPreviewPython().runtimeDigest, runtimeDigest, 'no bytecode or other runtime mutation');
  console.log(JSON.stringify({ passed: true, runtimeDigest, checks: [
    'module-relative resources outside checkout cwd', 'fixed Python version', 'PYTHON environment ignored',
    'site initialization disabled', 'no bytecode writes', 'native process identity helper', 'resource tree unchanged',
  ] }));
} finally { await rm(temp, { recursive: true, force: true }); }
