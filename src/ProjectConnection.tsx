import {useCallback,useEffect,useRef,useState} from 'react';
import {errorMessage,isDesktop,request} from './api';
import type {Project} from './types';
import './project-connection.css';

type ReportStatus={
  enabled:boolean;
  directory:string|null;
  phase:'unbound'|'preparing'|'waiting'|'connected'|'attention'|'disabled';
  instructionPath:'.taskboard/REPORTING.md';
  prompt:string;
  lastReport:null|{file:string;status:'accepted'|'rejected';error?:string;eventId?:string;taskId?:string;receivedAt:string|null};
  lastAccepted?:null|{eventId:string;taskId:string;receivedAt:string};
  instructions?:{status:'preparing'|'current'|'customized';currentText:string|null;recommendedText:string};
  rule?:{codex:{path:'AGENTS.md';block:string;installed:boolean};claude:{path:'CLAUDE.md';block:string;installed:boolean}};
  problem?:string;
};
type Props={project:Project;onBound:()=>void|Promise<void>;onOpenTask:(taskId:string)=>void};
const phaseText:Record<ReportStatus['phase'],string>={unbound:'尚未绑定目录',preparing:'正在准备汇报说明',waiting:'等待 AI 汇报',connected:'已收到汇报',attention:'需要检查汇报',disabled:'汇报未启用'};
const timeText=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?'时间未确认':date.toLocaleString('zh-CN');};
const technicalText=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2);
const friendlyError=(value:string,action:'read'|'bind'|'rule'|'copy')=>{
  if(action==='read')return '暂时无法读取汇报状态。检查连接后可以重试，文件夹绑定仍可继续。';
  if(action==='bind'){
    if(value.includes('绝对路径'))return '请输入项目文件夹的完整路径。';
    if(value.includes('不可访问')||value.includes('不存在'))return '无法访问这个文件夹。请检查路径、权限和文件夹是否存在。';
    if(value.includes('停止任务并解除会话绑定'))return '项目中还有运行任务或关联会话。请先停止任务并解除关联，再更换文件夹。';
    if(value.includes('已关联其他项目'))return '这个文件夹已关联到另一个项目。请选择其他文件夹。';
    return '文件夹绑定失败。请展开技术详情查看原因。';
  }
  if(action==='rule'){
    if(value.includes('项目目录已变更'))return '项目文件夹已变化，请刷新后重试。';
    if(value.includes('标记但内容已修改'))return '项目中的规则说明已被修改。为保留你的内容，请手动检查后再处理。';
    if(value.includes('权限')||value.includes('EACCES')||value.includes('EPERM'))return '无法写入项目规则文件，请检查文件权限后重试。';
    return '规则说明未能添加。请展开技术详情查看原因。';
  }
  return '复制未完成。请在文本框中选择并复制。';
};

