import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// The Python process only imports bridge.py and uses in-memory fake queues and
// transport. It never constructs AppServer or starts Codex/app-server.
const python = String.raw`
import importlib.util, json, queue, sys, threading, types
from unittest.mock import patch

sys.path.insert(0, 'plugins/codex-autocontinue')
spec = importlib.util.spec_from_file_location('tested_bridge', 'plugins/codex-autocontinue/bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class Clock:
    def __init__(self): self.value = 100.0
    def now(self): return self.value
    def advance(self, seconds): self.value += seconds

class Input:
    def __init__(self, server, clock, steps):
        self.server, self.clock, self.steps = server, clock, list(steps)
        self.sent = []
        self.flush_seconds = 0
    def write(self, text):
        request = json.loads(text)
        self.sent.append(request['method'])
        step = self.steps.pop(0)
        expected, seconds, response = step[:3]
        self.flush_seconds = step[3] if len(step) == 4 else 0
        assert request['method'] == expected, (request['method'], expected)
        self.clock.advance(seconds)
        self.server.responses[request['id']].put_nowait(response)
    def flush(self):
        self.clock.advance(self.flush_seconds)
        self.flush_seconds = 0

def server(clock, steps, *, paginated=True, timeout=8.0):
    app = bridge.AppServer.__new__(bridge.AppServer)
    app.timeout, app.lock, app.next_id = timeout, threading.Lock(), 0
    app.responses, app.created_empty, app.paginated_history = {}, set(), paginated
    input_stream = Input(app, clock, steps)
    app.proc = types.SimpleNamespace(stdin=input_stream)
    return app, input_stream

def response(result): return {'result': result}
def page(ids, cursor): return response({'data': [{'id': i} for i in ids], 'nextCursor': cursor})

clock = Clock()
with patch.object(bridge.time, 'monotonic', clock.now):
    app, stream = server(clock, [
        ('thread/read', 3, response({'thread': {'id': 't', 'status': {'type': 'idle'}}})),
        ('thread/turns/list', 3, page(['old1'], 'c2')),
        ('thread/turns/list', 3, page(['old2'], 'c3')),
        ('thread/turns/list', 1, page(['target'], None)),
    ])
    try: app.read_thread('t', ['target'])
    except bridge.ThreadReadTimeout as error: assert str(error) == 'Codex thread observation timed out'
    else: raise AssertionError('cumulative slow pages exceeded one read budget')
    assert stream.sent == ['thread/read', 'thread/turns/list', 'thread/turns/list'], stream.sent
    assert not app.responses

    clock = Clock()
    app, stream = server(clock, [
        ('thread/read', 4, {'error': {'message': 'includeTurns not supported'}}),
        ('thread/read', 3, response({'thread': {'id': 't', 'status': {'type': 'idle'}}})),
        ('thread/turns/list', 2, page(['target'], None)),
    ], paginated=False)
    with patch.object(bridge.time, 'monotonic', clock.now):
        try: app.read_thread('t', ['target'])
        except bridge.ThreadReadTimeout as error: assert str(error) == 'Codex thread observation timed out'
        else: raise AssertionError('includeTurns fallback got a fresh budget')
    assert stream.sent == ['thread/read', 'thread/read', 'thread/turns/list']
    assert not app.responses

    clock = Clock()
    app, stream = server(clock, [
        ('thread/read', .25, response({'thread': {'id': 't', 'status': {'type': 'idle'}, 'turns': []}})),
        ('account/rateLimits/read', .25, response({'ready': True})),
    ], paginated=False)
    with patch.object(bridge.time, 'monotonic', clock.now):
        assert app.read_thread('t')['thread']['turns'] == []
        clock.advance(30)
        assert app.rpc('account/rateLimits/read') == {'ready': True}
    assert stream.sent == ['thread/read', 'account/rateLimits/read']

    # The queue wait must be calculated AFTER a synchronous write/flush, not
    # from the remaining budget observed before those calls.
    clock = Clock()
    app, stream = server(clock, [
        ('thread/read', 1, response({'thread': {'id': 't', 'turns': []}}), 2),
    ], paginated=False, timeout=20)
    waits = []
    original_queue = bridge.queue.Queue
    class RecordingQueue(original_queue):
        def get(self, timeout=None):
            waits.append(timeout)
            return super().get(timeout=timeout)
    with patch.object(bridge.time, 'monotonic', clock.now), patch.object(bridge.queue, 'Queue', RecordingQueue):
        assert app.read_thread('t')['thread']['turns'] == []
    assert waits == [5.0], waits  # cap8 - write1 - flush2

    clock = Clock()
    app, stream = server(clock, [
        ('thread/read', 1, response({'thread': {'id': 't', 'turns': []}}), 7),
    ], paginated=False, timeout=20)
    waits.clear()
    with patch.object(bridge.time, 'monotonic', clock.now), patch.object(bridge.queue, 'Queue', RecordingQueue):
        try: app.read_thread('t')
        except bridge.ThreadReadTimeout: pass
        else: raise AssertionError('flush reached the deadline')
    assert waits == [], waits
    assert stream.sent == ['thread/read']
    assert not app.responses

    clock = Clock()
    app, stream = server(clock, [
        ('account/rateLimits/read', 1, response({'ready': True}), 2),
    ], timeout=20)
    waits.clear()
    with patch.object(bridge.time, 'monotonic', clock.now), patch.object(bridge.queue, 'Queue', RecordingQueue):
        assert app.rpc('account/rateLimits/read') == {'ready': True}
    assert waits == [20], waits  # no read-only deadline on other RPCs

    clock = Clock()
    app, stream = server(clock, [
        ('thread/read', .25, response({'thread': {'id': 'new', 'status': {'type': 'idle'}}})),
    ])
    app.created_empty.add('new')
    with patch.object(bridge.time, 'monotonic', clock.now):
        assert app.read_thread('new')['thread']['turns'] == []
    assert stream.sent == ['thread/read']

    # A timed-out response queue is removed. Late data for its old request ID
    # cannot become the next request's result.
    clock = Clock()
    app, stream = server(clock, [('thread/read', 0, response({'ok': 'next'}))])
    class ImmediateEmpty:
        def __init__(self, maxsize=1): self.items = []
        def put_nowait(self, item): self.items.append(item)
        def get(self, timeout=None):
            if self.items: return self.items.pop(0)
            raise queue.Empty()
    old_queue = bridge.queue.Queue
    bridge.queue.Queue = ImmediateEmpty
    try:
        # First request intentionally has no reply. Its transport write is
        # suppressed only in this fake; rpc's pending/finally path is real.
        original_write = stream.write
        expired_targets = []
        def no_reply(text):
            request = json.loads(text)
            stream.sent.append(request['method'])
            expired_targets.append(app.responses[request['id']])
        stream.write = no_reply
        with patch.object(bridge.time, 'monotonic', clock.now):
            try: app.rpc('thread/read', {'threadId': 't'}, deadline=clock.now()+8)
            except bridge.ThreadReadTimeout: pass
            else: raise AssertionError('first request should time out')
            assert not app.responses
            expired_targets[0].put_nowait(response({'ok': 'late'}))
            stream.write = original_write
            assert app.rpc('thread/read', {'threadId': 't'}) == {'ok': 'next'}
            assert app.next_id == 2
            sent_before = list(stream.sent)
            try: app.rpc('thread/read', {'threadId': 't'}, deadline=clock.now())
            except bridge.ThreadReadTimeout as error: assert str(error) == 'Codex thread observation timed out'
            else: raise AssertionError('expired read was sent')
            assert stream.sent == sent_before
            assert not app.responses
    finally: bridge.queue.Queue = old_queue

print(json.dumps({'scenarios': 8, 'appServerSpawned': False}))
`;

test('bridge read_thread has one bounded observation budget', () => {
  const result = spawnSync(process.env.TASKBOARD_TEST_PYTHON || 'python3', ['-c', python], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), { scenarios: 8, appServerSpawned: false });
});
