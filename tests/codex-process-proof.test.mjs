import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { captureCommandProcesses, verifyCommandProcessesStopped } from '../server/codex-process-proof.mjs';

const python = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';
const macOnly = { skip: process.platform !== 'darwin', timeout: 90000 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(fn) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(30); }
  throw new Error('Fixture did not reach expected state');
}

async function fixture(t, { aName = 'A', bName = 'B' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'seqivo-command-proof-'));
  const a = join(dir, aName), b = join(dir, bName);
  await mkdir(a); await mkdir(b);
  const script = join(dir, 'worker.py'), serverScript = join(dir, 'server.py');
  await writeFile(script, `import json,os,subprocess,sys,time
if sys.argv[1]=='parent':
    child=subprocess.Popen([sys.executable,__file__,'grandchild'],cwd=sys.argv[2],start_new_session=True)
    with open(sys.argv[3],'w') as f: json.dump({'pid':child.pid},f)
time.sleep(120)
`);
  await writeFile(serverScript, `import json,os,subprocess,sys
children={}
for line in sys.stdin:
    request=json.loads(line)
    try:
        if request['method']=='spawn':
            argv=[sys.executable,${JSON.stringify(script)},*request.get('args',['plain'])]
            child=subprocess.Popen(argv,cwd=request['cwd'],start_new_session=request.get('separateSession',True),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            children[child.pid]=child
            result={'pid':child.pid,'command':' '.join(argv),'cwd':request['cwd']}
        elif request['method']=='stop':
            child=children.pop(request['pid']);child.terminate();child.wait(timeout=5);result=True
        elif request['method']=='close':
            for child in children.values():
                if child.poll() is None: child.terminate()
            for child in children.values(): child.wait(timeout=5)
            print(json.dumps({'id':request['id'],'result':True}),flush=True);break
        else: raise ValueError('unexpected method')
        print(json.dumps({'id':request['id'],'result':result}),flush=True)
    except Exception as e: print(json.dumps({'id':request['id'],'error':str(e)}),flush=True)
`);
  const server = spawn(python, [serverScript], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { server.once('spawn', resolve); server.once('error', reject); });
  const pending = new Map(); let nextId = 0;
  const lines = createInterface({ input: server.stdout });
  lines.on('line', line => {
    const reply = JSON.parse(line), slot = pending.get(reply.id);
    if (slot) { pending.delete(reply.id); clearTimeout(slot.timer); reply.error ? slot.reject(new Error(reply.error)) : slot.resolve(reply.result); }
  });
  server.stderr.resume();
  const request = (method, fields = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Fixture request timeout')); }, 7000);
    pending.set(id, { resolve, reject, timer }); server.stdin.write(JSON.stringify({ id, method, ...fields }) + '\n');
  });
  const orphans = new Set();
  t.after(async () => {
    for (const pid of orphans) if (alive(pid)) process.kill(pid, 'SIGTERM');
    if (server.exitCode === null && !server.signalCode) await request('close').catch(() => server.kill('SIGTERM'));
    server.stdin.end(); lines.close();
    if (server.exitCode === null && !server.signalCode) await new Promise(resolve => server.once('exit', resolve));
    for (const slot of pending.values()) { clearTimeout(slot.timer); slot.reject(new Error('fixture closed')); }
    await rm(dir, { recursive: true, force: true });
  });
  const capture = (terminals, options = {}) => captureCommandProcesses({ appServerPid: server.pid,
    bridgePid: process.pid, workspace: a, terminals, pythonPath: python, ...options });
  const terminal = (row, label = 'A') => ({ itemId: `item-${label}`, processId: `provider-${label}`,
    command: row.command, cwd: row.cwd, osPid: null });
  return { dir, a, b, server, request, capture, terminal, orphans };
}

test('process proof refuses unsupported platforms and invalid captures', async () => {
  assert.equal((await captureCommandProcesses({ platform: 'win32' })).verified, false);
  assert.equal((await verifyCommandProcessesStopped({ platform: 'linux' })).verified, false);
});

