import {useEffect,useMemo,useRef,useState} from 'react';
import {errorMessage,request} from './api';
import {remoteHandoff} from './handoff-summary';
import type {BoardState} from './types';

type Props={board:BoardState;projectId:string;accountId:string;online:boolean;checking:boolean;isCurrent:()=>boolean};
const stamp=(value:string|null|undefined)=>{if(!value)return '尚未同步';const time=new Date(value);return Number.isNaN(time.getTime())?'同步时间未确认':time.toLocaleString('zh-CN');};

export default function ProjectHandoff({board,projectId,accountId,online,checking,isCurrent}:Props){
  const remote=board.connection.mode==='hub';
  const summary=useMemo(()=>remoteHandoff(board,projectId),[board,projectId]);
  const project=board.projects.find(item=>item.id===projectId);
  const [localText,setLocalText]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState(''),[copied,setCopied]=useState(false);
  const readSeq=useRef(0);
  const [reload,setReload]=useState(0);
  useEffect(()=>{
    if(remote||!project)return;
    let active=true;const seq=++readSeq.current;
    setLocalText('');setError('');setCopied(false);setLoading(true);
    void request<{markdown:string}>('GET',`/api/projects/${encodeURIComponent(projectId)}/context`).then(result=>{
      if(active&&readSeq.current===seq&&isCurrent()&&typeof result.markdown==='string')setLocalText(result.markdown);
    }).catch(cause=>{if(active&&readSeq.current===seq&&isCurrent())setError(errorMessage(cause));})
      .finally(()=>{if(active&&readSeq.current===seq)setLoading(false);});
    return()=>{active=false;readSeq.current++;};
  },[remote,projectId,accountId,reload]);
  const fresh=remote?Boolean(accountId&&online&&!checking&&!board.connection.offline&&board.connection.lastSeen):online&&!checking;
  const text=remote?summary?.text||'':localText;
  useEffect(()=>{setCopied(false);},[text]);
  const canCopy=Boolean(project&&text&&fresh);
  async function copy(){
    if(!canCopy||!isCurrent()||!navigator.onLine)return;
    const currentText=text;
    try{await navigator.clipboard.writeText(currentText);if(isCurrent())setCopied(true);}
    catch(cause){if(isCurrent())setError(errorMessage(cause));}
  }
  if(!project||remote&&!accountId)return <div className="empty-state"><h2>{remote&&!accountId?'正在确认账号和项目':'先选择项目'}</h2><p>确认当前可访问的项目后，这里会显示交接摘要。</p></div>;
  return <div className="content-page"><div className="section-header"><div><h2>{project.name}</h2><p>{project.goal}</p></div>
    {remote?<span className="small-note">仅已同步的共享信息</span>:<button className="secondary" onClick={()=>setReload(value=>value+1)}>更新摘要</button>}</div>
    {remote&&<p className="small-note" role="status">{fresh?'已同步':'当前内容可能已过期，恢复连接并刷新后再复制'} · 最近同步：{stamp(board.connection.lastSeen)}</p>}
    <div className="handoff-card">{text?<pre>{text}</pre>:<p>{loading?'正在读取项目交接摘要…':remote?'该项目暂时没有可展示的共享摘要。':'读取项目交接摘要后，可复制到新对话继续工作。'}</p>}</div>
    {error&&<p className="alert" role="alert">{error}</p>}
    {text&&<button className="primary" disabled={!canCopy} onClick={()=>void copy()}>复制交接摘要</button>}
    {copied&&<p className="small-note" role="status">已复制当前显示的交接摘要。</p>}
  </div>;
}
