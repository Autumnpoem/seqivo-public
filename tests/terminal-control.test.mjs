import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, copyFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.mjs';
import { createTerminalControl, snapshotWorkspace } from '../server/terminal/control.mjs';
import { createPlugin } from '../plugins/codex-autocontinue/host.mjs';

const clear = scope => ({ verified: true, quiescent: true, unknown: false, livePids: [], scope });
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'terminal-control-'));
  const dir=join(root,'workspace');await mkdir(dir);
  const store = new Store(join(root, 'board.sqlite'));
  const project = store.project({ name: 'Work', directory: dir });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const options = { store, quiesce: async () => clear('owned-group'), inspectWriters: async () => clear('all-writers'),
    inspectDirectories:async ({sessionRefs=[]})=>({verified:true,directories:sessionRefs.map(sessionRef=>({sessionRef,path:'.'}))}),...overrides };
  return { dir, store, project, options, control: createTerminalControl(options) };
}
const confirm=(control,projectId,token,actorId,review,profileId=undefined)=>control.confirmReturn({projectId,token,actorId,profileId,
  reviewId:review.returnReview.reviewId,expectedGeneration:review.generation});

test('takeover fences AI before async stop, and requires process evidence before human input', async t => {
  let finish;
  const stopped = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { quiesce: () => stopped });
  const pending = f.control.acquire({ projectId: f.project.id, actorId: 'phone-one' });
  assert.throws(() => f.control.assertMayStart(f.project.id), { code: 'CONTROL_BUSY' });
  assert.equal(f.control.state()[0].phase, 'stopping');
  finish(clear('owned-group'));
  const granted = await pending;
  assert.equal(granted.phase, 'human');
  assert.ok(granted.token);
  assert.equal(f.control.assertHuman({ projectId: f.project.id, token: granted.token }), true);
  assert.throws(() => f.control.assertHuman({ projectId: f.project.id, token: 'old' }), { code: 'CONTROL_STALE' });
  assert.throws(() => f.control.assertMayStart(f.project.id), { code: 'CONTROL_BUSY' });
});

test('pause or idle without process proof stays unknown through restart', async t => {
  const f = await fixture(t, { quiesce: async () => ({ status: 'paused', verified: false }) });
  const result = await f.control.acquire({ projectId: f.project.id, actorId: 'phone' });
  assert.equal(result.phase, 'unknown');
  assert.throws(() => f.control.assertMayStart(f.project.id), { code: 'CONTROL_BUSY' });
  const restarted = createTerminalControl(f.options);
  assert.equal(restarted.state()[0].phase, 'unknown');
  assert.throws(() => restarted.assertMayStart(f.project.id), { code: 'CONTROL_BUSY' });
});

test('return seals human input, reports changed tracked and untracked files, then permits AI', async t => {
  let finish;
  const sealed = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { sealHuman: () => sealed });
  await writeFile(join(f.dir, 'existing.txt'), 'before');
  const granted = await f.control.acquire({ projectId: f.project.id, actorId: 'phone' });
  assert.equal(granted.phase, 'human');
  assert.equal(f.control.handoffForProject(f.project.id), null);
  await writeFile(join(f.dir, 'existing.txt'), 'after');
  await writeFile(join(f.dir, 'new.txt'), 'new');
  const pending = f.control.release({ projectId: f.project.id, token: granted.token, notes: 'Edited files' });
  assert.throws(() => f.control.assertHuman({ projectId: f.project.id, token: granted.token }), { code: 'CONTROL_STALE' });
  assert.throws(() => f.control.assertMayStart(f.project.id), { code: 'CONTROL_BUSY' });
  finish();
  const review = await pending;
  assert.equal(review.phase,'return_review',review.reason);
  assert.equal(f.control.handoffForProject(f.project.id),null);
  assert.throws(()=>f.control.assertMayStart(f.project.id),{code:'CONTROL_BUSY'});
  assert.deepEqual(review.returnReview.changes.filter(c=>['existing.txt','new.txt'].includes(c.path)),[
    {path:'existing.txt',kind:'modified'},{path:'new.txt',kind:'added'}]);
  const returned=await confirm(f.control,f.project.id,granted.token,'phone',review);
  assert.equal(returned.phase, 'ai_ready');
  assert.equal(returned.snapshotScope, 'directory-tree-excluding-git-metadata');
  assert.deepEqual(returned.changes.filter(c => ['existing.txt', 'new.txt'].includes(c.path)), [
    { path: 'existing.txt', kind: 'modified' }, { path: 'new.txt', kind: 'added' },
  ]);
  const handoff=f.control.handoffForProject(f.project.id);
  assert.equal(handoff.generation,returned.generation);
  assert.equal(handoff.snapshotScope,returned.snapshotScope);
  assert.equal(handoff.notes,'Edited files');
  assert.ok(handoff.changes.some(item=>item.path==='new.txt'));
  assert.equal(JSON.stringify(handoff).includes(granted.token),false);
  assert.equal(f.control.assertMayStart(f.project.id), true);
});

