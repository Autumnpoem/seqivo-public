import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source=await readFile(new URL('../src/task-form-drafts.ts',import.meta.url),'utf8');
const compiled=stripTypeScriptTypes(source,{mode:'transform'});
const {taskFormDraftKey,readTaskFormDraft,saveTaskFormDraft,discardTaskFormDraft,
  clearTaskFormDrafts,taskCreateAvailabilityReason,hubTaskCreateBody,confirmedHubTaskId}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

class MemoryStorage{
  values=new Map();
  get length(){return this.values.size;}
  key(index){return [...this.values.keys()][index]??null;}
  getItem(key){return this.values.get(String(key))??null;}
  setItem(key,value){this.values.set(String(key),String(value));}
  removeItem(key){this.values.delete(String(key));}
  clear(){this.values.clear();}
}

const key=(account='account-a',project='project-a',task='task-a',kind='edit')=>
  taskFormDraftKey(account,project,task,kind);
const draft=(values={title:'Draft title'},revision=3,contentVersion=2,reviewDecision='pass')=>
  ({revision,contentVersion,values,reviewDecision});

test('keys require full scope and distinguish account, project, task, kind and delimiter collisions',()=>{
  assert.equal(key('','project-a','task-a','edit'),null);
  assert.equal(key('account-a','','task-a','edit'),null);
  assert.equal(key('account-a','project-a','','edit'),null);
  assert.equal(taskFormDraftKey('account-a','project-a','task-a',''),null);
  assert.equal(new Set([key(),key('account-b'),key('account-a','project-b'),
    key('account-a','project-a','task-b'),key('account-a','project-a','task-a','evidence'),
    key('account-a','project-a','task-a','review'),key('account-a','project-a','__new_task__','create')]).size,7);
  assert.notEqual(key('a:b','c','d'),key('a','b:c','d'));
});

test('edit, evidence and review form kinds persist independently with original revisions and string values',()=>{
  const storage=new MemoryStorage();
  const entries=[
    [key(),draft({title:'Title',goal:'Goal',criteria:'["one"]'},7,4)],
    [key('account-a','project-a','task-a','evidence'),draft({summary:'Summary',reference:'link'},8,5)],
    [key('account-a','project-a','task-a','review'),draft({approach:'Review',nextStep:'Next'},9,6,'fail')],
  ];
  for(const [scope,value] of entries)assert.equal(saveTaskFormDraft(storage,scope,value),true);
  for(const [scope,value] of entries)assert.deepEqual(readTaskFormDraft(storage,scope),value);
  assert.equal(readTaskFormDraft(storage,key('account-b')),null);
});

test('invalid stored objects and disallowed form fields cannot become drafts',()=>{
  const storage=new MemoryStorage(),scope=key();
  for(const raw of ['not JSON','[]','{}',JSON.stringify(draft({title:4})),
    JSON.stringify(draft({unexpected:'value'})),JSON.stringify(draft({},-1)),
    JSON.stringify(draft({},2,1.5)),JSON.stringify(draft({},2,'')),
    JSON.stringify(draft({},2,1,'maybe'))]){
    storage.setItem(scope,raw);
    assert.equal(readTaskFormDraft(storage,scope),null);
  }
});

test('opaque string content versions round-trip and a changed version cannot discard a newer draft',()=>{
  const storage=new MemoryStorage(),scope=key();
  const submitted=draft({summary:'Evidence'},5,'hub:opaque/version-1');
  const newer=draft({summary:'Evidence'},5,'hub:opaque/version-2');
  assert.equal(saveTaskFormDraft(storage,scope,submitted),true);
  assert.deepEqual(readTaskFormDraft(storage,scope),submitted);
  assert.equal(saveTaskFormDraft(storage,scope,newer),true);
  assert.equal(discardTaskFormDraft(storage,scope,submitted),true);
  assert.deepEqual(readTaskFormDraft(storage,scope),newer);
  assert.equal(discardTaskFormDraft(storage,scope,newer),true);
  assert.equal(readTaskFormDraft(storage,scope),null);
});

test('confirmed discard deletes only exact original contents and leaves newer drafts',()=>{
  const storage=new MemoryStorage(),scope=key(),other=key('account-a','project-a','task-b');
  const submitted=draft({title:'Before'},3,2);
  const changed=draft({title:'After'},3,2);
  assert.equal(saveTaskFormDraft(storage,scope,submitted),true);
  assert.equal(saveTaskFormDraft(storage,other,submitted),true);
  assert.equal(saveTaskFormDraft(storage,scope,changed),true);
  assert.equal(discardTaskFormDraft(storage,scope,submitted),true);
  assert.deepEqual(readTaskFormDraft(storage,scope),changed);
  assert.equal(discardTaskFormDraft(storage,scope,draft({title:'After'},4,2)),true);
  assert.deepEqual(readTaskFormDraft(storage,scope),changed);
  assert.equal(discardTaskFormDraft(storage,scope,changed),true);
  assert.equal(readTaskFormDraft(storage,scope),null);
  assert.deepEqual(readTaskFormDraft(storage,other),submitted);
  assert.equal(discardTaskFormDraft(storage,scope,submitted),true);
});