test('stopping A is proved with real OS processes while independent project B stays alive', macOnly, async t => {
  const f = await fixture(t);
  const a = await f.request('spawn', { cwd: f.a, args: ['private-marker'] });
  const b = await f.request('spawn', { cwd: f.b, args: ['private-marker'] });
  const capture = await f.capture([f.terminal(a)]);
  assert.equal(capture.verified, true, capture.reason);
  assert.equal(capture.version, 2);
  assert.deepEqual(capture.roots.map(row => row.pid), [a.pid]);
  for (const row of [...capture.infrastructure, ...capture.identities]) {
    assert.equal(row.euid, process.geteuid());
    assert.ok(Number.isSafeInteger(row.startSec) && row.startSec > 0);
    assert.ok(Number.isInteger(row.startUsec) && row.startUsec >= 0 && row.startUsec < 1000000);
  }
  assert.ok(!JSON.stringify(capture).includes('private-marker'), 'do not persist argv');
  assert.equal((await verifyCommandProcessesStopped({ capture, workspace: f.a, pythonPath: python })).stopped, false);
  await f.request('stop', { pid: a.pid });
  const result = await verifyCommandProcessesStopped({ capture, workspace: f.a, pythonPath: python });
  assert.equal(result.verified, true, result.reason);
  assert.equal(result.stopped, true, result.reason);
  assert.equal(alive(b.pid), true, 'other project was not stopped');
});

test('Unicode and literal escape cwd names are distinguished by filesystem identity', macOnly, async t => {
  const name = '中文 项目';
  const escaped = [...Buffer.from(name)].map(byte => byte >= 0x20 && byte < 0x7f
    ? String.fromCharCode(byte) : `\\x${byte.toString(16)}`).join('');
  const f = await fixture(t, { aName: name, bName: escaped });
  // lsof in C locale can print both directory names identically. argv is also
  // identical; only the actual device/inode can correlate the right cwd.
  const a = await f.request('spawn', { cwd: f.a, args: ['same-command'] });
  const b = await f.request('spawn', { cwd: f.b, args: ['same-command'] });
  const capture = await f.capture([f.terminal(a)]);
  assert.equal(capture.verified, true, capture.reason);
  assert.deepEqual(capture.roots.map(row => row.pid), [a.pid]);
  const literal = await f.capture([f.terminal(b)], { workspace: f.b });
  assert.equal(literal.verified, true, literal.reason);
  assert.deepEqual(literal.roots.map(row => row.pid), [b.pid]);
  await f.request('stop', { pid: a.pid });
  const stopped = await verifyCommandProcessesStopped({ capture, workspace: f.a, pythonPath: python });
  assert.equal(stopped.stopped, true, stopped.reason);
  assert.equal(alive(b.pid), true, 'similarly displayed cwd was not confused with A');
});

test('a captured child in a separate session remains a blocker after its parent exits', macOnly, async t => {
  const f = await fixture(t), marker = join(f.a, 'child.json');
  const parent = await f.request('spawn', { cwd: f.a, args: ['parent', f.b, marker] });
  const child = await waitFor(async () => { try { return JSON.parse(await readFile(marker, 'utf8')); } catch { return null; } });
  f.orphans.add(child.pid);
  const capture = await f.capture([f.terminal(parent)]);
  assert.equal(capture.verified, true, capture.reason);
  assert.ok(capture.identities.some(row => row.pid === child.pid));
  const parentIdentity = capture.identities.find(row => row.pid === parent.pid);
  const childIdentity = capture.identities.find(row => row.pid === child.pid);
  assert.notEqual(childIdentity.pgid, parentIdentity.pgid);
  await f.request('stop', { pid: parent.pid });
  const surviving = await verifyCommandProcessesStopped({ capture, workspace: f.a, pythonPath: python });
  assert.equal(surviving.verified, true, surviving.reason);
  assert.equal(surviving.stopped, false);
  assert.ok(surviving.liveIdentities.some(row => row.pid === child.pid));
  process.kill(child.pid, 'SIGTERM'); await waitFor(() => !alive(child.pid));
  assert.equal((await verifyCommandProcessesStopped({ capture, workspace: f.a, pythonPath: python })).stopped, true);
});