test('review refuses changed files, wrong actor, expiry and restart without granting AI',async t=>{
  let clock=1_000_000;
  const f=await fixture(t,{now:()=>clock});
  const human=await f.control.acquire({projectId:f.project.id,actorId:'phone'});
  const review=await f.control.release({projectId:f.project.id,token:human.token});
  assert.equal(review.phase,'return_review');
  await assert.rejects(confirm(f.control,f.project.id,human.token,'another-device',review),{code:'CONTROL_STALE'});
  assert.equal(f.control.state()[0].phase,'return_review');
  await writeFile(join(f.dir,'changed-after-review.txt'),'late');
  const changed=await confirm(f.control,f.project.id,human.token,'phone',review);
  assert.equal(changed.phase,'unknown');
  assert.throws(()=>f.control.assertMayStart(f.project.id),{code:'CONTROL_BUSY'});
  const recovered=await f.control.reconcile({projectId:f.project.id,actorId:'phone',action:'acquire'});
  const second=await f.control.release({projectId:f.project.id,token:recovered.token});
  assert.equal(second.phase,'return_review');
  clock=second.returnReview.expiresAt;
  await assert.rejects(confirm(f.control,f.project.id,recovered.token,'phone',second),{code:'CONTROL_STALE'});
  assert.equal(f.control.state()[0].phase,'unknown');
  const again=await f.control.reconcile({projectId:f.project.id,actorId:'phone',action:'acquire'});
  const third=await f.control.release({projectId:f.project.id,token:again.token});
  assert.equal(third.phase,'return_review');
  const restarted=createTerminalControl(f.options);
  assert.equal(restarted.state()[0].phase,'unknown');
  assert.throws(()=>restarted.assertMayStart(f.project.id),{code:'CONTROL_BUSY'});
});

test('review cancel remains fenced even after expiry and does not resume human input',async t=>{
  let clock=10_000;
  const f=await fixture(t,{now:()=>clock});
  const human=await f.control.acquire({projectId:f.project.id,actorId:'phone'});
  const review=await f.control.release({projectId:f.project.id,token:human.token});
  clock=review.returnReview.expiresAt+1;
  const cancelled=f.control.cancelReturn({projectId:f.project.id,token:human.token,actorId:'phone',
    reviewId:review.returnReview.reviewId,expectedGeneration:review.generation});
  assert.equal(cancelled.phase,'unknown');
  assert.throws(()=>f.control.assertHuman({projectId:f.project.id,token:human.token}),{code:'CONTROL_STALE'});
  assert.throws(()=>f.control.assertMayStart(f.project.id),{code:'CONTROL_BUSY'});
});

test('managed return parks before sealing and never releases on an unowned writer', async t => {
  const order=[];
  const ref={serverName:'managed_test',instanceId:'a'.repeat(64),sessionId:'$0'};
  let external=false;
  const f=await fixture(t,{
    inspectExisting:async()=>({verified:true,authorized:true,unknown:false,unownedWriters:[],
      scope:'registered-pane',sessionEvidence:[{sessionRef:ref,panes:[]}]}),
    parkManaged:async input=>{order.push('park');assert.equal(input.sessionRefs[0].sessionId,ref.sessionId);},
    sealHuman:async()=>{order.push('seal');},
    inspectWriters:async input=>{if(!input.parked)return clear('takeover-writers');
      order.push('writers');
      return external?{verified:true,quiescent:false,unknown:false,livePids:[456],scope:'visible-writers'}:
        clear('parked-managed-and-visible-writers');},
  });
  const granted=await f.control.acquire({projectId:f.project.id,actorId:'owner'});
  await f.control.registerManagedSession({projectId:f.project.id,token:granted.token,
    actorId:'owner',profileId:'profile',sessionRef:ref});
  external=true;
  const result=await f.control.release({projectId:f.project.id,token:granted.token});
  assert.equal(result.phase,'unknown');
  assert.deepEqual(order,['park','seal','writers']);
  assert.throws(()=>f.control.assertMayStart(f.project.id),{code:'CONTROL_BUSY'});
});

