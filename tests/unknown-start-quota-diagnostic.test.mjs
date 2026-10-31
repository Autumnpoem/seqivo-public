import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source=await readFile(new URL('../src/receipt-messages.ts',import.meta.url),'utf8');
const compiled=stripTypeScriptTypes(source,{mode:'transform'});
const {unknownStartQuotaText,loadUnknownStartQuotaDiagnostic}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const receipt={commandId:'start-cmd-1',projectId:'project-1',taskId:'task-1',action:'start_task',status:'unknown',
  result:{taskId:'task-1',status:'waiting_quota'}};
const message='AI 额度暂不可用。请等额度恢复后核对这次操作；结果未确认前请勿重复提交。';

test('quota diagnosis requires the exact unknown start-task receipt and matching task',()=>{
  assert.equal(unknownStartQuotaText(receipt,'start-cmd-1'),message);
  assert.equal(unknownStartQuotaText({...receipt,commandId:'other-command'},'start-cmd-1'),null);
  assert.equal(unknownStartQuotaText(receipt,'other-command'),null);
  assert.equal(unknownStartQuotaText({...receipt,taskId:'other-task'},'start-cmd-1'),null);
  assert.equal(unknownStartQuotaText({...receipt,result:{...receipt.result,taskId:'other-task'}},'start-cmd-1'),null);
  assert.equal(unknownStartQuotaText({...receipt,action:'continue'},'start-cmd-1'),null);
  assert.equal(unknownStartQuotaText({...receipt,status:'running'},'start-cmd-1'),null);
  assert.equal(unknownStartQuotaText({...receipt,result:{...receipt.result,status:'running'}},'start-cmd-1'),null);
  assert.equal(receipt.status,'unknown','diagnostic does not resolve or rewrite the original unknown receipt');
});

test('read-only diagnostic suppresses a late receipt when its current-command guard changes',async()=>{
  let current=true,resolveRead;
  const displayed=[],reads=[];
  const pending=loadUnknownStartQuotaDiagnostic('start-cmd-1',async commandId=>{
    reads.push(commandId);
    return new Promise(resolve=>{resolveRead=resolve;});
  },()=>current,text=>displayed.push(text));
  current=false;
  resolveRead(receipt);
  await pending;
  assert.deepEqual(reads,['start-cmd-1']);
  assert.deepEqual(displayed,[],'late results cannot change the current UI');
});

test('diagnostic uses only the supplied receipt read and never confirms or reconciles a command',async()=>{
  const calls=[],displayed=[];
  await loadUnknownStartQuotaDiagnostic('start-cmd-1',async commandId=>{
    calls.push({method:'GET',commandId});
    return receipt;
  },()=>true,text=>displayed.push(text));
  assert.deepEqual(calls,[{method:'GET',commandId:'start-cmd-1'}]);
  assert.deepEqual(displayed,[message]);
});

test('diagnostic does not swallow guard or display callback errors',async()=>{
  await assert.rejects(loadUnknownStartQuotaDiagnostic('start-cmd-1',async()=>receipt,
    ()=>{throw new Error('guard failed');},()=>{}),/guard failed/);
  await assert.rejects(loadUnknownStartQuotaDiagnostic('start-cmd-1',async()=>receipt,
    ()=>true,()=>{throw new Error('display failed');}),/display failed/);
});

async function actualCheckHarness(initialDiagnostic){
  const component=await readFile(new URL('../src/CommandRecovery.tsx',import.meta.url),'utf8');
  const start=component.indexOf('  async function check(){');
  const end=component.indexOf('\n  return <div className="command-recovery"',start);
  assert(start>=0&&end>start);
  const actualCheck=component.slice(start,end).replaceAll('request<CommandReceipt>','request');
  const state={diagnostic:initialDiagnostic,message:''};
  const recovery={outcome:'applied',requestedAt:'2026-01-01T00:00:00Z',checkedAt:'2026-01-01T00:00:01Z'};
  const resolved={...receipt,status:'completed',result:{taskId:receipt.taskId,status:'completed'},recovery};
  const context=vm.createContext({
    busyRef:{current:false},enabled:{current:true},isCurrentRef:{current:()=>true},generation:{current:1},
    currentIdentity:{current:'account-a'},currentCommand:{current:receipt.commandId},
    onResolvedRef:{current:()=>{}},commandId:receipt.commandId,identityKey:'account-a',
    initialDiagnosticActive:{current:true},setQuotaDiagnostic:value=>{state.diagnostic=value;},
    setBusy:()=>{},setMessage:value=>{state.message=value;},
    request:async method=>method==='GET'?resolved:{},confirmed:()=>true,reviewRejectionText:()=>null,
    unknownStartQuotaText,
    ApiError:class ApiError extends Error{},errorText:()=>'',window:{setTimeout},
  });
  const check=vm.runInContext(`(()=>{${actualCheck};return check})()`,context);
  return {state,context,check};
}

test('actual manual check clears an old quota hint when the original command is confirmed',async()=>{
  const {state,check}=await actualCheckHarness(message);
  await check();
  assert.match(state.message,/已确认这次操作已执行/);
  assert.equal(state.diagnostic,'','confirmed manual receipt removes the stale quota warning');
});

test('actual manual check invalidates the mount GET before a late quota receipt can restore its hint',async()=>{
  const {state,context,check}=await actualCheckHarness('');
  let resolveInitial;
  const initial=loadUnknownStartQuotaDiagnostic(receipt.commandId,()=>new Promise(resolve=>{resolveInitial=resolve;}),
    ()=>context.initialDiagnosticActive.current,
    value=>{state.diagnostic=value;});
  await check();
  resolveInitial(receipt);
  await initial;
  assert.match(state.message,/已确认这次操作已执行/);
  assert.equal(state.diagnostic,'','late initial GET cannot restore quota hint after manual verification');
});
