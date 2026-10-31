import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlugin as createClaude } from '../plugins/claude-code/host.mjs';
import { createPlugin as createCursor } from '../plugins/cursor-agent/host.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'taskboard-adapters-'));
  const projectDir = join(root, 'project');
  await mkdir(projectDir);
  const project = { id: 'p1', directory: projectDir };
  const task = { id: 't1', projectId: 'p1', title: 'Fixture', goal: 'Complete fake work', summary: '', criteria: [{ text: 'Done' }],
    conversationId: '', status: 'planned', acceptance: 'unverified', revision: 1, contentVersion: 1 };
  const context = { dataDir: join(root, 'state'), getTask: async id => id === task.id ? structuredClone(task) : null,
    getProject: async id => id === project.id ? structuredClone(project) : null,
    updateTask: async (id, patch, revision) => {
      assert.equal(id, task.id); assert.equal(revision, task.revision);
      const oldStatus = task.status;
      Object.assign(task, patch); task.revision++;
      if (patch.conversationId || (patch.status && patch.status !== oldStatus && patch.status === 'running')) task.contentVersion++;
      return structuredClone(task);
    } };
  return { root, project, task, context, close: () => rm(root, { recursive: true, force: true }) };
}

async function fakeClaude(root, mode) {
  const path = join(root, `fake-claude-${mode}.mjs`);
  await writeFile(path, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(root, `started-claude-${mode}`))}, 'started');