test('Git snapshot explicitly covers tracked and nonignored untracked files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'terminal-snapshot-scope-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  await writeFile(join(dir, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(dir, 'tracked.txt'), 'tracked');
  await writeFile(join(dir, 'untracked.txt'), 'new');
  await writeFile(join(dir, 'ignored.txt'), 'ignored');
  execFileSync('git', ['-C', dir, 'add', 'tracked.txt']);
  const image = snapshotWorkspace(dir);
  assert.equal(image.snapshotScope, 'git-tracked-and-nonignored-untracked');
  assert.ok('tracked.txt' in image.files);
  assert.ok('untracked.txt' in image.files);
  assert.equal('ignored.txt' in image.files, false);
});

test('failed return or app restart never releases an active human token', async t => {
  const f = await fixture(t, { inspectWriters: async () => clear('writers') });
  const granted = await f.control.acquire({ projectId: f.project.id, actorId: 'phone' });
  assert.equal(granted.phase, 'human');
  const restarted = createTerminalControl(f.options);
  assert.equal(restarted.state()[0].phase, 'unknown');
  assert.throws(() => restarted.assertHuman({ projectId: f.project.id, token: granted.token }), { code: 'CONTROL_STALE' });
  assert.throws(() => restarted.assertMayStart(f.project.id), { code: 'CONTROL_BUSY' });
});

test('unknown takeover can retry only by repeating stop and writer inspection', async t => {
  let safe = false, stops = 0, inspections = 0;
  const f = await fixture(t, {
    quiesce: async () => { stops++; return safe ? clear('owned') : { status: 'idle' }; },
    inspectWriters: async () => { inspections++; return clear('writers'); },
  });
  assert.equal((await f.control.acquire({ projectId: f.project.id, actorId: 'phone' })).phase, 'unknown');
  assert.equal(stops, 1);
  safe = true;
  const result = await f.control.reconcile({ projectId: f.project.id, actorId: 'phone' });
  assert.equal(result.phase, 'human');
  assert.equal(stops, 2);
  assert.equal(inspections, 1);
});

test('unknown return cannot release AI until a second writer check succeeds', async t => {
  let writer = false, checks = 0;
  const f = await fixture(t, { inspectWriters: async () => { checks++; return writer ? { ...clear('writers'), quiescent: false, livePids: [123] } : clear('writers'); } });
  const granted = await f.control.acquire({ projectId: f.project.id, actorId: 'phone' });
  writer = true;
  const failed = await f.control.release({ projectId: f.project.id, token: granted.token });
  assert.equal(failed.phase, 'unknown');
  assert.throws(() => f.control.assertMayStart(f.project.id), { code: 'CONTROL_BUSY' });
  writer = false;
  const review = await f.control.reconcile({ projectId: f.project.id, actorId: 'phone', token: granted.token, action: 'release' });
  assert.equal(review.phase,'return_review');
  const returned=await confirm(f.control,f.project.id,review.token,'phone',review);
  assert.equal(returned.phase, 'ai_ready');
  assert.equal(checks, 6,'review and confirmation each repeat the final writer proof');
});

test('recovery retains the original human baseline across restart and new token', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'work.txt'), 'before');
  const first = await f.control.acquire({ projectId: f.project.id, actorId: 'phone-A' });
  await writeFile(join(f.dir, 'work.txt'), 'edited before restart');
  await writeFile(join(f.dir, 'untracked.txt'), 'created before restart');
  const restarted = createTerminalControl(f.options);
  assert.equal(restarted.state()[0].phase, 'unknown');
  const recovered = await restarted.reconcile({ projectId: f.project.id, actorId: 'phone-A', action: 'acquire' });
  assert.equal(recovered.phase, 'human');
  assert.notEqual(recovered.token, first.token);
  const review=await restarted.release({projectId:f.project.id,token:recovered.token});
  const returned=await confirm(restarted,f.project.id,recovered.token,'phone-A',review);
  assert.equal(returned.phase, 'ai_ready');
  assert.deepEqual(returned.changes.filter(c => ['work.txt', 'untracked.txt'].includes(c.path)), [
    { path: 'untracked.txt', kind: 'added' }, { path: 'work.txt', kind: 'modified' },
  ]);
});

