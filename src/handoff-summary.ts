import type {BoardState,Project,Task} from './types';

const status:Record<Task['status'],string>={planned:'待开始',running:'正在做',paused:'已暂停',blocked:'遇到阻碍',submitted:'待验收',failed:'执行失败',cancelled:'已取消'};
const clean=(value:unknown,limit=2000)=>typeof value==='string'?value.trim().slice(0,limit):'';
const completed=(task:Task)=>task.status==='submitted'&&task.acceptance==='passed';

/** Only fields already present in the Hub's grant-scoped projection may enter this summary. */
export function remoteHandoff(board:BoardState,projectId:string):{project:Project;text:string;taskCount:number;included:number}|null{
  if(board.connection.mode!=='hub'||!projectId)return null;
  const project=board.projects.find(item=>item.id===projectId);
  if(!project)return null;
  const tasks=board.tasks.filter(item=>item.projectId===projectId&&item.status!=='cancelled');
  const finished=tasks.filter(completed).length;
  const active=tasks.filter(item=>item.status==='running').length;
  const waiting=tasks.filter(item=>item.status==='submitted'&&!completed(item)).length;
  const lines=[`# ${clean(project.name,240)}`,'',`项目目标：${clean(project.goal)||'尚未填写。'}`,'',
    `已验收 ${finished} 项；正在做 ${active} 项；待人工验收 ${waiting} 项；共 ${tasks.length} 项未取消任务。`,
    '本摘要仅包含当前账号已授权项目中已同步的共享信息；验收仍以当前任务记录为准。',''];
  const maxTasks=200,maxLength=120000;
  let included=0;
  for(const task of tasks){
    const item=[`## ${clean(task.title,240)}`,`状态：${completed(task)?'已验收':status[task.status]}；人工验收：${task.acceptance==='passed'&&completed(task)?'当前已通过':'尚未按当前任务确认为通过'}`,
      `目标：${clean(task.goal)||'尚未填写。'}`,`进展：${clean(task.summary)||'尚未记录。'}`,
      `下一步：${clean(task.nextStep)||'请核对当前任务和验收标准。'}`];
    if(task.status==='submitted'&&!completed(task))item.push('待处理：请由人核对并验收当前结果。');
    if(task.status==='blocked'||task.issues.some(issue=>issue.open))item.push('待处理：当前任务还有阻碍或未解决的问题。');
    const block=item.join('\n')+'\n\n';
    if(included>=maxTasks||lines.join('\n').length+block.length>maxLength)break;
    lines.push(block);included++;
  }
  if(included<tasks.length)lines.push(`另有 ${tasks.length-included} 项未在本次摘要中展开，请在已授权任务清单逐项核对。`);
  const sharedDecisions=(board.inbox?.items||[]).filter(item=>item.projectId===projectId&&item.shareWithRemote&&item.kind==='decision'&&['open','acknowledged'].includes(item.state));
  if(sharedDecisions.length){lines.push('待决定事项：');for(const item of sharedDecisions.slice(0,20))lines.push(`- ${clean(item.title,240)}：${clean(item.recommendedAction,1000)||'请打开事项核对。'}`);
    if(sharedDecisions.length>20)lines.push(`另有 ${sharedDecisions.length-20} 项共享决策事项，请打开收件箱核对。`);}
  return {project,text:lines.join('\n').trim(),taskCount:tasks.length,included};
}
