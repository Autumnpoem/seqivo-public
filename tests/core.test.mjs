import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { FileBridge } from '../server/files.mjs';
import { createCore } from '../server/core.mjs';
import { startHttp } from '../server/http.mjs';

async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'tuijin-core-'));const store=new Store(join(dir,'store.sqlite'));const project=store.project({name:'真实项目',goal:'真实集成',directory:dir});t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});const task=store.createTask({projectId:project.id,title:'订单接口',goal:'接入真实订单',criteria:['新建订单后可读取']});return {dir,store,project,task};}
test('AI self report cannot mark accepted and evidence is mandatory',async t=>{const {store,task}=await fixture(t);assert.throws(()=>store.updateTask(task.id,{acceptance:'passed'},task.revision));let current=store.updateTask(task.id,{status:'submitted'},task.revision);assert.throws(()=>store.review(task.id,{expectedRevision:current.revision,decision:'pass',summary:'看起来完成'}),/证据/);assert.equal(store.getTask(task.id).acceptance,'unverified');});
test('human acceptance binds current version; new implementation invalidates it',async t=>{const {store,task}=await fixture(t);let a=store.updateTask(task.id,{status:'submitted'},task.revision);a=store.addEvidence(task.id,{expectedRevision:a.revision,summary:'真实接口端到端运行',reference:'reports/run-42.json'});a=store.review(task.id,{expectedRevision:a.revision,decision:'pass',summary:'已按场景确认'});assert.equal(a.acceptance,'passed');a=store.updateTask(task.id,{implementationRef:'commit-new'},a.revision);assert.equal(a.acceptance,'stale');assert.throws(()=>store.review(task.id,{expectedRevision:a.revision,decision:'pass',summary:'沿用旧报告'}),/当前版本/);});
test('revision conflict never overwrites the newer report',async t=>{const {store,task}=await fixture(t);store.updateTask(task.id,{summary:'新进度'},task.revision);assert.throws(()=>store.updateTask(task.id,{summary:'旧进度'},task.revision),e=>e.status===409);assert.equal(store.getTask(task.id).summary,'新进度');});
test('discrepancy blocks acceptance until explicitly resolved',async t=>{const {store,task}=await fixture(t);let a=store.updateTask(task.id,{status:'submitted'},1);a=store.addEvidence(task.id,{expectedRevision:a.revision,summary:'本地演示',reference:'demo.html'});a=store.review(task.id,{expectedRevision:a.revision,decision:'fail',summary:'未连接真实系统'});assert.throws(()=>store.review(task.id,{expectedRevision:a.revision,decision:'pass',summary:'忽略问题'}),/偏差/);a=store.resolveIssue(task.id,a.issues[0].id,a.revision);assert.equal(a.acceptance,'unverified');});
test('same event is idempotent; changed payload with same id rejected',async t=>{const {store,task}=await fixture(t);const event={eventId:'evt-1',type:'task.update',taskId:task.id,expectedRevision:1,payload:{summary:'完成数据层'}};const r=store.applyEvent(event);assert.deepEqual(store.applyEvent(event),r);assert.equal(store.getTask(task.id).revision,2);assert.throws(()=>store.applyEvent({...event,payload:{summary:'另一个更新'}}),e=>e.status===409);assert.throws(()=>store.applyEvent({eventId:'x',type:'task.review',taskId:task.id,payload:{decision:'pass'}}),e=>e.status===403);});
test('transactions roll back a malformed import and survive restart',async t=>{const {store,dir}=await fixture(t);const other=join(dir,'other');await mkdir(join(other,'.taskboard'),{recursive:true});await writeFile(join(other,'.taskboard','project.json'),JSON.stringify({name:'错误项目',tasks:[{title:'合法任务'},{title:''}]}));assert.throws(()=>store.importProject(other));assert.equal(store.projects().length,1);const reader=new Store(join(dir,'store.sqlite'));assert.equal(reader.tasks().length,1);reader.close();});
test('file bridge consumes once, exports context and rejects a foreign task',async t=>{const {store,dir,project,task}=await fixture(t);const bridge=new FileBridge(store);t.after(()=>bridge.close());await mkdir(join(dir,'.taskboard','inbox'),{recursive:true});await writeFile(join(dir,'.taskboard','inbox','event.json'),JSON.stringify({eventId:'file-event',type:'task.update',taskId:task.id,expectedRevision:1,payload:{summary:'文件汇报'}}));await bridge.tick();await bridge.tick();assert.equal(store.getTask(task.id).revision,2);assert.match(await readFile(join(dir,'.taskboard','CONTEXT.md'),'utf8'),/文件汇报/);const other=store.project({name:'另一个项目'}),foreign=store.createTask({projectId:other.id,title:'其他任务',criteria:[]});await writeFile(join(dir,'.taskboard','inbox','bad.json'),JSON.stringify({eventId:'foreign',type:'task.update',taskId:foreign.id,expectedRevision:1,payload:{summary:'越界'}}));await bridge.tick();assert.equal(store.getTask(foreign.id).revision,1);});
test('HTTP authentication and role boundaries protect writes and controls',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'tuijin-http-'));const core=await createCore({dataDir:dir,pluginDir:resolve('plugins'),files:false});const web=await startHttp({core,dataDir:dir,distDir:resolve('dist'),port:0});t.after(async()=>{await web.close();await core.close();await rm(dir,{recursive:true,force:true});});const url=`http://127.0.0.1:${web.port}`;
 const call=(path,role='owner',method='GET',body)=>fetch(url+path,{method,headers:{Authorization:`Bearer ${web.tokens[role]||'bad'}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 assert.equal((await call('/api/state','bad')).status,401);assert.equal((await call('/api/state','viewer')).status,200);assert.equal((await call('/api/projects','viewer','POST',{name:'forbidden'})).status,403);assert.equal((await call('/api/plugin/enable','reporter','POST',{})).status,403);
 const csrf=await fetch(url+'/api/state',{headers:{Authorization:`Bearer ${web.tokens.owner}`,Origin:'https://evil.example'}});assert.equal(csrf.status,403);
 const p=await (await call('/api/projects','owner','POST',{name:'API project'})).json();const t1=await (await call('/api/events/ingest','reporter','POST',{eventId:'agent-create',type:'task.create',projectId:p.id,payload:{title:'可汇报',criteria:['必须验证']}})).json();assert.equal(t1.status,'accepted');assert.equal((await call(`/api/tasks/${t1.taskId}/review`,'reporter','POST',{expectedRevision:1,decision:'pass',summary:'自证'})).status,403);
});
test('reporters cannot change the baseline, bind a session, or override a user pause',async t=>{
 const {store,task,project}=await fixture(t);
 for(const patch of [{goal:'lower bar'},{criteria:[]},{conversationId:'other'},{status:'cancelled'}])assert.throws(()=>store.applyEvent({eventId:JSON.stringify(patch),type:'task.update',taskId:task.id,expectedRevision:1,payload:patch}),e=>e.status===403);
 assert.throws(()=>store.applyEvent({eventId:'bind',type:'task.create',projectId:project.id,payload:{title:'hidden binding',conversationId:'other'}}),e=>e.status===403);
 const paused=store.updateTask(task.id,{status:'paused'},1);
 assert.throws(()=>store.applyEvent({eventId:'unpause',type:'task.update',taskId:task.id,expectedRevision:paused.revision,payload:{status:'running'}}),e=>e.status===403);
 assert.equal(store.getTask(task.id).status,'paused');
});
test('acceptance expires on changed outcome, binding and submitted content',async t=>{
 const {store,project}=await fixture(t);
 for(const patch of [{status:'failed'},{status:'cancelled'},{status:'paused'},{summary:'different outcome'},{conversationId:'replacement'},{title:'replacement'}]){
  let a=store.createTask({projectId:project.id,title:'baseline',criteria:['real integration']});a=store.updateTask(a.id,{status:'submitted'},a.revision);a=store.addEvidence(a.id,{expectedRevision:a.revision,summary:'checked',reference:'report'});a=store.review(a.id,{expectedRevision:a.revision,decision:'pass',summary:'verified'});a=store.updateTask(a.id,patch,a.revision);assert.equal(a.acceptance,'stale');assert.equal(a.criteria[0].passed,false);
 }
});
test('resolving a discrepancy requires resubmission and fresh evidence',async t=>{
 const {store,task}=await fixture(t);let a=store.updateTask(task.id,{status:'submitted'},1);a=store.addEvidence(a.id,{expectedRevision:a.revision,summary:'offline demo',reference:'demo.html'});a=store.review(a.id,{expectedRevision:a.revision,decision:'fail',summary:'real integration missing'});a=store.resolveIssue(a.id,a.issues[0].id,a.revision);assert.notEqual(a.status,'submitted');a=store.updateTask(a.id,{status:'submitted'},a.revision);assert.throws(()=>store.review(a.id,{expectedRevision:a.revision,decision:'pass',summary:'reuse evidence'}),/当前版本/);
});
test('only one core can schedule against a data directory and clean close releases ownership',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'tuijin-lock-'));let core=await createCore({dataDir:dir,pluginDir:resolve('plugins'),files:false});await assert.rejects(createCore({dataDir:dir,pluginDir:resolve('plugins'),files:false}),/已有运行/);await core.close();core=await createCore({dataDir:dir,pluginDir:resolve('plugins'),files:false});await core.close();await rm(dir,{recursive:true,force:true});
});
test('import rejects excessive references before creating any project or tasks',async t=>{
 const {store,dir}=await fixture(t);const other=join(dir,'oversized');await mkdir(join(other,'.taskboard'),{recursive:true});await writeFile(join(other,'.taskboard','project.json'),JSON.stringify({name:'oversized',tasks:[{title:'huge',artifactRefs:Array(101).fill('x')}]}));assert.throws(()=>store.importProject(other),/最多 100/);assert.equal(store.projects().length,1);
});
test('an initial file scan cannot block opening the existing task database',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tuijin-slow-files-'));const tick=FileBridge.prototype.tick;let release,core;
 const pending=new Promise(resolveWait=>{release=resolveWait;});
 FileBridge.prototype.tick=()=>pending;
 const startup=createCore({dataDir:dir,pluginDir:join(dir,'empty'),files:true});
 let deadline;
 try{core=await Promise.race([startup,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('File scan blocked core startup')),1000);})]);assert.equal((await core.state()).tasks.length,0);}
 finally{clearTimeout(deadline);release();FileBridge.prototype.tick=tick;core??=await startup;await core.close();await rm(dir,{recursive:true,force:true});}
});