test('only trusted local owner can reclaim another device human token after repeating checks', async t => {
  let stops = 0, inspections = 0, seals = 0;
  const f = await fixture(t, {
    quiesce: async () => { stops++; return clear('owned'); },
    inspectWriters: async () => { inspections++; return clear('writers'); },
    sealHuman: async () => { seals++; },
  });
  await writeFile(join(f.dir, 'work.txt'), 'before');
  const phone = await f.control.acquire({ projectId: f.project.id, actorId: 'user:revoked-phone' });
  await writeFile(join(f.dir, 'work.txt'), 'edited by phone');
  await assert.rejects(f.control.reconcile({ projectId: f.project.id, actorId: 'user:new-phone', action: 'acquire' }), { code: 'CONTROL_STALE' });
  const owner = await f.control.reconcile({ projectId: f.project.id, actorId: 'local-owner', trustedOwner: true, action: 'acquire' });
  assert.equal(owner.phase, 'human');
  assert.notEqual(owner.token, phone.token);
  assert.equal(seals, 1);
  assert.equal(stops, 2);
  assert.equal(inspections, 2);
  assert.throws(() => f.control.assertHuman({ projectId: f.project.id, token: phone.token }), { code: 'CONTROL_STALE' });
  const review=await f.control.release({projectId:f.project.id,token:owner.token});
  const returned=await confirm(f.control,f.project.id,owner.token,'local-owner',review);
  assert.ok(returned.changes.some(c => c.path === 'work.txt' && c.kind === 'modified'));
});

test('owner recovery with insufficient process evidence stays unknown and old token stays fenced', async t => {
  let safe = true;
  const f = await fixture(t, { inspectWriters: async () => safe ? clear('writers') : { ...clear('writers'), livePids: [42], quiescent: false } });
  const phone = await f.control.acquire({ projectId: f.project.id, actorId: 'revoked-phone' });
  safe = false;
  const result = await f.control.reconcile({ projectId: f.project.id, actorId: 'local-owner', trustedOwner: true, action: 'acquire' });
  assert.equal(result.phase, 'unknown');
  assert.throws(() => f.control.assertHuman({ projectId: f.project.id, token: phone.token }), { code: 'CONTROL_STALE' });
  assert.throws(() => f.control.assertMayStart(f.project.id), { code: 'CONTROL_BUSY' });
  safe = true;
  const retried = await f.control.reconcile({ projectId: f.project.id, actorId: 'local-owner', trustedOwner: true, action: 'acquire' });
  assert.equal(retried.phase, 'human');
});

test('trusted owner can return an expired existing session after restart using fresh executor and zero-writer proof',async t=>{
  const ref={serverName:'existing',instanceId:'a'.repeat(64),sessionId:'$1'};
  let stops=0,sessionAlive=true;
  const f=await fixture(t,{quiesce:async()=>{stops++;return clear('managed-executor');},
    inspectExisting:async()=>{if(!sessionAlive)throw new Error('tmux session exited');return {
      verified:true,authorized:true,unknown:false,unownedWriters:[],sessionEvidence:[{sessionRef:ref,panes:[{paneId:'%1',pid:123,startedAt:'fixture'}]}],scope:'test-selected-session'};}});
  await writeFile(join(f.dir,'work.txt'),'before');
  const phone=await f.control.acquireExisting({projectId:f.project.id,actorId:'phone',profileId:'default',sessionRefs:[ref]});
  assert.equal(phone.phase,'human');
  await writeFile(join(f.dir,'work.txt'),'after');
  const restarted=createTerminalControl(f.options);
  assert.equal(restarted.state()[0].phase,'unknown');
  sessionAlive=false;
  await assert.rejects(restarted.reconcile({projectId:f.project.id,actorId:'phone',action:'release'}),{code:'CONTROL_STALE'});
  const review=await restarted.reconcile({projectId:f.project.id,actorId:'local-owner',trustedOwner:true,action:'release'});
  const returned=await confirm(restarted,f.project.id,review.token,'local-owner',review,'default');
  assert.equal(returned.phase,'ai_ready',returned.reason);
  assert.ok(returned.changes.some(item=>item.path==='work.txt'&&item.kind==='modified'));
  assert.equal(stops,2,'owner return repeats managed executor proof');
  assert.throws(()=>restarted.assertHuman({projectId:f.project.id,token:phone.token}),{code:'CONTROL_STALE'});
  assert.equal(restarted.assertMayStart(f.project.id),true);
});

