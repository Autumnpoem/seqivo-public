import type {BoardState,ConversationStartGate,ExecutionWriteReason,Project,Task,TaskExecutionWriteGate} from './types';

type GateResult={ready:boolean;reason:string;bootId:string|null};
const reasons:Record<ExecutionWriteReason,string>={
  ACTIVE_EXECUTION:'任务正在执行，请等待当前操作完成。',
  HUMAN_CONTROL:'任务已交给人工处理，请先在电脑核对执行权。',
  WORKSPACE_BUSY:'工作区正在使用，请稍后刷新核对。',
  SOURCE_CHANGED:'任务或执行位置已变化，请刷新后核对。',
  BINDING_UNAVAILABLE:'任务会话尚未确认，请在电脑核对。',
  CORE_UNAVAILABLE:'项目电脑的执行状态暂不可确认，请刷新后重试。',
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable:GateResult={ready:false,reason:'正在核对项目电脑状态，请刷新后再发送。',bootId:null};
function base(value:unknown,now:number):string|null{
  if(!value||typeof value!=='object')return null;
  const gate=value as {v?:unknown;bootId?:unknown;observedAt?:unknown};
  if(gate.v!==1||typeof gate.bootId!=='string'||!uuid.test(gate.bootId)||typeof gate.observedAt!=='string'||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(gate.observedAt))return null;
  const observed=Date.parse(gate.observedAt);
  return Number.isFinite(observed)&&now-observed<=10_000&&observed-now<=2_000?gate.bootId:null;
}
function action(value:unknown,bootId:string|null):GateResult{
  if(!bootId||!value||typeof value!=='object')return unavailable;
  const gate=value as {state?:unknown;reasonCode?:unknown};
  if(gate.state==='ready'&&gate.reasonCode===null)return {ready:true,reason:'',bootId};
  if((gate.state==='blocked'||gate.state==='unknown')&&typeof gate.reasonCode==='string'&&Object.prototype.hasOwnProperty.call(reasons,gate.reasonCode))
    return {ready:false,reason:gate.state==='unknown'&&gate.reasonCode==='ACTIVE_EXECUTION'?'上次执行结果尚未确认，请先在电脑核对。':reasons[gate.reasonCode as ExecutionWriteReason],bootId};
  return unavailable;
}
export function messageGate(task:Task|null,now=Date.now()):GateResult{
  if(!task)return unavailable;
  const gate=task.executionWrite as TaskExecutionWriteGate|undefined;
  if(!gate||gate.taskRevision!==task.revision||gate.contentVersion!==task.contentVersion)return unavailable;
  return action(gate.message,base(gate,now));
}
export function continueGate(task:Task|null,now=Date.now()):GateResult{
  if(!task)return unavailable;
  const gate=task.executionWrite as TaskExecutionWriteGate|undefined;
  if(!gate||gate.taskRevision!==task.revision||gate.contentVersion!==task.contentVersion)return unavailable;
  return action(gate.continue,base(gate,now));
}
export function startTaskGate(task:Task|null,board:BoardState,now=Date.now()):GateResult{
  if(!task)return unavailable;
  if(board.connection.mode==='hub'&&board.capabilities.taskStart!==true)
    return {ready:false,reason:'此手机连接暂不支持启动已有任务，请在目标电脑更新后重试。',bootId:null};
  if(task.status!=='planned'||task.hasExecutionBinding||task.conversationId||task.executionProvider&&task.executionProvider!=='codex-autocontinue')
    return {ready:false,reason:'仅未绑定的待开始 Codex 任务可以从这里启动。',bootId:null};
  const gate=task.executionWrite as TaskExecutionWriteGate|undefined;
  if(!gate||gate.taskRevision!==task.revision||gate.contentVersion!==task.contentVersion)return unavailable;
  return action(gate.start,base(gate,now));
}
export function conversationStartGate(project:Project|null,now=Date.now()):GateResult{
  if(!project)return unavailable;
  const gate=project.conversationStart as ConversationStartGate|undefined;
  return action(gate,base(gate,now));
}
export function freshTaskGate(original:Task,originalBootId:string|null,board:BoardState,kind:'message'|'continue'|'start',now=Date.now()):GateResult{
  if(!board.projects.some(project=>project.id===original.projectId))return unavailable;
  const latest=board.tasks.find(task=>task.id===original.id&&task.projectId===original.projectId);
  if(!latest||latest.revision!==original.revision||latest.contentVersion!==original.contentVersion)
    return {ready:false,reason:'任务或项目状态已变化，请刷新后核对。',bootId:null};
  const gate=kind==='message'?messageGate(latest,now):kind==='continue'?continueGate(latest,now):startTaskGate(latest,board,now);
  return gate.ready&&gate.bootId!==originalBootId?{ready:false,reason:'项目电脑已重新启动，请刷新后核对。',bootId:null}:gate;
}
export function freshConversationStartGate(original:Project,originalBootId:string|null,board:BoardState,now=Date.now()):GateResult{
  const latest=board.projects.find(project=>project.id===original.id);
  const gate=conversationStartGate(latest||null,now);
  return gate.ready&&gate.bootId!==originalBootId?{ready:false,reason:'项目电脑已重新启动，请刷新后核对。',bootId:null}:gate;
}
