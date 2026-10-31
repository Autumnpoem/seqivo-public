import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopStartupGate} from '../src/lib/desktop-startup.ts';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve};};

test('listen precedes snapshot; ready during delayed snapshot causes one initial read',async()=>{
  const snapshot=deferred();const order=[];let emit;
  const bridge={subscribeStartup:async callback=>{order.push('listen');emit=callback;return()=>order.push('off');},
    startupStatus:async()=>{order.push('snapshot');return snapshot.promise;}};
  let reads=0;const statuses=[];
  const gate=createDesktopStartupGate(bridge,{onStatus:s=>statuses.push(s.phase),onReady:()=>{reads++;order.push('GET /api/state');}});
  await tick();assert.deepEqual(order,['listen','snapshot']);assert.equal(reads,0);
  emit({phase:'ready',revision:3});assert.equal(reads,1);
  snapshot.resolve({phase:'starting',revision:2});await tick();
  emit({phase:'ready',revision:3});assert.equal(reads,1);
  assert.deepEqual(statuses,['ready']);gate.dispose();assert.equal(order.at(-1),'off');
});

test('starting and failed gate reads; manual retry only requests status, later ready reads once',async()=>{
  let snapshot={phase:'starting',revision:1},emit,queries=0,reads=0,mutations=0;
  const gate=createDesktopStartupGate({subscribeStartup:async callback=>{emit=callback;return()=>{};},
    startupStatus:async()=>{queries++;return snapshot;}},
  {onStatus:()=>{},onReady:()=>{reads++;}});
  await tick();assert.equal(queries,1);assert.equal(reads,0);
  snapshot={phase:'failed',revision:2,message:'sidecar exited'};await gate.retry();
  assert.equal(queries,2);assert.equal(reads,0);assert.equal(mutations,0);
  snapshot={phase:'starting',revision:3};await gate.retry();assert.equal(reads,0);
  emit({phase:'ready',revision:4});assert.equal(reads,1);
  snapshot={phase:'ready',revision:4};await gate.retry();assert.equal(reads,1);
  emit({phase:'stopping',revision:5});emit({phase:'ready',revision:6});assert.equal(reads,2);
  gate.dispose();
});

test('dispose before asynchronous subscription resolves unregisters and ignores late status',async()=>{
  const listener=deferred();let callback,off=0,reads=0,snapshots=0;
  const gate=createDesktopStartupGate({subscribeStartup:async cb=>{callback=cb;return listener.promise;},
    startupStatus:async()=>{snapshots++;return {phase:'ready',revision:1};}},
  {onStatus:()=>{},onReady:()=>{reads++;}});
  gate.dispose();callback({phase:'ready',revision:1});listener.resolve(()=>{off++;});await tick();
  assert.equal(off,1);assert.equal(snapshots,0);assert.equal(reads,0);
});

test('manual retry cannot query status before listener registration completes',async()=>{
  const listener=deferred();let callback,queries=0,reads=0;
  const gate=createDesktopStartupGate({subscribeStartup:async cb=>{callback=cb;return listener.promise;},
    startupStatus:async()=>{queries++;return {phase:'ready',revision:1};}},
  {onStatus:()=>{},onReady:()=>{reads++;}});
  const retry=gate.retry();await tick();assert.equal(queries,0);
  listener.resolve(()=>{});await retry;await tick();
  assert.equal(queries>=1,true);assert.equal(reads,1);
  callback({phase:'ready',revision:1});assert.equal(reads,1);gate.dispose();
});

test('legacy desktop bridge without handshake preserves initial read',async()=>{
  let reads=0;
  const gate=createDesktopStartupGate({}, {onStatus:()=>{},onReady:()=>{reads++;}});
  await tick();assert.equal(reads,1);gate.dispose();
});

test('failed listener registration can be retried without reading board state early',async()=>{
  let registrations=0,statusReads=0,boardReads=0;
  const gate=createDesktopStartupGate({
    subscribeStartup:async()=>{registrations++;if(registrations===1)throw new Error('listener unavailable');return()=>{};},
    startupStatus:async()=>{statusReads++;return {phase:'ready',revision:2};},
  },{onStatus:()=>{},onReady:()=>{boardReads++;},onError:()=>{}});
  await tick();assert.equal(statusReads,0);assert.equal(boardReads,0);
  await gate.retry();assert.equal(registrations,2);assert.equal(statusReads,1);assert.equal(boardReads,1);
  gate.dispose();
});

test('concurrent retries after listener failure install one listener and take one snapshot',async()=>{
  const second=deferred();let registrations=0,statusReads=0,boardReads=0;
  const gate=createDesktopStartupGate({
    subscribeStartup:async()=>{registrations++;if(registrations===1)throw new Error('listener unavailable');return second.promise;},
    startupStatus:async()=>{statusReads++;return {phase:'ready',revision:2,message:null};},
  },{onStatus:()=>{},onReady:()=>{boardReads++;},onError:()=>{}});
  await tick();const a=gate.retry(),b=gate.retry();await tick();
  assert.equal(registrations,2);assert.equal(statusReads,0);
  second.resolve(()=>{});await Promise.all([a,b]);
  assert.equal(registrations,2);assert.equal(statusReads,1);assert.equal(boardReads,1);
  gate.dispose();
});
