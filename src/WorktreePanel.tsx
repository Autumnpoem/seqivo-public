import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {AlertCircle,GitBranch,RefreshCw} from 'lucide-react';
import {errorMessage,request} from './api';
import type {Project,Task} from './types';
import './worktree.css';

export interface WorktreeEntry {
  id:string;projectId:string;taskId:string;role:string;path:string;branch:string;baseCommit:string;
  phase:'creating'|'ready'|'merging'|'conflict'|'merged'|'removing'|'removed'|string;
  reason?:string|null;mergeCommit?:string;reviewId?:string;mergeSourceHead?:string;mergeTargetHead?:string;
}
export interface WorktreeBinding {worktreeId:string;taskId:string;conversationId:string|null;verified:boolean;status:string}
interface WorktreeBase {projectId:string;targetHead:string;targetBranch:string;targetDirty:boolean}
interface WorktreeDetail extends WorktreeEntry {
  head:string;targetHead:string;targetBranch:string;dirty:boolean;targetDirty:boolean;
  status:string;targetStatus:string;nameStatus:string;patch:string|null;patchTruncated:boolean;
  indexTree:string|null;conflictFiles:string[];stagedPatch:string|null;stagedPatchTruncated:boolean;
  reviewStatus:{valid:boolean;reason:'missing_receipt'|'task_review_stale'|'index_unresolved'|'index_changed'|null;reviewId:string|null}|null;
  cleanupEligible:boolean;cleanupBlockedReason:string|null;
}
interface ReviewReceipt {reviewId:string;worktreeId:string;taskId:string;contentVersion:number|string;sourceHead:string;targetHead:string;indexTree?:string|null;actor:string;createdAt:string}
interface SavePreview {worktreeId:string;head:string;taskRevision:number;contentVersion:number|string;sourceDigest?:string;changedFiles?:{path:string;kind:string;bytes:number}[];patch?:string;saveable:boolean;blockedReason?:string|null}
interface SaveIntent {projectId:string;worktreeId:string;taskId:string;requestId:string;expectedHead:string;expectedTaskRevision:number;expectedContentVersion:number|string;expectedSourceDigest:string;changedFileCount:number}
interface SaveResult {phase:'not_found'|'not_saved'|'prepared'|'ready'|'saving_unknown';requestId:string;worktreeId?:string;saveId?:string;sourceHead?:string;previousHead?:string;sourceDigest?:string;changedFileCount?:number;reason?:string}
const SAVE_KEY_PREFIX='seqivo-worktree-save-v1:';
const saveKey=(projectId:string,worktreeId:string)=>`${SAVE_KEY_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(worktreeId)}`;
function readSaveIntent(projectId:string,worktreeId:string):SaveIntent|null{
  const raw=localStorage.getItem(saveKey(projectId,worktreeId));if(raw===null)return null;
  let value:SaveIntent;try{value=JSON.parse(raw) as SaveIntent}catch{throw new Error('上次保存记录无法读取；为避免重复写入，当前工作区保持锁定。')}
  if(!value||value.projectId!==projectId||value.worktreeId!==worktreeId||typeof value.taskId!=='string'||typeof value.requestId!=='string'||!value.requestId||
    typeof value.expectedHead!=='string'||!value.expectedHead||!Number.isInteger(value.expectedTaskRevision)||
    !['number','string'].includes(typeof value.expectedContentVersion)||typeof value.expectedSourceDigest!=='string'||!value.expectedSourceDigest||
    !Number.isInteger(value.changedFileCount)||value.changedFileCount<1)
    throw new Error('上次保存记录与当前工作区不匹配；为避免重复写入，当前工作区保持锁定。');
  return value;
}
function persistSaveIntent(value:SaveIntent){
  const key=saveKey(value.projectId,value.worktreeId),raw=JSON.stringify(value);
  if(localStorage.getItem(key)!==null)throw new Error('此工作区仍有保存结果待核对，请先处理原请求。');
  localStorage.setItem(key,raw);
  if(localStorage.getItem(key)!==raw)throw new Error('无法确认保存记录已留在本机，未发送保存请求。');
}
function clearSaveIntent(value:SaveIntent){
  const key=saveKey(value.projectId,value.worktreeId);
  const existing=readSaveIntent(value.projectId,value.worktreeId);
  if(existing?.requestId!==value.requestId)throw new Error('保存记录身份已变化；请刷新后核对，不会发送新请求。');
  localStorage.removeItem(key);
  if(localStorage.getItem(key)!==null)throw new Error('本机保存记录尚未清除；请刷新后核对。');
}
function boundSavePreview(value:SavePreview,detail:WorktreeDetail,task:Task,projectId:string){
  return value?.worktreeId===detail.id&&detail.projectId===projectId&&detail.taskId===task.id&&value.head===detail.head&&
    value.taskRevision===task.revision&&value.contentVersion===task.contentVersion&&typeof value.saveable==='boolean';
}
function validSavePreview(value:SavePreview,detail:WorktreeDetail,task:Task,projectId:string){
  return boundSavePreview(value,detail,task,projectId)&&value.saveable===true&&
    typeof value.sourceDigest==='string'&&!!value.sourceDigest&&Array.isArray(value.changedFiles)&&value.changedFiles.length>0&&
    value.changedFiles.every(item=>typeof item.path==='string'&&!!item.path&&typeof item.kind==='string'&&!!item.kind&&Number.isInteger(item.bytes)&&item.bytes>=0)&&
    typeof value.patch==='string'&&value.patch.length>0&&
    (value.blockedReason===null||typeof value.blockedReason==='string');
}
const saveFileKind:Record<string,string>={modified:'修改',added:'新增',deleted:'删除'};
const isGitOid=(value:unknown)=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const phaseNames:Record<string,string>={creating:'正在建立',ready:'待审查',saving:'保存结果待核对',merging:'待完成合入',conflict:'合入冲突',merged:'已合入',removing:'正在清理',removed:'已清理'};
const reviewReasons:Record<string,string>={missing_receipt:'当前合入没有可核实的审查记录。',task_review_stale:'任务当前版本的人工验收已失效。请回到任务清单重新验收，再刷新这里。',index_unresolved:'仍有未解决冲突，先在本机解决并暂存。',index_changed:'暂存内容已变化，需要重新核对并登记当前索引的人工审查。'};
const short=(value?:string|null)=>value?value.slice(0,12):'未提供';

