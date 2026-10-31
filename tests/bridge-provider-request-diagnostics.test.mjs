import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridgeDiagnostics, providerRequestDiagnostic } from '../plugins/codex-autocontinue/bridge-diagnostics.mjs';
import { createPlugin } from '../plugins/codex-autocontinue/host.mjs';

const taskId = 'original-task';
const threadId = 'original-thread';
const turnId = 'original-turn';
const commands = [
  { taskId, threadId, turnId, status: 'running' },
  { taskId: 'other-task', threadId: 'other-thread', turnId: 'other-turn', status: 'running' },
  { taskId, threadId, turnId: 'old-turn', status: 'completed' },
];

test('provider request categories are fixed and identity booleans require the same active command', () => {
  const known = new Map([
    ['item/commandExecution/requestApproval', 'command_approval'],
    ['item/fileChange/requestApproval', 'file_approval'],
    ['item/permissions/requestApproval', 'permissions_approval'],
    ['item/tool/requestUserInput', 'user_input'],
    ['mcpServer/elicitation/request', 'elicitation'],
  ]);
  for (const [method, category] of known) {
    assert.deepEqual(providerRequestDiagnostic(method, taskId, threadId, turnId, commands),
      { event: 'provider_request', category, taskMatched: true, threadMatched: true, turnMatched: true });
  }
  assert.deepEqual(providerRequestDiagnostic('private/token/requestApproval', taskId, threadId, turnId, commands),
    { event: 'provider_request', category: 'unknown', taskMatched: true, threadMatched: true, turnMatched: true });
  assert.deepEqual(providerRequestDiagnostic('item/commandExecution/requestApproval', taskId, threadId, 'old-turn', commands),
    { event: 'provider_request', category: 'command_approval', taskMatched: true, threadMatched: true, turnMatched: false });
  assert.deepEqual(providerRequestDiagnostic('item/commandExecution/requestApproval', taskId, 'other-thread', 'other-turn', commands),
    { event: 'provider_request', category: 'command_approval', taskMatched: true, threadMatched: false, turnMatched: false });
  assert.deepEqual(providerRequestDiagnostic('item/commandExecution/requestApproval', 'other-task', threadId, turnId, commands),
    { event: 'provider_request', category: 'command_approval', taskMatched: true, threadMatched: false, turnMatched: false });
  assert.deepEqual(providerRequestDiagnostic('item/commandExecution/requestApproval', null, threadId, turnId, commands),
    { event: 'provider_request', category: 'command_approval', taskMatched: false, threadMatched: false, turnMatched: false });
});

