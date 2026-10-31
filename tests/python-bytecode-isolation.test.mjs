import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdtemp, mkdir, readlink, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlugin } from '../plugins/codex-autocontinue/host.mjs';
import { startupObservationForTest } from '../server/macos-executor-job.mjs';
import { prepareExecutorJob } from '../server/macos-executor-job.mjs';
import { readJobRecord, readRetiredJobRecord } from '../server/macos-executor-job-record.mjs';
import { prepareTaskJob, recoverTaskJob } from '../plugins/codex-autocontinue/job-transport.mjs';

const pluginSource = fileURLToPath(new URL('../plugins/codex-autocontinue/', import.meta.url));
const fakeSource = fileURLToPath(new URL('./plugin-fake-codex.py', import.meta.url));
const externalPython = (() => {
  const names = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
})();
const python = process.env.TASKBOARD_TEST_PYTHON || externalPython;

async function copyPlugin(root) {
  await mkdir(root, { recursive: true });
  await copyFile(join(pluginSource, 'bridge.py'), join(root, 'bridge.py'));
  await cp(join(pluginSource, 'vendor'), join(root, 'vendor'), {
    recursive: true,
    filter: path => !path.includes('__pycache__') && !path.endsWith('.pyc'),
  });
}

async function bytecodePaths(root) {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.pyc')) found.push(path);
    }
  }
  await walk(root);
  return found;
}

async function removeCopiedBytecode(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && entry.name === '__pycache__') await rm(path, { recursive: true });
    else if (entry.isDirectory()) await removeCopiedBytecode(path);
    else if (entry.name.endsWith('.pyc')) await rm(path);
  }
}

