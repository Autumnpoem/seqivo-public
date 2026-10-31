import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {MessageSquarePlus,Pause,RefreshCw,Send} from 'lucide-react';
import {ApiError,ReadTimeoutError,errorMessage as message,isDesktop,request} from './api';
import CommandRecovery from './CommandRecovery';
import {conversationDraftKey} from './conversation-drafts';
import {useConversationDraft,type ConversationDraftSnapshot} from './lib/use-conversation-draft';
import {conversationDisplay,messageCompletionLabel} from './conversation-display';
import {conversationStartGate,freshConversationStartGate,freshTaskGate,messageGate,startTaskGate} from './execution-write-gate';
import type {BoardState,CommandReceipt,Conversation,Task} from './types';

const receiptPending=(receipt:CommandReceipt)=>['queued','received','sending'].includes(receipt.status)||(receipt.status==='running'&&receipt.result==null&&!receipt.error);
const finalStatus=(receipt:CommandReceipt)=>!receiptPending(receipt)&&receipt.status!=='unknown';
const uncertain=(error:unknown)=>!(error instanceof ApiError)||error.status>=500;
const statusLabel:Record<string,string>={inProgress:'进行中',loading:'等待电脑同步',running:'进行中',created:'已创建',paused:'已暂停',planned:'待开始',submitted:'待验收',completed:'本轮已结束',turn_completed:'本轮已结束',awaiting_approval:'等待授权',waiting_quota:'等待额度恢复',blocked:'遇到阻碍',unknown:'结果待核查',failed:'失败',cancelled:'已取消'};
function taskFromReceipt(receipt:CommandReceipt):string{
  const result=receipt.result;
  if(result&&typeof result==='object'&&'taskId' in result&&typeof result.taskId==='string')return result.taskId;
  return '';
}
function confirmedTaskStart(receipt:CommandReceipt,task:Task|null,commandId:string):boolean{
  if(!task||receipt.commandId!==commandId||receipt.projectId!==task.projectId||receipt.taskId!==task.id||receipt.action!=='start_task'||receipt.status!=='running'||!receipt.result||typeof receipt.result!=='object')return false;
  const result=receipt.result as {taskId?:unknown;status?:unknown};
  return result.taskId===task.id&&['running','submitted','completed','awaiting_approval'].includes(String(result.status));
}
function confirmedLocalTaskStart(value:unknown,task:Task|null):boolean{
  if(!task||!value||typeof value!=='object')return false;
  const result=value as {taskId?:unknown;status?:unknown};
  return result.taskId===task.id&&['running','submitted','completed','awaiting_approval'].includes(String(result.status));
}
export default function ConversationPanel({board,projectId,selectedTaskId,onSelectTask,onOpenTask,onOpenTerminal,onRefresh,clientOnline=true,onClientOffline=()=>{},getClientStatus=()=>({online:clientOnline&&navigator.onLine,epoch:0}),accountScopeReady=true,pendingTaskCommands=[],getPendingTaskCommands=()=>[],getPendingProjectCommands=()=>[],onRememberTaskCommand=()=>{},onForgetTaskCommand=()=>{},identityKey='',canReconcile=false,isRecoveryCurrent=()=>true,onRecoveryResolved=()=>{}}:{board:BoardState;projectId:string;selectedTaskId:string;onSelectTask:(id:string)=>void;onOpenTask?:(taskId:string,projectId:string)=>void;onOpenTerminal?:(taskId:string,projectId:string)=>void;onRefresh:()=>Promise<void>;clientOnline?:boolean;onClientOffline?:()=>void;getClientStatus?:()=>{online:boolean;epoch:number};accountScopeReady?:boolean;pendingTaskCommands?:Array<{id?:string;projectId?:string;taskId?:string;action:string;status?:string}>;getPendingTaskCommands?:(taskId:string)=>Array<{id:string;action:string}>;getPendingProjectCommands?:(projectId:string)=>Array<{id:string;action:string}>;onRememberTaskCommand?:(id:string,projectId:string,action:string,taskId?:string,status?:string)=>void;onForgetTaskCommand?:(id:string)=>void;identityKey?:string;canReconcile?:boolean;isRecoveryCurrent?:()=>boolean;onRecoveryResolved?:(receipt:CommandReceipt)=>void}){
  const [conversation,setConversation]=useState<Conversation|null>(null);
  const [loadError,setLoadError]=useState('');const [loading,setLoading]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [pendingId,setPendingId]=useState('');const [pendingKind,setPendingKind]=useState<'new'|'message'|'start_task'|'pause'>('new');
  const pendingStartTaskRef=useRef('');
  const [unconfirmedId,setUnconfirmedId]=useState('');const [unconfirmedStatus,setUnconfirmedStatus]=useState<'unknown'|'failed'|''>('');
  const selectedIdRef=useRef('');const selectedVersionRef=useRef('');const projectIdRef=useRef(projectId);const identityKeyRef=useRef(identityKey);const inFlight=useRef(new Set<string>());const componentGeneration=useRef(0);
  const [gateNow,setGateNow]=useState(()=>Date.now());
  const recoveryGuardRef=useRef(isRecoveryCurrent);recoveryGuardRef.current=isRecoveryCurrent;
  const hub=board.connection.mode==='hub';const clientOffline=!isDesktop()&&(!clientOnline||!navigator.onLine);const canWrite=!clientOffline&&(!hub||accountScopeReady&&board.capabilities.role!=='viewer')&&!board.connection.offline;
  const canWriteRef=useRef(canWrite);canWriteRef.current=canWrite;
  const project=board.projects.find(item=>item.id===projectId);
  const tasks=board.tasks.filter(item=>item.projectId===projectId&&(hub?item.hasExecutionBinding:Boolean(item.conversationId)));
  const selectedTask=board.tasks.find(item=>item.id===selectedTaskId&&item.projectId===projectId);
  const startingTask=Boolean(selectedTask&&selectedTask.status==='planned'&&!selectedTask.hasExecutionBinding&&!selectedTask.conversationId&&(!selectedTask.executionProvider||selectedTask.executionProvider==='codex-autocontinue'));
  const pendingStartTasks=board.tasks.filter(item=>item.projectId===projectId&&item.status==='planned'&&!item.hasExecutionBinding&&!item.conversationId&&pendingTaskCommands.some(command=>command.action==='start_task'&&command.taskId===item.id&&command.projectId===item.projectId));
  const selectableTasks=[...tasks,...pendingStartTasks.filter(item=>!tasks.some(bound=>bound.id===item.id))];
  if(startingTask&&selectedTask&&!selectableTasks.some(item=>item.id===selectedTask.id))selectableTasks.push(selectedTask);
  const draftIdentity=isDesktop()?'local-owner':identityKey;
  const compose=useConversationDraft(conversationDraftKey(draftIdentity,projectId,selectedTask?.id||''));
  const {title,message:draft}=compose.value;
  const setTitle=(title:string)=>compose.update({title});const setDraft=(message:string)=>compose.update({message});
  const pendingDraft=useRef<ConversationDraftSnapshot|null>(null);
  const writeGate=startingTask?startTaskGate(selectedTask||null,board,gateNow):selectedTask?messageGate(project&&selectedTask.projectId===project.id?selectedTask:null,gateNow):conversationStartGate(project||null,gateNow);
  const display=conversationDisplay(selectedTask||null,conversation);
  const selectedTaskIntent=pendingTaskCommands.filter(item=>item.taskId===selectedTaskId);
  const selectedProjectIntent=pendingTaskCommands.filter(item=>item.projectId===project?.id);
  const genericContinuePending=selectedTaskIntent.some(item=>['continue','update'].includes(item.action));
  const genericPausePending=selectedTaskIntent.some(item=>item.action==='pause');
  const genericTaskWritePending=selectedTaskIntent.some(item=>item.action!=='pause');
  const genericNewPending=selectedProjectIntent.some(item=>item.action==='new');
  const recoveryIntents=[...selectedTaskIntent,...selectedProjectIntent].filter(item=>item.id&&item.status==='unknown').filter((item,index,items)=>items.findIndex(candidate=>candidate.id===item.id)===index);
  selectedIdRef.current=selectedTask?.id||'';selectedVersionRef.current=selectedTask?`${selectedTask.revision}:${selectedTask.contentVersion}`:'';projectIdRef.current=projectId;identityKeyRef.current=identityKey;
  useEffect(()=>{
    const intent=pendingTaskCommands.find(item=>item.action==='start_task'&&item.taskId===selectedTaskId&&item.projectId===projectId);
    if(!intent?.id)return;
    if(intent.status==='unknown'){
      pendingStartTaskRef.current=intent.taskId||'';setUnconfirmedId(intent.id);setUnconfirmedStatus('unknown');setPendingId('');setPendingKind('start_task');
    }else{pendingStartTaskRef.current=intent.taskId||'';setPendingKind('start_task');setPendingId(intent.id);}
  },[pendingTaskCommands,selectedTaskId,projectId]);
  useEffect(()=>{
    if(pendingKind==='start_task'&&pendingStartTaskRef.current&&pendingStartTaskRef.current!==selectedTaskId){
      setPendingId('');setPendingKind('new');setUnconfirmedId('');setUnconfirmedStatus('');
    }
  },[selectedTaskId,pendingKind]);
  useEffect(()=>{const timer=window.setInterval(()=>setGateNow(Date.now()),500);return()=>window.clearInterval(timer)},[]);
  useEffect(()=>{const generation=++componentGeneration.current;return()=>{if(componentGeneration.current===generation)componentGeneration.current++;}},[]);
  const load=useCallback(async()=>{
    const id=selectedIdRef.current;if(!id||startingTask||inFlight.current.has(id))return;
    inFlight.current.add(id);setLoading(true);
    try{const value=await request<Conversation>('GET',`/api/tasks/${encodeURIComponent(id)}/conversation`);if(selectedIdRef.current===id){setConversation(value);setLoadError('');}}
    catch(caught){if(!isDesktop()&&(caught instanceof TypeError||caught instanceof ReadTimeoutError))onClientOffline();if(selectedIdRef.current===id)setLoadError(message(caught));}
    finally{inFlight.current.delete(id);if(selectedIdRef.current===id)setLoading(false);}
  },[selectedTask?.id,onClientOffline,startingTask]);
  useEffect(()=>{setConversation(null);setError('');setLoadError('');if(selectedTask&&!startingTask)void load();},[selectedTask?.id,startingTask,load]);
  useEffect(()=>{if(!selectedTask||startingTask||document.visibilityState!=='visible')return;const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void load()},2000);return()=>window.clearInterval(timer)},[selectedTask?.id,startingTask,load]);
  useEffect(()=>{
    if(!pendingId)return;let active=true;let timer:number;
    const poll=async()=>{let terminal=false;try{const receipt=await request<CommandReceipt>('GET',`/api/commands/${encodeURIComponent(pendingId)}`);if(!active||!recoveryGuardRef.current())return;if(receipt.commandId!==pendingId)return;
      if(pendingKind==='start_task'){
        if(!selectedTask||receipt.projectId!==selectedTask.projectId||receipt.taskId!==selectedTask.id||receipt.action!=='start_task')return;
        if(confirmedTaskStart(receipt,selectedTask,pendingId)){
          terminal=true;setPendingId('');onForgetTaskCommand(pendingId);setUnconfirmedId('');setUnconfirmedStatus('');pendingStartTaskRef.current='';
          const currentDraft=compose.capture();compose.clearSubmitted(pendingDraft.current?.key===currentDraft.key?pendingDraft.current:currentDraft);pendingDraft.current=null;
          setNotice('目标电脑已确认在此任务中启动 Codex。正在更新对话。');await onRefresh();void load();return;
        }
        if(receipt.status==='failed'||receipt.status==='expired'){
          terminal=true;setPendingId('');onForgetTaskCommand(pendingId);setUnconfirmedId('');setUnconfirmedStatus('');pendingStartTaskRef.current='';
          setError(receipt.error||'目标电脑没有启动此任务。草稿已保留，核对后可重新提交。');setNotice('');return;
        }
        if(receipt.status==='unknown'||!receiptPending(receipt)){
          terminal=true;setPendingId('');onRememberTaskCommand(pendingId,selectedTask.projectId,'start_task',selectedTask.id,'unknown');setUnconfirmedId(pendingId);setUnconfirmedStatus('unknown');pendingStartTaskRef.current=selectedTask.id;
          setError('启动结果尚未确认；请核对原任务，勿重复启动。');setNotice('');await onRefresh();return;
        }
        setNotice('启动请求已送达，等待目标电脑确认；请勿重复提交。');return;
      }
      const taskId=taskFromReceipt(receipt);if(taskId&&pendingKind==='new'){onSelectTask(taskId);await onRefresh();}
      const acknowledged=receipt.status==='running'&&receipt.result!=null;
      if(finalStatus(receipt)||acknowledged||receipt.status==='unknown'){setPendingId('');if(receipt.status==='unknown')onRememberTaskCommand(pendingId,project?.id||selectedTask?.projectId||projectId,pendingKind,pendingKind==='new'?(taskId||undefined):selectedTaskId,'unknown');else if(pendingKind==='pause')onForgetTaskCommand(pendingId);setUnconfirmedId(['unknown','failed'].includes(receipt.status)?pendingId:'');setUnconfirmedStatus(['unknown','failed'].includes(receipt.status)?receipt.status as 'unknown'|'failed':'');
        if(['failed','expired','unknown'].includes(receipt.status)){setError(receipt.error||`请求${statusLabel[receipt.status]||receipt.status}，请核对目标会话。`);setNotice('');}
        else{if(pendingKind!=='pause'&&pendingDraft.current){compose.clearSubmitted(pendingDraft.current);pendingDraft.current=null;}setNotice('电脑已确认请求，正在更新对话。');}
        await onRefresh();if(pendingKind==='message')void load();return;}
      setNotice('请求已送达，等待电脑确认。');
    }catch(caught){if(active&&recoveryGuardRef.current()){if(!isDesktop()&&(caught instanceof TypeError||caught instanceof ReadTimeoutError))onClientOffline();setError(message(caught));}}
    finally{if(active&&recoveryGuardRef.current()&&!terminal)timer=window.setTimeout(poll,2000);}
    };timer=window.setTimeout(poll,1200);return()=>{active=false;window.clearTimeout(timer)};
  },[pendingId,pendingKind,onRefresh,onSelectTask,load,onClientOffline,onRememberTaskCommand,onForgetTaskCommand,selectedTaskId,identityKey,selectedTask?.id]);
  async function create(event:FormEvent<HTMLFormElement>){event.preventDefault();if(hub&&!getClientStatus().online){setError('连接状态待确认，请刷新后再创建；草稿已保留。');return}if(!canWrite||busy||pendingId||unconfirmedId||genericNewPending)return;
    const cleanTitle=title.trim(),cleanMessage=draft.trim();if(!project||!cleanTitle||!cleanMessage)return;
    if(cleanTitle.length>240||cleanMessage.length>10000){setError('标题最多 240 字，消息最多 10000 字。');return;}
    const initialGate=conversationStartGate(project);if(!initialGate.ready){setError(initialGate.reason);return;}
    if(hub&&getPendingProjectCommands(project.id).some(item=>item.action==='new')){setError('此项目已有新对话等待确认，请先核对原请求。');return;}
    const submittedDraft=compose.capture();const commandId=crypto.randomUUID(),initialClientStatus=getClientStatus(),sendGeneration=componentGeneration.current,initialIdentity=identityKey;let postStarted=false;setBusy(true);setError('');setNotice('');
    try{if(hub){const fresh=await request<BoardState>('GET','/api/state'),currentClientStatus=getClientStatus();
        if(sendGeneration!==componentGeneration.current||projectIdRef.current!==project.id||selectedIdRef.current||identityKeyRef.current!==initialIdentity)return;
        if(!initialClientStatus.online||!currentClientStatus.online||currentClientStatus.epoch!==initialClientStatus.epoch||!canWriteRef.current||fresh.connection.mode!=='hub'||fresh.connection.offline||!fresh.capabilities.remote||fresh.capabilities.role==='viewer'){setError('连接或项目权限已变化；请刷新状态并重新确认后再创建。');return;}
        if(getPendingProjectCommands(project.id).some(item=>item.action==='new')){setError('此项目已有未决操作，请先核对原请求。');return;}
        const freshGate=freshConversationStartGate(project,initialGate.bootId,fresh);
        if(!freshGate.ready){setError(freshGate.reason);return;}
        onRememberTaskCommand(commandId,project.id,'new');}
      pendingDraft.current=submittedDraft;postStarted=true;const receipt=await request<CommandReceipt&{taskId?:string}>('POST','/api/conversations',{projectId:project.id,title:cleanTitle,message:cleanMessage,commandId});
      const taskId=hub?taskFromReceipt(receipt):receipt.taskId||taskFromReceipt(receipt);
      if(taskId){onSelectTask(taskId);await onRefresh();}
      if(hub&&(receiptPending(receipt)||receipt.status==='unknown')){onRememberTaskCommand(commandId,project.id,'new',undefined,receipt.status);setPendingId(commandId);setPendingKind('new');setNotice('新对话已排队，等待电脑创建。');}
      else{if(hub)onForgetTaskCommand(commandId);if(['failed','unknown'].includes(receipt.status)){setError(`创建结果${statusLabel[receipt.status]}，请核对任务清单。`);setUnconfirmedId(commandId);setUnconfirmedStatus(receipt.status as 'unknown'|'failed');}else{compose.clearSubmitted(submittedDraft);pendingDraft.current=null;setNotice('对话已创建，正在读取输出。');}}
    }catch(caught){if(!isDesktop()&&(caught instanceof TypeError||caught instanceof ReadTimeoutError))onClientOffline();setError(message(caught));if(hub&&postStarted&&(uncertain(caught)||caught instanceof ApiError&&[401,403,404].includes(caught.status))){setPendingId(commandId);setPendingKind('new');setNotice('提交结果可能未知。正在核对原请求，请勿重复创建。');}else if(hub&&caught instanceof ApiError&&caught.status>=400&&caught.status<500)onForgetTaskCommand(commandId);else if(!hub&&uncertain(caught))setUnconfirmedId(commandId);}
    finally{setBusy(false);}}
  async function startSelectedTask(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!selectedTask||!startingTask||hub&&!getClientStatus().online){setError('连接或任务状态待确认，请刷新后再开始；草稿已保留。');return;}
    if(!canWrite||busy||pendingId||unconfirmedId||genericTaskWritePending)return;
    const clean=draft.trim();if(!clean||clean.length>10000){setError('请填写 1 至 10000 字的启动说明。');return;}
    const initialGate=startTaskGate(selectedTask,board);if(!initialGate.ready){setError(initialGate.reason);return;}
    if(hub&&getPendingTaskCommands(selectedTask.id).some(item=>item.action==='start_task')){setError('此任务已有启动请求待确认，请先核对原命令。');return;}
    const submittedDraft=compose.capture(),commandId=crypto.randomUUID(),initialClientStatus=getClientStatus(),generation=componentGeneration.current,initialIdentity=identityKey;
    let postStarted=false;setBusy(true);setError('');setNotice('');
    try{
      const fresh=await request<BoardState>('GET','/api/state');
      const currentClientStatus=getClientStatus();
      if(generation!==componentGeneration.current||selectedIdRef.current!==selectedTask.id||selectedVersionRef.current!==`${selectedTask.revision}:${selectedTask.contentVersion}`||projectIdRef.current!==selectedTask.projectId||identityKeyRef.current!==initialIdentity)return;
      if(hub&&(!initialClientStatus.online||!currentClientStatus.online||currentClientStatus.epoch!==initialClientStatus.epoch||!canWriteRef.current||fresh.connection.mode!=='hub'||fresh.connection.offline||!fresh.capabilities.remote||fresh.capabilities.role==='viewer')){setError('连接或项目权限已变化；请刷新状态并重新确认后再开始。');return;}
      if(!hub&&fresh.connection.mode==='hub'){setError('连接模式已变化，请刷新后再开始。');return;}
      const freshGate=freshTaskGate(selectedTask,initialGate.bootId,fresh,'start');if(!freshGate.ready){setError(freshGate.reason);return;}
      if(hub&&getPendingTaskCommands(selectedTask.id).some(item=>item.action==='start_task')){setError('此任务已有启动请求待确认，请先核对原命令。');return;}
      if(hub)onRememberTaskCommand(commandId,selectedTask.projectId,'start_task',selectedTask.id);
      pendingDraft.current=submittedDraft;postStarted=true;
      if(!hub){
        const result=await request<{taskId?:string;status?:string;revision?:number}>('POST',`/api/tasks/${encodeURIComponent(selectedTask.id)}/start`,{message:clean,expectedRevision:selectedTask.revision,commandId});
        if(confirmedLocalTaskStart(result,selectedTask)){compose.clearSubmitted(submittedDraft);pendingDraft.current=null;setNotice('此任务已开始。正在更新对话。');await onRefresh();void load();}
        else{setUnconfirmedId(commandId);setUnconfirmedStatus('unknown');setError('启动结果无法确认；草稿已保留，请刷新任务状态后核对。');}
        return;
      }
      const receipt=await request<CommandReceipt>('POST','/api/commands',{commandId,projectId:selectedTask.projectId,taskId:selectedTask.id,action:'start_task',expectedRevision:selectedTask.revision,expiresAt:new Date(Date.now()+5*60*1000).toISOString(),queueOffline:false,body:{message:clean}});
      if(confirmedTaskStart(receipt,selectedTask,commandId)){
        if(hub)onForgetTaskCommand(commandId);pendingStartTaskRef.current='';setPendingId('');setUnconfirmedId('');setUnconfirmedStatus('');
        compose.clearSubmitted(submittedDraft);pendingDraft.current=null;setNotice('目标电脑已确认在此任务中启动 Codex。正在更新对话。');await onRefresh();void load();return;
      }
      if(receipt.commandId!==commandId||receipt.projectId!==selectedTask.projectId||receipt.taskId!==selectedTask.id||receipt.action!=='start_task'){
        if(hub)onRememberTaskCommand(commandId,selectedTask.projectId,'start_task',selectedTask.id,'unknown');
        pendingStartTaskRef.current=selectedTask.id;setPendingId('');setPendingKind('start_task');
        setUnconfirmedId(commandId);setUnconfirmedStatus('unknown');setError('启动回执无法与原任务对应；结果待核实，请勿重复启动。');return;
      }
      if(receipt.status==='failed'||receipt.status==='expired'){
        if(hub)onForgetTaskCommand(commandId);pendingStartTaskRef.current='';setPendingId('');setPendingKind('new');setError(receipt.error||'目标电脑没有启动此任务。草稿已保留，核对后可重新提交。');return;
      }
      if(hub){
        pendingStartTaskRef.current=selectedTask.id;
        setPendingKind('start_task');
        if(receipt.status==='unknown'||!receiptPending(receipt)){
          onRememberTaskCommand(commandId,selectedTask.projectId,'start_task',selectedTask.id,'unknown');setUnconfirmedId(commandId);setUnconfirmedStatus('unknown');setPendingId('');setError('启动结果尚未确认；请核对原任务，勿重复启动。');setNotice('');
        }else{
          onRememberTaskCommand(commandId,selectedTask.projectId,'start_task',selectedTask.id,receipt.status);setPendingId(commandId);
          setNotice('启动请求已排队，等待目标电脑确认；请勿重复提交。');
        }
      }
    }catch(caught){
      if(!isDesktop()&&(caught instanceof TypeError||caught instanceof ReadTimeoutError))onClientOffline();
      if(hub&&postStarted&&(uncertain(caught)||caught instanceof ApiError&&[401,403,404].includes(caught.status))){pendingStartTaskRef.current=selectedTask.id;onRememberTaskCommand(commandId,selectedTask.projectId,'start_task',selectedTask.id,'unknown');setPendingId('');setPendingKind('start_task');setUnconfirmedId(commandId);setUnconfirmedStatus('unknown');setNotice('启动提交结果可能未知；正在核对原命令，请勿重复启动。');}
      else if(hub&&caught instanceof ApiError&&caught.status>=400&&caught.status<500){onForgetTaskCommand(commandId);pendingStartTaskRef.current='';setPendingId('');setPendingKind('new');setError(message(caught));}
      else{setError(`${message(caught)} 启动结果可能未知，请先核对任务状态，勿重复提交。`);if(postStarted){setUnconfirmedId(commandId);setUnconfirmedStatus('unknown');if(hub)onRememberTaskCommand(commandId,selectedTask.projectId,'start_task',selectedTask.id,'unknown');}}
    }finally{setBusy(false);}
  }
  async function send(event:FormEvent<HTMLFormElement>){event.preventDefault();if(startingTask){await startSelectedTask(event);return;}if(hub&&!getClientStatus().online){setError('连接状态待确认，请刷新后再发送；草稿已保留。');return}if(!canWrite||busy||pendingId||unconfirmedId||genericTaskWritePending||!selectedTask)return;
    const clean=draft.trim();if(!clean||clean.length>10000){setError('请输入 1 至 10000 字的消息。');return;}if(hub&&getPendingTaskCommands(selectedTask.id).length){setError('此任务已有未决操作，请先核对回执后再发送。');return;}
    const initialGate=messageGate(project&&project.id===selectedTask.projectId?selectedTask:null);if(!initialGate.ready){setError(initialGate.reason);return;}
    const submittedDraft=compose.capture();const commandId=crypto.randomUUID();const initialClientStatus=getClientStatus();const sendGeneration=componentGeneration.current,initialIdentity=identityKey;let postStarted=false;setBusy(true);setError('');setNotice('');
    try{let receipt:CommandReceipt;
      if(hub){const fresh=await request<BoardState>('GET','/api/state');const currentClientStatus=getClientStatus();if(sendGeneration!==componentGeneration.current||selectedIdRef.current!==selectedTask.id||selectedVersionRef.current!==`${selectedTask.revision}:${selectedTask.contentVersion}`||projectIdRef.current!==selectedTask.projectId||identityKeyRef.current!==initialIdentity)return;if(!initialClientStatus.online||!currentClientStatus.online||currentClientStatus.epoch!==initialClientStatus.epoch||!canWriteRef.current||fresh.connection.mode!=='hub'||fresh.connection.offline||!fresh.capabilities.remote||fresh.capabilities.role==='viewer'){setError('连接或项目权限已变化；请刷新状态并重新确认后再发送。');return;}if(getPendingTaskCommands(selectedTask.id).length){setError('此任务已有未决操作，请先核对回执后再发送。');return;}const freshGate=freshTaskGate(selectedTask,initialGate.bootId,fresh,'message');if(!freshGate.ready){setError(freshGate.reason);return;}onRememberTaskCommand(commandId,selectedTask.projectId,'message',selectedTask.id);pendingDraft.current=submittedDraft;postStarted=true;receipt=await request<CommandReceipt>('POST','/api/commands',{commandId,projectId:selectedTask.projectId,taskId:selectedTask.id,action:'message',expectedRevision:selectedTask.revision,expiresAt:new Date(Date.now()+5*60*1000).toISOString(),body:{message:clean},queueOffline:false});}
      else{pendingDraft.current=submittedDraft;postStarted=true;receipt=await request<CommandReceipt>('POST',`/api/tasks/${encodeURIComponent(selectedTask.id)}/message`,{message:clean,expectedRevision:selectedTask.revision,commandId});}
      if(hub&&(receiptPending(receipt)||receipt.status==='unknown')){onRememberTaskCommand(commandId,selectedTask.projectId,'message',selectedTask.id,receipt.status);setPendingId(commandId);setPendingKind('message');setNotice('消息已排队，等待电脑回执。');}
      else{if(hub)onForgetTaskCommand(commandId);if(['failed','unknown'].includes(receipt.status)){setError(`发送结果${statusLabel[receipt.status]}，请核对会话。`);setUnconfirmedId(commandId);setUnconfirmedStatus(receipt.status as 'unknown'|'failed');}else{compose.clearSubmitted(submittedDraft);pendingDraft.current=null;setNotice('消息已发送，正在读取输出。');await onRefresh();void load();}}
    }catch(caught){if(!isDesktop()&&(caught instanceof TypeError||caught instanceof ReadTimeoutError))onClientOffline();setError(message(caught));if(hub&&postStarted&&(uncertain(caught)||caught instanceof ApiError&&[401,403,404].includes(caught.status))){setPendingId(commandId);setPendingKind('message');setNotice('提交结果可能未知。正在核对原请求，请勿重复发送。');}else if(hub&&caught instanceof ApiError&&caught.status>=400&&caught.status<500)onForgetTaskCommand(commandId);else if(postStarted&&uncertain(caught))setUnconfirmedId(commandId);}
    finally{setBusy(false);}}
  async function pause(){if(hub&&!getClientStatus().online){setError('连接状态待确认，请刷新后再暂停。');return}if(!canWrite||!selectedTask||busy||pendingId)return;const unresolved=hub?getPendingTaskCommands(selectedTask.id):[];if(unresolved.some(item=>item.action==='pause')||unresolved.some(item=>!['continue','update'].includes(item.action)))return;setBusy(true);setError('');
    const commandId=crypto.randomUUID();let postStarted=false;if(hub)onRememberTaskCommand(commandId,selectedTask.projectId,'pause',selectedTask.id);try{const receipt=hub?
      await (async()=>{postStarted=true;return request<CommandReceipt>('POST','/api/commands',{commandId,projectId:selectedTask.projectId,taskId:selectedTask.id,action:'pause',expectedRevision:selectedTask.revision,expiresAt:new Date(Date.now()+5*60*1000).toISOString(),queueOffline:false,body:{}})})():
      await request<CommandReceipt>('POST',`/api/tasks/${encodeURIComponent(selectedTask.id)}/pause`,{expectedRevision:selectedTask.revision});
      if(hub&&receipt.commandId){if(receipt.status==='unknown')onRememberTaskCommand(commandId,selectedTask.projectId,'pause',selectedTask.id,'unknown');else if(finalStatus(receipt)||receipt.status==='running'&&receipt.result!=null)onForgetTaskCommand(commandId);setPendingId(receipt.commandId);setPendingKind('pause');}setNotice(hub&&receipt.commandId?'暂停请求已发送，等待电脑确认。':'暂停请求已提交。');await onRefresh();
    }catch(caught){if(!isDesktop()&&(caught instanceof TypeError||caught instanceof ReadTimeoutError))onClientOffline();if(hub&&postStarted&&(uncertain(caught)||caught instanceof ApiError&&[401,403,404].includes(caught.status))){setPendingId(commandId);setPendingKind('pause');setNotice('暂停提交结果可能未知；正在核对同一命令回执。');}else if(hub&&caught instanceof ApiError&&caught.status>=400&&caught.status<500&&![401,403,404].includes(caught.status))onForgetTaskCommand(commandId);else if(!hub&&uncertain(caught))setUnconfirmedId(commandId);setError(message(caught));}finally{setBusy(false);}}
  function refresh(){void onRefresh();void load();}
  return <div className="content-page conversation-page"><div className="section-header"><div><h2>与 Codex 对话</h2><p>选择已有项目，直接描述要完成的工作。新建对话可修改所选项目文件；AI 可能读取电脑上其他可读内容，请只授权可信设备。</p></div><button className="secondary" type="button" onClick={refresh}><RefreshCw size={15}/> 刷新</button></div>{!project?<div className="empty-state"><h2>{hub?'还没有同步的项目':'先在电脑上选择项目'}</h2><p>{hub?'在电脑的「手机连接」页连接此账号并选择要同步的项目，然后回到这里。':'在桌面端新建或导入本地项目，然后开始对话。'}</p></div>:<div className="conversation-layout"><section className="setting-card conversation-compose"><h3><MessageSquarePlus size={17}/> {startingTask?'开始此任务':selectedTask?'继续对话':'开启新对话'}</h3><label className="field" htmlFor="conversation-task"><span>已有对话或待开始任务</span><select aria-label="已有对话或待开始任务" id="conversation-task" value={selectedTask?.id||''} onChange={event=>{onSelectTask(event.target.value);setError('');setNotice('')}}><option value="">新对话</option>{selectableTasks.map(item=><option key={item.id} value={item.id}>{startingTask&&item.id===selectedTask?.id?`开始此任务：${item.title}`:item.title}</option>)}</select></label>{startingTask&&selectedTask&&<div className="conversation-start-context"><strong>在此任务中开始，进度与证据保留。</strong><p>任务目标：{selectedTask.goal}</p><p>验收标准：{selectedTask.criteria.length?selectedTask.criteria.map(item=>item.text).join('；'):'尚未设置'}</p></div>}{selectedTask&&<div className="conversation-task-links">{onOpenTask&&<button className="secondary" type="button" onClick={()=>onOpenTask(selectedTask.id,selectedTask.projectId)}>任务与证据</button>}{!startingTask&&onOpenTerminal&&<button className="secondary" type="button" onClick={()=>onOpenTerminal(selectedTask.id,selectedTask.projectId)}>项目终端</button>}</div>}<form onSubmit={startingTask?startSelectedTask:selectedTask?send:create}>{!selectedTask&&<label className="field" htmlFor="conversation-title"><span>对话标题</span><input id="conversation-title" disabled={!draftIdentity} maxLength={240} value={title} onChange={event=>setTitle(event.target.value)} placeholder="例如：修复登录失败" required/></label>}<label className="field" htmlFor="conversation-message"><span>{startingTask?'给 Codex 的启动说明':selectedTask?'继续说明需求':'告诉 Codex 要做什么'}</span><textarea id="conversation-message" disabled={!draftIdentity||Boolean(pendingId)||Boolean(unconfirmedId)||genericTaskWritePending} maxLength={10000} rows={5} value={draft} onChange={event=>setDraft(event.target.value)} placeholder="描述目标、相关文件或期望结果…" required/></label><button className="primary" type="submit" disabled={!canWrite||!writeGate.ready||busy||Boolean(pendingId)||Boolean(unconfirmedId)||(selectedTask?genericTaskWritePending:genericNewPending)}><Send size={15}/>{busy?'正在提交…':startingTask?'让 AI 开始此任务':selectedTask?'发送消息':'创建并开始'}</button>{(selectedTask?.status==='running'||genericContinuePending)&&<button className="secondary" type="button" onClick={()=>void pause()} disabled={!canWrite||busy||Boolean(pendingId)||genericPausePending}><Pause size={15}/> 暂停执行</button>}</form>{(title||draft)&&<p className="small-note" role="status">{compose.saved?'草稿保存在当前设备，不会自动发送。':'草稿暂未保存到此设备，请先复制内容，避免离开后丢失。'}</p>}{!writeGate.ready&&<p className="small-note" role="status">{writeGate.reason} 草稿会保留；请刷新状态后再试。</p>}{unconfirmedId&&<div className="conversation-uncertain">{hub&&unconfirmedStatus==="unknown"?<p className="small-note">结果仍待电脑确认。手机端不能解除这条操作的锁定；请在目标电脑核对处理结果，回执同步后再提交。</p>:<><p className="small-note">上次提交的结果尚未确认。核对任务清单和对话输出后才能再次提交。</p><button className="secondary" type="button" onClick={()=>{setUnconfirmedId("");setUnconfirmedStatus("")}}>我已核对结果</button></>}</div>}{recoveryIntents.map(item=><CommandRecovery key={item.id} commandId={item.id!} identityKey={identityKey} canReconcile={canReconcile} isRecoveryCurrent={isRecoveryCurrent} onResolved={receipt=>{const intent=selectedTaskIntent.find(value=>value.id===receipt.commandId&&value.action==='start_task');if(intent?.id&&receipt.action==='start_task'&&receipt.taskId===selectedTask?.id&&receipt.projectId===selectedTask?.projectId&&receipt.recovery?.outcome==='applied'&&confirmedTaskStart(receipt,selectedTask||null,intent.id)){compose.clearSubmitted(compose.capture());setNotice('电脑已确认在此任务中启动 Codex。正在更新任务状态。');}onRecoveryResolved(receipt);}}/>)}{hub&&!accountScopeReady&&<p className="small-note">正在确认连接身份，确认完成前暂不能提交。</p>}{hub&&!clientOnline&&<p className="small-note">连接状态待确认，恢复连接并刷新后才能写入。</p>}{hub&&board.connection.offline&&<p className="small-note">目标电脑离线，连接恢复后才能发送新消息。</p>}{hub&&board.capabilities.role==='viewer'&&<p className="small-note">当前连接只有查看权限。</p>}{notice&&<p className="notice" role="status">{notice}</p>}{(error||loadError)&&<p className="alert" role="alert">{error||loadError}</p>}</section><section className="conversation-output" aria-label="对话输出"><div className="conversation-output-header"><strong>{selectedTask?.title||'对话输出'}</strong><span>{loading?'输出更新中…':display.visible?.updatedAt?`输出更新于 ${new Date(display.visible.updatedAt).toLocaleString('zh-CN')}`:'输出尚未更新'}</span></div>{selectedTask?<><p className="conversation-status">任务状态：{display.taskStatus}</p>{startingTask?<div className="conversation-empty">提交明确的启动说明后，目标电脑的 Codex 输出会显示在这里。</div>:display.outputSyncPending&&<p className="small-note" role="status">对话输出同步中，以下内容可能不是最新结果。</p>}{!startingTask&&display.visible?.truncated&&<p className="small-note">仅显示最近部分输出。</p>}{!startingTask&&display.visible?.messages?.length?<div className="conversation-messages" aria-live="polite">{display.visible.messages.map(item=><article key={item.id} className={`conversation-message role-${item.role}`}><div><strong>{item.role==='user'?'你':item.role==='assistant'?'Codex':item.role==='tool'?'工具':'系统'}</strong>{item.status&&<span>{messageCompletionLabel(item.role,item.status)||statusLabel[item.status]||item.status}</span>}</div><pre>{item.text}</pre></article>)}</div>:!startingTask&&<div className="conversation-empty">{loading||display.visible?.status==='loading'?'正在读取输出…':error?'输出暂时不可用，请稍后刷新。':'还没有可显示的输出。电脑接收请求后会在这里出现。'}</div>}</>:<div className="conversation-empty">选择已有对话，或发送第一条消息开始。</div>}</section></div>}</div>;
}
