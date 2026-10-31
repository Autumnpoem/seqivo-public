import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const bridgePath = fileURLToPath(new URL('../plugins/codex-autocontinue/bridge.py', import.meta.url));
const pythonPath = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';

test('background-terminal bridge preserves scoped pagination and refuses false success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'taskboard-background-terminals-'));
  const fakePath = join(dir, 'fake-app-server.py');
  const logPath = join(dir, 'requests.jsonl');
  await writeFile(fakePath, `import json,sys
log_path=sys.argv[2] if len(sys.argv)>2 else ${JSON.stringify(logPath)}
for line in sys.stdin:
    request=json.loads(line)
    with open(log_path,'a',encoding='utf-8') as log: log.write(json.dumps(request)+'\\n')
    method=request.get('method')
    if method=='initialized': continue
    params=request.get('params') or {}
    if method=='initialize': result={}
    elif method=='thread/read': result={'thread':{'id':params['threadId'],'cwd':'/fixture','status':{'type':'idle'},'turns':[{'id':'turn-1','status':'interrupted','items':[{'id':'item-1','type':'commandExecution','processId':'pty-1'}]}]}}
    elif method=='thread/backgroundTerminals/list':
        if params.get('cursor')=='rpc-error':
            reply={'id':request['id'],'error':{'message':'list denied'}}
            sys.stdout.write(json.dumps(reply)+'\\n');sys.stdout.flush();continue
        if params.get('cursor')=='malformed': result={'data':[{'processId':'pty-1'}]}
        elif params.get('cursor')=='page-2': result={'data':[],'nextCursor':None}
        else: result={'data':[{'processId':'pty-1','itemId':'item-1','command':'python sleep','cwd':'/fixture','osPid':123}],'nextCursor':'page-2'}
    elif method=='thread/backgroundTerminals/terminate':
        if params['processId']=='rpc-error':
            reply={'id':request['id'],'error':{'message':'terminate denied'}}
            sys.stdout.write(json.dumps(reply)+'\\n');sys.stdout.flush();continue
        result={} if params['processId']=='malformed' else {'terminated':params['processId']=='pty-1'}
    else:
        reply={'id':request['id'],'error':{'message':'unexpected method '+str(method)}}
        sys.stdout.write(json.dumps(reply)+'\\n');sys.stdout.flush();continue
    sys.stdout.write(json.dumps({'id':request['id'],'result':result})+'\\n');sys.stdout.flush()
`);
  const bridge = spawn(pythonPath, [bridgePath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0;
  let stderr = '';
  bridge.stderr.on('data', bytes => { stderr += bytes.toString(); });
  createInterface({ input: bridge.stdout }).on('line', line => {
    const message = JSON.parse(line);
    const slot = pending.get(message.id);
    if (slot) { pending.delete(message.id); clearTimeout(slot.timer); slot.resolve(message); }
  });
  bridge.once('exit', (code, signal) => {
    for (const slot of pending.values()) { clearTimeout(slot.timer); slot.reject(new Error(`bridge exited ${code ?? signal}: ${stderr}`)); }
    pending.clear();
  });
  const request = (method, fields = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timed out: ${method}; ${stderr}`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    bridge.stdin.write(JSON.stringify({ id, method, ...fields }) + '\n');
  });
  try {
    const opened = (await request('open', { codexPath: fakePath })).result;
    assert.equal(opened.available, true);
    assert.ok(Number.isSafeInteger(opened.appServerPid) && opened.appServerPid > 1);
    const thread = await request('thread', { threadId: 'thread-1' });
    assert.equal(thread.result.thread.turns[0].items[0].processId, 'pty-1');
    const first = await request('listBackgroundTerminals', { threadId: 'thread-1', limit: 1, cursor: null });
    assert.deepEqual(first.result, { data: [{ processId: 'pty-1', itemId: 'item-1', command: 'python sleep', cwd: '/fixture', osPid: 123 }], nextCursor: 'page-2' });
    assert.deepEqual((await request('listBackgroundTerminals', { threadId: 'thread-1', cursor: first.result.nextCursor, limit: 1 })).result, { data: [], nextCursor: null });
    assert.deepEqual((await request('terminateBackgroundTerminal', { threadId: 'thread-1', processId: 'pty-1' })).result, { terminated: true });
    assert.deepEqual((await request('terminateBackgroundTerminal', { threadId: 'thread-1', processId: 'missing' })).result, { terminated: false });
    for (const [method, fields, expected] of [
      ['listBackgroundTerminals', { threadId: 'thread-1', cursor: 'rpc-error' }, /list denied/],
      ['listBackgroundTerminals', { threadId: 'thread-1', cursor: 'malformed' }, /malformed/],
      ['terminateBackgroundTerminal', { threadId: 'thread-1', processId: 'rpc-error' }, /terminate denied/],
      ['terminateBackgroundTerminal', { threadId: 'thread-1', processId: 'malformed' }, /malformed/],
      ['listBackgroundTerminals', { threadId: 'thread-1', limit: -1 }, /uint32/],
      ['terminateBackgroundTerminal', { threadId: 'thread-1', processId: '' }, /required/],
    ]) {
      const reply = await request(method, fields);
      assert.equal(reply.result, undefined);
      assert.match(reply.error.message, expected);
    }
    const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.find(call => call.method === 'initialize').params.capabilities.experimentalApi, true);
    assert.deepEqual(calls.filter(call => call.method === 'thread/backgroundTerminals/list').map(call => call.params), [
      { threadId: 'thread-1', limit: 1, cursor: null },
      { threadId: 'thread-1', cursor: 'page-2', limit: 1 },
      { threadId: 'thread-1', cursor: 'rpc-error' },
      { threadId: 'thread-1', cursor: 'malformed' },
    ]);
    assert.deepEqual(calls.filter(call => call.method === 'thread/backgroundTerminals/terminate').map(call => call.params), [
      { threadId: 'thread-1', processId: 'pty-1' },
      { threadId: 'thread-1', processId: 'missing' },
      { threadId: 'thread-1', processId: 'rpc-error' },
      { threadId: 'thread-1', processId: 'malformed' },
    ]);
    assert.deepEqual((await request('close')).result, true);
  } finally {
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