async function resourceTreeDigest(root) {
  const hash = createHash('sha256');
  let files = 0;
  async function walk(dir, relative = '') {
    const entries = (await readdir(dir, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const path = join(dir, entry.name), name = relative ? `${relative}/${entry.name}` : entry.name;
      const info = await lstat(path);
      if (entry.isDirectory()) {
        hash.update(`D\0${name}\0${info.mode & 0o777}\0`);
        await walk(path, name);
      } else if (entry.isSymbolicLink()) {
        hash.update(`L\0${name}\0${await readlink(path)}\0`);
      } else if (entry.isFile()) {
        const bytes = await readFile(path);
        hash.update(`F\0${name}\0${info.mode & 0o777}\0${bytes.length}\0`);
        hash.update(bytes);
        files++;
      } else throw new Error(`Unexpected packaged Python entry: ${name}`);
    }
  }
  await walk(root);
  return { digest: hash.digest('hex'), files };
}

test('real plugin bridge import cannot generate bytecode through the host launch path',
  { concurrency: false, timeout: 20000,
    skip: process.platform === 'win32' ? 'the fake Codex executable fixture is Unix-only'
      : process.platform !== 'darwin' && (!python || !externalPython)
        ? 'Python 3 control executable is unavailable on PATH' : false }, async () => {
    assert.ok(python, 'macOS bytecode regression requires a Python 3 executable');
    if (process.platform === 'darwin')
      assert.ok(externalPython, 'macOS bytecode regression requires an external control Python');
    const root = await mkdtemp(join(tmpdir(), 'seqivo-bytecode-'));
    const control = join(root, 'control'), managed = join(root, 'managed');
    const oldBytecode = process.env.PYTHONDONTWRITEBYTECODE;
    const oldPrefix = process.env.PYTHONPYCACHEPREFIX;
    const names = ['TASKBOARD_FAKE_SCENARIO', 'TASKBOARD_FAKE_LOG', 'TASKBOARD_FAKE_PID', 'TASKBOARD_FAKE_CWD'];
    const oldFake = Object.fromEntries(names.map(name => [name, process.env[name]]));
    let plugin;
    try {
      delete process.env.PYTHONDONTWRITEBYTECODE;
      delete process.env.PYTHONPYCACHEPREFIX;
      await copyPlugin(control);
      await copyPlugin(managed);
      if (!process.env.SEQIVO_TEST_PACKAGED_PYTHON_ROOT) {
        const direct = spawnSync(externalPython, [join(control, 'bridge.py')], {
          input: '{"id":1,"method":"close"}\n', encoding: 'utf8', timeout: 5000,
          env: { ...process.env },
        });
        assert.equal(direct.status, 0, direct.stderr);
        assert.ok((await bytecodePaths(control)).length >= 4,
          'control without -B must demonstrate that this actual import creates bytecode');
      } // The packaged-tree test below uses a disposable raw interpreter for its control.

      const fake = join(root, 'fake-codex.py');
      await copyFile(fakeSource, fake);
      await chmod(fake, 0o700);
      const scenario = join(root, 'scenario.json'), log = join(root, 'fake.log');
      await writeFile(scenario, '{}');
      await writeFile(log, '');
      process.env.TASKBOARD_FAKE_SCENARIO = scenario;
      process.env.TASKBOARD_FAKE_LOG = log;
      process.env.TASKBOARD_FAKE_PID = join(root, 'fake.pid');
      process.env.TASKBOARD_FAKE_CWD = root;
      plugin = createPlugin({ dataDir: join(root, 'state'), pluginDir: managed,
        taskJobBackend: null, getTask: async () => null, getProject: async () => null,
        updateTask: async () => { throw Error('not used'); } });
      await plugin.configure({ pythonPath: python, codexPath: fake, pollSeconds: 86400 });
      const result = await plugin.check();
      assert.equal(result.available, true);
      assert.match(await readFile(log, 'utf8'), /account\/rateLimits\/read/);
      await plugin.close();
      plugin = null;
      assert.deepEqual(await bytecodePaths(managed), [],
        'the real host bridge must leave its packaged plugin copy unchanged');
    } finally {
      if (plugin) await plugin.close().catch(() => {});
      for (const [name, value] of Object.entries({
        PYTHONDONTWRITEBYTECODE: oldBytecode, PYTHONPYCACHEPREFIX: oldPrefix, ...oldFake,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

test('packaged Python resource tree stays unchanged through bridge, Python fake provider and child',
  { concurrency: false, timeout: 120000,
    skip: !process.env.SEQIVO_TEST_PACKAGED_PYTHON_ROOT
      ? 'requires an explicit packaged Python resource root' : false }, async () => {
    const packagedRoot = process.env.SEQIVO_TEST_PACKAGED_PYTHON_ROOT;
    assert.ok(isAbsolute(packagedRoot), 'packaged Python root must be absolute');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-packaged-bytecode-')));
    const copied = join(root, 'preview-python'), managed = join(root, 'managed');
    const names = ['TASKBOARD_FAKE_SCENARIO', 'TASKBOARD_FAKE_LOG', 'TASKBOARD_FAKE_PID',
      'TASKBOARD_FAKE_CWD', 'TASKBOARD_FAKE_CHILD_SCRIPT'];
    const oldEnv = Object.fromEntries([...names, 'PYTHONDONTWRITEBYTECODE', 'PYTHONPYCACHEPREFIX']
      .map(name => [name, process.env[name]]));
    let plugin;
    try {
      await cp(packagedRoot, copied, { recursive: true,
        filter: path => !path.split(sep).includes('__pycache__') && !path.endsWith('.pyc') });
      const launcher = join(copied, 'bin', 'seqivo-python');
      const rawPython = join(copied, 'python', 'bin', 'python3.12');
      assert.ok(existsSync(launcher) && existsSync(rawPython));
      const copiedReal = await realpath(copied);
      for (const executable of [launcher, rawPython])
        assert.ok((await realpath(executable)).startsWith(`${copiedReal}${sep}`),
          'test executables must resolve inside the disposable copied tree');
      const controlEnv = { ...process.env };
      delete controlEnv.PYTHONDONTWRITEBYTECODE;
      delete controlEnv.PYTHONPYCACHEPREFIX;
      const direct = spawnSync(rawPython, ['-E', '-S', '-c', 'import json,subprocess'],
        { encoding: 'utf8', env: controlEnv, timeout: 10000 });
      assert.equal(direct.status, 0, direct.stderr);
      assert.ok((await bytecodePaths(copied)).length > 0,
        'unflagged raw copied interpreter must prove the test can detect stdlib bytecode');
      await removeCopiedBytecode(copied);
      assert.deepEqual(await bytecodePaths(copied), []);
      const before = await resourceTreeDigest(copied);
      await copyPlugin(managed);
      const fake = join(root, 'fake-codex.py'), child = join(root, 'fake-child.py');
      const childMarker = join(root, 'child-ran');
      await copyFile(fakeSource, fake);
      await chmod(fake, 0o700);
      await writeFile(child, `import json\nfrom pathlib import Path\nPath(${JSON.stringify(childMarker)}).write_text('ran')\n`);
      const scenario = join(root, 'scenario.json'), log = join(root, 'fake.log');
      await writeFile(scenario, JSON.stringify({ bytecodeChildOnInitialize: true }));
      await writeFile(log, '');
      delete process.env.PYTHONDONTWRITEBYTECODE;
      delete process.env.PYTHONPYCACHEPREFIX;
      process.env.TASKBOARD_FAKE_SCENARIO = scenario;
      process.env.TASKBOARD_FAKE_LOG = log;
      process.env.TASKBOARD_FAKE_PID = join(root, 'fake.pid');
      process.env.TASKBOARD_FAKE_CWD = root;
      process.env.TASKBOARD_FAKE_CHILD_SCRIPT = child;
      plugin = createPlugin({ dataDir: join(root, 'state'), pluginDir: managed,
        taskJobBackend: null, getTask: async () => null, getProject: async () => null,
        updateTask: async () => { throw Error('not used'); } });
      await plugin.configure({ pythonPath: launcher, codexPath: fake, pollSeconds: 86400 });
      const result = await plugin.check();
      assert.equal(result.available, true);
      assert.equal(await readFile(childMarker, 'utf8'), 'ran');
      assert.match(await readFile(log, 'utf8'), /account\/rateLimits\/read/);
      await plugin.close();
      plugin = null;
      assert.deepEqual(await resourceTreeDigest(copied), before,
        'the complete copied packaged Python tree, including stdlib, must remain byte-identical');
      assert.deepEqual(await bytecodePaths(managed), []);
    } finally {
      if (plugin) await plugin.close().catch(() => {});
      for (const [name, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

test('macOS executor identity helper invokes Python with bytecode disabled', async () => {
  const calls = [];
  const result = await startupObservationForTest(async (executable, args) => {
    calls.push({ executable, args });
    return { stdout: JSON.stringify({ verified: true, identity: { pid: 1 } }) };
  }, 'inspect');
  assert.equal(result.verified, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], '-B');
  assert.match(calls[0].args[1], /executor_job\.py$/);
  assert.deepEqual(calls[0].args.slice(2), ['inspect', '1']);
});

test('prepared macOS task job persists -B in launch config without changing record identity',
  { timeout: 20000, skip: process.platform !== 'darwin' ? 'macOS job backend only' : false }, async () => {
    assert.ok(python, 'macOS job regression requires a Python 3 executable');
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-bytecode-job-')));
    await chmod(dataDir, 0o700);
    const workspace = join(dataDir, 'workspace');
    await mkdir(workspace);
    const bridgePath = join(pluginSource, 'bridge.py');
    let prepared, legacy, complete = false;
    try {
      prepared = await prepareTaskJob({ dataDir, taskId: 'new-task', projectId: 'project',
        workspace, pythonPath: python, bridgePath, env: { PATH: '/usr/bin:/bin' } });
      const config = JSON.parse(await readFile(join(prepared.job.directory, 'launch.json'), 'utf8'));
      assert.equal(config.command, await realpath(python));
      assert.deepEqual(config.args, ['-B', bridgePath]);
      const original = await readJobRecord(prepared.recordRoot, prepared.recordId,
        'new-task', await realpath(workspace));
      assert.equal(original.phase, 'prepared');
      assert.equal(original.attempted, false);
      assert.equal(original.identity, null);
      assert.equal(JSON.stringify(original).includes(bridgePath), false,
        'durable authority record must remain independent of launch arguments');
      const sameOwner = await recoverTaskJob({ recordRoot: prepared.recordRoot,
        recordId: prepared.recordId, taskId: 'new-task', workspace, pythonPath: python });
      assert.equal(sameOwner.verified, false);
      assert.equal(sameOwner.reason, 'job_original_owner_still_alive',
        'a separate recovery handle must not adopt the live original owner');
      assert.deepEqual(await prepared.job.abandonPrepared(),
        { verified: true, retired: true, neverSubmitted: true });
      const retired = await readRetiredJobRecord(prepared.recordRoot, prepared.recordId,
        'new-task', await realpath(workspace));
      assert.equal(retired.phase, 'retired');
      assert.equal(retired.attempted, false);

      // A pre-change prepared record has the same schema and remains readable;
      // the bytecode flag belongs to the launch config, not the authority record.
      legacy = await prepareExecutorJob({ taskId: 'old-task', command: python,
        args: [bridgePath], cwd: workspace, env: { PATH: '/usr/bin:/bin' },
        pythonPath: python, recordRoot: prepared.recordRoot });
      const oldRecord = await readJobRecord(prepared.recordRoot, legacy.recordId,
        'old-task', await realpath(workspace));
      assert.equal(oldRecord.phase, 'prepared');
      assert.equal(oldRecord.attempted, false);
      assert.deepEqual(await legacy.abandonPrepared(),
        { verified: true, retired: true, neverSubmitted: true });
      assert.equal((await readRetiredJobRecord(prepared.recordRoot, legacy.recordId,
        'old-task', await realpath(workspace))).phase, 'retired');
      complete = true;
    } finally {
      if (complete) await rm(dataDir, { recursive: true, force: true });
    }
  });
