import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowRight,Clock3,RefreshCw} from 'lucide-react';
import {ApiError,ReadTimeoutError,errorMessage as errorText,isDesktop,request} from './api';
import type {BoardState,CommandReceipt,InboxItem} from './types';
import CommandRecovery from './CommandRecovery';
import {reviewRejectionText} from './receipt-messages';
import {inboxDraftKey,readInboxDraft,saveInboxDraft,removeSubmittedInboxDraft,confirmedInboxAction,type InboxDraft} from './inbox-drafts';

type Action='acknowledge'|'answer'|'supplement';
type Filter='all'|InboxItem['kind']|'later'|'handled';
type Pending={commandId:string;projectId:string;taskId:string;itemId:string;itemRevision?:number;action:Action;status:string;draftKey?:string;submittedDraft?:InboxDraft};
const kinds:Record<InboxItem['kind'],string>={decision:'需要决策',acceptance:'等待验收',blocked:'遇到阻碍',unknown:'结果待核实'};
const historyKinds:Record<InboxItem['kind'],string>={decision:'决策记录',acceptance:'验收记录',blocked:'阻碍记录',unknown:'核实记录'};
const storageKey='seqivo-inbox-commands-v1';
const pendingStatus=new Set(['queued','received','sending','running']);
function readPending(key:string):Pending[]{try{const raw=JSON.parse(sessionStorage.getItem(key)||'[]');return Array.isArray(raw)?raw.filter((x:Pending)=>x&&typeof x.commandId==='string'&&typeof x.itemId==='string'&&typeof x.taskId==='string'&&typeof x.projectId==='string').map((x:Pending)=>x.status==='auth'?{...x,status:'received'}:x):[]}catch{return []}}
function dateText(value:string){const d=new Date(value);return Number.isNaN(d.getTime())?value:d.toLocaleString('zh-CN',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}
function syncText(board:BoardState){
  const value=board.connection.mode==='hub'?board.connection.lastSeen:board.connection.updatedAt;
  if(typeof value!=='string')return '尚未同步';
  const timestamp=Date.parse(value);
  return Number.isFinite(timestamp)&&timestamp>0?dateText(value):'尚未同步';
}
function statusText(status:string){return status==='auth'?'连接权限已变化；命令 ID 已保留。恢复原账号后核对回执，勿重新提交。':status==='unknown'?'操作结果未知，请核对目标任务；不要再次提交。':status==='failed'?'操作失败；请刷新并核对当前状态。':status==='expired'?'请求已过期，没有执行。':pendingStatus.has(status)?'请求已发送，等待目标电脑回执。':'操作已确认。'}
function nextAction(item:InboxItem){
  if(item.kind==='decision')return '查看待决定的内容，再选择或填写你的答复。';
  if(item.kind==='acceptance')return '打开任务核对当前证据，再由你决定是否验收。';
  if(item.kind==='unknown')return item.source.type==='hub.command'?'点击「核实这次操作」，让项目电脑检查原操作记录；不会重新执行。':'先查看任务或手机连接状态，确认这次操作的实际结果。';
  if(item.source.type==='plugin.autocontinue')return item.recommendedAction;
  if(item.source.type==='verification.check')return '打开任务，在「测试验证」中查看步骤；缺少资料时再补充信息。';
  return '打开任务了解阻碍；有帮助的信息可以在这里补充。';
}
function historyText(item:InboxItem){
  if(item.state==='superseded')return '这条事项属于旧任务版本，已由版本变化替代。请到任务中核对当前状态。';
  if(item.kind==='decision')return '这条决策事项已处理。可查看关联任务的当前状态。';
  if(item.kind==='acceptance')return '这条验收提醒已结束。是否通过，请以任务中的验收记录为准。';
  return '这条提醒已结束。请到任务中核对当前状态。';
}

export default function InboxPanel({board,projectId,onOpenTask,onOpenConnection,onOpenPlugin,onReview,onRefresh,clientOnline=true,connectionNoticeInHeader=false,onClientOffline=()=>{},accountId='local',isRecoveryCurrent=()=>true}:{board:BoardState;projectId:string;onOpenTask:(taskId:string,projectId:string)=>void;onOpenConnection:()=>void;onOpenPlugin?:()=>void;onReview:(taskId:string,projectId:string)=>void;onRefresh:()=>Promise<void>;clientOnline?:boolean;connectionNoticeInHeader?:boolean;onClientOffline?:()=>void;accountId?:string;isRecoveryCurrent?:()=>boolean}){
  const [filter,setFilter]=useState<Filter>('all');
  const [showAll,setShowAll]=useState(false);
  const [expandedId,setExpandedId]=useState<string|null>(null);
  const [drafts,setDrafts]=useState<Record<string,InboxDraft>>({});
  const draftStorage=useMemo(()=>{try{return window.localStorage}catch{return null}},[]);
  const accountStorageKey=`${storageKey}:${location.origin}:${accountId}`;
  const [pending,setPending]=useState<Pending[]>(()=>readPending(accountStorageKey));
  // A settled command must stay settled even before React commits pending state.
  const settledCommandIds=useRef(new Set<string>());
  const [messages,setMessages]=useState<Record<string,{text:string;error:boolean}>>({});
  const [working,setWorking]=useState<string>('');
  const [recoveryNotice,setRecoveryNotice]=useState('');
  const currentRecoveryGuard=useRef(isRecoveryCurrent);currentRecoveryGuard.current=isRecoveryCurrent;
  const hub=board.connection.mode==='hub';
  const available=board.capabilities.inbox===true&&Boolean(board.inbox)&&(!hub||board.projects.find(x=>x.id===projectId)?.inboxAvailable!==false);
  const clientOffline=!isDesktop()&&(!clientOnline||!navigator.onLine);
  const writable=available&&!clientOffline&&board.capabilities.role!=='viewer'&&(!hub||(!board.connection.offline&&board.capabilities.remote));
  const permissionReadOnly=board.capabilities.role==='viewer'||(hub&&!board.capabilities.remote);
  const items=board.inbox?.items||[];
  const draftIdentity=isDesktop()?'local-owner':accountId;
  function draftKey(item:InboxItem){return inboxDraftKey(draftIdentity,item.projectId,item.taskId,item.id)}
  function draftFor(item:InboxItem){const key=draftKey(item);return key?(drafts[key]||draftStorage&&readInboxDraft(draftStorage,key)):null}
  function sameDraft(a:InboxDraft,b:InboxDraft){return a.answer===b.answer&&a.optionId===b.optionId&&a.revision===b.revision&&a.contentVersion===b.contentVersion&&a.itemRevision===b.itemRevision}
  function updateDraft(item:InboxItem,task:BoardState['tasks'][number],patch:Partial<Pick<InboxDraft,'answer'|'optionId'>>){
    const key=draftKey(item);if(!key)return;
    const next:InboxDraft={...(draftFor(item)||{answer:'',optionId:'',revision:task.revision,contentVersion:task.contentVersion,itemRevision:item.itemRevision}),...patch};
    const saved=Boolean(draftStorage&&saveInboxDraft(draftStorage,key,next));
    setDrafts(current=>({...current,[key]:next}));
    setMessages(current=>{const copy={...current};if(saved){if(copy[item.id]?.text==='草稿未保存到此设备；离开或刷新后可能丢失。')delete copy[item.id];}
      else copy[item.id]={text:'草稿未保存到此设备；离开或刷新后可能丢失。',error:true};return copy;});
  }
  function clearSubmitted(item:Pick<InboxItem,'id'|'projectId'|'taskId'>,key:string|undefined,submitted:InboxDraft|undefined):boolean{
    const expected=inboxDraftKey(draftIdentity,item.projectId,item.taskId,item.id);
    if(!key||key!==expected||!submitted)return true;
    if(draftStorage&&!removeSubmittedInboxDraft(draftStorage,key,submitted))return false;
    setDrafts(current=>{if(!current[key]||!sameDraft(current[key],submitted))return current;
      const copy={...current};delete copy[key];return copy;});
    return true;
  }
  function resetDraft(item:InboxItem){const key=draftKey(item),current=draftFor(item);if(!key||!current)return;
    if(draftStorage&&!removeSubmittedInboxDraft(draftStorage,key,current)){
      setMessages(x=>({...x,[item.id]:{text:'旧草稿未能清除，请稍后重试。',error:true}}));return;
    }
    setDrafts(x=>{const next={...x};delete next[key];return next;});
    setMessages(x=>{const next={...x};delete next[item.id];return next;});
  }
  const omitted=board.inbox?.omitted?.find(x=>x.projectId===projectId);
  const pendingSignature=pending.map(x=>`${x.commandId}:${x.status}`).join('|');
  useEffect(()=>{sessionStorage.setItem(accountStorageKey,JSON.stringify(pending));},[pending,accountStorageKey]);
  useEffect(()=>{if(!hub||!pending.length)return;let active=true;const poll=async()=>{
    for(const item of pending){
      const requestGuard=currentRecoveryGuard.current;
      if(!active||!requestGuard())break;
      try{const receipt=await request<CommandReceipt>('GET',`/api/commands/${encodeURIComponent(item.commandId)}`);
        if(!active||!requestGuard()||!currentRecoveryGuard.current())break;
        if(settledCommandIds.current.has(item.commandId))continue;
        if(pendingStatus.has(receipt.status)||receipt.status==='unknown'){if(receipt.status!==item.status)setPending(current=>current.map(x=>x.commandId===item.commandId?{...x,status:receipt.status}:x));continue;}
        const confirmed=receipt.status==='completed'&&Number.isSafeInteger(item.itemRevision)&&
          confirmedInboxAction(receipt.status,receipt.result,item.taskId,item.itemId,item.itemRevision!);
        const cleared=confirmed?clearSubmitted({id:item.itemId,projectId:item.projectId,taskId:item.taskId},item.draftKey,item.submittedDraft):true;
        settledCommandIds.current.add(item.commandId);
        setPending(current=>current.filter(x=>x.commandId!==item.commandId));
        setMessages(current=>({...current,[item.itemId]:{text:receipt.status==='completed'&&!confirmed?'提交回执未能核实，请核对任务；草稿未清除。':statusText(receipt.status)+(receipt.error?` ${receipt.error}`:'')+(cleared?'':' 本地草稿未能清理。'),error:['unknown','failed','expired'].includes(receipt.status)||receipt.status==='completed'&&(!confirmed||!cleared)}}));
        if(receipt.status!=='unknown')void onRefresh();
      }catch(e){if(!active||!requestGuard()||!currentRecoveryGuard.current())break;if(settledCommandIds.current.has(item.commandId))continue;if(e instanceof ApiError&&[401,403,404].includes(e.status)){
        setPending(current=>current.map(x=>x.commandId===item.commandId?{...x,status:e.status===404?'unknown':'auth'}:x));
        setMessages(current=>({...current,[item.itemId]:{text:e.status===404?'无法查询原命令回执；结果未知，请在目标任务核对，勿重复提交。':'连接权限已变化，命令 ID 已保留。请恢复原账号连接，核对目标任务与回执。',error:true}}));
      }}
    }
  };void poll();const timer=window.setInterval(()=>void poll(),3000);return()=>{active=false;window.clearInterval(timer)}},[hub,pendingSignature,onRefresh]);
  const visible=useMemo(()=>items.filter(item=>item.projectId===projectId).filter(item=>filter==='handled'?['resolved','superseded'].includes(item.state):filter==='later'?item.state==='acknowledged':item.state==='open'&&(filter==='all'||item.kind===filter)).sort((a,b)=>b.priority-a.priority||Date.parse(a.createdAt)-Date.parse(b.createdAt)),[items,projectId,filter]);
  const shown=filter==='all'&&!showAll?visible.slice(0,5):visible;
  const counts=useMemo(()=>({all:items.filter(x=>x.projectId===projectId&&x.state==='open').length,later:items.filter(x=>x.projectId===projectId&&x.state==='acknowledged').length}),[items,projectId]);
  async function act(item:InboxItem,action:Action){
    if(!writable||working||pending.some(x=>x.itemId===item.id))return;
    if(hub&&!isRecoveryCurrent()){setMessages(x=>({...x,[item.id]:{text:'连接状态待确认，请刷新后再处理。',error:true}}));return}
    const task=board.tasks.find(x=>x.id===item.taskId&&x.projectId===item.projectId);
    if(!task){setMessages(x=>({...x,[item.id]:{text:'任务已变化，请刷新后核对。',error:true}}));return}
    const original=draftFor(item);
    const draft=original||{answer:'',optionId:'',revision:task.revision,contentVersion:task.contentVersion,itemRevision:item.itemRevision};
    if(action!=='acknowledge'&&original&&
      (original.revision!==task.revision||original.contentVersion!==task.contentVersion||original.itemRevision!==item.itemRevision)){
      setMessages(x=>({...x,[item.id]:{text:'任务或事项版本已变化；旧草稿不能直接提交。请重新填写。',error:true}}));return;
    }
    if(action==='answer'&&!draft.optionId&&!draft.answer.trim()){setMessages(x=>({...x,[item.id]:{text:'请选择一个选项或填写回答。',error:true}}));return}
    if(action==='supplement'&&!draft.answer.trim()){setMessages(x=>({...x,[item.id]:{text:'请填写需要补充的信息。',error:true}}));return}
    const submittedDraft=action==='acknowledge'?undefined:{...draft};
    const submittedKey=submittedDraft?draftKey(item)||undefined:undefined;
    const actionId=crypto.randomUUID();
    setExpandedId(null);
    const body:Record<string,unknown>={actionId,expectedRevision:task.revision,expectedItemRevision:item.itemRevision,action};
    if(action==='answer'){if(draft.optionId)body.optionId=draft.optionId;if(draft.answer.trim())body.answer=draft.answer.trim()}
    if(action==='supplement')body.answer=draft.answer.trim();
    setWorking(item.id);setMessages(x=>({...x,[item.id]:{text:'正在提交…',error:false}}));
    try{
      if(hub){
        // Persist the ID before sending. A lost response must never generate a second command.
        const record:Pending={commandId:actionId,projectId:item.projectId,taskId:item.taskId,itemId:item.id,itemRevision:item.itemRevision,action,status:'sending',draftKey:submittedKey,submittedDraft};
        sessionStorage.setItem(accountStorageKey,JSON.stringify([...readPending(accountStorageKey),record]));setPending(x=>[...x,record]);
        const commandBody:Record<string,unknown>={itemId:item.id,expectedItemRevision:item.itemRevision,action};
        if(body.answer)commandBody.answer=body.answer;if(body.optionId)commandBody.optionId=body.optionId;
        const receipt=await request<CommandReceipt>('POST','/api/commands',{commandId:actionId,projectId:item.projectId,taskId:item.taskId,action:'inbox_action',expectedRevision:task.revision,expiresAt:new Date(Date.now()+5*60_000).toISOString(),queueOffline:false,body:commandBody});
        if(!pendingStatus.has(receipt.status)){
          if(receipt.status==='unknown')setPending(x=>x.map(y=>y.commandId===actionId?{...y,status:'unknown'}:y));
          else {settledCommandIds.current.add(actionId);setPending(x=>x.filter(y=>y.commandId!==actionId));}
          const confirmed=confirmedInboxAction(receipt.status,receipt.result,item.taskId,item.id,item.itemRevision);
          const cleared=confirmed?clearSubmitted(item,submittedKey,submittedDraft):true;
          setMessages(x=>({...x,[item.id]:{text:receipt.status==='completed'&&!confirmed?'提交回执未能核实，请核对任务；草稿未清除。':statusText(receipt.status)+(cleared?'':' 本地草稿未能清理。'),error:['failed','expired','unknown'].includes(receipt.status)||receipt.status==='completed'&&(!confirmed||!cleared)}}));
          if(receipt.status!=='unknown')void onRefresh();
        }else setMessages(x=>({...x,[item.id]:{text:statusText(receipt.status),error:false}}));
      }else{
        const result=await request<{status:string;taskId:string;itemId:string;itemRevision:number}>('POST',`/api/tasks/${encodeURIComponent(item.taskId)}/inbox/${encodeURIComponent(item.id)}/actions`,body);
        const confirmed=confirmedInboxAction(result.status,result,item.taskId,item.id,item.itemRevision);
        const cleared=confirmed?clearSubmitted(item,submittedKey,submittedDraft):true;
        setMessages(x=>({...x,[item.id]:{text:!confirmed?'提交结果未能核实，请核对任务；草稿未清除。':(action==='acknowledge'?'已放到稍后处理。':action==='supplement'?'信息已补充；阻碍仍需核实。':'回答已记录。')+(cleared?'':' 本地草稿未能清理。'),error:!confirmed||!cleared}}));
        await onRefresh();
      }
    }catch(e){
      if(!isDesktop()&&(e instanceof TypeError||e instanceof ReadTimeoutError))onClientOffline();
      const conflict=e instanceof ApiError&&e.status===409;
      const staleRejected=hub&&conflict&&['REVISION_CONFLICT','INBOX_CONFLICT'].includes(e.code||'');
      setMessages(x=>({...x,[item.id]:{text:staleRejected?'任务或事项已变化；本次未提交。请刷新后核对最新状态。':hub?`提交回执未确认；已保留命令 ID，请等待查询结果，勿重复提交。${errorText(e)}`:conflict?'任务或事项已变化；已刷新，请重新核对后操作。':errorText(e),error:true}}));
      if(conflict)void onRefresh();
      if(hub&&e instanceof ApiError&&[401,403].includes(e.status))setPending(x=>x.map(y=>y.commandId===actionId?{...y,status:'auth'}:y));
      else if(hub&&e instanceof ApiError&&e.status===404)setPending(x=>x.map(y=>y.commandId===actionId?{...y,status:'unknown'}:y));
      else if(hub&&e instanceof ApiError&&(e.status===400||staleRejected)){settledCommandIds.current.add(actionId);setPending(x=>x.filter(y=>y.commandId!==actionId));}
      else if(hub&&conflict)setPending(x=>x.map(y=>y.commandId===actionId?{...y,status:'unknown'}:y));
    }finally{setWorking('')}
  }
  if(!available)return <div className="content-page inbox-page"><div className="empty-state"><h2>此连接尚未提供待处理收件箱</h2><p>更新目标电脑和手机连接服务后即可查看。现有任务仍可在任务清单中处理。</p><button className="primary" onClick={()=>onOpenTask('',projectId)}>查看任务清单 <ArrowRight size={16}/></button></div></div>;
  return <section className="content-page inbox-page" aria-label="需要我处理">
    {recoveryNotice&&<p className="inbox-message" role="status">{recoveryNotice}</p>}
    {omitted&&(omitted.open>0||omitted.history>0)&&<p className="alert" role="status">手机快照为部分内容：另有 {omitted.open} 项待处理、{omitted.history} 项历史记录保留在目标电脑。请在电脑上查看完整收件箱。</p>}
    {(connectionNoticeInHeader?permissionReadOnly:(board.connection.offline||!clientOnline||!writable))&&<p className="alert" role="status">{connectionNoticeInHeader?'当前连接只有查看权限，处理按钮已停用。':!clientOnline?'连接状态待确认，写操作已停用；恢复连接并刷新后可继续。':board.connection.offline?'目标电脑离线，处理按钮已停用。请连接后刷新。':'当前连接只有查看权限，处理按钮已停用。'}</p>}
    <div className="inbox-filter" role="group" aria-label="待处理筛选">{([['all',`现在 ${counts.all}`],['decision','决策'],['acceptance','验收'],['blocked','阻碍'],['unknown','待核实'],['later',`稍后 ${counts.later}`],['handled','已处理']] as [Filter,string][]).map(([id,label])=><button key={id} type="button" aria-pressed={filter===id} onClick={()=>{setFilter(id);setShowAll(false);setExpandedId(null)}}>{label}</button>)}</div>
    {!shown.length?<div className="empty-state"><h2>{filter==='all'?'目前没有需要你处理的事项':'这个筛选下暂无事项'}</h2><p>任务清单保留完整进展和验收依据。</p><button className="secondary" onClick={()=>onOpenTask('',projectId)}>查看任务清单</button></div>:<div className="inbox-list">{shown.map(item=>{
      const task=board.tasks.find(x=>x.id===item.taskId);
      const pendingItem=pending.find(x=>x.itemId===item.id);
      const disabled=!writable||Boolean(working)||Boolean(pendingItem)||Boolean(item.readOnly)||item.state==='resolved'||item.state==='superseded';
      const privateRemote=hub&&item.kind==='decision'&&!item.shareWithRemote;
      const handled=item.state==='resolved'||item.state==='superseded';
      const message=messages[item.id];
      const itemDraft=task?draftFor(item):null;
      const staleDraft=Boolean(itemDraft&&task&&(itemDraft.revision!==task.revision||
        itemDraft.contentVersion!==task.contentVersion||itemDraft.itemRevision!==item.itemRevision));
      return <article className="inbox-card" key={item.id}>
        <div className="inbox-card-head"><span className={`inbox-kind inbox-kind-${item.kind}`}>{handled?historyKinds[item.kind]:kinds[item.kind]}</span><span>{item.state==='acknowledged'?'稍后处理':item.state==='resolved'?'已处理':item.state==='superseded'?'旧版本已替代':''}</span></div>
        <h2>{privateRemote?(handled?'一条私人决策记录':'有一项私人决策需在电脑上处理'):item.title}</h2><p className="inbox-context">{task?.title||(item.kind==='unknown'?'项目命令尚未关联任务':'任务已变化')}</p>
        {!privateRemote&&<><div className="inbox-plain">{handled?<p><strong>历史状态</strong><span>{historyText(item)}</span></p>:<><p className="inbox-progress"><strong>当前进展</strong><span>{task?.summary?.trim()||'任务还没有填写当前进展，请打开任务查看。'}</span></p><p><strong>还需处理</strong><span>{item.kind==='acceptance'?'当前版本还没有人工验收。':item.kind==='unknown'?'这次操作的结果尚未确认。':item.summary}</span></p><p><strong>下一步</strong><span>{nextAction(item)}</span></p></>}</div><details className="inbox-details"><summary>查看完整说明与版本</summary><dl className="inbox-explanation"><div><dt>事项说明</dt><dd>{item.summary}</dd></div><div><dt>可能影响</dt><dd>{item.impact}</dd></div><div><dt>原始建议</dt><dd>{item.recommendedAction}</dd></div></dl><p>任务版本 {item.contentVersion} · 首次出现 {dateText(item.createdAt)}</p></details>
        {expandedId===item.id&&!handled&&item.kind==='decision'&&['open','acknowledged'].includes(item.state)&&<div className="inbox-input"><label htmlFor={`answer-${item.id}`}>你的回答</label>{Boolean(item.options?.length)&&<select aria-label={`选择 ${item.title} 的答案`} value={itemDraft?.optionId||''} onChange={e=>{if(task)updateDraft(item,task,{optionId:e.target.value})}}><option value="">选择一个选项（可选）</option>{item.options?.map(option=><option key={option.id} value={option.id}>{option.label} — {option.consequence}</option>)}</select>}<textarea id={`answer-${item.id}`} value={itemDraft?.answer||''} onChange={e=>{if(task)updateDraft(item,task,{answer:e.target.value})}} placeholder="也可填写具体回答" rows={2}/></div>}
        {expandedId===item.id&&!handled&&item.kind==='blocked'&&item.source.type!=='plugin.autocontinue'&&['open','acknowledged'].includes(item.state)&&<div className="inbox-input"><label htmlFor={`answer-${item.id}`}>补充信息</label><textarea id={`answer-${item.id}`} value={itemDraft?.answer||''} onChange={e=>{if(task)updateDraft(item,task,{answer:e.target.value,optionId:''})}} placeholder="写下可帮助解除阻碍的信息" rows={2}/></div>}
        {expandedId===item.id&&staleDraft&&<p className="inbox-safety" role="alert">任务或事项版本已变化，旧草稿保留供核对，不能直接提交。<button className="secondary" type="button" onClick={()=>resetDraft(item)}>重新填写（清除旧草稿）</button></p>}</>}
        <div className="inbox-actions"><button className="secondary" onClick={()=>task?onOpenTask(item.taskId,item.projectId):item.kind==='unknown'?onOpenConnection():onOpenTask('',item.projectId)}>{task?(handled?'查看任务':item.source.type==='verification.check'?'查看任务与验证步骤':'查看任务'):item.kind==='unknown'?'查看手机连接':'查看任务清单'} <ArrowRight size={15}/></button>{item.source.type==='plugin.autocontinue'&&!handled&&!hub&&onOpenPlugin&&(!board.capabilities.role||board.capabilities.role==='owner')&&<button className="primary" onClick={onOpenPlugin}>查看自动继续计划 <ArrowRight size={15}/></button>}{item.kind==='acceptance'&&['open','acknowledged'].includes(item.state)&&<button className="primary" disabled={disabled||!task} onClick={()=>onReview(item.taskId,item.projectId)}>人工验收</button>}{item.kind==='decision'&&['open','acknowledged'].includes(item.state)&&!privateRemote&&<button className={expandedId===item.id?'secondary':'primary'} disabled={disabled||!task} aria-expanded={expandedId===item.id} onClick={()=>setExpandedId(current=>current===item.id?null:item.id)}>{expandedId===item.id?'收起填写':'答复决策'}</button>}{item.kind==='decision'&&expandedId===item.id&&!handled&&!privateRemote&&<button className="primary" disabled={disabled||!task||staleDraft} onClick={()=>void act(item,'answer')}>提交回答</button>}{item.kind==='blocked'&&item.source.type!=='plugin.autocontinue'&&['open','acknowledged'].includes(item.state)&&<button className={expandedId===item.id?'secondary':'primary'} disabled={disabled||!task} aria-expanded={expandedId===item.id} onClick={()=>setExpandedId(current=>current===item.id?null:item.id)}>{expandedId===item.id?'收起填写':'补充信息'}</button>}{item.kind==='blocked'&&item.source.type!=='plugin.autocontinue'&&expandedId===item.id&&!handled&&<button className="primary" disabled={disabled||!task||staleDraft} onClick={()=>void act(item,'supplement')}>提交补充</button>}{item.state==='open'&&item.kind!=='unknown'&&!privateRemote&&!item.readOnly&&<button className="secondary" disabled={disabled||!task} onClick={()=>void act(item,'acknowledge')}><Clock3 size={15}/> 稍后处理</button>}{item.kind==='unknown'&&item.state==='open'&&<button className="secondary" onClick={()=>void onRefresh()}><RefreshCw size={15}/> 更新状态</button>}</div>
        {hub&&item.kind==='unknown'&&item.source.type==='hub.command'&&item.state==='open'&&<CommandRecovery commandId={item.source.id} identityKey={accountId} canReconcile={writable} isRecoveryCurrent={isRecoveryCurrent} onResolved={receipt=>{
          if(!isRecoveryCurrent()||receipt.commandId!==item.source.id||!['applied','not_applied'].includes(receipt.recovery?.outcome||''))return;
          setPending(current=>current.filter(entry=>entry.commandId!==receipt.commandId));
          setRecoveryNotice(reviewRejectionText(receipt)||(receipt.recovery?.outcome==='not_applied'?'已确认这次操作没有执行。请查看最新任务，再决定下一步。':'已找到这次操作的执行记录。请查看最新任务和输出；这不代表任务已经完成或验收通过。'));
          void onRefresh();
        }}/>}
        {privateRemote&&<p className="inbox-safety">{handled?'此决策的历史详情仅在目标电脑可见。':'此决策的内容仅在目标电脑可见。请在电脑上查看并处理。'}</p>}
        {item.kind==='unknown'&&!handled&&<p className="inbox-safety">请查看任务与目标会话的实际状态；结果未确认前不要重复提交。</p>}
        {pendingItem&&<p className="inbox-message" role="status">{statusText(pendingItem.status)}</p>}
        {message&&<p className={`inbox-message ${message.error?'inbox-message-error':''}`} role={message.error?'alert':'status'}>{message.text}</p>}
      </article>
    })}</div>}
    {filter==='all'&&!showAll&&visible.length>5&&<button className="secondary inbox-more" onClick={()=>setShowAll(true)}>查看其余 {visible.length-5} 项</button>}
    <p className="inbox-updated">最近同步 {syncText(board)}</p>
  </section>;
}