test('private provider-request log excludes raw method, ids, params and rotates within bound', t => {
  const root = mkdtempSync(join(tmpdir(), 'seqivo-provider-diagnostic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = createBridgeDiagnostics(root);
  const secret = 'credential-token-private';
  const diagnostic = providerRequestDiagnostic(`private/${secret}/requestApproval`, taskId, threadId, turnId, commands);
  writer.record({ ...diagnostic, method: `private/${secret}/requestApproval`, requestId: secret,
    params: { prompt: secret }, path: `/private/${secret}`, category: secret });
  const directory = join(root, 'diagnostics');
  const current = join(directory, 'bridge-lifecycle.jsonl');
  let source = readFileSync(current, 'utf8');
  assert.ok(!source.includes(secret) && !source.includes(taskId) && !source.includes(threadId) && !source.includes(turnId));
  assert.deepEqual(JSON.parse(source), {
    at: JSON.parse(source).at, event: 'provider_request', bridge: null, record: null,
    reason: null, method: null, timeoutMs: null, category: 'unknown',
    taskMatched: true, threadMatched: true, turnMatched: true,
  });
  for (let index = 0; index < 1200; index++) writer.record({ ...diagnostic, bridgeId: `bridge-${index}` });
  assert.deepEqual(readdirSync(directory).sort(), ['bridge-lifecycle.jsonl', 'bridge-lifecycle.jsonl.previous']);
  for (const name of readdirSync(directory)) {
    const row = statSync(join(directory, name));
    assert.ok(row.size <= 64 * 1024);
    assert.equal(row.mode & 0o077, 0);
  }
  const victim = join(root, 'victim');
  writeFileSync(victim, 'unchanged', { mode: 0o600 });
  rmSync(current);
  symlinkSync(victim, current);
  assert.doesNotThrow(() => writer.record(diagnostic));
  assert.equal(readFileSync(victim, 'utf8'), 'unchanged');
});

test('actual host approval event records fixed category before its existing first-stop event',
  { concurrency: false }, async t => {
    const pythonPath = process.env.TASKBOARD_TEST_PYTHON;
    if (!pythonPath) return t.skip('Set TASKBOARD_TEST_PYTHON to run the local protocol-only fixture');
    const dir = await realpath(mkdtempSync(join(tmpdir(), 'seqivo-provider-event-')));
    let complete = false;
    const envNames = ['TASKBOARD_FAKE_SCENARIO', 'TASKBOARD_FAKE_LOG', 'TASKBOARD_FAKE_PID',
      'TASKBOARD_FAKE_CWD', 'TASKBOARD_FAKE_APPROVAL_GATE'];
    const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
    const executable = join(dir, 'fake-codex.py');
    const gate = join(dir, 'approval-gate');
    const dataDir = join(dir, 'state');
    await copyFile(fileURLToPath(new URL('./plugin-fake-codex.py', import.meta.url)), executable);
    await chmod(executable, 0o700);
    await writeFile(join(dir, 'scenario.json'), JSON.stringify({ approval: true, approvalWithTurnId: true,
      approvalAfterGate: true }));
    await writeFile(join(dir, 'appserver.log'), '');
    Object.assign(process.env, {
      TASKBOARD_FAKE_SCENARIO: join(dir, 'scenario.json'), TASKBOARD_FAKE_LOG: join(dir, 'appserver.log'),
      TASKBOARD_FAKE_PID: join(dir, 'appserver.pid'), TASKBOARD_FAKE_CWD: dir,
      TASKBOARD_FAKE_APPROVAL_GATE: gate,
    });
    let task = { id: taskId, projectId: 'project-1', title: 'Fixture task', goal: 'Fixture only',
      conversationId: threadId, status: 'blocked', blockedReason: 'Quota', acceptance: 'unverified',
      revision: 1, contentVersion: 1 };
    const plugin = createPlugin({ taskJobBackend: null, dataDir,
      pluginDir: fileURLToPath(new URL('../plugins/codex-autocontinue/', import.meta.url)),
      getTask: async id => id === task.id ? task : null,
      getProject: async id => id === 'project-1' ? { id, directory: dir } : null,
      updateTask: async (id, patch, revision) => {
        assert.equal(id, task.id); assert.equal(revision, task.revision);
        task = { ...task, ...patch, revision: revision + 1 };
        return task;
      },
    });
    t.after(async () => {
      try { await plugin.close(); }
      finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
        if (complete) rmSync(dir, { recursive: true, force: true });
        else process.stderr.write('Retained failed local provider fixture in private temp directory\n');
      }
    });
    await plugin.configure({ pythonPath, codexPath: executable, pollSeconds: 86400 });
    await plugin.setPolicy({ taskId, enabled: true });
    await plugin.resume({ taskId, expectedRevision: 1, commandId: 'diagnostic-command' });
    await writeFile(gate, 'continue');
    const diagnosticPath = join(dataDir, 'diagnostics', 'bridge-lifecycle.jsonl');
    let rows=[];
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      try{rows=(await readFile(diagnosticPath,'utf8')).trim().split('\n').map(JSON.parse)}catch(error){
        if(error.code!=='ENOENT')throw error;
      }
      if(rows.some(row=>row.event==='first_stop'&&row.reason==='provider_approval'))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const requestAt=rows.findIndex(row=>row.event==='provider_request');
    const stopAt=rows.findIndex(row=>row.event==='first_stop'&&row.reason==='provider_approval');
    assert.ok(requestAt>=0 && stopAt>requestAt, 'handled request must be observed before original stop');
    assert.deepEqual({category:rows[requestAt].category,taskMatched:rows[requestAt].taskMatched,
      threadMatched:rows[requestAt].threadMatched,turnMatched:rows[requestAt].turnMatched},
    {category:'command_approval',taskMatched:true,threadMatched:true,turnMatched:true});
    const persisted=readFileSync(diagnosticPath,'utf8');
    assert.ok(!persisted.includes(taskId)&&!persisted.includes(threadId)&&
      !persisted.includes('fake-turn-1')&&!persisted.includes('diagnostic-command'));
    complete=true;
  });