test('storage errors return failure and do not claim a draft was deleted',()=>{
  const storage=new MemoryStorage(),scope=key(),value=draft();
  storage.setItem=()=>{throw new Error('quota');};
  assert.equal(saveTaskFormDraft(storage,scope,value),false);
  storage.setItem=MemoryStorage.prototype.setItem;
  storage.setItem(scope,JSON.stringify(value));
  storage.removeItem=()=>{throw new Error('storage denied');};
  assert.equal(discardTaskFormDraft(storage,scope,value),false);
  assert.deepEqual(readTaskFormDraft(storage,scope),value);
  storage.getItem=()=>{throw new Error('storage denied');};
  assert.equal(readTaskFormDraft(storage,scope),null);
  assert.equal(discardTaskFormDraft(storage,scope,value),false);
  assert.equal(saveTaskFormDraft(storage,null,value),false);
});

test('logout clears only exact account task-form drafts',()=>{
  const storage=new MemoryStorage(),own=[key(),key('account-a','project-a','task-a','evidence'),
    key('account-a','project-b','task-b','review'),key('account-a','project-b','__new_task__','create')],other=key('account-b');
  for(const scope of [...own,other])assert.equal(saveTaskFormDraft(storage,scope,draft()),true);
  storage.setItem('unrelated-app-key','keep');
  assert.equal(clearTaskFormDrafts(storage,'account-a'),true);
  for(const scope of own)assert.equal(readTaskFormDraft(storage,scope),null);
  assert.deepEqual(readTaskFormDraft(storage,other),draft());
  assert.equal(storage.getItem('unrelated-app-key'),'keep');
  assert.equal(clearTaskFormDrafts(storage,''),false);
});

test('new Hub task drafts restore per account and project and explicit cancel discards only that draft',()=>{
  const storage=new MemoryStorage();
  const first=key('account-a','project-a','__new_task__','create');
  const otherAccount=key('account-b','project-a','__new_task__','create');
  const otherProject=key('account-a','project-b','__new_task__','create');
  const value=draft({title:'Phone task',goal:'Keep this after interruption',criteria:'Check one'},0,'new-task');
  assert.equal(saveTaskFormDraft(storage,first,value),true);
  assert.deepEqual(readTaskFormDraft(storage,first),value);
  assert.equal(readTaskFormDraft(storage,otherAccount),null);
  assert.equal(readTaskFormDraft(storage,otherProject),null);
  assert.equal(discardTaskFormDraft(storage,first,value),true);
  assert.equal(readTaskFormDraft(storage,first),null);
});

test('Hub task creation gate explains identity, role, connectivity, node capability and unresolved requests',()=>{
  const base={role:'controller',hasIdentity:true,remote:true,online:true,available:true,pending:false};
  assert.equal(taskCreateAvailabilityReason(base),'');
  assert.match(taskCreateAvailabilityReason({...base,hasIdentity:false}),/确认连接身份/);
  assert.match(taskCreateAvailabilityReason({...base,role:'viewer'}),/只有查看权限/);
  assert.match(taskCreateAvailabilityReason({...base,role:undefined}),/没有新建任务的写入权限/);
  assert.match(taskCreateAvailabilityReason({...base,online:false}),/目标电脑未在线/);
  assert.match(taskCreateAvailabilityReason({...base,available:undefined}),/版本较旧/);
  assert.match(taskCreateAvailabilityReason({...base,pending:true}),/不能重复提交/);
});

test('Hub task body has only the six create fields and trims criteria to nonempty lines',()=>{
  const body=hubTaskCreateBody({title:'  Title ',goal:' Goal ',example:' ',summary:' Summary ',approach:' Plan ',criteria:' one \n\n two ',sourceProvider:'must not leak',conversationId:'must not leak'});
  assert.deepEqual(Object.keys(body),['title','goal','example','summary','approach','criteria']);
  assert.deepEqual(body,{title:'Title',goal:'Goal',example:'',summary:'Summary',approach:'Plan',criteria:['one','two']});
});

test('create receipt only confirms a completed planned task with its original command envelope',()=>{
  const receipt={commandId:'cmd-1',projectId:'p1',taskId:'cmd-1',action:'create_task',status:'completed',result:{taskId:'real-1',status:'planned',revision:1}};
  assert.equal(confirmedHubTaskId(receipt,'cmd-1','p1'),'real-1');
  assert.equal(confirmedHubTaskId({...receipt,status:'received'},'cmd-1','p1'),null);
  assert.equal(confirmedHubTaskId({...receipt,taskId:'other'},'cmd-1','p1'),null);
  assert.equal(confirmedHubTaskId({...receipt,projectId:'other'},'cmd-1','p1'),null);
  assert.equal(confirmedHubTaskId({...receipt,result:{taskId:'real-1',status:'running',revision:1}},'cmd-1','p1'),null);
  assert.equal(confirmedHubTaskId({...receipt,result:{taskId:'real-1',status:'planned',revision:2}},'cmd-1','p1'),null);
});