const args = process.argv.slice(2);
const at = args.indexOf('--session-id') >= 0 ? args.indexOf('--session-id') : args.indexOf('--resume');
const id = args[at + 1];
if (!args.includes('-p') || !args.includes('--output-format') || args[args.indexOf('--output-format') + 1] !== 'stream-json') process.exit(3);
if (${JSON.stringify(mode)} === 'readonly' && (!args.includes('--tools') || !args.includes('--disallowedTools'))) process.exit(5);
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (${JSON.stringify(mode)} === 'auth') { out({type:'result',is_error:true,result:'Authentication required'}); process.exit(1); }
out({type:'system',subtype:'init',session_id:id});
if (${JSON.stringify(mode)} === 'hang') { process.on('SIGINT', () => process.exit(130)); setInterval(() => {}, 1000); }
else {
  setTimeout(() => {
    if (${JSON.stringify(mode)} === 'permission') out({type:'system',subtype:'permission_denied'});
    out({type:'result',is_error:false,result:'Finished',permission_denials:${JSON.stringify(mode)} === 'permission' ? [{}] : []});
    process.exit(0);
  }, 80);
}
`);
  return path;
}

async function fakeCursor(root, mode) {
  const path = join(root, `fake-cursor-${mode}.mjs`);
  await writeFile(path, `
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const rl = readline.createInterface({input:process.stdin});
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let promptId;
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method) appendFileSync(${JSON.stringify(join(root, `cursor-rpc-${mode}.log`))}, m.method + '\\n');
  if (m.method === 'initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}});
  else if (m.method === 'authenticate') {
    if (${JSON.stringify(mode)} === 'auth') send({jsonrpc:'2.0',id:m.id,error:{message:'Login required'}});
    else send({jsonrpc:'2.0',id:m.id,result:{}});
  }
  else if (m.method === 'session/new') send({jsonrpc:'2.0',id:m.id,result:{sessionId:'owned-cursor-session'}});
  else if (m.method === 'session/load') send({jsonrpc:'2.0',id:m.id,result:{sessionId:m.params.sessionId}});
  else if (m.method === 'session/set_mode') {
    if (${JSON.stringify(mode)} === 'no-readonly') send({jsonrpc:'2.0',id:m.id,error:{message:'Unsupported mode'}});
    else send({jsonrpc:'2.0',id:m.id,result:{modeId:m.params.modeId}});
  }
  else if (m.method === 'session/prompt') {
    promptId = m.id;
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{text:'Started'}}}});
    if (${JSON.stringify(mode)} === 'permission') send({jsonrpc:'2.0',id:99,method:'session/request_permission',params:{sessionId:m.params.sessionId,options:[{optionId:'reject-once',kind:'reject-once'}]}});
    else if (${JSON.stringify(mode)} !== 'hang') setTimeout(() => send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}}), 80);
  }
  else if (m.id === 99) { if (m.result?.outcome?.optionId !== 'reject-once') process.exit(4); send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}}); }
  else if (m.method === 'session/cancel') send({jsonrpc:'2.0',id:promptId,result:{stopReason:'cancelled'}});
});
`);
  return path;
}

async function until(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Timed out waiting for adapter state');
}

test('Claude owned session starts only on resume and submits after confirmed result', async () => {
  const x = await fixture();
  const path = await fakeClaude(x.root, 'success');
  const plugin = await createClaude(x.context);
  try {
    await plugin.configure({ executablePath: path, maxBudgetUsd: 1 }); await plugin.enable();
    const session = await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
    assert.equal(session.status, 'created'); assert.equal(session.materialized, false);
    assert.equal(x.task.status, 'planned');
    const result = await plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'go1' });
    assert.ok(['running', 'completed'].includes(result.status));
    await until(() => x.task.status === 'submitted');
    assert.equal(x.task.acceptance, 'unverified');
    assert.equal(plugin.state().commands[0].status, 'completed');
    assert.equal((await plugin.resume({ taskId: 't1', expectedRevision: result.revision, commandId: 'go1' })).status, 'completed');
    assert.equal(plugin.getExecution({ taskId: 't1', commandId: 'go1' }).status, 'completed');
    await assert.rejects(plugin.resume({ taskId: 't1', expectedRevision: result.revision, commandId: 'go1', instructions: 'Different' }), /different request/);
    await assert.rejects(plugin.resume({ taskId: 't1', expectedRevision: result.revision, commandId: 'go1', role: 'reviewer' }), /different request/);
  } finally { await plugin.close(); await x.close(); }
});

test('Claude final revalidation rejects after reservation without starting provider', async () => {
  const x = await fixture();
  const path = await fakeClaude(x.root, 'success');
  const calls = [], reviews = [];
  const plugin = await createClaude({ ...x.context,
    authorizeExecution: async input => { calls.push(`authorize:${input.commandId}`); return { maySend: true }; },
    revalidateExecution: async input => { calls.push(`revalidate:${input.commandId}`); reviews.push(input); return false; },
  });
  try {
    await plugin.configure({ executablePath: path }); await plugin.enable();
    await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new-final' });
    const result = await plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'denied-final' });
    assert.equal(result.status, 'not_started');
    assert.deepEqual(calls, ['authorize:denied-final', 'revalidate:denied-final']);
    assert.deepEqual(reviews, [{taskId:'t1',commandId:'denied-final',expectedRevision:x.task.revision,expectedConversationId:x.task.conversationId,expectedDirectory:await realpath(x.project.directory)}]);
    assert.equal(await readFile(join(x.root, 'started-claude-success'), 'utf8').catch(() => ''), '');
  } finally { await plugin.close(); await x.close(); }
});

test('Cursor final revalidation blocks session/new and session/prompt', async () => {
  const x = await fixture();
  const path = await fakeCursor(x.root, 'success');
  let denySession = true;
  const calls = [], reviews = [];
  const plugin = await createCursor({ ...x.context,
    authorizeExecution: async input => { calls.push(`authorize:${input.commandId}`); return { maySend: true }; },
    revalidateExecution: async input => { calls.push(`revalidate:${input.commandId}`); reviews.push(input); return denySession ? false : input.commandId !== 'denied-prompt'; },
  });
  try {
    await plugin.configure({ executablePath: path }); await plugin.enable();
    const denied = await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'denied-session' });
    assert.equal(denied.status, 'not_started');
    assert.deepEqual(reviews[0], {taskId:'t1',commandId:'denied-session',expectedRevision:1,expectedConversationId:null,expectedDirectory:await realpath(x.project.directory)});
    let rpc = await readFile(join(x.root, 'cursor-rpc-success.log'), 'utf8');
    assert.equal(rpc.includes('session/new'), false);
    denySession = false;
    const session = await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'allowed-session' });
    assert.equal(session.status, 'created');
    const result = await plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'denied-prompt' });
    assert.equal(result.status, 'not_started');
    assert.deepEqual(calls.slice(-2), ['authorize:denied-prompt', 'revalidate:denied-prompt']);
    assert.deepEqual(reviews.at(-1), {taskId:'t1',commandId:'denied-prompt',expectedRevision:x.task.revision,expectedConversationId:x.task.conversationId,expectedDirectory:await realpath(x.project.directory)});
    rpc = await readFile(join(x.root, 'cursor-rpc-success.log'), 'utf8');
    assert.equal(rpc.includes('session/prompt'), false);
  } finally { await plugin.close(); await x.close(); }
});

test('Claude pause confirms owned process exit; different command payload is rejected', async () => {
  const x = await fixture();
  const path = await fakeClaude(x.root, 'hang');
  const plugin = await createClaude(x.context);
  try {
    await plugin.configure({ executablePath: path }); await plugin.enable();
    await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
    await plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'go1' });
    await assert.rejects(plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'go2' }), /Prior command/);
    const paused = await plugin.pause({ taskId: 't1', expectedRevision: x.task.revision });
    assert.equal(paused.status, 'paused'); assert.equal(x.task.status, 'paused');
  } finally { await plugin.close(); await x.close(); }
});

test('Claude auth failure blocks without claimed start, and foreign binding is rejected', async () => {
  const x = await fixture();
  const path = await fakeClaude(x.root, 'auth');
  const plugin = await createClaude(x.context);
  try {
    await plugin.configure({ executablePath: path }); await plugin.enable();
    await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
    const result = await plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'go1' });
    assert.equal(result.status, 'awaiting_approval'); assert.equal(x.task.status, 'blocked');
    assert.deepEqual({ status: plugin.getExecution({ taskId: 't1', commandId: 'go1' }).status,
      reason: plugin.getExecution({ taskId: 't1', commandId: 'go1' }).reason }, { status: 'not_started', reason: 'awaiting_approval' });
    x.task.conversationId = 'external-session'; x.task.revision++;
    await assert.rejects(plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'go2' }), /owned session/);
  } finally { await plugin.close(); await x.close(); }
});

test('Cursor ACP authenticates, creates owned session, and submits only after end_turn', async () => {
  const x = await fixture();
  const path = await fakeCursor(x.root, 'success');
  const plugin = await createCursor(x.context);
  try {
    await plugin.configure({ executablePath: path, model: 'test-model' }); await plugin.enable();
    const session = await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
    assert.equal(session.sessionId, 'owned-cursor-session'); assert.equal(x.task.status, 'planned');
    const result = await plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'go1' });
    assert.ok(['running', 'completed'].includes(result.status));
    await until(() => x.task.status === 'submitted');
    assert.equal(x.task.acceptance, 'unverified');
  } finally { await plugin.close(); await x.close(); }
});

test('Cursor rejects permission requests and reports blocked, not success', async () => {
  const x = await fixture();
  const path = await fakeCursor(x.root, 'permission');
  const plugin = await createCursor(x.context);
  try {
    await plugin.configure({ executablePath: path }); await plugin.enable();
    await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
    await plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'go1' });
    await until(() => x.task.status === 'blocked');
    assert.equal(plugin.state().commands[0].status, 'awaiting_approval');
    assert.deepEqual({ status: plugin.getExecution({ taskId: 't1', commandId: 'go1' }).status,
      reason: plugin.getExecution({ taskId: 't1', commandId: 'go1' }).reason }, { status: 'paused', reason: 'awaiting_approval' });
  } finally { await plugin.close(); await x.close(); }
});

test('Cursor cancel requires owned live prompt and confirmed cancelled response', async () => {
  const x = await fixture();
  const path = await fakeCursor(x.root, 'hang');
  const plugin = await createCursor(x.context);
  try {
    await plugin.configure({ executablePath: path }); await plugin.enable();
    await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
    await plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'go1' });
    const paused = await plugin.pause({ taskId: 't1', expectedRevision: x.task.revision });
    assert.equal(paused.status, 'paused'); assert.equal(x.task.status, 'paused');
  } finally { await plugin.close(); await x.close(); }
});

test('Claude evidence-only turn restricts tools and keeps per-turn model separate', async () => {
  const x = await fixture();
  const path = await fakeClaude(x.root, 'readonly');
  const plugin = await createClaude(x.context);
  try {
    await plugin.configure({ executablePath: path, model: 'configured' }); await plugin.enable();
    await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
    const run = await plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'review1', instructions: 'Inspect tests', model: 'per-turn', evidenceOnly: true });
    assert.ok(['running', 'completed'].includes(run.status));
    await until(() => plugin.getExecution({ taskId: 't1', commandId: 'review1' }).status === 'completed');
    assert.equal(plugin.state().config.model, 'configured');
  } finally { await plugin.close(); await x.close(); }
});

test('Cursor evidence-only turn refuses to prompt when read-only mode is unsupported', async () => {
  const x = await fixture();
  const path = await fakeCursor(x.root, 'no-readonly');
  const plugin = await createCursor(x.context);
  try {
    await plugin.configure({ executablePath: path }); await plugin.enable();
    await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
    const run = await plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'review1', evidenceOnly: true });
    assert.equal(run.status, 'not_started'); assert.equal(x.task.status, 'planned');
    assert.equal(plugin.getExecution({ taskId: 't1', commandId: 'review1' }).status, 'not_started');
  } finally { await plugin.close(); await x.close(); }
});

test('Cursor auth failure does not create a task binding', async () => {
  const x = await fixture();
  const path = await fakeCursor(x.root, 'auth');
  const plugin = await createCursor(x.context);
  try {
    await plugin.configure({ executablePath: path }); await plugin.enable();
    const session = await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
    assert.equal(session.status, 'awaiting_approval'); assert.equal(x.task.conversationId, '');
  } finally { await plugin.close(); await x.close(); }
});

test('sending journal becomes unknown on restart and is not resent', async () => {
  const x = await fixture();
  const path = await fakeClaude(x.root, 'success');
  let plugin = await createClaude(x.context);
  try {
    await plugin.configure({ executablePath: path }); await plugin.enable();
    await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
    await plugin.close();
    const statePath = join(x.context.dataDir, 'sessions.json');
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    saved.commands.go1 = { taskId: 't1', commandId: 'go1', sessionId: saved.sessions.t1.sessionId, cwd: saved.sessions.t1.cwd,
      revision: x.task.revision, contentVersion: x.task.contentVersion, digest: 'pre-send', status: 'sending' };
    await writeFile(statePath, JSON.stringify(saved));
    plugin = await createClaude(x.context);
    assert.equal(plugin.state().commands[0].status, 'unknown');
    await assert.rejects(plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'go2' }), /Prior command/);
    assert.equal((await plugin.reconcile({ taskId: 't1', expectedRevision: x.task.revision })).status, 'unknown');
    assert.equal((await plugin.reconcile({ taskId: 't1', expectedRevision: x.task.revision, confirmStopped: true })).status, 'reconciled');
  } finally { await plugin.close(); await x.close(); }
});

test('Cursor refuses an owned session after its project directory changes', async () => {
  const x = await fixture();
  const path = await fakeCursor(x.root, 'success');
  const plugin = await createCursor(x.context);
  try {
    await plugin.configure({ executablePath: path }); await plugin.enable();
    await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
    const other = join(x.root, 'other-project'); await mkdir(other);
    x.project.directory = other;
    await assert.rejects(plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'go1' }), /owned session/);
    assert.equal(plugin.state().commands.length, 0);
  } finally { await plugin.close(); await x.close(); }
});

test('Cursor persisted sending command becomes unknown after adapter restart', async () => {
  const x = await fixture();
  const path = await fakeCursor(x.root, 'success');
  let plugin = await createCursor(x.context);
  try {
    await plugin.configure({ executablePath: path }); await plugin.enable();
    await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
    await plugin.close();
    const statePath = join(x.context.dataDir, 'sessions.json');
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    saved.commands.go1 = { taskId: 't1', commandId: 'go1', sessionId: saved.sessions.t1.sessionId, cwd: saved.sessions.t1.cwd,
      revision: x.task.revision, contentVersion: x.task.contentVersion, digest: 'pre-send', status: 'sending' };
    await writeFile(statePath, JSON.stringify(saved));
    plugin = await createCursor(x.context);
    assert.equal(plugin.getExecution({ taskId: 't1', commandId: 'go1' }).status, 'unknown');
    await assert.rejects(plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'go2' }), /Prior command/);
  } finally { await plugin.close(); await x.close(); }
});

for (const [provider, factory, fake] of [['Claude', createClaude, fakeClaude], ['Cursor', createCursor, fakeCursor]]) {
  test(`${provider} records the command before execution authorization and does not send when denied`, async () => {
    const x = await fixture();
    const path = await fake(x.root, 'success');
    let checked = false;
    x.context.authorizeExecution = async ({ taskId, commandId }) => {
      assert.equal(taskId, 't1'); assert.equal(commandId, 'go1');
      const recorded = JSON.parse(await readFile(join(x.context.dataDir, 'sessions.json'), 'utf8'));
      assert.equal(recorded.commands.go1.status, 'sending');
      checked = true;
      return { maySend: false };
    };
    const plugin = await factory(x.context);
    try {
      assert.equal(plugin.getExecution({ taskId: 't1', commandId: 'absent' }).status, 'not_started');
      await plugin.configure({ executablePath: path }); await plugin.enable();
      await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
      const result = await plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'go1' });
      assert.equal(checked, true);
      assert.equal(result.status, 'not_started');
      assert.equal(x.task.status, 'planned');
      assert.equal(plugin.getExecution({ taskId: 't1', commandId: 'go1' }).status, 'not_started');
    } finally { await plugin.close(); await x.close(); }
  });

  test(`${provider} pause during execution authorization prevents a prompt`, async () => {
    const x = await fixture();
    const path = await fake(x.root, 'success');
    let entered = false, release;
    x.context.authorizeExecution = async () => { entered = true; await new Promise(resolve => { release = resolve; }); return true; };
    const plugin = await factory(x.context);
    try {
      await plugin.configure({ executablePath: path }); await plugin.enable();
      await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
      const resumed = plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'go1' });
      await until(() => entered);
      const paused = plugin.pause({ taskId: 't1', expectedRevision: x.task.revision });
      await until(() => plugin.state().commands[0]?.pauseRequested || plugin.state().commands[0]?.status === 'pausing');
      release();
      await paused;
      const result = await resumed;
      assert.equal(result.status, 'not_started');
      assert.equal(x.task.status, 'planned');
    } finally { if (release) release(); await plugin.close(); await x.close(); }
  });
}

test('Claude permission denial after a confirmed start reports a stopped approval wait', async () => {
  const x = await fixture();
  const path = await fakeClaude(x.root, 'permission');
  const plugin = await createClaude(x.context);
  try {
    await plugin.configure({ executablePath: path }); await plugin.enable();
    await plugin.createSession({ taskId: 't1', expectedRevision: 1, commandId: 'new1' });
    await plugin.resume({ taskId: 't1', expectedRevision: x.task.revision, commandId: 'go1' });
    await until(() => plugin.state().commands[0].status === 'awaiting_approval');
    assert.equal(x.task.status, 'blocked');
    assert.equal(plugin.state().commands[0].exitConfirmed, true);
    assert.equal(plugin.getExecution({ taskId: 't1', commandId: 'go1' }).status, 'paused');
    assert.equal(plugin.getExecution({ taskId: 't1', commandId: 'go1' }).reason, 'awaiting_approval');
  } finally { await plugin.close(); await x.close(); }
});

for (const [provider, factory] of [['Claude', createClaude], ['Cursor', createCursor]]) {
  test(`${provider} keeps a persisted approval wait unknown without exit proof`, async () => {
    const x = await fixture();
    const stateDir = x.context.dataDir;
    await mkdir(stateDir);
    await writeFile(join(stateDir, 'sessions.json'), JSON.stringify({ enabled: true, config: {}, sessions: {}, commands: {
      go1: { taskId: 't1', commandId: 'go1', status: 'awaiting_approval', runningContentVersion: 2, updatedAt: '2026-01-01T00:00:00Z' },
    } }));
    const plugin = await factory(x.context);
    try { assert.equal(plugin.getExecution({ taskId: 't1', commandId: 'go1' }).status, 'unknown'); }
    finally { await plugin.close(); await x.close(); }
  });
}
