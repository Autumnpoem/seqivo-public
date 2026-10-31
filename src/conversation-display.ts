import type {Conversation,Task} from './types';

const taskLabels:Record<Task['status'],string>={planned:'待开始',running:'进行中',paused:'已暂停',blocked:'遇到阻碍',submitted:'待验收',failed:'失败',cancelled:'已取消'};

export function conversationDisplay(task:Task|null,conversation:Conversation|null){
  const visible=task&&conversation?.taskId===task.id?conversation:null;
  return {
    visible,
    taskStatus:task?taskLabels[task.status]:null,
    outputSyncPending:!!visible&&visible.status!=='loading'&&visible.status!==task?.status,
  };
}

export function messageCompletionLabel(role:string,status:string){
  if(status==='completed')return role==='tool'?'工具已完成':'已完成';
  if(status==='turn_completed')return '本轮已结束';
  return null;
}