export default function WorktreePanel({project,tasks,onEntriesChange,onBindingsChange}:{project:Project;tasks:Task[];onEntriesChange:(entries:WorktreeEntry[])=>void;onBindingsChange:(bindings:Record<string,WorktreeBinding>)=>void}){
  const [entries,setEntries]=useState<WorktreeEntry[]>([]);
  const [bindings,setBindings]=useState<Record<string,WorktreeBinding>>({});
  const [base,setBase]=useState<WorktreeBase|null>(null);
  const [taskId,setTaskId]=useState('');
  const [role,setRole]=useState('worker');
  const [selectedId,setSelectedId]=useState('');
  const [detail,setDetail]=useState<WorktreeDetail|null>(null);
  const [review,setReview]=useState<ReviewReceipt|null>(null);
  const [diffViewed,setDiffViewed]=useState(false);
  const [stagedViewedIndex,setStagedViewedIndex]=useState<string|null>(null);
  const [inspectionVersion,setInspectionVersion]=useState(0);
  const [sessionSubmittedId,setSessionSubmittedId]=useState('');
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [uncertain,setUncertain]=useState(false);
  const [createAttempt,setCreateAttempt]=useState<{requestId:string;projectId:string;taskId:string;role:string;expectedBase:string}|null>(null);
  const [savePreview,setSavePreview]=useState<SavePreview|null>(null);
  const [saveAttempt,setSaveAttempt]=useState<SaveIntent|null>(null);
  const [saveCheckedKey,setSaveCheckedKey]=useState('');
  const [saveRecordError,setSaveRecordError]=useState('');
  const [saveResolution,setSaveResolution]=useState<'pending'|'not_found'|'prepared'|'saving_unknown'>('pending');
  const previewRequestRef=useRef(0);
  const selectionRef=useRef({projectId:project.id,worktreeId:selectedId});
  selectionRef.current={projectId:project.id,worktreeId:selectedId};
  const selectedSaveKey=selectedId?saveKey(project.id,selectedId):'';
  const saveReady=!!selectedId&&saveCheckedKey===selectedSaveKey&&!saveRecordError;
  const pendingSave=saveAttempt?.projectId===project.id&&saveAttempt.worktreeId===selectedId?saveAttempt:null;
  const saveLocked=!saveReady||!!pendingSave;
  const candidates=tasks.filter(task=>task.projectId===project.id&&task.status!=='cancelled'&&!task.conversationId);
  const selected=entries.find(item=>item.id===selectedId);
  const selectedTask=tasks.find(item=>item.id===selected?.taskId);
  const selectedBound=!!selected&&!!selectedTask&&bindings[selected.id]?.verified===true&&bindings[selected.id]?.status==='bound'&&bindings[selected.id]?.taskId===selectedTask.id&&bindings[selected.id]?.conversationId===selectedTask.conversationId;
  const load=useCallback(async()=>{
    if(!project.id)return;
    try{
      const [list,head]=await Promise.all([
        request<WorktreeEntry[]>('GET',`/api/worktrees?projectId=${encodeURIComponent(project.id)}`),
        request<WorktreeBase>('GET',`/api/worktrees/base?projectId=${encodeURIComponent(project.id)}`),
      ]);
      const items=Array.isArray(list)?list.filter(item=>item.projectId===project.id):[];
      setEntries(items);onEntriesChange(items);setBase(head);setSelectedId(current=>items.some(item=>item.id===current)?current:items.find(item=>item.phase!=='removed')?.id||'');
      const checked=await Promise.allSettled(items.filter(item=>item.phase==='ready').map(async item=>request<WorktreeBinding>('GET',`/api/worktrees/${encodeURIComponent(item.id)}/binding`)));
      const bound:Record<string,WorktreeBinding>={};
      checked.forEach(result=>{if(result.status==='fulfilled'&&result.value.verified===true&&result.value.status==='bound'&&result.value.worktreeId&&result.value.taskId)bound[result.value.worktreeId]=result.value;});
      setBindings(bound);onBindingsChange(bound);
      setError('');setUncertain(false);
    }catch(cause){setEntries([]);setBindings({});onEntriesChange([]);onBindingsChange({});setBase(null);setDetail(null);setError(errorMessage(cause));}
  },[project.id,onEntriesChange,onBindingsChange]);
  useEffect(()=>{setEntries([]);setBase(null);setSelectedId('');setDetail(null);setReview(null);setCreateAttempt(null);void load();},[load]);
  useEffect(()=>{
    previewRequestRef.current++;setSavePreview(null);setSaveAttempt(null);setSaveCheckedKey('');setSaveRecordError('');setSaveResolution('pending');
    if(!selectedId)return;
    try{
      const value=readSaveIntent(project.id,selectedId);
      if(value&&entries.find(item=>item.id===selectedId)?.taskId!==value.taskId)throw new Error('上次保存记录的任务与当前工作区不匹配；当前工作区保持锁定。');
      setSaveAttempt(value);
    }catch(cause){setSaveRecordError(errorMessage(cause));}
    setSaveCheckedKey(saveKey(project.id,selectedId));
  },[project.id,selectedId,entries]);
  const inspect=useCallback(async(id:string)=>{
    if(!id)return;
    previewRequestRef.current++;setSavePreview(null);
    try{
      const value=await request<WorktreeDetail>('GET',`/api/worktrees/${encodeURIComponent(id)}`);
      if(value.id!==id||value.projectId!==project.id)throw new Error('工作树与当前项目不匹配。');
      setDetail(value);setDiffViewed(false);setStagedViewedIndex(null);setInspectionVersion(current=>current+1);setError('');
      setReview(current=>current&&current.worktreeId===id&&current.sourceHead===value.head&&current.targetHead===value.targetHead?current:null);
    }catch(cause){setDetail(null);setError(errorMessage(cause));}
  },[project.id]);
  useEffect(()=>{setDetail(null);setReview(null);void inspect(selectedId);},[selectedId,inspect]);
  async function create(event:FormEvent){
    event.preventDefault();if(!base||base.targetDirty||!taskId||!role||busy||uncertain)return;
    const same=createAttempt&&createAttempt.projectId===project.id&&createAttempt.taskId===taskId&&createAttempt.role===role&&createAttempt.expectedBase===base.targetHead;
    const input=same?createAttempt:{projectId:project.id,taskId,role,expectedBase:base.targetHead,requestId:crypto.randomUUID()};
    setCreateAttempt(input);setBusy('create');setError('');setNotice('');
    try{
      const entry=await request<WorktreeEntry>('POST','/api/worktrees',input);
      if(!entry?.id||entry.taskId!==taskId||entry.role!==role)throw new Error('工作树创建结果待核对，请刷新列表。');
      setCreateAttempt(null);await load();setSelectedId(entry.id);setNotice('独立工作区已建立。请在其中新建该任务的独立执行会话，再安排计划。');
    }catch(cause){setError(`${errorMessage(cause)} 创建结果可能尚未确认；请先刷新列表核对，重复请求会沿用同一请求标识。`);setUncertain(true);}
    finally{setBusy('');}
  }
  async function createSession(){
    if(!detail||detail.phase!=='ready'||!selectedTask||selectedTask.conversationId||busy||uncertain)return;
    setBusy('session');setError('');setNotice('');
    try{
      const result=await request<{status:string}>('POST',`/api/tasks/${encodeURIComponent(selectedTask.id)}/session`,{
        expectedRevision:selectedTask.revision,commandId:crypto.randomUUID(),worktreeId:detail.id,workspaceWrite:true,
      });
      if(result.status!=='created')throw new Error(`执行会话结果为 ${result.status||'未知'}；请先核对，不能自动重试。`);
      setSessionSubmittedId(detail.id);await load();setNotice('已在该工作树创建独立执行会话。请刷新任务状态；只有服务器核实会话绑定后才能加入工作树计划。');
    }catch(cause){setError(`${errorMessage(cause)} 会话创建结果可能未知；请核对任务与执行工具，不会自动重发。`);setUncertain(true);}
    finally{setBusy('');}
  }
  async function previewForSave(){
    if(!detail||!selectedTask||detail.phase!=='ready'||!detail.dirty||busy||uncertain||saveLocked)return;
    const id=detail.id,task=selectedTask,requestVersion=++previewRequestRef.current;
    setBusy('savePreview');setError('');setNotice('');setSavePreview(null);
    try{
      const value=await request<SavePreview>('GET',`/api/worktrees/${encodeURIComponent(id)}/save-preview`);
      if(requestVersion!==previewRequestRef.current||selectionRef.current.projectId!==project.id||selectionRef.current.worktreeId!==id)return;
      if(!boundSavePreview(value,detail,task,project.id)||value.saveable&&!validSavePreview(value,detail,task,project.id))throw new Error('待保存版本与当前工作区或任务不匹配；请重新检查现场。');
      setSavePreview(value);
    }catch(cause){if(requestVersion===previewRequestRef.current&&selectionRef.current.worktreeId===id)setError(errorMessage(cause));}
    finally{setBusy('');}
  }
  async function confirmedSave(intent:SaveIntent,result:SaveResult){
    if(result.phase!=='ready'||result.requestId!==intent.requestId||result.worktreeId!==intent.worktreeId||result.previousHead!==intent.expectedHead||!isGitOid(result.previousHead)||!result.saveId||
      !isGitOid(result.sourceHead)||result.sourceHead===intent.expectedHead||
      result.sourceDigest!==intent.expectedSourceDigest||result.changedFileCount!==intent.changedFileCount)
      throw new Error('保存回执与原请求或文件数不匹配；保持锁定，请核对现场。');
    clearSaveIntent(intent);
    if(selectionRef.current.projectId!==intent.projectId||selectionRef.current.worktreeId!==intent.worktreeId)return;
    setSaveAttempt(null);setSavePreview(null);setSaveResolution('pending');
    setNotice(`原请求已保存审查版本 ${short(result.sourceHead)}。当前工作区现场仍需重新检查；这不是任务验收或源码审查。`);
    await load();await inspect(intent.worktreeId);
  }
  async function confirmedNotSaved(intent:SaveIntent,result:SaveResult){
    if(result.phase!=='not_saved'||result.requestId!==intent.requestId||result.worktreeId!==intent.worktreeId)
      throw new Error('未保存回执与原请求不匹配；保持锁定，请核对现场。');
    clearSaveIntent(intent);
    if(selectionRef.current.projectId!==intent.projectId||selectionRef.current.worktreeId!==intent.worktreeId)return;
    setSaveAttempt(null);setSavePreview(null);setSaveResolution('pending');
    await inspect(intent.worktreeId);
    if(selectionRef.current.projectId===intent.projectId&&selectionRef.current.worktreeId===intent.worktreeId)
      setNotice(`已核实这次请求未保存${result.reason?`：${result.reason}`:'。'} 请重新查看当前文件与版本，再明确发起新的保存。`);
  }
  async function submitSave(){
    if(!detail||!selectedTask||!savePreview||busy||uncertain||saveLocked||!savePreview.saveable||
      !validSavePreview(savePreview,detail,selectedTask,project.id)||!detail.dirty)return;
    const id=detail.id;
    const intent:SaveIntent={projectId:project.id,worktreeId:id,taskId:selectedTask.id,requestId:crypto.randomUUID(),
      expectedHead:savePreview.head,expectedTaskRevision:savePreview.taskRevision,
      expectedContentVersion:savePreview.contentVersion,expectedSourceDigest:savePreview.sourceDigest!,
      changedFileCount:savePreview.changedFiles!.length};
    try{persistSaveIntent(intent);}catch(cause){setSaveRecordError(`${errorMessage(cause)} 保存请求未发送。`);return;}
    setSaveAttempt(intent);setSaveResolution('pending');setSavePreview(null);setBusy('save');setError('');setNotice('');
    try{
      const result=await request<SaveResult>('POST',`/api/worktrees/${encodeURIComponent(id)}/save`,{
        requestId:intent.requestId,expectedHead:intent.expectedHead,expectedTaskRevision:intent.expectedTaskRevision,
        expectedContentVersion:intent.expectedContentVersion,expectedSourceDigest:intent.expectedSourceDigest,
      });
      if(result?.requestId!==intent.requestId||!['ready','saving_unknown','not_saved'].includes(result.phase))throw new Error('保存回执无法确认原请求。');
      if(result.phase==='ready')await confirmedSave(intent,result);
      else if(result.phase==='not_saved')await confirmedNotSaved(intent,result);
      else if(selectionRef.current.projectId===intent.projectId&&selectionRef.current.worktreeId===intent.worktreeId){setSaveResolution('saving_unknown');setNotice('保存结果尚未确认。原请求已保留；请核对或进一步核实，不会自动重发。');}
    }catch(cause){if(selectionRef.current.projectId===intent.projectId&&selectionRef.current.worktreeId===intent.worktreeId)setError(`${errorMessage(cause)} 保存结果待核对；原请求不会自动重发。`);}
    finally{setBusy('');}
  }
  async function verifySave(reconcile=false){
    const intent=pendingSave;
    if(!intent||busy||!saveReady||selectionRef.current.projectId!==intent.projectId||selectionRef.current.worktreeId!==intent.worktreeId)return;
    setBusy(reconcile?'saveReconcile':'saveStatus');setError('');setNotice('');
    try{
      const path=`/api/worktrees/${encodeURIComponent(intent.worktreeId)}/save`;
      const result=reconcile
        ?await request<SaveResult>('POST',`${path}/reconcile`,{requestId:intent.requestId})
        :await request<SaveResult>('GET',`${path}?requestId=${encodeURIComponent(intent.requestId)}`);
      if(result?.requestId!==intent.requestId||!['not_found','not_saved','prepared','ready','saving_unknown'].includes(result.phase))throw new Error('核对结果无法绑定原保存请求。');
      if(selectionRef.current.projectId!==intent.projectId||selectionRef.current.worktreeId!==intent.worktreeId)return;
      if(result.phase==='ready')await confirmedSave(intent,result);
      else if(result.phase==='not_saved')await confirmedNotSaved(intent,result);
      else if(result.phase==='not_found'){
        setSaveResolution('not_found');
        setNotice('暂未找到原请求记录，不能确认是否执行过。请继续核对原请求或现场；不会自动重发。');
      }else{
        setSaveResolution(result.phase);
        setNotice(result.phase==='prepared'?'已找到原保存请求，结果尚未确认。可进一步核对现场；不会重复提交。':'保存现场仍待核对，原请求保持锁定；不会重复提交。');
      }
    }catch(cause){setError(`${errorMessage(cause)} 原保存请求仍锁定；请稍后按同一编号核对，不会自动重发。`);}
    finally{setBusy('');}
  }
  async function act(kind:'review'|'reviewIndex'|'merge'|'finalize'|'cleanup'){
    if(!detail||busy||uncertain||saveLocked)return;
    const id=detail.id;setBusy(kind);setError('');setNotice('');
    try{
      if(kind==='review'){
        if(!diffViewed||detail.phase!=='ready'||detail.dirty||detail.targetDirty||detail.patch===null||detail.patchTruncated||selectedTask?.acceptance!=='passed')return;
        const receipt=await request<ReviewReceipt>('POST',`/api/worktrees/${encodeURIComponent(id)}/review`,{sourceHead:detail.head,targetHead:detail.targetHead});
        if(receipt.worktreeId!==id||receipt.sourceHead!==detail.head||receipt.targetHead!==detail.targetHead||!receipt.reviewId)throw new Error('审查记录与当前版本不匹配。');
        setReview(receipt);setNotice('人工审查已登记到当前源和目标版本。合入前请再次核对差异。');
      }else if(kind==='reviewIndex'){
        if(stagedViewedIndex!==detail.indexTree||!['merging','conflict'].includes(detail.phase)||selectedTask?.acceptance!=='passed'||!detail.indexTree||detail.conflictFiles.length||detail.stagedPatch===null||detail.stagedPatchTruncated||!detail.mergeSourceHead||!detail.mergeTargetHead)return;
        const receipt=await request<ReviewReceipt>('POST',`/api/worktrees/${encodeURIComponent(id)}/review`,{sourceHead:detail.mergeSourceHead,targetHead:detail.mergeTargetHead,expectedIndexTree:detail.indexTree});
        if(receipt.worktreeId!==id||receipt.sourceHead!==detail.mergeSourceHead||receipt.targetHead!==detail.mergeTargetHead||receipt.indexTree!==detail.indexTree||!receipt.reviewId)throw new Error('当前索引审查记录与现场不匹配。');
        await inspect(id);setNotice('当前暂存版本的人工审查已登记。请再次核对现场后完成合入。');
      }else if(kind==='merge'){
        if(!review||review.worktreeId!==id||review.sourceHead!==detail.head||review.targetHead!==detail.targetHead)return;
        await request('POST',`/api/worktrees/${encodeURIComponent(id)}/merge`,{expectedTargetHead:detail.targetHead,reviewId:review.reviewId});
        setReview(null);await load();await inspect(id);setNotice('合入已准备。请核对主工作区暂存差异；如有冲突，先人工解决并暂存。');
      }else if(kind==='finalize'){
        if(stagedViewedIndex!==detail.indexTree||detail.reviewStatus?.valid!==true||selectedTask?.acceptance!=='passed'||!detail.indexTree||detail.conflictFiles.length||detail.stagedPatch===null||detail.stagedPatchTruncated)return;
        await request('POST',`/api/worktrees/${encodeURIComponent(id)}/finalize`,{expectedIndexTree:detail.indexTree,confirmReviewed:true});
        await load();await inspect(id);setNotice('合入提交已完成。');
      }else{
        if(!detail.cleanupEligible)return;
        await request('POST',`/api/worktrees/${encodeURIComponent(id)}/cleanup`,{});
        await load();setDetail(null);setNotice('工作树已安全清理。');
      }
    }catch(cause){setError(`${errorMessage(cause)} 结果或版本可能已变化；请刷新现场后核对，不会自动重试。`);setUncertain(true);}
    finally{setBusy('');}
  }
  return <section className="setting-card worktree-panel" aria-label="独立工作区">
    <div className="worktree-head"><div><h3><GitBranch size={17}/> 独立工作区</h3><p>每个角色在自己的 Git 工作树中修改。文件不会自动合入项目主目录。</p></div><button className="secondary" type="button" onClick={()=>{void load();if(selectedId)void inspect(selectedId);}} disabled={!!busy}><RefreshCw size={15}/> 刷新现场</button></div>
    {error&&<p className="alert" role="alert"><AlertCircle size={15}/>{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
    {base&&<p className="worktree-base">项目目标：<code>{base.targetBranch}</code> · 版本 <code>{short(base.targetHead)}</code>{base.targetDirty?' · 主工作区有未保存更改，暂不能建立工作树':''}</p>}
    <details className="worktree-create"><summary>建立角色工作区</summary><p>先选尚未绑定执行会话的任务。旧会话不能迁入工作树；若任务已有原目录会话，请新建任务和独立会话。</p><form onSubmit={event=>void create(event)}><label>任务<select value={taskId} onChange={event=>setTaskId(event.target.value)} required><option value="">选择未绑定会话的任务</option>{candidates.map(task=><option key={task.id} value={task.id}>{task.title}</option>)}</select></label><label>承担角色<select value={role} onChange={event=>setRole(event.target.value)}><option value="worker">执行</option><option value="reviewer">独立审查</option><option value="tester">测试</option><option value="planner">规划</option></select></label><button className="primary" disabled={!base||base.targetDirty||!taskId||!!busy||uncertain}>建立工作区</button></form>{!candidates.length&&<p>目前没有可建立工作树的未绑定会话任务。已有原目录会话不能迁移，请先创建新任务。</p>}</details>
    {entries.filter(item=>item.phase!=='removed').length?<div className="worktree-list" role="group" aria-label="工作树列表">{entries.filter(item=>item.phase!=='removed').map(item=><button type="button" key={item.id} className={selectedId===item.id?'selected':''} onClick={()=>setSelectedId(item.id)}><strong>{tasks.find(task=>task.id===item.taskId)?.title||item.taskId}</strong><span>{item.role} · {phaseNames[item.phase]||item.phase}</span></button>)}</div>:<p className="worktree-empty">还没有独立工作区；现有普通计划继续按项目目录串行。</p>}
    {selected&&saveRecordError&&<p className="alert" role="alert">{saveRecordError}</p>}
    {selected&&pendingSave&&<section className="worktree-save-recovery" aria-label="待核对的审查版本保存"><h4>上次保存结果待核对</h4><p>任务：{tasks.find(item=>item.id===pendingSave.taskId)?.title||'原任务待核对'} · 原源版本 <code>{short(pendingSave.expectedHead)}</code>。刷新页面不会重新提交，也不会自动登记审查或合入。</p><div className="worktree-save-actions"><button className="secondary" type="button" disabled={!!busy||!saveReady} onClick={()=>void verifySave(false)}>核对上次保存</button>{saveResolution!=='pending'&&<button className="secondary" type="button" disabled={!!busy||!saveReady} onClick={()=>void verifySave(true)}>进一步核对保存现场</button>}</div></section>}
    {selected&&detail&&<div className="worktree-detail"><div className="worktree-detail-head"><h4>{tasks.find(task=>task.id===selected.taskId)?.title||selected.taskId} · {detail.phase==='ready'&&detail.dirty?'有修改待保存':phaseNames[detail.phase]||detail.phase}</h4><button className="secondary" type="button" onClick={()=>void inspect(detail.id)} disabled={!!busy}>重新检查</button></div>
      <dl><div><dt>角色工作区</dt><dd><code>{detail.path}</code></dd></div><div><dt>源分支与版本</dt><dd><code>{detail.branch}</code> · <code title={detail.head}>{short(detail.head)}</code></dd></div><div><dt>项目目标版本</dt><dd><code>{detail.targetBranch}</code> · <code title={detail.targetHead}>{short(detail.targetHead)}</code></dd></div><div><dt>起始版本</dt><dd><code title={detail.baseCommit}>{short(detail.baseCommit)}</code></dd></div></dl>
      {detail.dirty&&<p className="worktree-warning">角色工作区有未保存修改；请先查看待保存文件和完整差异，再明确保存为审查版本。</p>}{detail.targetDirty&&<p className="worktree-warning">项目主工作区有未保存修改或合入现场；请先核对。</p>}
      {selectedTask&&!selectedTask.conversationId&&detail.phase==='ready'&&<div className="worktree-session"><p>该任务尚未绑定执行会话。新会话会以此工作树为写入目录；不会启动任务回合。</p><button className="secondary" type="button" disabled={!!busy||uncertain||saveLocked||sessionSubmittedId===detail.id} onClick={()=>void createSession()}>{sessionSubmittedId===detail.id?'会话已创建，等待任务刷新':'在此工作区创建独立会话'}</button></div>}
      {selectedTask?.conversationId&&!selectedBound&&<p className="worktree-warning">该任务已有执行会话。只有服务端确认它绑定此工作树后才可加入工作树计划；原目录会话不能迁移。</p>}
      <details className="worktree-diff" open={detail.phase==='conflict'} onToggle={event=>{if(event.currentTarget.open)setDiffViewed(true);}}><summary>查看文件变化与补丁</summary><p>相对起始版本的文件变化：</p><pre>{detail.nameStatus||'暂无已提交差异'}</pre><p>{detail.patchTruncated?'补丁超过展示上限，请在本机完整审查。':'源码补丁：'}</p><pre>{detail.patch??'无法完整读取补丁；界面不登记审查。'}</pre>{detail.status&&<><p>未提交状态（含未跟踪文件，不一定包含在补丁中）：</p><pre>{detail.status}</pre></>}</details>
      {detail.phase==='ready'&&detail.dirty&&<section className="worktree-save" aria-label="保存审查版本"><h4>保存为审查版本</h4><p>只保存下面预览列出的文件；这不会把任务标成完成，也不会进行人工验收、登记源码审查或合入。</p><button className="secondary" type="button" disabled={!!busy||uncertain||saveLocked||!selectedTask} onClick={()=>void previewForSave()}>查看待保存文件和完整差异</button>{savePreview?.worktreeId===detail.id&&<div className="worktree-save-preview"><p>当前源版本 <code>{short(savePreview.head)}</code> · 待保存 {savePreview.changedFiles?.length??0} 个文件</p>{!!savePreview.changedFiles?.length&&<ul>{savePreview.changedFiles.map(file=><li key={file.path}><code>{file.path}</code> · {saveFileKind[file.kind]||file.kind} · {file.bytes} 字节</li>)}</ul>}{savePreview.patch&&<><p>本次完整差异：</p><pre>{savePreview.patch}</pre></>}{!savePreview.saveable&&<p className="worktree-warning" role="status">{savePreview.blockedReason||'当前现场不能保存；请重新检查。'}</p>}<button className="primary" type="button" disabled={!!busy||uncertain||saveLocked||!savePreview.saveable||!selectedTask||!validSavePreview(savePreview,detail,selectedTask,project.id)} onClick={()=>void submitSave()}>确认保存为审查版本</button></div>}</section>}
      {detail.phase==='ready'&&<div className="worktree-review"><p>先完成任务当前版本的人工验收，再展开核对源与目标版本、文件差异。登记审查会生成绑定这两个完整提交的服务端记录；不会自动合入。</p><button className="secondary" type="button" disabled={!!busy||uncertain||saveLocked||!diffViewed||selectedTask?.acceptance!=='passed'||detail.dirty||detail.targetDirty||detail.patch===null||detail.patchTruncated||detail.head===detail.baseCommit} onClick={()=>void act('review')}>已核对当前差异，登记人工审查</button>{selectedTask?.acceptance!=='passed'&&<small>当前任务尚未通过人工验收。</small>}{review&&<p>审查记录 {short(review.reviewId)} · 源 {short(review.sourceHead)} → 目标 {short(review.targetHead)}</p>}{review&&<button className="primary" type="button" disabled={!!busy||uncertain||saveLocked||review.sourceHead!==detail.head||review.targetHead!==detail.targetHead} onClick={()=>void act('merge')}>按审查记录请求合入</button>}</div>}
      {['merging','conflict'].includes(detail.phase)&&<div className="worktree-conflict"><h4>{detail.phase==='conflict'?'合入冲突待人工解决':'合入待完成'}</h4>{detail.conflictFiles.length?<ul>{detail.conflictFiles.map(path=><li key={path}><code>{path}</code></li>)}</ul>:<p>没有未解决的冲突文件。</p>}<p>在本机检查并暂存最终文件。界面不会自动解决冲突，也不会覆盖当前项目目录。</p><details key={`${detail.id}:${inspectionVersion}`} onToggle={event=>{if(event.currentTarget.open&&detail.indexTree)setStagedViewedIndex(detail.indexTree);}}><summary>查看主工作区暂存差异与索引版本</summary><pre>{detail.stagedPatchTruncated?'暂存差异超过展示上限，请在本机完整审查。':detail.stagedPatch??'暂存差异无法读取。'}</pre><p>索引版本：<code title={detail.indexTree||''}>{short(detail.indexTree)}</code></p></details>{detail.reviewStatus?.valid===true?<p className="worktree-review-proof">当前审查仍有效；登记版本 {short(detail.reviewStatus.reviewId)}。</p>:<p className="worktree-warning" role="status">{reviewReasons[detail.reviewStatus?.reason||'']||'当前审查状态未核实，不能完成合入。'}</p>}{detail.reviewStatus?.valid!==true&&detail.reviewStatus?.reason!=='task_review_stale'&&<button className="secondary" type="button" disabled={!!busy||uncertain||saveLocked||stagedViewedIndex!==detail.indexTree||selectedTask?.acceptance!=='passed'||!!detail.conflictFiles.length||!detail.indexTree||detail.stagedPatch===null||detail.stagedPatchTruncated||!detail.mergeSourceHead||!detail.mergeTargetHead} onClick={()=>void act('reviewIndex')}>已核对当前暂存差异，登记新的人工审查</button>}{detail.reviewStatus?.reason==='task_review_stale'&&selectedTask?.acceptance==='passed'&&<button className="secondary" type="button" disabled={!!busy||uncertain||saveLocked||stagedViewedIndex!==detail.indexTree||!!detail.conflictFiles.length||!detail.indexTree||detail.stagedPatch===null||detail.stagedPatchTruncated||!detail.mergeSourceHead||!detail.mergeTargetHead} onClick={()=>void act('reviewIndex')}>已重新验收并核对暂存差异，登记新审查</button>}<button className="primary" type="button" disabled={!!busy||uncertain||saveLocked||stagedViewedIndex!==detail.indexTree||detail.reviewStatus?.valid!==true||selectedTask?.acceptance!=='passed'||!!detail.conflictFiles.length||!detail.indexTree||detail.stagedPatch===null||detail.stagedPatchTruncated} onClick={()=>void act('finalize')}>已核对暂存差异，完成合入提交</button></div>}
      <div className="worktree-cleanup"><button className="secondary" type="button" disabled={!!busy||uncertain||saveLocked||!detail.cleanupEligible} onClick={()=>void act('cleanup')}>安全清理工作区</button>{!detail.cleanupEligible&&<small>{detail.cleanupBlockedReason||'当前不能清理；修改与现场会保留。'}</small>}</div>
    </div>}
  </section>;
}
