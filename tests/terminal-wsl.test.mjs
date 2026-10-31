import test from 'node:test';
import assert from 'node:assert/strict';
import { createWslSupport } from '../server/terminal/wsl.mjs';

const executable = 'C:\\Windows\\System32\\wsl.exe';

function fakeWsl() {
  const calls = [];
  const targets = new Map([
    ['Ubuntu 24.04', { user: 'alice', uid: '1000', sessions: [] }],
    ['Debian', { user: 'bob', uid: '1001', sessions: [] }],
  ]);
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, executable);
    if (args[0] === '--list') {
      assert.deepEqual(args, ['--list', '--quiet']);
      return { stdout: Buffer.from('\uFEFFUbuntu 24.04\r\nDebian\r\n', 'utf16le'), stderr: Buffer.alloc(0) };
    }
    assert.equal(args[0], '--distribution');
    const target = targets.get(args[1]);
    if (!target) throw Object.assign(new Error('Distribution unavailable'), { stderr: 'Distribution unavailable' });
    const execAt = args.indexOf('--exec');
    assert.ok(execAt > 1);
    const userAt = args.indexOf('--user');
    if (userAt !== -1) assert.equal(args[userAt + 1], target.user);
    const argv = args.slice(execAt + 1);
    if (argv[0] === 'id' && argv[1] === '-un') return { stdout: `${target.user}\n`, stderr: '' };
    if (argv[0] === 'id' && argv[1] === '-u') return { stdout: `${target.uid}\n`, stderr: '' };
    if (argv[0] === 'test' && argv[1] === '-d') {
      if (!argv[2].startsWith('/existing/')) throw Object.assign(new Error('missing'), { stderr: 'missing' });
      return { stdout: '', stderr: '' };
    }
    if (argv[0] === 'tmux' && argv[1] === '-V') return { stdout: 'tmux 3.4\n', stderr: '' };
    assert.deepEqual(argv.slice(0, 4), ['tmux', '-u', '-L', 'shared']);
    const tmux = argv.slice(4);
    if (tmux[0] === 'list-sessions') {
      if (!target.sessions.length) throw Object.assign(new Error('no server running'), { stderr: 'no server running' });
      return { stdout: target.sessions.map((name, i) => `219\t1710000000\t/tmp/tmux-1000/shared\t$${i}\t${name}\t1\t0\n`).join(''), stderr: '' };
    }
    if (tmux[0] === 'new-session') {
      target.sessions.push(tmux[tmux.indexOf('-s') + 1]);
      return { stdout: `$${target.sessions.length - 1}\n`, stderr: '' };
    }
    throw new Error(`Unexpected fake WSL command: ${argv[0]}`);
  };
  return { calls, targets, run };
}

test('discovery decodes UTF-16LE distribution names and does not run on non-Windows', async () => {
  const fake = fakeWsl();
  const support = createWslSupport({ platform: 'win32', executable, run: fake.run });
  assert.deepEqual(await support.discover(), {
    supported: true, available: true, distributions: ['Ubuntu 24.04', 'Debian'],
  });
  assert.equal(fake.calls[0].options.encoding, 'buffer');
  assert.deepEqual(await createWslSupport({ platform: 'darwin', executable, run: fake.run }).discover(), {
    supported: false, available: false, distributions: [], reason: 'WSL requires Windows',
  });
  assert.equal(fake.calls.length, 1);
});

test('discovery decodes a UTF-16LE distribution name starting with non-ASCII text', async () => {
  const support = createWslSupport({ platform: 'win32', executable,
    run: async () => ({ stdout: Buffer.from('中文发行版\r\n', 'utf16le'), stderr: Buffer.alloc(0) }) });
  assert.deepEqual((await support.discover()).distributions, ['中文发行版']);
});

test('configure pins default Linux user and UID, and verifies the selected absolute directory', async () => {
  const fake = fakeWsl();
  const support = createWslSupport({ platform: 'win32', executable, run: fake.run });
  assert.deepEqual(await support.configure({ distro: 'Ubuntu 24.04', cwd: '/existing/project with spaces' }), {
    distro: 'Ubuntu 24.04', user: 'alice', uid: 1000, cwd: '/existing/project with spaces',
  });
  assert.ok(fake.calls.some(call => call.args.join('|') === '--distribution|Ubuntu 24.04|--user|alice|--exec|test|-d|/existing/project with spaces'));
  await assert.rejects(support.configure({ distro: 'Other', cwd: '/existing/x' }), { code: 'DISTRO_UNAVAILABLE' });
  await assert.rejects(support.configure({ distro: 'Debian', cwd: 'C:\\Users\\me' }), { code: 'INVALID_CWD' });
  await assert.rejects(support.configure({ distro: 'Debian', cwd: '/missing/x' }), { code: 'DISTRO_UNAVAILABLE' });
  fake.targets.get('Debian').uid = '9007199254740992';
  await assert.rejects(support.configure({ distro: 'Debian', cwd: '/existing/d' }), { code: 'PROTOCOL_ERROR' });
  assert.throws(() => support.adapter({ serverName: 'shared', wsl: {
    distro: 'Debian', user: 'bob', uid: -1, cwd: '/existing/d',
  } }), { code: 'INVALID_PROFILE' });
});

