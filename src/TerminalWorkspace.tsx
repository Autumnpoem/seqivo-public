import { useState } from 'react';
import type { BoardState, Task } from './types';
import SshPanel from './SshPanel';
import TerminalPanel from './TerminalPanel';

type Props={board:BoardState;projectId?:string;contextTask?:Task;onOpenTask?:(taskId:string,projectId:string)=>void};

export default function TerminalWorkspace({board,projectId,contextTask,onOpenTask}:Props) {
  const [managed,setManaged]=useState(Boolean(contextTask));
  return managed?<><div className="ssh-managed-back">
    {contextTask&&<section className="terminal-task-context" aria-label="当前终端任务">
      <div><small>正在处理 · {board.projects.find(project=>project.id===contextTask.projectId)?.name}</small><strong>{contextTask.title}</strong><p>进入后可申请人工接管。请在会话列表选择要使用的 tmux 会话。</p></div>
      {onOpenTask&&<button className="secondary" type="button" onClick={()=>onOpenTask(contextTask.id,contextTask.projectId)}>返回任务与证据</button>}
    </section>}
    <button className="secondary" type="button" onClick={()=>setManaged(false)}>返回 SSH 主机列表</button>
    {!contextTask&&<p>这里连接本机与已绑定电脑；AI 项目接管和设备授权只适用于这些连接。</p>}
  </div><TerminalPanel board={board} projectId={projectId}/></>:
    <SshPanel onManaged={()=>setManaged(true)}/>;
}
