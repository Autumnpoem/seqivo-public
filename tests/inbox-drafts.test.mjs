import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

const source=await readFile(new URL('../src/inbox-drafts.ts',import.meta.url),'utf8');
const compiled=stripTypeScriptTypes(source,{mode:'transform'});
const {inboxDraftKey,readInboxDraft,saveInboxDraft,removeSubmittedInboxDraft,
  clearInboxDrafts,clearInboxSubmittedDrafts,confirmedInboxAction}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

class MemoryStorage{
  values=new Map();
  get length(){return this.values.size;}
  key(index){return [...this.values.keys()][index]??null;}
  getItem(key){return this.values.get(String(key))??null;}
  setItem(key,value){this.values.set(String(key),String(value));}
  removeItem(key){this.values.delete(String(key));}
}
const key=(account='a',project='p',task='t',item='i')=>inboxDraftKey(account,project,task,item);
const draft=(answer='未提交',contentVersion='opaque:1')=>({answer,optionId:'option-1',revision:4,contentVersion,itemRevision:2});

test('account, project, task and item scope never collide',()=>{
  assert.equal(key('','p','t','i'),null);
  assert.equal(key('a','','t','i'),null);
  assert.equal(key('a','p','','i'),null);
  assert.equal(key('a','p','t',''),null);
  const keys=[key(),key('b'),key('a','q'),key('a','p','u'),key('a','p','t','j')];
  assert.equal(new Set(keys).size,keys.length);
  assert.notEqual(key('a:b','c','d','e'),key('a','b:c','d','e'));
});

test('draft answer, option and original task/item versions survive another read',()=>{
  const storage=new MemoryStorage(),scope=key(),value=draft();
  assert.equal(saveInboxDraft(storage,scope,value),true);
  assert.deepEqual(readInboxDraft(storage,scope),value);
  assert.equal(readInboxDraft(storage,key('b')),null);
  assert.deepEqual(readInboxDraft(storage,scope),value);
});

test('invalid stored draft or storage failure is not presented as saved',()=>{
  const storage=new MemoryStorage(),scope=key();
  for(const raw of ['not-json','[]','{}',JSON.stringify({...draft(),answer:3}),
    JSON.stringify({...draft(),contentVersion:''}),JSON.stringify({...draft(),itemRevision:0})]){
    storage.setItem(scope,raw);
    assert.equal(readInboxDraft(storage,scope),null);
  }
  storage.setItem=()=>{throw Error('quota');};
  assert.equal(saveInboxDraft(storage,scope,draft()),false);
  storage.getItem=()=>{throw Error('denied');};
  assert.equal(readInboxDraft(storage,scope),null);
  assert.equal(removeSubmittedInboxDraft(storage,scope,draft()),false);
});

test('late confirmed submission cannot erase revised text or a changed version',()=>{
  const storage=new MemoryStorage(),scope=key(),other=key('a','p','t','j');
  const submitted=draft('first'),revised=draft('new answer');
  assert.equal(saveInboxDraft(storage,scope,submitted),true);
  assert.equal(saveInboxDraft(storage,other,submitted),true);
  assert.equal(saveInboxDraft(storage,scope,revised),true);
  assert.equal(removeSubmittedInboxDraft(storage,scope,submitted),true);
  assert.deepEqual(readInboxDraft(storage,scope),revised);
  assert.equal(removeSubmittedInboxDraft(storage,scope,{...revised,itemRevision:3}),true);
  assert.deepEqual(readInboxDraft(storage,scope),revised);
  assert.equal(removeSubmittedInboxDraft(storage,scope,revised),true);
  assert.equal(readInboxDraft(storage,scope),null);
  assert.deepEqual(readInboxDraft(storage,other),submitted);
  assert.equal(removeSubmittedInboxDraft(storage,scope,submitted),true);
});

test('only a matching completed inbox receipt proves submission',()=>{
  const result={status:'completed',taskId:'t',itemId:'i',itemRevision:3};
  assert.equal(confirmedInboxAction('completed',result,'t','i',2),true);
  for(const status of ['queued','received','sending','running','unknown','failed','expired'])
    assert.equal(confirmedInboxAction(status,result,'t','i',2),false);
  assert.equal(confirmedInboxAction('completed',{...result,itemRevision:2},'t','i',2),false);
  assert.equal(confirmedInboxAction('completed',{...result,itemId:'j'},'t','i',2),false);
  assert.equal(confirmedInboxAction('completed',{...result,taskId:'u'},'t','i',2),false);
  assert.equal(confirmedInboxAction('completed',{...result,status:'running'},'t','i',2),false);
});

test('account clearing removes only exact account inbox drafts',()=>{
  const storage=new MemoryStorage(),own=[key(),key('a','q','t','i')],other=key('b');
  for(const scope of [...own,other])assert.equal(saveInboxDraft(storage,scope,draft()),true);
  storage.setItem('other-feature','keep');
  assert.equal(clearInboxDrafts(storage,'a'),true);
  for(const scope of own)assert.equal(readInboxDraft(storage,scope),null);
  assert.deepEqual(readInboxDraft(storage,other),draft());
  assert.equal(storage.getItem('other-feature'),'keep');
  assert.equal(clearInboxDrafts(storage,''),false);
});

test('logout strips submitted answer from this account pending commands without losing unknown IDs',()=>{
  const origin='https://board.example';
  const local=new MemoryStorage(),session=new MemoryStorage();
  const accountKey=`seqivo-inbox-commands-v1:${origin}:account-a`;
  const otherKey=`seqivo-inbox-commands-v1:${origin}:account-b`;
  const own=[{commandId:'unknown-command',status:'unknown',itemId:'item-1',
    draftKey:key('account-a'),submittedDraft:draft('private decision')}];
  const other=[{commandId:'other-command',status:'unknown',itemId:'item-2',
    draftKey:key('account-b'),submittedDraft:draft('other account answer')}];
  session.setItem(accountKey,JSON.stringify(own));
  session.setItem(otherKey,JSON.stringify(other));
  saveInboxDraft(local,key('account-a'),own[0].submittedDraft);
  assert.equal(clearInboxDrafts(local,'account-a'),true);
  assert.equal(clearInboxSubmittedDrafts(session,'account-a',origin),true);
  const preserved=JSON.parse(session.getItem(accountKey));
  assert.equal(preserved[0].commandId,'unknown-command');
  assert.equal(preserved[0].status,'unknown');
  assert.equal(preserved[0].submittedDraft,undefined);
  assert.equal(preserved[0].draftKey,undefined);
  assert.deepEqual(JSON.parse(session.getItem(otherKey)),other);
});