test('WSL create and attach use argv, configured Linux cwd, and no host process PID', async () => {
  const fake = fakeWsl();
  const support = createWslSupport({ platform: 'win32', executable, run: fake.run });
  const wsl = await support.configure({ distro: 'Ubuntu 24.04', cwd: '/existing/a b; echo danger' });
  const adapter = support.adapter({ serverName: 'shared', wsl });
  assert.deepEqual(await adapter.inspect(), {
    available: true, version: 'tmux 3.4', serverName: 'shared', instanceId: null, serverPid: null,
  });
  const created = await adapter.create({ name: 'first', cwd: 'C:\\ignored' });
  const createCall = fake.calls.find(call => call.args.includes('new-session'));
  assert.deepEqual(createCall.args, ['--distribution', 'Ubuntu 24.04', '--user', 'alice', '--exec',
    'tmux', '-u', '-L', 'shared', 'new-session', '-d', '-s', 'first', '-c', '/existing/a b; echo danger', '-P', '-F', '#{session_id}']);
  assert.equal(createCall.args.some(arg => arg.includes('C:\\ignored')), false);
  assert.match(created.sessionRef.instanceId, /^[a-f0-9]{64}$/);
  const target = await adapter.attachTarget({ sessionRef: created.sessionRef, readOnly: true });
  assert.equal(target.command, executable);
  assert.deepEqual(target.args, ['--distribution', 'Ubuntu 24.04', '--user', 'alice', '--exec',
    'tmux', '-u', '-L', 'shared', 'attach-session', '-r', '-t', '$0']);
  assert.throws(() => adapter.sessionsPanes([created.sessionRef]), { code: 'CAPABILITY_UNAVAILABLE' });
});

test('same tmux server identity cannot cross distro or changed Linux UID', async () => {
  const fake = fakeWsl();
  const support = createWslSupport({ platform: 'win32', executable, run: fake.run });
  const ubuntu = support.adapter({ serverName: 'shared', wsl: await support.configure({ distro: 'Ubuntu 24.04', cwd: '/existing/u' }) });
  const debian = support.adapter({ serverName: 'shared', wsl: await support.configure({ distro: 'Debian', cwd: '/existing/d' }) });
  const original = (await ubuntu.create({ name: 'same' })).sessionRef;
  const other = (await debian.create({ name: 'same' })).sessionRef;
  assert.notEqual(original.instanceId, other.instanceId);
  await assert.rejects(debian.attachTarget({ sessionRef: original }), { code: 'STALE_SERVER' });
  fake.targets.get('Ubuntu 24.04').uid = '2000';
  assert.match((await ubuntu.list()).reason, /identity changed/);
  assert.equal((await ubuntu.inspect()).available, false);
  await assert.rejects(ubuntu.attachTarget({ sessionRef: original }), { code: 'STALE_SERVER' });
});

test('inspect reports unavailable when its subsequent list sees a changed Linux UID', async () => {
  let identityChecks = 0;
  const run = async (_command, args) => {
    const argv = args.slice(args.indexOf('--exec') + 1);
    if (argv.join(' ') === 'id -u') return { stdout: `${++identityChecks === 1 ? 1000 : 2000}\n`, stderr: '' };
    if (argv.join(' ') === 'tmux -V') return { stdout: 'tmux 3.4\n', stderr: '' };
    throw new Error('Session listing must not run after identity changed');
  };
  const support = createWslSupport({ platform: 'win32', executable, run });
  const adapter = support.adapter({ serverName: 'shared', wsl: {
    distro: 'Ubuntu 24.04', user: 'alice', uid: 1000, cwd: '/existing/x',
  } });
  const inspection = await adapter.inspect();
  assert.equal(identityChecks, 2);
  assert.equal(inspection.available, false);
  assert.match(inspection.reason, /identity changed/);
});

test('missing WSL and tmux report unavailable without a host tmux fallback', async () => {
  const absent = createWslSupport({ platform: 'win32', env: { SystemRoot: 'C:\\missing' } });
  assert.deepEqual(await absent.discover(), {
    supported: true, available: false, distributions: [], reason: 'WSL executable is unavailable',
  });
  const fake = fakeWsl();
  const run = async (command, args, options) => {
    if (args.at(-2) === 'tmux' && args.at(-1) === '-V') throw Object.assign(new Error('missing tmux'), { stderr: 'missing tmux' });
    return fake.run(command, args, options);
  };
  const support = createWslSupport({ platform: 'win32', executable, run });
  const adapter = support.adapter({ serverName: 'shared', wsl: await support.configure({ distro: 'Debian', cwd: '/existing/d' }) });
  assert.equal((await adapter.inspect()).available, false);
  assert.deepEqual((await adapter.list()).sessions, []);
  await assert.rejects(adapter.create({ name: 'new' }), { code: 'CAPABILITY_UNAVAILABLE' });
});