test('trusted owner return stays fenced while a writer remains or writer proof is missing',async t=>{
  const ref={serverName:'existing',instanceId:'b'.repeat(64),sessionId:'$2'};
  let inspection={...clear('workspace'),quiescent:false,livePids:[77]};
  const f=await fixture(t,{inspectExisting:async()=>({verified:true,authorized:true,unknown:false,unownedWriters:[],
    sessionEvidence:[{sessionRef:ref,panes:[{paneId:'%2',pid:456,startedAt:'fixture'}]}],scope:'test-selected-session'}),
    inspectWriters:async()=>inspection});
  const phone=await f.control.acquireExisting({projectId:f.project.id,actorId:'phone',profileId:'default',sessionRefs:[ref]});
  assert.equal(phone.phase,'human');
  const restarted=createTerminalControl(f.options);
  let result=await restarted.reconcile({projectId:f.project.id,actorId:'local-owner',trustedOwner:true,action:'release'});
  assert.equal(result.phase,'unknown');
  assert.throws(()=>restarted.assertMayStart(f.project.id),{code:'CONTROL_BUSY'});
  inspection={verified:false,quiescent:true,unknown:true,livePids:[],scope:'missing-proof'};
  result=await restarted.reconcile({projectId:f.project.id,actorId:'local-owner',trustedOwner:true,action:'release'});
  assert.equal(result.phase,'unknown');
  assert.throws(()=>restarted.assertHuman({projectId:f.project.id,token:phone.token}),{code:'CONTROL_STALE'});
  inspection=clear('workspace');
  const review=await restarted.reconcile({projectId:f.project.id,actorId:'local-owner',trustedOwner:true,action:'release'});
  assert.equal(review.phase,'return_review',review.reason);
  result=await confirm(restarted,f.project.id,review.token,'local-owner',review,'default');
  assert.equal(result.phase,'ai_ready');
});

test('late callback from an older generation cannot replace owner recovery', async t => {
  let finishOld, calls = 0;
  const oldStop = new Promise(resolve => { finishOld = resolve; });
  const f = await fixture(t, { quiesce: async () => ++calls === 1 ? oldStop : clear('owned') });
  const pendingOld = f.control.acquire({ projectId: f.project.id, actorId: 'revoked-phone' });
  assert.equal(f.control.state()[0].phase, 'stopping');
  const restarted = createTerminalControl(f.options);
  assert.equal(restarted.state()[0].phase, 'unknown');
  const owner = await restarted.reconcile({ projectId: f.project.id, actorId: 'local-owner', trustedOwner: true, action: 'acquire' });
  assert.equal(owner.phase, 'human');
  finishOld(clear('old-owned'));
  const oldResult = await pendingOld;
  assert.equal(oldResult.token, undefined);
  assert.equal(restarted.state()[0].actorId, 'local-owner');
  assert.equal(restarted.assertHuman({ projectId: f.project.id, token: owner.token }), true);
});

test('managed session registration cannot cross actor, profile, or an async control generation change', async t => {
  let finishInspection;
  const inspection=new Promise(resolve=>{finishInspection=resolve;});
  const ref={serverName:'managed_test',instanceId:'a'.repeat(64),sessionId:'$0'};
  const f=await fixture(t,{inspectExisting:()=>inspection});
  const granted=await f.control.acquire({projectId:f.project.id,actorId:'phone-one'});
  await assert.rejects(f.control.registerManagedSession({projectId:f.project.id,token:granted.token,
    actorId:'phone-two',profileId:'profile',sessionRef:ref}),{code:'CONTROL_STALE'});
  const pending=f.control.registerManagedSession({projectId:f.project.id,token:granted.token,
    actorId:'phone-one',profileId:'profile',sessionRef:ref});
  assert.equal(f.control.state()[0].phase,'stopping');
  const restarted=createTerminalControl(f.options);
  const owner=await restarted.reconcile({projectId:f.project.id,actorId:'local-owner',trustedOwner:true,action:'acquire'});
  assert.equal(owner.phase,'human');
  finishInspection({verified:true,authorized:true,unknown:false,unownedWriters:[],scope:'test-inspection',
    sessionEvidence:[{sessionRef:ref,panes:[{paneId:'%0',pid:123,startedAt:'test'}]}]});
  await assert.rejects(pending,{code:'CONTROL_STALE'});
  assert.equal(restarted.state()[0].actorId,'local-owner');
  assert.deepEqual(restarted.state()[0].authorizedSessionRefs,[]);
  assert.equal(restarted.assertHuman({projectId:f.project.id,token:owner.token}),true);
  await restarted.registerManagedSession({projectId:f.project.id,token:owner.token,
    actorId:'local-owner',profileId:'profile',sessionRef:ref});
  await assert.rejects(restarted.registerManagedSession({projectId:f.project.id,token:owner.token,
    actorId:'local-owner',profileId:'other-profile',sessionRef:ref}),{code:'CONTROL_STALE'});
});

