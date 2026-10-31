import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {Store} from '../server/store.mjs';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'tuijin-journal-'));const path=join(dir,'board.sqlite');let store=new Store(path);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return {dir,path,get store(){return store;},restart(){store.close();store=new Store(path);return store;}};}
test('transactional journal survives restart and reconstructs corrupted projections with receipts',async t=>{
 const f=await fixture(t);const p=f.store.project({name:'replay',directory:f.dir}),a=f.store.createTask({projectId:p.id,title:'original',criteria:['real']});const event={eventId:'stable',type:'task.update',taskId:a.id,expectedRevision:1,payload:{summary:'new progress',sourceConversation:{provider:'codex',conversationId:'source',label:'design'}}};const receipt=f.store.applyEvent(event);const expected=f.store.getTask(a.id);f.restart();
 f.store.journal.enabled=false;f.store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify({...expected,title:'corrupt'}),a.id);f.store.journal.enabled=true;
 assert.equal(f.store.replay().status,'rebuilt');assert.deepEqual(f.store.getTask(a.id),expected);assert.deepEqual(f.store.applyEvent(event),receipt);assert.equal(f.store.getTask(a.id).conversationId,'');
});
test('failed transaction leaves no partial journal and history cursor filters by task',async t=>{
 const {store}=await fixture(t);const p=store.project({name:'history'}),a=store.createTask({projectId:p.id,title:'first'}),b=store.createTask({projectId:p.id,title:'second'});const count=store.journal.rows().length;
 assert.throws(()=>store.transaction(()=>{store.updateTask(a.id,{summary:'rollback'},1);throw Error('abort');}));assert.equal(store.journal.rows().length,count);assert.equal(store.getTask(a.id).summary,'');
 store.updateTask(a.id,{summary:'saved'},1);store.updateTask(b.id,{summary:'other'},1);const page=store.history({taskId:a.id,limit:1});assert.equal(page.events.length,1);const next=store.history({taskId:a.id,afterSeq:page.cursor});assert.equal(next.events.length,1);assert.equal(next.events[0].taskId,a.id);
});
test('archive corruption rejected atomically; restore clears executable bindings and directories',async t=>{
 const {store,dir}=await fixture(t);const p=store.project({name:'backup',directory:dir}),a=store.createTask({projectId:p.id,title:'bound',conversationId:'old-thread'});store.updateTask(a.id,{status:'running'},1);const archive=store.exportArchive();
 assert.throws(()=>store.restoreArchive({...archive,digest:'bad'}),/校验/);assert.equal(store.getTask(a.id).conversationId,'old-thread');
 assert.equal(store.restoreArchive(archive).status,'restored');assert.equal(store.getProject(p.id).directory,null);assert.equal(store.getTask(a.id).conversationId,'');assert.equal(store.getTask(a.id).status,'blocked');store.replay();assert.equal(store.getTask(a.id).conversationId,'');
 const bad=structuredClone(store.exportArchive());bad.journal[0].entity='tasks; DROP TABLE tasks';delete bad.digest;bad.digest=createHash('sha256').update(JSON.stringify(bad)).digest('hex');assert.throws(()=>store.restoreArchive(bad),/不合法/);assert.equal(store.tasks().length,1);
});
test('pre-journal databases receive one checkpoint without resetting user data',async t=>{
 const f=await fixture(t);const p=f.store.project({name:'legacy'}),a=f.store.createTask({projectId:p.id,title:'preserved'});f.store.close();
 const db=new DatabaseSync(f.path);for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all())db.exec(`DROP TRIGGER ${row.name}`);db.exec('DROP TABLE journal_entries');db.close();
 // Replace closed fixture store through restart-safe ownership.
 const s=new Store(f.path);assert.equal(s.getTask(a.id).title,'preserved');const n=s.journal.rows().length;s.close();const second=new Store(f.path);assert.equal(second.journal.rows().length,n);second.replay();assert.equal(second.getProject(p.id).name,'legacy');second.close();
});
test('archive validates event payload before restore and compacts overwritten row images',async t=>{
 const {store}=await fixture(t);const p=store.project({name:'compact'}),a=store.createTask({projectId:p.id,title:'task'});for(let i=1;i<25;i++)store.updateTask(a.id,{summary:'image-'+i},i);
 const archive=store.exportArchive();assert.equal(archive.journal.filter(e=>e.entity==='tasks').length,1);const event=archive.journal.find(e=>e.entity==='events');const row=JSON.parse(event.data);row.data='invalid-json';event.data=JSON.stringify(row);delete archive.digest;archive.digest=createHash('sha256').update(JSON.stringify(archive)).digest('hex');assert.throws(()=>store.restoreArchive(archive),/损坏|不合法/);assert.equal(store.getTask(a.id).summary,'image-24');assert.ok(store.events().length);
});
