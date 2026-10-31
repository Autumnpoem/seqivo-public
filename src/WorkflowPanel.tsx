import {useCallback,useEffect,useMemo,useState,type FormEvent} from 'react';
import {AlertCircle,CheckCircle2,Clock3,Play,Plus,RefreshCw,ShieldCheck} from 'lucide-react';
import {request} from './api';
import type {Project,Task} from './types';
import WorktreePanel,{type WorktreeBinding,type WorktreeEntry} from './WorktreePanel';

interface MemberDraft {selected:boolean;role:string;model:string;dependsOn:string[];reviewOf:string;worktreeId:string}
interface WorkflowMember {taskId:string;role:string;provider:string;model?:string;actualModel?:string;dependsOn:string[];reviewOf:string|null;worktreeId?:string|null;status:string;attempts:number;startedAt:string|null;endedAt:string|null;lastError:string|null}
interface Plan {id:string;projectId:string;workspaceMode?:'project'|'worktree';status:string;members:WorkflowMember[];maxConcurrent:number;maxStarts:number;budgetMinutes:number;starts:number;createdAt:string;startedAt:string|null;deadlineAt:string|null;updatedAt:string}
interface WorkflowState {version:number;plans:Plan[]}
const roleNames:Record<string,string>={worker:'执行',reviewer:'独立审查',tester:'测试',planner:'规划'};
const planNames:Record<string,string>={draft:'草稿',active:'运行中',pause_pending:'正在暂停',paused:'已暂停',budget_exhausted:'预算已用尽',complete:'已完成',restored:'已从备份恢复'};
const memberNames:Record<string,string>={pending:'等待依赖',sending:'发送中',running:'已开始',awaiting_review:'等待人工验收',complete:'已通过验收',unknown:'结果待核对',blocked:'额度或条件阻碍',pausing:'正在暂停',paused:'已暂停',failed:'未开始或失败',stale:'任务要求已变更',restored:'恢复后需重建计划'};
const providerNames:Record<string,string>={'codex-autocontinue':'Codex','claude-code':'Claude Code','cursor-agent':'Cursor Agent'};
function message(error:unknown){return error instanceof Error?error.message:'操作没有完成。'}
function minutes(value:string|null){if(!value)return '尚未启动';return `${Math.max(0,Math.floor((Date.now()-Date.parse(value))/60000))} 分钟`}
function initial():MemberDraft{return {selected:false,role:'worker',model:'',dependsOn:[],reviewOf:'',worktreeId:''}}