test('managed selection recovery freezes if an ended ref lacks exact retired-process proof', async t => {
  const a={serverName:'managed_test',instanceId:'a'.repeat(64),sessionId:'$0'};
  const b={...a,sessionId:'$1'};
  let omitRetired=false;
  const f=await fixture(t,{inspectExisting:async input=>({verified:true,authorized:true,unknown:false,
    unownedWriters:[],scope:'test-selected-session',
    sessionEvidence:input.sessionRefs.map((sessionRef,index)=>({sessionRef,
      panes:[{paneId:`%${index}`,pid:100+index,startedAt:'fixture'}]})),
    retiredSessionRefs:omitRetired?[]:input.retiredSessionRefs||[]})});
  const initial=await f.control.acquire({projectId:f.project.id,actorId:'phone'});
  await f.control.registerManagedSession({projectId:f.project.id,token:initial.token,actorId:'phone',profileId:'profile',sessionRef:a});
  await f.control.registerManagedSession({projectId:f.project.id,token:initial.token,actorId:'phone',profileId:'profile',sessionRef:b});
  await assert.rejects(f.control.reclaimManagedSelection({projectId:f.project.id,actorId:'other',token:initial.token,
    profileId:'profile',sessionRef:a,liveSessionRefs:[a]}),{code:'CONTROL_STALE'});
  omitRetired=true;
  const result=await f.control.reclaimManagedSelection({projectId:f.project.id,actorId:'phone',token:initial.token,
    profileId:'profile',sessionRef:a,liveSessionRefs:[a]});
  assert.equal(result.phase,'unknown');
  assert.equal(result.generation,initial.generation+1);
  assert.throws(()=>f.control.assertHuman({projectId:f.project.id,token:initial.token}),{code:'CONTROL_STALE'});
  assert.throws(()=>f.control.assertMayStart(f.project.id),{code:'CONTROL_BUSY'});
});

test('owner recovery after restart prunes only proved-ended managed refs and rotates control identity', async t => {
  const a={serverName:'managed_test',instanceId:'a'.repeat(64),sessionId:'$0'};
  const b={...a,sessionId:'$1'},replacement={...a,sessionId:'$2'};
  let retiredProof=false,bGone=false;
  const f=await fixture(t,{inspectExisting:async input=>{
    if(bGone&&input.sessionRefs.some(ref=>ref.sessionId===b.sessionId))throw new Error('Selected tmux session is no longer present');
    return {verified:true,authorized:true,unknown:false,
    unownedWriters:[],scope:'test-selected-session',
    sessionEvidence:input.sessionRefs.map((sessionRef,index)=>({sessionRef,
      panes:[{paneId:`%${index}`,pid:100+index,startedAt:'fixture'}]})),
    retiredSessionRefs:retiredProof?input.retiredSessionRefs||[]:[]};}});
  const initial=await f.control.acquire({projectId:f.project.id,actorId:'phone'});
  await f.control.registerManagedSession({projectId:f.project.id,token:initial.token,
    actorId:'phone',profileId:'profile',sessionRef:a});
  await f.control.registerManagedSession({projectId:f.project.id,token:initial.token,
    actorId:'phone',profileId:'profile',sessionRef:b});
  const restarted=createTerminalControl(f.options);
  bGone=true;
  assert.equal(restarted.state()[0].phase,'unknown');
  const selection={profileId:'profile',sessionRef:a,availableSessionRefs:[a,replacement]};
  const oldActor=await restarted.reconcile({projectId:f.project.id,actorId:'phone',action:'acquire',
    managedSelection:selection});
  assert.equal(oldActor.phase,'unknown','old remote actor cannot use owner pruning');
  const unproved=await restarted.reconcile({projectId:f.project.id,actorId:'local-owner',trustedOwner:true,
    action:'acquire',managedSelection:selection});
  assert.equal(unproved.phase,'unknown');
  assert.throws(()=>restarted.assertHuman({projectId:f.project.id,token:initial.token}),{code:'CONTROL_STALE'});
  assert.throws(()=>restarted.assertMayStart(f.project.id),{code:'CONTROL_BUSY'});
  retiredProof=true;
  const recovered=await restarted.reconcile({projectId:f.project.id,actorId:'local-owner',trustedOwner:true,
    action:'acquire',managedSelection:selection});
  assert.equal(recovered.phase,'human',recovered.reason);
  assert.deepEqual(recovered.authorizedSessionRefs,[a]);
  assert.equal(recovered.generation,unproved.generation+1);
  assert.throws(()=>restarted.assertHuman({projectId:f.project.id,token:initial.token}),{code:'CONTROL_STALE'});
  assert.equal(restarted.assertHuman({projectId:f.project.id,token:recovered.token}),true);
});

