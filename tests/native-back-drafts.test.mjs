import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const appText=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
const draftSource=await readFile(new URL('../src/task-form-drafts.ts',import.meta.url),'utf8');
const draftModule=await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(draftSource,{mode:'transform'})).toString('base64')}`);

function findMatchingBrace(source,open){
  let depth=0,state='code',escaped=false;
  for(let i=open;i<source.length;i++){
    const char=source[i],next=source[i+1];
    if(state==='line'){if(char==='\n')state='code';continue;}
    if(state==='block'){if(char==='*'&&next==='/'){state='code';i++;}continue;}
    if(state!=='code'){
      if(escaped){escaped=false;continue;}
      if(char==='\\'){escaped=true;continue;}
      if(state==='single'&&char==="'"||state==='double'&&char==='"'||state==='template'&&char==='`')state='code';
      continue;
    }
    if(char==='/'&&next==='/'){state='line';i++;continue;}
    if(char==='/'&&next==='*'){state='block';i++;continue;}
    if(char==="'"){state='single';continue;}
    if(char==='"'){state='double';continue;}
    if(char==='`'){state='template';continue;}
    if(char==='{')depth++;
    else if(char==='}'&&--depth===0)return i;
  }
  throw new Error('unterminated production handler body');
}

function extractBody(marker){
  const start=appText.indexOf(marker);
  assert.notEqual(start,-1,`production handler not found: ${marker}`);
  const open=appText.indexOf('{',start+marker.length-1);
  assert.notEqual(open,-1,'production handler body not found');
  return appText.slice(open+1,findMatchingBrace(appText,open));
}

function extractFunction(marker){
  const start=appText.indexOf(marker);
  assert.notEqual(start,-1,`production function not found: ${marker}`);
  const open=appText.indexOf('{',start+marker.length-1);
  assert.notEqual(open,-1,'production function body not found');
  return appText.slice(start,findMatchingBrace(appText,open)+1);
}

function compileFunction(body,context){
  return vm.runInContext(`(function(){${body}\n})`,context);
}

function compileDeclaration(declaration,context){
  return vm.runInContext(`(${declaration})`,context);
}

class MemoryStorage{
  values=new Map();
  getItem(key){return this.values.get(String(key))??null;}
  setItem(key,value){this.values.set(String(key),String(value));}
  removeItem(key){this.values.delete(String(key));}
}

function setup(dialog,draft,{busy=false,pending=false}={}){
  const storage=new MemoryStorage();
  const key=draftModule.taskFormDraftKey('account-a','project-a',dialog==='task'?'__new_task__':'task-a',dialog==='task'?'create':dialog);
  assert.ok(key);
  assert.equal(draftModule.saveTaskFormDraft(storage,key,draft),true);
  const sandbox={
    authenticated:true,state:{},dialog,busy,
    formDraftRef:{current:{key,draft}},formDraftStorage:storage,
    activeAccountId:'account-a',storedPendingCommands:()=>pending?[{action:'create_task',accountId:'account-a',draftKey:key}]:[],
    discardTaskFormDraft:draftModule.discardTaskFormDraft,
    saveTaskFormDraft:draftModule.saveTaskFormDraft,
    setFormDraftNotice:value=>{sandbox.formDraftNotice=value;},
    setDialog:value=>{sandbox.dialog=value;},
    setDialogTaskBinding:value=>{sandbox.dialogTaskBinding=value;},
    setDialogCreateProjectId:value=>{sandbox.dialogCreateProjectId=value;},
    setError:value=>{sandbox.error=value;},
    setNotice:value=>{sandbox.notice=value;},
    setNoticeWarning:value=>{sandbox.noticeWarning=value;},
  };
  const context=vm.createContext(sandbox);
  sandbox.closeDialog=compileDeclaration(extractFunction('function closeDialog('),context);
  const useNativeBackHandler=compileFunction(extractBody('useNativeBack(()=>{'),context);
  return {storage,key,draft,sandbox,useNativeBackHandler};
}

const cases=[
  ['task',{revision:0,contentVersion:'new-task',values:{title:'New task',goal:'Goal',criteria:'Check'},reviewDecision:'pass'}],
  ['edit',{revision:4,contentVersion:3,values:{title:'Edited task',goal:'Goal'},reviewDecision:'pass'}],
  ['evidence',{revision:4,contentVersion:3,values:{summary:'Evidence',reference:'file.txt'},reviewDecision:'pass'}],
  ['review',{revision:4,contentVersion:3,values:{summary:'Review note'},reviewDecision:'fail'}],
];

test('system Back executes the App handler and preserves create/edit/evidence/review drafts for reopening',()=>{
  for(const [dialog,draft] of cases){
    const {storage,key,sandbox,useNativeBackHandler}=setup(dialog,draft);
    assert.equal(useNativeBackHandler(),true,`${dialog} Back request is consumed`);
    assert.equal(sandbox.dialog,null,`${dialog} closes`);
    assert.deepEqual(draftModule.readTaskFormDraft(storage,key),draft,`${dialog} restores exact fields and review decision`);
  }
});

test('explicit close still executes the destructive closeDialog behavior',()=>{
  const {storage,key,draft,sandbox}=setup('review',cases[3][1]);
  sandbox.closeDialog();
  assert.equal(sandbox.dialog,null);
  assert.equal(draftModule.readTaskFormDraft(storage,key),null,'explicit close discards the stored snapshot');
  assert.equal(draft.reviewDecision,'fail');
});

test('system Back keeps the existing busy and pending-create gates',()=>{
  const busy=setup('edit',cases[1][1],{busy:true});
  assert.equal(busy.useNativeBackHandler(),true);
  assert.equal(busy.sandbox.dialog,'edit','busy form stays open');
  assert.deepEqual(draftModule.readTaskFormDraft(busy.storage,busy.key),busy.draft);

  const pending=setup('task',cases[0][1],{pending:true});
  assert.equal(pending.useNativeBackHandler(),true);
  assert.equal(pending.sandbox.dialog,null,'pending create can be collapsed');
  assert.deepEqual(draftModule.readTaskFormDraft(pending.storage,pending.key),pending.draft);
  assert.match(pending.sandbox.notice,/请求仍在核实中/);
});

test('system Back keeps the dialog and in-memory draft open when saving the snapshot fails',()=>{
  const fixture=setup('review',cases[3][1]);
  const originalDraftRef=fixture.sandbox.formDraftRef.current;
  fixture.storage.setItem=()=>{throw new Error('quota exceeded');};
  assert.equal(fixture.useNativeBackHandler(),true);
  assert.equal(fixture.sandbox.dialog,'review','the user can still copy or retry the form');
  assert.equal(fixture.sandbox.formDraftRef.current,originalDraftRef,'the in-memory draft remains available');
  assert.deepEqual(draftModule.readTaskFormDraft(fixture.storage,fixture.key),fixture.draft,'the prior persisted draft is not treated as replaced');
  assert.match(fixture.sandbox.error,/未能保存草稿/);
  assert.match(fixture.sandbox.formDraftNotice,/窗口保持打开/);
});