test('ambiguous commands, wrong ancestry, wrong osPid and unreadable inspection never prove ownership', macOnly, async t => {
  const f = await fixture(t);
  const a = await f.request('spawn', { cwd: f.a });
  const terminal = f.terminal(a);
  assert.equal((await f.capture([terminal], { bridgePid: f.server.pid })).verified, false);
  assert.equal((await f.capture([{ ...terminal, osPid: process.pid }])).verified, false);
  assert.equal((await f.capture([terminal], { lsofPath: '/does/not/exist' })).verified, false);
  assert.equal((await f.capture([terminal], { psPath: '/usr/bin/false' })).verified, false);
  assert.equal((await f.capture([terminal], { pythonPath: '/usr/bin/false' })).verified, false,
    'native identity collection is required, with no second-resolution fallback');
  const valid = await f.capture([terminal]); assert.equal(valid.verified, true, valid.reason);
  const changed = structuredClone(valid); changed.identities[0].startedAt = 'different-start';
  assert.equal((await verifyCommandProcessesStopped({ capture: changed, workspace: f.a, pythonPath: python })).verified, false);
  await f.request('spawn', { cwd: f.a });
  assert.equal((await f.capture([{ ...terminal, osPid: a.pid }])).verified, false, 'osPid must not disambiguate identical commands');
  const escaped = await f.request('spawn', { cwd: f.b, args: ['private-marker\nsecond-line'] });
  assert.equal((await f.capture([f.terminal(escaped)], { workspace: f.b })).verified, false,
    'macOS ps escapes newline argv; transformed commands must fail closed, not be guessed');
});

test('empty provider list is only a current baseline; real descendants and new external writers block it', macOnly, async t => {
  const f = await fixture(t);
  const b = await f.request('spawn', { cwd: f.b });
  const empty = await f.capture([]);
  assert.equal(empty.verified, true, empty.reason);
  assert.equal(empty.emptyBaseline, true);
  assert.equal((await verifyCommandProcessesStopped({ capture: empty, workspace: f.a, pythonPath: python })).stopped, true);
  const external = spawn('/bin/sleep', ['60'], { cwd: f.a, stdio: 'ignore' });
  await new Promise((resolve, reject) => { external.once('spawn', resolve); external.once('error', reject); });
  t.after(() => { if (alive(external.pid)) external.kill('SIGTERM'); });
  assert.equal((await f.capture([])).verified, false, 'external writer blocks empty capture');
  assert.equal((await verifyCommandProcessesStopped({ capture: empty, workspace: f.a, pythonPath: python })).stopped, false, 'new writer blocks final proof');
  external.kill('SIGTERM'); await new Promise(resolve => external.once('exit', resolve));
  await f.request('spawn', { cwd: f.a });
  assert.equal((await f.capture([])).verified, false, 'unlisted managed descendant blocks empty capture');
  assert.equal(alive(b.pid), true);
});

test('shared infrastructure groups and serialized or reduced captures cannot produce stop permission', macOnly, async t => {
  const f = await fixture(t);
  const shared = await f.request('spawn', { cwd: f.a, separateSession: false });
  const rejected = await f.capture([f.terminal(shared)]);
  assert.equal(rejected.verified, false);
  assert.match(rejected.reason, /infrastructure process group/);
  await f.request('stop', { pid: shared.pid });
  const a = await f.request('spawn', { cwd: f.a });
  const capture = await f.capture([f.terminal(a)]);
  assert.equal(capture.verified, true, capture.reason);
  assert.ok(Object.isFrozen(capture) && Object.isFrozen(capture.identities[0]));
  const reduced = { ...structuredClone(capture), roots: [], identities: [], groups: [], emptyBaseline: true };
  assert.equal((await verifyCommandProcessesStopped({ capture: reduced, workspace: f.a, pythonPath: python })).verified, false);
  assert.equal((await verifyCommandProcessesStopped({ capture: structuredClone(capture), workspace: f.a, pythonPath: python })).verified, false);
  assert.equal(alive(a.pid), true);
});
