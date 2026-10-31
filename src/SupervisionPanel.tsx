import {useEffect, useMemo, useState} from 'react';
import {ArrowRight, CheckCircle2, CircleDashed, Inbox, Layers2, Play, Search, TrendingUp} from 'lucide-react';
import type {BoardState, InboxItem, Task} from './types';
import './supervision.css';

type Filter='all'|'planned'|'running'|'attention'|'review'|'done';
type Matrix='projects'|'conversations';
const completed=(task:Task)=>task.status==='submitted'&&task.acceptance==='passed';
const needsReview=(task:Task)=>task.status==='submitted'&&!completed(task);
const statusLabel=(task:Task)=>completed(task)?'已完成':needsReview(task)?'待验收':({planned:'未开始',running:'进行中',paused:'已暂停',blocked:'遇到阻碍',failed:'执行失败',cancelled:'已取消',submitted:'待验收'} as const)[task.status];
const attentionLabel:Record<InboxItem['kind'],string>={decision:'需要决策',acceptance:'等待验收',blocked:'遇到阻碍',unknown:'结果待核实'};
function groupKey(task:Task,hub:boolean,sourceNames:Map<string,string>){
  if(hub){
    if(task.sourceConversationGroup)return {key:`source:${task.sourceConversationGroup}`,label:sourceNames.get(task.sourceConversationGroup)||'来源对话'};
    if(task.sourceConversationGroup===undefined)return {key:`source-unknown:${task.id}`,label:'来源信息未同步'};
    if(task.hasExecutionBinding)return {key:`masked:${task.id}`,label:'已绑定执行会话'};
    return {key:'unbound',label:'未关联会话'};
  }
  const source=task.sourceConversation;
  if(source?.provider&&source.conversationId)return {key:JSON.stringify(['source',source.provider,source.conversationId]),label:source.label?.trim()||`${source.provider} 来源会话`};
  if(task.conversationId)return {key:JSON.stringify(['execution',task.executionProvider||'codex-autocontinue',task.conversationId]),label:`${task.executionProvider||'Codex'} 执行会话`};
  return {key:'unbound',label:'未关联会话'};
}
function nextStep(task:Task){if(task.nextStep?.trim())return task.nextStep.trim();if(needsReview(task))return '打开任务，核对证据并决定是否验收。';if(task.status==='blocked'&&task.blockedReason?.trim())return `处理阻碍：${task.blockedReason.trim()}`;return '打开任务，补充明确的下一步。';}
function pct(done:number,total:number){return total?`${Math.round(done/total*100)}%`:'—'}
const filterLabels:Record<Filter,string>={all:'全部任务',planned:'未开始',running:'进行中',attention:'待我处理',review:'待验收',done:'已完成'};
function SummaryRow({label,tasks,attention,omitted,selected,onSelect}:{label:string;tasks:Task[];attention:number;omitted:string;selected:boolean;onSelect:(filter:Filter)=>void}){
  const done=tasks.filter(completed).length;
  const values:[Filter,number][]=[['all',tasks.length],['planned',tasks.filter(task=>task.status==='planned').length],['running',tasks.filter(task=>task.status==='running').length],['attention',attention],['review',tasks.filter(needsReview).length],['done',done]];
  return <tr className={selected?'is-selected':''}>
    <th scope="row"><button type="button" onClick={()=>onSelect('all')}>{label}<ArrowRight size={14}/></button></th>
    {values.map(([kind,count])=><td key={kind}><button type="button" className={`supervision-count count-${kind}${count===0?' is-zero':''}`} aria-label={`查看${label}的${filterLabels[kind]}：${count}${kind==='attention'?'条':'项'}`} onClick={()=>onSelect(kind)}>{count}{kind==='attention'&&<span className="supervision-count-unit">条</span>}</button>{kind==='attention'&&omitted&&<small className="supervision-missing">{omitted}</small>}</td>)}
    <td><span className={`supervision-percent${done===tasks.length&&tasks.length?' is-complete':''}`}>{pct(done,tasks.length)}</span></td>
  </tr>;
}
function taskKind(task:Task,items:InboxItem[],hub:boolean){const checks=task.verification?.pendingChecks?.filter(check=>!check.completed&&(hub?check.shareWithRemote!==false:true))||[];const labels=[...new Set(checks.map(check=>({implementation:'实现',test:'测试',decision:'决策'} as const)[check.kind]))];if(labels.length)return labels.join(' / ');const kinds=[...new Set(items.filter(item=>item.taskId===task.id&&item.state==='open'&&(!hub||item.shareWithRemote)).map(item=>({decision:'待决策',acceptance:'待验收',blocked:'阻塞',unknown:'结果核对'} as const)[item.kind]))];return kinds.length?kinds.join(' / '):'未分类'}
export default function SupervisionPanel({board,projectId,onOpenTask,onOpenConversation,onOpenInbox,onNewTask,taskCreateDisabledReason=()=>''}:{board:BoardState;projectId:string;onOpenTask:(taskId:string,projectId:string)=>void;onOpenConversation:(taskId:string,projectId:string)=>void;onOpenInbox:(projectId:string)=>void;onNewTask:(projectId:string)=>void;taskCreateDisabledReason?:(projectId:string)=>string}){
  const [scope,setScope]=useState(projectId||'all');
  const [filter,setFilter]=useState<Filter>('all');
  const [matrix,setMatrix]=useState<Matrix>('projects');
  const [conversationKey,setConversationKey]=useState('');
  const [query,setQuery]=useState('');
  useEffect(()=>{setScope(projectId||'all');setConversationKey('')},[projectId]);
  const privateRemote=board.connection.mode==='hub';
  const allTasks=useMemo(()=>board.tasks.filter(task=>task.status!=='cancelled'),[board.tasks]);
  const sourceNames=useMemo(()=>new Map([...new Set(allTasks.map(task=>task.sourceConversationGroup).filter((value):value is string=>typeof value==='string'&&value.length>0))].sort().map((value,index)=>[value,`来源对话 ${index+1}`])),[allTasks]);
  const scoped=useMemo(()=>allTasks.filter(task=>(scope==='all'||task.projectId===scope)&&(!conversationKey||groupKey(task,privateRemote,sourceNames).key===conversationKey)),[allTasks,scope,conversationKey,privateRemote,sourceNames]);
  const inboxAvailable=board.capabilities.inbox===true&&Boolean(board.inbox);
  const scopedTaskIds=new Set(scoped.map(task=>task.id));
  const attention=useMemo(()=>inboxAvailable?(board.inbox?.items||[]).filter(item=>item.state==='open'&&(scope==='all'||item.projectId===scope)&&(!conversationKey||scopedTaskIds.has(item.taskId))&&board.projects.find(project=>project.id===item.projectId)?.inboxAvailable!==false).sort((a,b)=>b.priority-a.priority||Date.parse(a.createdAt)-Date.parse(b.createdAt)):[],[board.inbox,board.projects,scope,conversationKey,inboxAvailable,scoped]);
  const relevantProjectIds=new Set(conversationKey?scoped.map(task=>task.projectId):scope==='all'?board.projects.map(project=>project.id):[scope]);
  const omittedCount=inboxAvailable?(board.inbox?.omitted||[]).filter(item=>relevantProjectIds.has(item.projectId)).reduce((sum,item)=>sum+item.open,0):0;
  const matrixOmittedCount=inboxAvailable?(board.inbox?.omitted||[]).reduce((sum,item)=>sum+item.open,0):0;
  const attentionTaskIds=new Set(attention.map(item=>item.taskId));
  const outsideList=board.projects.map(project=>({project,count:attention.filter(item=>item.projectId===project.id&&!scopedTaskIds.has(item.taskId)).length})).filter(item=>item.count>0);
  const counts={all:scoped.length,planned:scoped.filter(task=>task.status==='planned').length,running:scoped.filter(task=>task.status==='running').length,attention:attention.length,review:scoped.filter(needsReview).length,done:scoped.filter(completed).length};
  const groups=useMemo(()=>{const grouped=new Map<string,{label:string;tasks:Task[]}>();for(const task of allTasks){const {key,label}=groupKey(task,privateRemote,sourceNames);const group=grouped.get(key)||{label,tasks:[]};group.tasks.push(task);grouped.set(key,group)}return [...grouped].map(([key,value])=>({key,...value}));},[allTasks,privateRemote,sourceNames]);
  const rows=scoped.filter(task=>(filter==='all'||filter==='planned'&&task.status==='planned'||filter==='running'&&task.status==='running'||filter==='attention'&&attentionTaskIds.has(task.id)||filter==='review'&&needsReview(task)||filter==='done'&&completed(task))&&(`${task.title} ${task.summary} ${task.goal}`).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
  const createTaskReason=scope==='all'?'请先选择一个项目。':taskCreateDisabledReason(scope);
  function chooseScope(next:string){setScope(next);setConversationKey('');setFilter('all')}
  function chooseGroup(key:string){setConversationKey(key);setScope('all');setFilter('all')}
  const heading=conversationKey?groups.find(group=>group.key===conversationKey)?.label||'关联对话':scope==='all'?'全部项目':board.projects.find(project=>project.id===scope)?.name||'当前项目';
  return <div className="content-page supervision-page supervision-refined">
    <div className="supervision-intro"><div><h2>{heading}</h2><p>一眼看进展，按项目或对话追踪每项交付。</p></div><label className="supervision-scope"><span>项目范围</span><select aria-label="督办项目范围" value={scope} onChange={event=>chooseScope(event.target.value)}><option value="all">全部项目</option>{board.projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div>
    <div className="supervision-stats" role="group" aria-label="按状态筛选任务">{([
      {id:'all',label:'任务总数',hint:'当前范围内的有效任务',icon:Layers2},
      {id:'planned',label:'未开始',hint:'已规划，等待推进',icon:CircleDashed},
      {id:'running',label:'进行中',hint:'正在执行的任务',icon:Play},
      {id:'attention',label:'待我处理',hint:'需要决定或核对',icon:Inbox},
      {id:'done',label:'已完成',hint:'已提交且人工验收通过',icon:CheckCircle2},
    ] as const).map(({id,label,hint,icon:Icon})=><button key={id} className={`supervision-stat stat-${id}`} type="button" aria-pressed={filter===id} onClick={()=>setFilter(id)}><span><Icon size={16}/>{label}</span><strong>{counts[id]}{id==='attention'&&<small> 条</small>}</strong><small>{hint}</small></button>)}<div className="supervision-rate"><span><TrendingUp size={16}/>验收完成率</span><strong>{pct(counts.done,counts.all)}</strong><small>{counts.done} / {counts.all} 项已验收</small></div></div>
    {omittedCount>0&&<p className="supervision-omitted supervision-stat-note">另有 {omittedCount} 条待处理事项未同步，请在桌面查看。{conversationKey&&'这些事项无法归属到当前对话。'}</p>}
    <section className="supervision-matrix" aria-label="督办汇总"><div className="supervision-section-head"><div><span className="supervision-accent"/><h3>进度总览</h3></div><div className="supervision-segment" role="group" aria-label="汇总维度"><button type="button" aria-pressed={matrix==='projects'} onClick={()=>setMatrix('projects')}>按项目</button><button type="button" aria-pressed={matrix==='conversations'} onClick={()=>setMatrix('conversations')}>按对话</button></div></div><p className="supervision-swipe-hint">左右滑动查看完整统计</p><div className="supervision-table-scroll"><table className="supervision-table supervision-summary-table"><thead><tr><th scope="col">{matrix==='projects'?'项目':'来源 / 执行对话'}</th><th scope="col">任务</th><th scope="col">未开始</th><th scope="col">进行中</th><th scope="col">待我处理</th><th scope="col">待验收</th><th scope="col">已完成</th><th scope="col">验收完成率</th></tr></thead><tbody>{matrix==='projects'?board.projects.map(project=>{
        const list=allTasks.filter(task=>task.projectId===project.id);
        const itemCount=(board.inbox?.items||[]).filter(item=>inboxAvailable&&item.projectId===project.id&&item.state==='open'&&project.inboxAvailable!==false).length;
        const omitted=(board.inbox?.omitted||[]).find(item=>item.projectId===project.id)?.open||0;
        return <SummaryRow key={project.id} label={project.name} tasks={list} attention={itemCount} omitted={omitted?`另有 ${omitted} 条未同步`:''} selected={scope===project.id&&!conversationKey} onSelect={next=>{chooseScope(project.id);setFilter(next)}}/>;
      }):groups.map(group=>{
        const ids=new Set(group.tasks.map(task=>task.id));
        const itemCount=(board.inbox?.items||[]).filter(item=>inboxAvailable&&ids.has(item.taskId)&&item.state==='open'&&board.projects.find(project=>project.id===item.projectId)?.inboxAvailable!==false).length;
        const projectIds=new Set(group.tasks.map(task=>task.projectId));
        const omitted=(board.inbox?.omitted||[]).some(item=>projectIds.has(item.projectId)&&item.open>0);
        return <SummaryRow key={group.key} label={group.label} tasks={group.tasks} attention={itemCount} omitted={omitted?'所涉项目有未同步 *':''} selected={conversationKey===group.key} onSelect={next=>{chooseGroup(group.key);setFilter(next)}}/>;
      })}</tbody></table></div>{matrixOmittedCount>0&&<p className="supervision-omitted">另有 {matrixOmittedCount} 条待办事项尚未同步，请在桌面查看。{conversationKey&&'这些事项无法归属到当前对话，对话统计可能不完整。'}{matrix==='conversations'&&' * 对话行仅统计已同步事项，未同步事项无法按对话归属。'}</p>}{board.projects.length===0&&<div className="supervision-empty"><h3>还没有项目</h3><p>新建或导入项目后可在这里查看汇总。</p></div>}</section>
    {attention.length>0&&<section className="supervision-attention" aria-labelledby="supervision-attention-heading"><div className="supervision-section-head"><div><span className="supervision-accent"/><h3 id="supervision-attention-heading">需要我处理</h3></div><button type="button" onClick={()=>onOpenInbox(attention[0].projectId)}>查看全部待处理 <ArrowRight size={15}/></button></div><div className="supervision-attention-list">{attention.slice(0,3).map(item=>{const task=allTasks.find(task=>task.id===item.taskId);return <button type="button" key={item.id} onClick={()=>onOpenInbox(item.projectId)}><span className="supervision-attention-kind">{attentionLabel[item.kind]}</span><strong>{privateRemote&&!item.shareWithRemote?'有一项仅桌面可见的待处理事项':task?.title||'项目待处理事项'}</strong><span>{privateRemote&&!item.shareWithRemote?'请在桌面端查看详情':item.kind==='acceptance'?'请核对任务证据':item.kind==='unknown'?'请核对操作结果':item.summary}</span><ArrowRight size={15}/></button>})}</div></section>}
    <section className="supervision-detail" aria-label="任务督办明细"><div className="supervision-detail-head"><div><span className="eyebrow">任务明细</span><h3>{conversationKey?groups.find(group=>group.key===conversationKey)?.label||'关联对话':heading}<span>{rows.length} 项</span></h3><p className="supervision-detail-note">{filterLabels[filter]} · 百分比按验收标准计算，已取消任务不计入{filter==='attention'&&'。同一任务可能有多条待处理事项'}</p></div><div className="supervision-detail-tools">{filter!=='all'&&<button type="button" onClick={()=>setFilter('all')}>清除状态筛选</button>}{conversationKey&&<button type="button" onClick={()=>setConversationKey('')}>清除对话筛选</button>}<label className="supervision-search"><Search size={16}/><span className="sr-only">搜索任务</span><input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索任务"/></label></div></div>{filter==='attention'&&outsideList.map(({project,count})=><div className="supervision-outside-list" key={project.id}><span>{project.name}有 {count} 条事项的关联任务不在此清单中。</span><button type="button" onClick={()=>onOpenInbox(project.id)}>查看该项目待处理 <ArrowRight size={14}/></button></div>)}{rows.length===0?<div className="supervision-empty"><h3>{scoped.length?'没有符合条件的任务':'这个范围还没有任务'}</h3><p>{scoped.length?'切换状态或清除筛选后再看。':'创建任务后，这里会显示真实进展。'}</p>{!scoped.length&&scope!=='all'&&!conversationKey&&<><button className="primary" disabled={Boolean(createTaskReason)} title={createTaskReason||undefined} onClick={()=>onNewTask(scope)}>新建任务</button>{createTaskReason&&<small className="form-help" role="status">{createTaskReason}</small>}</>}</div>:<div className="supervision-table-scroll"><table className="supervision-table supervision-task-table"><thead><tr><th scope="col">任务</th><th scope="col">任务类型</th><th scope="col">来源对话 / AI</th><th scope="col">任务进展</th><th scope="col">验收进度</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>{rows.map(task=>{const project=board.projects.find(item=>item.id===task.projectId);const passed=task.criteria.filter(item=>item.passed).length;const source=task.sourceConversation;const sourceText=privateRemote?(task.sourceConversationGroup===undefined?'来源信息未同步':task.sourceConversationGroup?sourceNames.get(task.sourceConversationGroup)||'来源对话':task.hasExecutionBinding?'执行会话已绑定':'未关联'):source?.label?.trim()||source?.provider||task.executionProvider||'未关联';return <tr key={task.id}><th scope="row" data-label="任务"><button type="button" className="supervision-task-title" onClick={()=>onOpenTask(task.id,task.projectId)}>{task.title}</button>{scope==='all'&&<small>{project?.name||'未知项目'}</small>}</th><td data-label="任务类型"><span className="supervision-type">{taskKind(task,board.inbox?.items||[],privateRemote)}</span></td><td data-label="来源对话 / AI">{sourceText}{privateRemote&&task.hasExecutionBinding&&task.sourceConversationGroup!==null&&<small>执行会话已绑定</small>}</td><td data-label="任务进展"><span>{task.summary?.trim()||'尚未记录当前进展。'}</span><small>下一步：{nextStep(task)}</small></td><td data-label="验收进度">{task.criteria.length?<><div className="supervision-meter" role="progressbar" aria-label={`${task.title}验收项进度`} aria-valuemin={0} aria-valuemax={task.criteria.length} aria-valuenow={passed}><span style={{width:pct(passed,task.criteria.length)}}/></div><div className="supervision-progress-label"><strong>{pct(passed,task.criteria.length)}</strong><small>{passed}/{task.criteria.length} 项</small></div>{task.acceptance==='stale'&&<small className="supervision-recheck">版本已变，需重新验收</small>}</>:<span>未设置</span>}</td><td data-label="状态"><span className={`supervision-status ${completed(task)?'is-done':needsReview(task)?'is-review':task.status==='blocked'||task.status==='failed'?'is-risk':''}`}>{completed(task)&&<CheckCircle2 size={13}/>} {statusLabel(task)}</span></td><td data-label="操作"><button type="button" className="supervision-open" onClick={()=>onOpenTask(task.id,task.projectId)}>详情 <ArrowRight size={14}/></button>{(task.conversationId||task.hasExecutionBinding)&&<button type="button" className="supervision-open" onClick={()=>onOpenConversation(task.id,task.projectId)}>对话</button>}</td></tr>})}</tbody></table></div>}</section>
  </div>;
}