test('explicit human transfer rotates token, keeps the original baseline, and restarts pending transfers as unknown', async t => {
  const ref={serverName:'managed_test',instanceId:'a'.repeat(64),sessionId:'$0'};
  const f=await fixture(t,{inspectExisting:async input=>({verified:true,authorized:true,unknown:false,
    unownedWriters:[],scope:'test-selected-session',sessionEvidence:input.sessionRefs.map(sessionRef=>({sessionRef,
      panes:[{paneId:'%0',pid:123,startedAt:'fixture'}]}))})});
  await writeFile(join(f.dir,'before-transfer.txt'),'original baseline');
  const owner=await f.control.acquire({projectId:f.project.id,actorId:'local-owner'});
  await f.control.registerManagedSession({projectId:f.project.id,token:owner.token,
    actorId:'local-owner',profileId:'managed',sessionRef:ref});
  const baseline=JSON.parse(f.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.control.v1').value)
    .entries[f.project.id].baseline;
  assert.ok(baseline.files['before-transfer.txt']);
  assert.throws(()=>f.control.beginTransfer({projectId:f.project.id,token:owner.token,actorId:'local-owner',
    targetActorId:'user:phone',targetConnectionId:'phone-connection',profileId:'managed',
    expectedGeneration:Number.MAX_SAFE_INTEGER,transferId:'overflow',expiresAt:Date.now()+60_000}),{code:'CONTROL_STALE'});
  const started=f.control.beginTransfer({projectId:f.project.id,token:owner.token,actorId:'local-owner',
    targetActorId:'user:phone',targetConnectionId:'phone-connection',profileId:'managed',
    expectedGeneration:owner.generation,transferId:'transfer-one',expiresAt:Date.now()+60_000});
  assert.equal(started.phase,'transfer_pending');
  assert.equal(started.generation,owner.generation+1);
  assert.throws(()=>f.control.beginTransfer({projectId:f.project.id,token:owner.token,actorId:'local-owner',
    targetActorId:'user:other',targetConnectionId:'other-connection',profileId:'managed',
    expectedGeneration:owner.generation,transferId:'second-begin',expiresAt:Date.now()+60_000}),{code:'CONTROL_STALE'});
  assert.throws(()=>f.control.assertHuman({projectId:f.project.id,token:owner.token}),{code:'CONTROL_STALE'});
  assert.throws(()=>f.control.assertMayStart(f.project.id),{code:'CONTROL_BUSY'});
  await assert.rejects(Promise.resolve().then(()=>f.control.acceptTransfer({projectId:f.project.id,
    transferId:'transfer-one',targetActorId:'user:other',targetConnectionId:'phone-connection',profileId:'managed'})),
    {code:'CONTROL_STALE'});
  const accepted=f.control.acceptTransfer({projectId:f.project.id,transferId:'transfer-one',
    targetActorId:'user:phone',targetConnectionId:'phone-connection',profileId:'managed'});
  assert.equal(accepted.phase,'human');assert.equal(accepted.actorId,'user:phone');
  assert.deepEqual(JSON.parse(f.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.control.v1').value)
    .entries[f.project.id].baseline,baseline,'transfer retains the exact first handoff file hashes');
  assert.deepEqual(accepted.authorizedSessionRefs,[ref]);
  assert.equal(f.control.assertHuman({projectId:f.project.id,token:accepted.token}),true);
  assert.throws(()=>f.control.acceptTransfer({projectId:f.project.id,transferId:'transfer-one',
    targetActorId:'user:phone',targetConnectionId:'phone-connection',profileId:'managed'}),{code:'CONTROL_STALE'});
  f.control.beginTransfer({projectId:f.project.id,token:accepted.token,actorId:'user:phone',
    targetActorId:'local-owner',targetConnectionId:'owner-new',profileId:'managed',
    expectedGeneration:accepted.generation,transferId:'transfer-two',expiresAt:Date.now()+60_000});
  const restarted=createTerminalControl(f.options);
  assert.equal(restarted.state()[0].phase,'unknown');
  assert.throws(()=>restarted.assertMayStart(f.project.id),{code:'CONTROL_BUSY'});
  assert.throws(()=>restarted.acceptTransfer({projectId:f.project.id,transferId:'transfer-two',
    targetActorId:'local-owner',targetConnectionId:'owner-new',profileId:'managed'}),{code:'CONTROL_STALE'});
});

test('expired and cancelled offers keep the AI fence and cannot be accepted',async t=>{
  for(const ending of ['expiry','cancel'])await t.test(ending,async sub=>{
    let clock=Date.now();
    const f=await fixture(sub,{now:()=>clock,inspectExisting:async input=>({verified:true,authorized:true,unknown:false,
      unownedWriters:[],scope:'injected-expiry-test',sessionEvidence:input.sessionRefs.map(sessionRef=>({sessionRef,
        panes:[{paneId:'%0',pid:123,startedAt:'fixture'}]}))})});
    const owner=await f.control.acquire({projectId:f.project.id,actorId:'local-owner'});
    await f.control.registerManagedSession({projectId:f.project.id,token:owner.token,actorId:'local-owner',
      profileId:'managed',sessionRef:{serverName:'test',instanceId:'a'.repeat(64),sessionId:'$0'}});
    f.control.beginTransfer({projectId:f.project.id,token:owner.token,actorId:'local-owner',
      targetActorId:'user:phone',targetConnectionId:'phone',profileId:'managed',
      expectedGeneration:owner.generation,transferId:'one',expiresAt:clock+60_000});
    if(ending==='expiry'){
      clock+=60_000;
      assert.equal(f.control.acceptTransfer({projectId:f.project.id,transferId:'one',
        targetActorId:'user:phone',targetConnectionId:'phone',profileId:'managed'}).phase,'unknown');
    }else assert.equal(f.control.failTransfer({projectId:f.project.id,transferId:'one',reason:'已取消'}).phase,'unknown');
    assert.throws(()=>f.control.acceptTransfer({projectId:f.project.id,transferId:'one',
      targetActorId:'user:phone',targetConnectionId:'phone',profileId:'managed'}),{code:'CONTROL_STALE'});
    assert.throws(()=>f.control.assertMayStart(f.project.id),{code:'CONTROL_BUSY'});
  });
});

test('Codex quiesce proves its own fake app-server process group exited', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'terminal-codex-quiesce-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'fake-codex.py');
  await copyFile(fileURLToPath(new URL('./plugin-fake-codex.py', import.meta.url)), executable);
  await chmod(executable, 0o700);
  const scenarioPath = join(dir, 'scenario.json');
  const pidPath = join(dir, 'appserver.pid');
  await writeFile(scenarioPath, JSON.stringify({ notifyInterrupted: true }));
  await writeFile(join(dir, 'appserver.log'), '');
  process.env.TASKBOARD_FAKE_SCENARIO = scenarioPath;
  process.env.TASKBOARD_FAKE_LOG = join(dir, 'appserver.log');
  process.env.TASKBOARD_FAKE_PID = pidPath;
  process.env.TASKBOARD_FAKE_CWD = dir;
  let task = { id: 't1', projectId: 'p1', title: 'Test', goal: 'Test', conversationId: 'thread-1', status: 'blocked',
    blockedReason: 'Codex quota exhausted', acceptance: 'unverified', revision: 1, contentVersion: 1 };
  const plugin = createPlugin({ dataDir: join(dir, 'state'), pluginDir: fileURLToPath(new URL('../plugins/codex-autocontinue/', import.meta.url)),
    getTask: async () => task, getProject: async id => ({ id, directory: dir }),
    updateTask: async (_id, patch, revision) => { assert.equal(revision, task.revision); task = { ...task, ...patch, revision: revision + 1 }; return task; } });
  try {
    await plugin.configure({ pythonPath: process.env.TASKBOARD_TEST_PYTHON || 'python3', codexPath: executable, pollSeconds: 86400 });
    assert.equal((await plugin.resume({ taskId: 't1', expectedRevision: 1, commandId: 'c1' })).status, 'running');
    // The fixture PID file is shared by task and quota app-servers. Bind this
    // assertion to the task bridge's actual child, not the last process spawned.
    const saved = JSON.parse(await readFile(join(dir, 'state', 'codex-autocontinue.json'), 'utf8'));
    const bridgePid = saved.executors['task:t1'].pid;
    const children = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
      .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
      .filter(([, parent]) => parent === bridgePid);
    assert.equal(children.length, 1, 'Fixture task bridge must own one app-server');
    const pid = children[0][0];
    assert.ok(Number.isInteger(pid) && pid > 0);
    await assert.rejects(plugin.quiesce({ projectId: 'p2', workspace: dir }), /Another project has an active or unconfirmed Codex executor in an overlapping workspace/);
    assert.doesNotThrow(() => process.kill(pid, 0));
    const evidence = await plugin.quiesce({ projectId: 'p1', workspace: dir });
    assert.equal(evidence.verified, true);
    assert.equal(evidence.quiescent, true);
    assert.deepEqual(evidence.livePids, []);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(bridgePid, 0), { code: 'ESRCH' });
  } finally { await plugin.close(); }
});