export default function WorkflowPanel({project,tasks}:{project?:Project;tasks:Task[]}){
  const [data,setData]=useState<WorkflowState>({version:1,plans:[]});
  const [drafts,setDrafts]=useState<Record<string,MemberDraft>>({});
  const [maxConcurrent,setMaxConcurrent]=useState('1');
  const [maxStarts,setMaxStarts]=useState('5');
  const [budgetMinutes,setBudgetMinutes]=useState('30');
  const [workspaceMode,setWorkspaceMode]=useState<'project'|'worktree'>('project');
  const [worktrees,setWorktrees]=useState<WorktreeEntry[]>([]);
  const [bindings,setBindings]=useState<Record<string,WorktreeBinding>>({});
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const load=useCallback(async()=>{
    try{const state=await request<WorkflowState>('GET','/api/workflow');setData(state);setError('');}
    catch(e){setError(message(e));}
  },[]);
  useEffect(()=>{void load();const timer=window.setInterval(()=>{void load()},10000);return()=>window.clearInterval(timer)},[load]);
  const eligible=useMemo(()=>tasks.filter(task=>task.conversationId&&!['running','paused','submitted','cancelled'].includes(task.status)&&task.acceptance!=='passed'),[tasks]);
  const selected=eligible.filter(task=>drafts[task.id]?.selected);
  const verifiedTree=(task:Task,draft:MemberDraft)=>worktrees.find(entry=>entry.id===draft.worktreeId&&entry.phase==='ready'&&entry.taskId===task.id&&entry.role===draft.role&&bindings[entry.id]?.verified===true&&bindings[entry.id]?.taskId===task.id&&bindings[entry.id]?.conversationId===task.conversationId);
  const missingWorktree=workspaceMode==='worktree'&&selected.some(task=>!verifiedTree(task,drafts[task.id]||initial()));
  const plans=data.plans.filter(plan=>plan.projectId===project?.id).slice().reverse();
  const excluded=tasks.filter(task=>!eligible.some(item=>item.id===task.id)&&task.status!=='cancelled');
  function update(id:string,patch:Partial<MemberDraft>){setDrafts(current=>({...current,[id]:{...(current[id]||initial()),...patch}}))}
  const updateTrees=useCallback((items:WorktreeEntry[])=>setWorktrees(items),[]);
  const updateBindings=useCallback((items:Record<string,WorktreeBinding>)=>setBindings(items),[]);
  function toggleDependency(id:string,target:string){const current=drafts[id]||initial();update(id,{dependsOn:current.dependsOn.includes(target)?current.dependsOn.filter(value=>value!==target):[...current.dependsOn,target]})}
  async function verifyWorktreeSessions(members:{taskId:string;worktreeId?:string|null}[]){
    const checked=await Promise.all(members.map(async member=>{
      if(!member.worktreeId)throw new Error('计划成员尚未选择工作树。');
      const task=tasks.find(item=>item.id===member.taskId);
      const binding=await request<WorktreeBinding>('GET',`/api/worktrees/${encodeURIComponent(member.worktreeId)}/binding`);
      if(!task?.conversationId||binding.verified!==true||binding.status!=='bound'||binding.worktreeId!==member.worktreeId||binding.taskId!==task.id||binding.conversationId!==task.conversationId)
        throw new Error(`「${task?.title||member.taskId}」的执行会话未被服务器核实为当前工作树，计划保持未启动。`);
      return binding;
    }));
    setBindings(Object.fromEntries(checked.map(item=>[item.worktreeId,item])));
  }
  async function create(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!project||!project.directory||!selected.length||missingWorktree)return;
    setBusy('create');setError('');setNotice('');
    try{
      const members=selected.map(task=>{
        const draft=drafts[task.id];
        return {taskId:task.id,role:draft.role,provider:task.executionProvider||'codex-autocontinue',...(draft.model.trim()?{model:draft.model.trim()}:{}),dependsOn:draft.dependsOn.filter(id=>id!==task.id&&selected.some(item=>item.id===id)),...(draft.reviewOf&&selected.some(item=>item.id===draft.reviewOf)?{reviewOf:draft.reviewOf}:{}),...(workspaceMode==='worktree'?{worktreeId:draft.worktreeId}:{})};
      });
      if(workspaceMode==='worktree')await verifyWorktreeSessions(members);
      await request('POST','/api/workflow/plans',{projectId:project.id,workspaceMode,members,maxConcurrent:Number(maxConcurrent),maxStarts:Number(maxStarts),budgetMinutes:Number(budgetMinutes)});
      setDrafts({});await load();setNotice('协作计划草稿已保存。请核对成员和预算后，再明确启动。');
    }catch(e){setError(message(e));}
    finally{setBusy('');}
  }
  async function action(plan:Plan,verb:'start'|'pause'){
    setBusy(plan.id);setError('');setNotice('');
    try{if(verb==='start'&&plan.workspaceMode==='worktree')await verifyWorktreeSessions(plan.members);await request('POST',`/api/workflow/plans/${encodeURIComponent(plan.id)}/${verb}`,{});await load();setNotice(verb==='start'?'启动请求已提交，请查看成员实际状态。':'暂停请求已提交，请核对每位成员的回执。');}
    catch(e){setError(message(e));}
    finally{setBusy('');}
  }
  async function reconcile(plan:Plan,member:WorkflowMember){
    setBusy(member.taskId);setError('');setNotice('');
    try{await request('POST',`/api/workflow/plans/${encodeURIComponent(plan.id)}/reconcile`,{taskId:member.taskId,confirm:true});await load();setNotice('已根据执行工具的可核实状态更新记录。');}
    catch(e){setError(message(e));}
    finally{setBusy('');}
  }
  return <div className="content-page workflow-page">
    <div className="section-header"><div><h2>协作计划</h2><p>安排已有任务的角色与依赖；每项工作仍需人工验收。</p></div><button className="secondary" onClick={()=>void load()} disabled={Boolean(busy)}><RefreshCw size={15}/> 刷新</button></div>
    {!project?<div className="setting-card"><p>先选择一个项目。</p></div>:<>
      {!project.directory&&<p className="alert" role="status">项目尚未绑定本机目录。先在“记录备份”中绑定，再建立计划。</p>}
      {project.directory&&<WorktreePanel project={project} tasks={tasks} onEntriesChange={updateTrees} onBindingsChange={updateBindings}/>}
      <form className="setting-card workflow-builder" onSubmit={event=>void create(event)}><div className="card-heading"><Plus size={17}/><h3>新建计划草稿</h3></div><p>选择已绑定执行会话的任务。创建草稿不会启动任何工具。</p>
        <label className="workflow-workspace-mode">工作区安排<select aria-label="工作区安排" value={workspaceMode} onChange={event=>setWorkspaceMode(event.target.value as 'project'|'worktree')}><option value="project">项目目录串行（默认）</option><option value="worktree">独立工作树（明确选择）</option></select></label>
        {eligible.length?<div className="workflow-candidates">{eligible.map(task=>{const draft=drafts[task.id]||initial();const options=worktrees.filter(entry=>entry.phase==='ready'&&entry.taskId===task.id&&entry.role===draft.role&&bindings[entry.id]?.verified===true&&bindings[entry.id]?.taskId===task.id&&bindings[entry.id]?.conversationId===task.conversationId);return <section className="workflow-candidate" key={task.id}><label className="workflow-select"><input type="checkbox" checked={draft.selected} onChange={event=>update(task.id,{selected:event.target.checked})}/><span><strong>{task.title}</strong><small>{providerNames[task.executionProvider||'codex-autocontinue']||task.executionProvider} · {task.status==='planned'?'待开始':'待处理'}</small></span></label>{draft.selected&&<div className="workflow-member-fields"><label className="field"><span>承担角色</span><select aria-label={`${task.title} 承担角色`} value={draft.role} onChange={event=>update(task.id,{role:event.target.value,worktreeId:''})}>{Object.entries(roleNames).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label className="field"><span>请求模型（可留空）</span><input aria-label={`${task.title} 请求模型`} value={draft.model} maxLength={100} placeholder="留空则继承工具设置" onChange={event=>update(task.id,{model:event.target.value})}/></label>{workspaceMode==='worktree'&&<label className="field"><span>已核实的独立工作树</span><select aria-label={`${task.title} 独立工作树`} value={draft.worktreeId} onChange={event=>update(task.id,{worktreeId:event.target.value})}><option value="">选择工作树</option>{options.map(entry=><option key={entry.id} value={entry.id}>{entry.branch} · {entry.id.slice(0,8)}</option>)}</select>{!options.length&&<small>服务器尚未核实此任务会话绑定到对应工作树；原目录会话不能迁移。</small>}</label>}<label className="field"><span>审查目标</span><select aria-label={`${task.title} 审查目标`} value={draft.reviewOf} onChange={event=>update(task.id,{reviewOf:event.target.value})}><option value="">无</option>{selected.filter(item=>item.id!==task.id).map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label><fieldset className="workflow-dependencies"><legend>等待哪些任务通过验收</legend>{selected.filter(item=>item.id!==task.id).length?selected.filter(item=>item.id!==task.id).map(item=><label key={item.id}><input type="checkbox" checked={draft.dependsOn.includes(item.id)} onChange={()=>toggleDependency(task.id,item.id)}/>{item.title}</label>):<small>当前没有其他已选任务。</small>}</fieldset></div>}</section>})}</div>:<p>没有可加入的任务。请先创建未完成任务，并绑定执行会话。</p>}
        {excluded.length>0&&<details className="workflow-excluded"><summary>{excluded.length} 项任务暂不可加入</summary><ul>{excluded.map(task=><li key={task.id}>{task.title}：{!task.conversationId?'未绑定执行会话':task.status==='running'?'正在运行':task.status==='paused'?'已暂停':task.status==='submitted'?'等待验收':task.acceptance==='passed'?'已验收':'当前状态不可启动'}</li>)}</ul></details>}
        <div className="workflow-limits"><label className="field"><span>最多同时启动</span><input type="number" min="1" max="3" required value={maxConcurrent} onChange={event=>setMaxConcurrent(event.target.value)}/></label><label className="field"><span>最多启动次数</span><input type="number" min="1" max="20" required value={maxStarts} onChange={event=>setMaxStarts(event.target.value)}/></label><label className="field"><span>时间预算（分钟）</span><input type="number" min="1" max="120" required value={budgetMinutes} onChange={event=>setBudgetMinutes(event.target.value)}/></label></div><p className="form-help">{workspaceMode==='worktree'?'仅服务器核实会话绑定的工作树可加入；各角色在独立目录工作，合入仍需人工审查。':'同一项目目录的任务会串行启动；请求模型不代表实际运行模型已确认。'}</p><button className="primary" type="submit" disabled={busy==='create'||!project.directory||!selected.length||missingWorktree}>保存草稿</button>
      </form>
      <div className="section-header"><div><h2>已有计划</h2><p>启动次数会在调用执行工具前计入预算。</p></div></div>
      {plans.length?plans.map(plan=><article className="setting-card workflow-plan" key={plan.id}><div className="workflow-plan-head"><div><h3>{plan.members.map(member=>tasks.find(task=>task.id===member.taskId)?.title||'已移除任务').slice(0,2).join('、')}{plan.members.length>2?` 等 ${plan.members.length} 项`:''}</h3><p>创建于 {new Date(plan.createdAt).toLocaleString('zh-CN')} · {plan.workspaceMode==='worktree'?'独立工作树':'项目目录串行'}</p></div><span className="pill">{planNames[plan.status]||plan.status}</span></div><div className="workflow-stats"><span><Play size={14}/> 启动 {plan.starts}/{plan.maxStarts} 次</span><span><Clock3 size={14}/> 已用 {minutes(plan.startedAt)} / {plan.budgetMinutes} 分钟</span><span>同时最多 {plan.maxConcurrent} 项</span></div><div className="workflow-members">{plan.members.map(member=>{const task=tasks.find(item=>item.id===member.taskId);const tree=worktrees.find(item=>item.id===member.worktreeId);return <div className="workflow-member" key={member.taskId}><div><strong>{task?.title||member.taskId}</strong><span>{roleNames[member.role]||member.role} · {providerNames[member.provider]||member.provider} · {memberNames[member.status]||member.status}</span><small>请求模型：{member.model||'继承工具设置'} · 实际模型：{member.actualModel||'未确认'}</small>{member.worktreeId&&<small>工作树：{tree?.branch||member.worktreeId} · {tree?.phase||'状态待刷新'}</small>}{member.reviewOf&&<small>审查：{tasks.find(item=>item.id===member.reviewOf)?.title||member.reviewOf}</small>}{member.dependsOn.length>0&&<small>依赖 {member.dependsOn.length} 项人工验收</small>}{member.lastError&&<small className="warning-line">{member.lastError}</small>}</div>{member.status==='complete'?<CheckCircle2 size={17} className="workflow-good"/>:member.status==='unknown'?<AlertCircle size={17} className="workflow-risk"/>:null}{member.status==='unknown'&&<div className="workflow-reconcile"><p>看板会向执行工具查询这条命令的实际状态。若工具仍无法确认，任务会保持锁定，不会自动重试。</p><button className="secondary" disabled={busy===member.taskId} onClick={()=>void reconcile(plan,member)}>核对执行状态</button></div>}</div>})}</div><div className="action-row">{['draft','paused'].includes(plan.status)&&<button className="primary" disabled={Boolean(busy)} onClick={()=>void action(plan,'start')}><Play size={15}/> 明确启动</button>}{['active','pause_pending'].includes(plan.status)&&<button className="secondary" disabled={Boolean(busy)} onClick={()=>void action(plan,'pause')}>暂停计划</button>}</div></article>):<div className="setting-card"><p>还没有协作计划。</p></div>}
    </>}
    {error&&<p className="alert" role="alert">{error}</p>}{notice&&<p className="notice" role="status"><ShieldCheck size={15}/>{notice}</p>}
  </div>;
}