export default function ProjectConnection({project,onBound,onOpenTask}:Props){
  const [directory,setDirectory]=useState(project.directory||'');
  const [status,setStatus]=useState<ReportStatus|null>(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [operationError,setOperationError]=useState('');
  const [operationErrorAction,setOperationErrorAction]=useState<'bind'|'rule'>('bind');
  const [notice,setNotice]=useState('');
  const [copyError,setCopyError]=useState('');
  const [ruleBusy,setRuleBusy]=useState<'codex'|'claude'|null>(null);
  const active=useRef(true),inFlight=useRef(false),binding=useRef(false),readGeneration=useRef(0),refreshPending=useRef(false);
  const readStatus=useCallback(async()=>{
    if(inFlight.current||binding.current)return;
    inFlight.current=true;const generation=readGeneration.current;
    try{
      const result=await request<ReportStatus>('GET',`/api/projects/${encodeURIComponent(project.id)}/file-reporting`);
      if(active.current&&generation===readGeneration.current){setStatus(result);setError('');}
    }catch(cause){if(active.current&&generation===readGeneration.current)setError(technicalText(errorMessage(cause)));}
    finally{
      inFlight.current=false;
      if(active.current){setLoading(false);if(refreshPending.current&&!binding.current){refreshPending.current=false;window.setTimeout(()=>void readStatus(),0);}}
    }
  },[project.id]);
  useEffect(()=>{
    active.current=true;
    void readStatus();
    const timer=window.setInterval(()=>void readStatus(),2000);
    return()=>{active.current=false;window.clearInterval(timer);};
  },[readStatus]);
  async function chooseDirectory(){
    if(!window.taskboard||busy||ruleBusy)return;
    setNotice('');
    try{const value=await window.taskboard.chooseDirectory();if(value){setDirectory(value);setOperationError('');}}
    catch(cause){setOperationErrorAction('bind');setOperationError(technicalText(errorMessage(cause)));}
  }
  async function bindDirectory(){
    const value=directory.trim();if(!value||busy||ruleBusy)return;
    setBusy(true);binding.current=true;readGeneration.current++;refreshPending.current=true;setError('');setNotice('');setCopyError('');setStatus(null);
    try{
      await request('PATCH',`/api/projects/${encodeURIComponent(project.id)}`,{directory:value});
      setOperationError('');
      setNotice('目录已绑定，正在读取汇报状态。');
      await onBound();
    }catch(cause){setOperationErrorAction('bind');setOperationError(technicalText(errorMessage(cause)));}
    finally{binding.current=false;setBusy(false);if(!inFlight.current){refreshPending.current=false;void readStatus();}}
  }
  async function copyPrompt(){
    if(!status?.prompt||busy)return;
    setCopyError('');
    try{await navigator.clipboard.writeText(status.prompt);setNotice('提示词已复制。');setCopyError('');}
    catch(cause){setNotice(friendlyError('', 'copy'));setCopyError(technicalText(errorMessage(cause)));}
  }
  async function addRule(provider:'codex'|'claude'){
    if(busy||ruleBusy)return;
    setRuleBusy(provider);setOperationError('');setNotice('');
    try{
      await request('POST',`/api/projects/${encodeURIComponent(project.id)}/file-reporting/rule`,{provider,expectedDirectory:status?.directory||null});
      setNotice(`已将汇报说明添加到 ${provider==='codex'?'AGENTS.md':'CLAUDE.md'}。`);
      await readStatus();
    }catch(cause){setOperationErrorAction('rule');setOperationError(technicalText(errorMessage(cause)));}
    finally{setRuleBusy(null);}
  }
  const unavailable=busy||Boolean(ruleBusy);
  const promptAvailable=Boolean(status?.prompt.trim()&&['waiting','connected','attention'].includes(status.phase));
  const reportError=status?.lastReport?.error;
  const showProblem=Boolean(status?.problem&&status.problem!==reportError);
  return <main className="content-page project-connection">
    <div className="section-header"><div><span className="eyebrow">本机项目</span><h2>{project.name}</h2><p>把当前 AI 对话里的项目进展，汇报到这个项目目录。</p></div><span className={`project-connection-pill phase-${status?.phase||'loading'}`} role="status">{status?(status.phase==='waiting'&&status.lastReport?.status==='accepted'?'已收到历史汇报':phaseText[status.phase]):'正在读取状态'}</span></div>
    <section className="project-connection-card">
      <div className="project-connection-step"><span>1</span><div><h3>选择现有项目文件夹</h3><p>选择代码所在的文件夹即可，无需导入文件。序程会在文件夹中准备汇报说明和项目快照；AI 按说明提交进度后，看板会自动更新。</p></div></div>
      <label className="field" htmlFor="project-connection-directory"><span>项目文件夹路径</span><input id="project-connection-directory" value={directory} onChange={event=>{setDirectory(event.target.value);setOperationError('');}} placeholder="输入绝对路径，例如 /Users/me/my-project" autoComplete="off" disabled={unavailable}/></label>
      {operationError&&<div className="project-connection-error" role="alert"><p>{friendlyError(operationError,operationErrorAction)}</p><details><summary>技术详情</summary><pre>{operationError}</pre></details></div>}
      <div className="project-connection-actions">{isDesktop()&&<button className="secondary" type="button" onClick={()=>void chooseDirectory()} disabled={unavailable}>选择文件夹</button>}<button className="primary" type="button" onClick={()=>void bindDirectory()} disabled={unavailable||!directory.trim()||directory.trim()===status?.directory}>绑定文件夹</button></div>
    </section>
    <section className="project-connection-card">
      <div className="project-connection-step"><span>2</span><div><h3>在当前 AI 对话中发送汇报提示</h3><p>复制下面的提示词，粘贴到正在使用的 Codex、Claude 或其他 AI 对话中。看板不会替你启动 AI。</p></div></div>
      {promptAvailable?<><textarea className="project-connection-prompt" aria-label="汇报提示词" readOnly value={status!.prompt}/><div className="project-connection-actions"><button className="secondary" type="button" onClick={()=>void copyPrompt()} disabled={unavailable}>复制提示词</button><span className="small-note">复制失败时，可直接选择上方文本复制。</span></div></>:<p className="small-note">{status?.phase==='unbound'?'先绑定项目文件夹，提示词会在准备好后显示。':status?.phase==='preparing'?'正在准备汇报说明和项目快照…':loading?'正在读取汇报状态…':'当前状态尚未准备好汇报提示。'}</p>}
      {copyError&&<details className="project-connection-details"><summary>查看复制失败的技术详情</summary><pre>{copyError}</pre></details>}
      {status?.instructions?.status==='customized'&&<details className="project-connection-details"><summary>查看汇报说明与推荐内容的差异</summary><div className="project-connection-comparison"><p>项目中的说明与序程推荐内容不同。此处仅供查看，不会覆盖项目文件。</p><strong>项目当前说明</strong><pre>{status.instructions.currentText||'（当前文件内容为空）'}</pre><strong>推荐说明</strong><pre>{status.instructions.recommendedText}</pre></div></details>}
      {status?.instructions?.status==='current'&&<p className="project-connection-current">项目汇报说明已是推荐内容。</p>}
    </section>
    <section className="project-connection-card project-report-card" aria-live="polite">
      <div className="project-connection-step"><span>3</span><div><h3>查看接入结果</h3><p>看到“已收到汇报”，表示进度已经进入看板。</p></div></div>
      {status?.lastReport? <div className={`project-report-receipt ${status.lastReport.status}`}><strong>{status.lastReport.status==='accepted'?'汇报已接收':'汇报未接收'}</strong>{status.lastAccepted&&<><span>最近成功接收：<time>{timeText(status.lastAccepted.receivedAt)}</time></span><button type="button" className="project-open-task" onClick={()=>onOpenTask(status.lastAccepted!.taskId)}>查看对应任务</button></>}{status.lastReport.status==='rejected'&&<p>让 AI 读取失败原因并修正后再提交。</p>}{reportError&&<details><summary>查看技术详情</summary><pre>{reportError}</pre></details>}</div>:<>{status?.lastAccepted&&<div className="project-report-receipt accepted"><strong>最近汇报已接收</strong><span>接收时间：<time>{timeText(status.lastAccepted.receivedAt)}</time></span><button type="button" className="project-open-task" onClick={()=>onOpenTask(status.lastAccepted!.taskId)}>查看对应任务</button></div>}<p className="small-note">{status?.phase==='waiting'?'尚未收到汇报。发送上方提示词后，这里会自动更新。':status?.phase==='preparing'?'正在准备汇报文件说明…':status?.phase==='unbound'?'绑定文件夹后即可开始。':'暂时没有汇报回执。'}</p></>}
      {showProblem&&<div className="project-connection-error" role="alert"><p>{status?.instructions?.status==='customized'?'你修改过汇报说明，已为你保留。可展开对比新版内容。':'汇报服务暂时无法读取，请展开技术详情查看原因。'}</p><details><summary>技术详情</summary><pre>{status?.problem}</pre></details></div>}
      <details className="project-connection-generated"><summary>让新对话沿用汇报规则（可选）</summary><p>添加时会在 AGENTS.md 或 CLAUDE.md 末尾追加一小段汇报说明，并保留原有内容。这能提醒支持该文件的 AI 遵循说明，但不能保证每种 AI 工具都会执行。你可以先查看下面的内容，再决定是否添加。</p>{(['codex','claude'] as const).map(provider=>{const rule=status?.rule?.[provider];if(!rule)return null;return <div className="project-rule-option" key={provider}><strong>{provider==='codex'?'Codex':'Claude'} 项目规则 · {rule.path}</strong><pre>{rule.block}</pre>{rule.installed?<p>已添加</p>:<button type="button" className="secondary" onClick={()=>void addRule(provider)} disabled={Boolean(ruleBusy||busy)}>{ruleBusy===provider?'正在添加…':`添加到 ${rule.path}`}</button>}</div>;})}</details>
    </section>
    {error&&<div className="project-connection-error" role="alert"><p>{friendlyError(error,'read')}</p><details><summary>查看技术详情</summary><pre>{error}</pre></details></div>}
    {notice&&<p className="notice" role="status">{notice}</p>}
  </main>;
}
