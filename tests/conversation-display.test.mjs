import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

const source=await readFile(new URL('../src/conversation-display.ts',import.meta.url),'utf8');
const compiled=stripTypeScriptTypes(source,{mode:'transform'});
const {conversationDisplay,messageCompletionLabel}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const task=(id,status)=>({id,status});
const output=(taskId,status,extra={})=>({taskId,status,messages:[{id:'tool',status:'completed',text:'本轮已结束'}],updatedAt:'2026-01-01T00:00:00Z',truncated:false,...extra});

test('submitted task wins over stale running output without treating a completed tool as acceptance',()=>{
  const result=conversationDisplay(task('A','submitted'),output('A','running'));
  assert.equal(result.taskStatus,'待验收');assert.equal(result.outputSyncPending,true);
  assert.equal(result.visible.messages[0].status,'completed');
});
test('running task wins over stale submitted output',()=>{
  const result=conversationDisplay(task('A','running'),output('A','submitted'));
  assert.equal(result.taskStatus,'进行中');assert.equal(result.outputSyncPending,true);
});
test('task switch hides old output; first loading and absent output are not conflicts',()=>{
  assert.deepEqual(conversationDisplay(task('B','planned'),output('A','running')),{visible:null,taskStatus:'待开始',outputSyncPending:false});
  assert.equal(conversationDisplay(task('B','planned'),output('B','loading')).outputSyncPending,false);
  assert.equal(conversationDisplay(task('B','planned'),null).outputSyncPending,false);
  assert.equal(conversationDisplay(null,output('A','running')).visible,null);
});
test('matching output keeps truncation and timestamp independent of task status',()=>{
  const result=conversationDisplay(task('A','submitted'),output('A','submitted',{truncated:true}));
  assert.equal(result.outputSyncPending,false);
  assert.equal(result.visible.truncated,true);
  assert.equal(result.visible.updatedAt,'2026-01-01T00:00:00Z');
});
test('a completed tool is not presented as the whole turn ending',()=>{
  assert.equal(messageCompletionLabel('tool','completed'),'工具已完成');
  assert.equal(messageCompletionLabel('assistant','completed'),'已完成');
  assert.equal(messageCompletionLabel('system','turn_completed'),'本轮已结束');
});
