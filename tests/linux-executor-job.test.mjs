import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp,mkdir,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const exec=promisify(execFile),pythonPath=process.env.TASKBOARD_TEST_PYTHON||'/usr/bin/python3';
const native={skip:process.platform!=='linux',timeout:25000};
async function until(fn,reason){
 const end=Date.now()+8000;
 while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,50));}
 throw new Error(reason);
}
async function fixture(t,mode='live',longPath=false){
 const root=await mkdtemp(join(tmpdir(),'seqivo-linux-job-test-'));
 const recordRoot=join(root,longPath?'normal-application-data-directory/plugins/codex-autocontinue/linux-executor-jobs':'records'),workspace=join(root,'workspace');
 await mkdir(recordRoot,{mode:0o700,recursive:true});await mkdir(workspace,{mode:0o700});
 const {recoverLinuxExecutorJob}=await import('../server/linux-executor-job.mjs');
 const taskId='linux-job-test-task',projectId='linux-job-test-project';
 const {stdout}=await exec(process.execPath,[fileURLToPath(new URL('./fixtures/linux-job-controller.mjs',import.meta.url)),recordRoot,workspace,taskId,projectId,mode],{timeout:10000,env:{...process.env,TASKBOARD_TEST_PYTHON:pythonPath}});
 const original=JSON.parse(stdout.trim());
 const binding={recordRoot,recordId:original.recordId,workspace,taskId,projectId,pythonPath};
 let recovered;
 t.after(async()=>{
  recovered ||= await recoverLinuxExecutorJob(binding);
  assert.equal(recovered.verified,true,'cleanup must recover only the original fixture job');
  const stopped=await recovered.job.stop();
  const final=stopped.retired?stopped:await until(async()=>{const s=await recovered.job.recheck();return s.retired?s:null;},'fixture job did not retire');
  assert.equal(final.verified,true,'cleanup cannot assume retirement');
  await rm(root,{recursive:true});
 });
 const pid=await until(async()=>{try{return Number(await readFile(join(workspace,'workload.pid'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}},'workload did not start');
 recovered=await recoverLinuxExecutorJob(binding);
 assert.equal(recovered.verified,true,recovered.reason);
 return {job:recovered.job,binding,original,workspace,pid,recover:recoverLinuxExecutorJob};
}

test('Linux job survives its caller and a new controller can stop the original workload',native,async t=>{
 const f=await fixture(t);
 const state=await f.job.observe();
 assert.equal(state.verified,true,state.reason);assert.equal(state.unknown,false);
 assert.equal(state.retired,false);assert.ok(state.members.some(r=>r.pid===f.pid));
 assert.equal(f.original.pid,f.pid,'spawn transport identifies the bridge, not its supervisor');
 const stopped=await f.job.stop();
 const final=stopped.retired?stopped:await until(async()=>{const s=await f.job.recheck();return s.retired?s:null;},'original workload was not retired');
 assert.equal(final.verified,true);assert.equal(final.unknown,false);
 assert.equal(await readFile(join(f.workspace,'launches.txt'),'utf8'),'launch\n');
 await assert.rejects(()=>f.job.spawn(),/recover|spawn|attempt|retir|start/i);
 const again=await f.recover(f.binding);
 assert.equal(again.verified,true,again.reason);
 assert.equal((await again.job.recheck()).retired,true,'durable retirement survives controller replacement');
});

test('Linux job accepts normal application data paths longer than a Unix socket address',native,async t=>{
 const f=await fixture(t,'live',true);
 assert.ok(Buffer.byteLength(join(f.job.directory,'control.sock'))>108);
 assert.equal((await f.job.observe()).verified,true);
 assert.equal((await f.job.stop()).retired,true);
 assert.equal(await readFile(join(f.workspace,'launches.txt'),'utf8'),'launch\n');
});

test('Linux job adopts a double-forked descendant after its bridge exits',native,async t=>{
 const f=await fixture(t,'double-fork');
 assert.notEqual(f.pid,f.original.pid);
 const state=await until(async()=>{const s=await f.job.observe();assert.equal(s.verified,true,s.reason);return s.members.some(r=>r.pid===f.pid)?s:null;},'adopted descendant not reported');
 assert.equal(state.retired,false);assert.equal(state.unknown,false);
 const stopped=await f.job.stop();
 const final=stopped.retired?stopped:await until(async()=>{const s=await f.job.recheck();return s.retired?s:null;},'double-forked descendant did not retire');
 assert.equal(final.verified,true);assert.equal(final.unknown,false);
 assert.equal(await readFile(join(f.workspace,'launches.txt'),'utf8'),'launch\n');
});

test('Linux job observes descendants forked by a nonleader thread',native,async t=>{
 const f=await fixture(t,'thread-fork');
 assert.notEqual(f.pid,f.original.pid);
 const state=await f.job.observe();
 assert.equal(state.verified,true,state.reason);
 assert.ok(state.members.some(r=>r.pid===f.pid),'a nonleader thread child must remain part of the job');
});

test('Linux job recovery rejects another task, project or workspace without stopping the original',native,async t=>{
 const f=await fixture(t);
 for(const changed of [{taskId:'other-task'},{projectId:'other-project'},{workspace:join(f.workspace,'missing')}]){
  const result=await f.recover({...f.binding,...changed});
  assert.equal(result.verified,false,'mismatched binding must not grant recovery');
  assert.equal(result.unknown,true);assert.equal(result.job,undefined);
 }
 const state=await f.job.observe();assert.equal(state.verified,true,state.reason);
 assert.ok(state.members.some(r=>r.pid===f.pid),'mismatched attempts must not stop the live workload');
 assert.equal(await readFile(join(f.workspace,'launches.txt'),'utf8'),'launch\n');
});

test('Linux job can retire a live bridge with an unreaped exited child',native,async t=>{
 const f=await fixture(t,'zombie-child');
 const stopped=await f.job.stop();
 assert.equal(stopped.verified,true,stopped.reason);
 assert.equal(stopped.retired,true,'an exited child must not prevent stopping its live parent');
});

test('Linux job reports unknown within a deadline when its original supervisor is suspended',native,async t=>{
 const f=await fixture(t);
 const record=JSON.parse(await readFile(join(f.job.directory,'record.json'),'utf8'));
 const identity=record.supervisorIdentity;
 const helper=fileURLToPath(new URL('../plugins/codex-autocontinue',import.meta.url));
 const signalOriginal=number=>exec(pythonPath,['-I','-B','-c',
  'import sys,json,os,signal;sys.path.insert(0,sys.argv[1]);from process_identities import linux_identity;expected=json.loads(sys.argv[2]);fd=os.pidfd_open(expected["pid"]);current=linux_identity(expected["pid"],expected["euid"],expected["ruid"],expected["bootId"]);assert all(current[k]==expected[k] for k in ("kind","pid","euid","ruid","bootId","startTicks"));signal.pidfd_send_signal(fd,int(sys.argv[3]),None,0);os.close(fd)',helper,JSON.stringify(identity),String(number)],{timeout:2000});
 let observed,timer;
 await signalOriginal(19); // Linux SIGSTOP; only the fixture's original birth identity.
 try {
  observed=f.job.observe();
  const result=await Promise.race([observed,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),6500);})]);
  assert.ok(result,'a suspended supervisor must not leave callers waiting indefinitely');
  assert.equal(result.verified,false);assert.equal(result.unknown,true);
 } finally {
  clearTimeout(timer);
  await signalOriginal(18); // Linux SIGCONT before normal fixture cleanup.
  if(observed)await observed;
 }
});
