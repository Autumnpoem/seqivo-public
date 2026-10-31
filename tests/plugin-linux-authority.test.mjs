import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedPlugin } from '../server/plugin-process.mjs';

async function fixture(t, { trustedBuiltIn = true, id = 'codex-autocontinue', permissions = ['task.resume'] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'linux-proof-rpc-'));
  const entry = join(root, 'host.mjs');
  await writeFile(entry, `export function createPlugin(context) {
    const state=()=>({available:true,enabled:false,workerPid:process.pid});
    return {state,configure:input=>context[input.method](input.payload),enable:state,
      disable:state,check:state,close:async()=>{}};
  }`);
  const seen = [];
  const observe = async input => { seen.push(input); return { verified: true, workerPid: input.trustedWorkerPid }; };
  const plugin = await createIsolatedPlugin({ entry, dataDir: root, pluginDir: root,
    manifest: { id, name: 'Isolated RPC contract fixture', version: '1', permissions }, trustedBuiltIn,
    context: { verifyLinuxExecutorAdmission: observe, verifyLinuxBridgeRetirementWorkspace: observe,
      verifyLinuxJobRetirement: observe } });
  t.after(async () => { await plugin.close(); await rm(root, { recursive: true, force: true }); });
  return { plugin, root, seen };
}

const request = workspace => ({ taskId: 'task-a', commandId: 'command-a', workspace,
  worktreeId: null, bridgePid: 900000001, appServerPid: 900000002 });

test('Linux executor callbacks are unavailable to side-loaded or unrelated plugins', async t => {
  for (const options of [{ trustedBuiltIn: false }, { id: 'other-provider' }, { permissions: ['tasks.read'] }]) {
    const f = await fixture(t, options);
    for (const method of ['verifyLinuxExecutorAdmission', 'verifyLinuxBridgeRetirementWorkspace', 'verifyLinuxJobRetirement']) {
      await assert.rejects(f.plugin.configure({ method, payload: { ...request(f.root),
        ...(method.includes('Retirement') ? { expectedHandoffGeneration: 1 } : {}) } }),
      { code: 'PERMISSION_DENIED' });
    }
    assert.equal(f.seen.length, 0);
  }
});

test('Linux executor RPC injects its actual worker and rejects caller-supplied authority',
  { skip: process.platform !== 'linux' }, async t => {
    const f = await fixture(t);
    const workerPid = (await f.plugin.state()).workerPid;
    for (const method of ['verifyLinuxExecutorAdmission', 'verifyLinuxBridgeRetirementWorkspace']) {
      const payload = { ...request(f.root), ...(method.includes('Retirement') ? { expectedHandoffGeneration: 1 } : {}) };
      await assert.rejects(f.plugin.configure({ method, payload: { ...payload, trustedWorkerPid: process.pid } }),
        { code: 'INVALID_CALLBACK' });
      await assert.rejects(f.plugin.configure({ method, payload: { ...payload, bridgePid: payload.appServerPid } }),
        { code: 'INVALID_CALLBACK' });
      assert.equal(f.seen.filter(row => row.commandId === payload.commandId).length, method.includes('Retirement') ? 1 : 0);
      const result = await f.plugin.configure({ method, payload });
      assert.equal(result.workerPid, workerPid);
      assert.deepEqual(f.seen.at(-1), { ...payload, trustedWorkerPid: workerPid });
    }
  });

test('Linux durable job RPC accepts a record binding but not worker-supplied stop authority',
  { skip: process.platform !== 'linux' }, async t => {
    const f = await fixture(t), workerPid = (await f.plugin.state()).workerPid;
    for (const method of ['verifyLinuxExecutorAdmission', 'verifyLinuxJobRetirement']) {
      const payload = { ...request(f.root), recordId: 'a'.repeat(32),
        ...(method === 'verifyLinuxJobRetirement' ? { expectedHandoffGeneration: null } : {}) };
      for (const extra of [{ trustedWorkerPid: process.pid }, { threadId: 'invented-thread' },
        { receipt: { verified: true } }, { recordId: '../wrong-record' }])
        await assert.rejects(f.plugin.configure({ method, payload: { ...payload, ...extra } }),
          { code: 'INVALID_CALLBACK' });
      assert.equal((await f.plugin.configure({ method, payload })).workerPid, workerPid);
      assert.deepEqual(f.seen.at(-1), { ...payload, trustedWorkerPid: workerPid });
    }
  });

test('Linux RPC permits a missing app-server identity only for original job retirement verification',
  { skip: process.platform !== 'linux' }, async t => {
    const f = await fixture(t), workerPid = (await f.plugin.state()).workerPid;
    for (const method of ['verifyLinuxExecutorAdmission', 'verifyLinuxBridgeRetirementWorkspace']) {
      const payload = { ...request(f.root), appServerPid: null,
        ...(method === 'verifyLinuxExecutorAdmission' ? { recordId: 'a'.repeat(32) }
          : { expectedHandoffGeneration: 1 }) };
      await assert.rejects(f.plugin.configure({ method, payload }), { code: 'INVALID_CALLBACK' });
    }
    assert.equal(f.seen.length, 0, 'a missing app-server identity cannot admit or prove workspace retirement');
    const payload = { ...request(f.root), appServerPid: null, recordId: 'a'.repeat(32),
      expectedHandoffGeneration: null };
    for (const appServerPid of [0, 1, '2', -1])
      await assert.rejects(f.plugin.configure({ method: 'verifyLinuxJobRetirement',
        payload: { ...payload, appServerPid } }), { code: 'INVALID_CALLBACK' });
    assert.equal((await f.plugin.configure({ method: 'verifyLinuxJobRetirement', payload })).workerPid, workerPid);
    assert.deepEqual(f.seen, [{ ...payload, trustedWorkerPid: workerPid }],
      'Core receives the real worker identity and must independently verify the original retired job');
  });
