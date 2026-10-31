import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteHandoff} from '../src/handoff-summary.ts';

const project=(id,name)=>({id,name,goal:`${name}的目标`,directory:'/private/not-shared',createdAt:'2026-01-01T00:00:00Z'});
const task=(id,projectId,status='running',acceptance='unverified')=>({id,projectId,title:`任务${id}`,goal:'可共享目标',summary:'正在核对结果',nextStep:'请检查页面',status,acceptance,issues:[],criteria:[],evidence:[],updatedAt:'2026-01-01T00:00:00Z'});
const board={connection:{mode:'hub',lastSeen:'2026-01-01T00:00:00Z'},projects:[project('a','甲'),project('b','乙')],
  tasks:[task('one','a'),task('two','a','submitted','passed'),task('three','a','submitted'),task('secret','b')],
  inbox:{items:[{projectId:'a',kind:'decision',state:'open',shareWithRemote:true,title:'确定入口',recommendedAction:'选择方案'},
    {projectId:'a',kind:'decision',state:'open',shareWithRemote:false,title:'私人决定',recommendedAction:'内部资料'},
    {projectId:'b',kind:'decision',state:'open',shareWithRemote:true,title:'乙的决定',recommendedAction:'不要泄露'}]}};

test('Hub handoff uses only the selected authorized projection',()=>{
  const result=remoteHandoff(board,'a');assert.ok(result);
  assert.equal(result.taskCount,3);
  assert.match(result.text,/甲的目标/);
  assert.match(result.text,/已验收 1 项；正在做 1 项；待人工验收 1 项/);
  assert.match(result.text,/任务one.*正在核对结果.*请检查页面/s);
  assert.match(result.text,/确定入口：选择方案/);
  assert.doesNotMatch(result.text,/任务secret|乙的目标|乙的决定|私人决定|内部资料|private\/not-shared/);
  assert.equal(remoteHandoff(board,'revoked'),null);
  assert.equal(remoteHandoff({...board,projects:board.projects.filter(item=>item.id!=='a')},'a'),null);
  assert.equal(remoteHandoff({...board,connection:{mode:'local'}},'a'),null);
});

test('empty authorized project is explicit and cancelled work is not presented as current',()=>{
  const result=remoteHandoff({...board,tasks:[task('cancelled','a','cancelled')]},'a');
  assert.ok(result);assert.equal(result.taskCount,0);assert.match(result.text,/共 0 项未取消任务/);
  assert.doesNotMatch(result.text,/任务cancelled/);
});
