import {useCallback, useEffect, useState, type ChangeEvent} from 'react';
import {ArrowRight, Clock3, Download, RefreshCw, Upload, X} from 'lucide-react';
import {request} from './api';
import type {HistoryEntry, HistoryResponse, Project, Task} from './types';

function message(error:unknown){return error instanceof Error?error.message:'操作没有完成。'}
function stamp(value?:string){if(!value)return '时间未知';const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toLocaleString('zh-CN');}
const eventLabels:Record<string,string>={'project.created':'创建项目','task.created':'创建任务','task.updated':'更新任务','task.reviewed':'人工验收','evidence.added':'添加证据','issue.resolved':'解决偏差','task.session.created':'绑定会话'};
function eventTitle(event:HistoryEntry){return eventLabels[event.type||'']||'记录更新'}
function eventSummary(event:HistoryEntry){
  if(typeof event.summary==='string'&&event.summary)return event.summary;
  if(typeof event.title==='string'&&event.title)return event.title;
  if(event.decision==='pass')return '验收通过';
  if(event.decision==='fail')return '验收未通过';
  return '';
}

export default function DataPanel({project,tasks,onRestored}:{project?:Project;tasks:Task[];onRestored:()=>Promise<void>}){
  const [drawer,setDrawer]=useState(false);
  const [taskId,setTaskId]=useState('');
  const [events,setEvents]=useState<HistoryEntry[]>([]);
  const [cursor,setCursor]=useState<number|string|null>(null);
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [archive,setArchive]=useState<unknown>(null);
  const [archiveName,setArchiveName]=useState('');
  const [confirmation,setConfirmation]=useState('');
  const [replayConfirmation,setReplayConfirmation]=useState('');
  const [directory,setDirectory]=useState('');
  useEffect(()=>{setDirectory(project?.directory||'')},[project?.id,project?.directory]);
  const load=useCallback(async(append=false)=>{
    if(!project)return;
    setLoading(true);setError('');
    try{
      const query=new URLSearchParams({projectId:project.id});
      if(taskId)query.set('taskId',taskId);
      if(append&&cursor!==null)query.set('afterSeq',String(cursor));
      const data=await request<HistoryResponse>('GET',`/api/history?${query}`);
      setEvents(current=>append?[...current,...(data.events||[])]:data.events||[]);
      setCursor((data.events||[]).length>=100?data.cursor??null:null);
    }catch(e){setError(message(e));}
    finally{setLoading(false);}
  },[project,taskId,cursor]);
  useEffect(()=>{if(drawer)void load(false)},[drawer,project?.id,taskId]);
  async function download(){
    setBusy(true);setError('');setNotice('');
    try{
      const data=await request<unknown>('GET','/api/backup');
      const blob=new Blob([JSON.stringify(data)],{type:'application/json'});
      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');link.href=url;link.download=`tuijin-backup-${new Date().toISOString().slice(0,10)}.json`;
      document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
      setNotice('备份已准备下载。');
    }catch(e){setError(message(e));}
    finally{setBusy(false);}
  }
  async function selectArchive(event:ChangeEvent<HTMLInputElement>){
    const file=event.target.files?.[0];setArchive(null);setArchiveName('');setConfirmation('');setError('');
    if(!file)return;
    try{if(file.size>16_000_000)throw Error('备份文件超过 16 MB，请检查文件。');setArchive(JSON.parse(await file.text()));setArchiveName(file.name);}
    catch(e){setError(message(e));}
  }
  async function restore(){
    if(confirmation!=='恢复'||archive===null)return;
    setBusy(true);setError('');setNotice('');
    try{await request('POST','/api/backup/restore',{archive,confirm:true});await onRestored();setArchive(null);setArchiveName('');setConfirmation('');setNotice('备份已恢复。请重新绑定项目目录和执行会话，并重新验收；自动继续保持关闭。');}
    catch(e){setError(message(e));}
    finally{setBusy(false);}
  }
  async function replay(){
    if(replayConfirmation!=='重建')return;
    setBusy(true);setError('');setNotice('');
    try{await request('POST','/api/maintenance/replay',{confirm:true});await onRestored();setReplayConfirmation('');setNotice('记录已重建，请核对当前任务。');}
    catch(e){setError(message(e));}
    finally{setBusy(false);}
  }
  async function bindDirectory(){
    if(!project||!directory.trim())return;
    setBusy(true);setError('');setNotice('');
    try{await request('PATCH',`/api/projects/${encodeURIComponent(project.id)}`,{directory:directory.trim()});await onRestored();setNotice('项目目录已绑定。请在任务详情核对并绑定执行会话。');}
    catch(e){setError(message(e));}
    finally{setBusy(false);}
  }
  return <div className="content-page"><div className="section-header"><div><h2>记录与备份</h2><p>查看任务变化，保存或恢复自己的看板数据。</p></div></div><div className="plugin-grid"><section className="setting-card"><div className="card-heading"><Clock3 size={18}/><h3>历史记录</h3></div><p>按项目或任务查看更新来源与时间。</p><button className="secondary" onClick={()=>setDrawer(true)} disabled={!project}>查看历史 <ArrowRight size={15}/></button></section><section className="setting-card"><div className="card-heading"><Download size={18}/><h3>下载备份</h3></div><p>保存当前项目和任务记录，供日后恢复。</p><button className="secondary" onClick={()=>void download()} disabled={busy}><Download size={15}/> 下载备份</button></section></div>{project&&<section className="setting-card"><div className="card-heading"><h3>项目目录</h3></div><p>恢复备份后，需要重新指定此项目的本机目录。</p><label className="field" htmlFor="rebind-directory"><span>{project.name} 的目录</span><input id="rebind-directory" value={directory} onChange={e=>setDirectory(e.target.value)} placeholder="项目目录的绝对路径"/></label><div className="action-row">{window.taskboard&&<button className="secondary" onClick={()=>void window.taskboard?.chooseDirectory().then(value=>{if(value)setDirectory(value)}).catch(e=>setError(message(e)))}>选择目录</button>}<button className="secondary" disabled={busy||!directory.trim()||directory.trim()===project.directory} onClick={()=>void bindDirectory()}>绑定目录</button></div></section>}<section className="setting-card"><div className="card-heading"><Upload size={18}/><h3>从备份恢复</h3></div><p>恢复会替换当前记录、停止自动继续，并清除项目目录与执行会话绑定。恢复后请重新绑定目录和会话，再重新验收任务。</p><label className="field" htmlFor="backup-file"><span>备份文件</span><input id="backup-file" type="file" accept=".json,application/json" onChange={e=>void selectArchive(e)}/></label>{archiveName&&<p>已选择：{archiveName}</p>}<label className="field" htmlFor="restore-confirm"><span>输入“恢复”以确认替换当前记录</span><input id="restore-confirm" value={confirmation} onChange={e=>setConfirmation(e.target.value)} autoComplete="off"/></label><button className="secondary" disabled={busy||archive===null||confirmation!=='恢复'} onClick={()=>void restore()}>确认恢复</button></section><details className="setting-card maintenance"><summary>修复任务记录</summary><p>从历史记录重建当前索引。此操作不会运行任务或向 AI 发送指令。</p><label className="field" htmlFor="replay-confirm"><span>输入“重建”以确认</span><input id="replay-confirm" value={replayConfirmation} onChange={e=>setReplayConfirmation(e.target.value)} autoComplete="off"/></label><button className="secondary" disabled={busy||replayConfirmation!=='重建'} onClick={()=>void replay()}>重建记录</button></details>{error&&<p className="alert" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
    {drawer&&<div className="dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setDrawer(false)}}><section className="history-drawer" role="dialog" aria-modal="true" aria-label="历史记录"><header className="dialog-top"><h2>历史记录</h2><button className="icon-button" aria-label="关闭历史记录" onClick={()=>setDrawer(false)}><X size={17}/></button></header><div className="action-row history-tools"><label className="field" htmlFor="history-task"><span>查看范围</span><select id="history-task" value={taskId} onChange={e=>{setTaskId(e.target.value);setCursor(null)}}><option value="">整个项目</option>{tasks.map(task=><option key={task.id} value={task.id}>{task.title}</option>)}</select></label><button className="secondary" onClick={()=>void load(false)} disabled={loading}><RefreshCw size={15}/> 刷新</button></div>{error&&<p className="alert" role="alert">{error}</p>}<div className="history-list">{events.length?events.map((event,index)=><article key={event.id||`${event.seq}-${index}`} className="history-item"><span>{stamp(event.createdAt)} · #{event.seq??'—'}</span><strong>{eventTitle(event)}</strong>{eventSummary(event)&&<p>{eventSummary(event)}</p>}{event.taskId&&<small>任务 {event.taskId}</small>}<details><summary>查看记录</summary><pre>{JSON.stringify(event,null,2)}</pre></details></article>):<p>{loading?'正在读取…':'此范围暂无历史记录。'}</p>}</div>{cursor!==null&&<button className="secondary" onClick={()=>void load(true)} disabled={loading}>{loading?'正在读取…':'查看更多'}</button>}</section></div>}</div>;
}
