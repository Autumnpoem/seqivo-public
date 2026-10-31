export type TaskFormKind='create'|'edit'|'evidence'|'review';
export interface TaskFormDraft{
  revision:number;
  contentVersion:string|number;
  values:Record<string,string>;
  reviewDecision:'pass'|'fail';
}

const prefix='seqivo:task-form-draft:v1:';
const kinds=new Set(['create','edit','evidence','review']);
const formKeys=new Set(['title','goal','example','summary','approach','nextStep','blockedReason',
  'conversationId','executionProvider','status','criteria','reference']);

export function taskCreateAvailabilityReason(input:{role?:string;hasIdentity:boolean;remote:boolean;online:boolean;available?:boolean;pending:boolean}):string{
  if(!input.hasIdentity)return '正在确认连接身份，确认后才能新建任务。';
  if(input.role==='viewer')return '此连接只有查看权限，无法新建任务。';
  if(input.role!=='owner'&&input.role!=='controller')return '当前连接没有新建任务的写入权限。';
  if(!input.remote)return '当前连接尚未启用远程任务写入。';
  if(!input.online)return '目标电脑未在线或连接状态待确认；恢复连接并刷新后再试。';
  if(input.available!==true)return '目标电脑版本较旧或尚未支持手机端新建任务。';
  if(input.pending)return '此项目已有新建任务请求待核实；请先等待原命令回执，不能重复提交。';
  return '';
}

export function hubTaskCreateBody(values:Record<string,string>):{title:string;goal:string;example:string;summary:string;approach:string;criteria:string[]}{
  return {title:values.title?.trim()||'',goal:values.goal?.trim()||'',example:values.example?.trim()||'',
    summary:values.summary?.trim()||'',approach:values.approach?.trim()||'',
    criteria:(values.criteria||'').split('\n').map(value=>value.trim()).filter(Boolean)};
}

export function confirmedHubTaskId(receipt:unknown,commandId:string,projectId:string):string|null{
  if(!receipt||typeof receipt!=='object')return null;
  const value=receipt as Record<string,unknown>,result=value.result;
  if(value.commandId!==commandId||value.projectId!==projectId||value.taskId!==commandId||
    value.action!=='create_task'||value.status!=='completed'||!result||typeof result!=='object')return null;
  const created=result as Record<string,unknown>;
  return typeof created.taskId==='string'&&created.taskId.length>0&&created.status==='planned'&&created.revision===1?created.taskId:null;
}

function parseDraft(raw:string|null):TaskFormDraft|null{
  if(!raw)return null;
  try{
    const draft:unknown=JSON.parse(raw);
    if(!draft||typeof draft!=='object'||Array.isArray(draft))return null;
    const value=draft as Record<string,unknown>;
    if(!Number.isSafeInteger(value.revision)||(value.revision as number)<0||
      !(typeof value.contentVersion==='string'&&value.contentVersion.length>0)&&
      !(Number.isSafeInteger(value.contentVersion)&&(value.contentVersion as number)>=0)||
      (value.reviewDecision!=='pass'&&value.reviewDecision!=='fail')||
      !value.values||typeof value.values!=='object'||Array.isArray(value.values))return null;
    const values=value.values as Record<string,unknown>;
    if(Object.entries(values).some(([key,item])=>!formKeys.has(key)||typeof item!=='string'))return null;
    return {revision:value.revision as number,contentVersion:value.contentVersion as string|number,
      values:values as Record<string,string>,reviewDecision:value.reviewDecision};
  }catch{return null;}
}

export function taskFormDraftKey(identity:string,projectId:string,taskId:string,kind:TaskFormKind):string|null{
  return identity&&projectId&&taskId&&kinds.has(kind)?prefix+JSON.stringify([identity,projectId,taskId,kind]):null;
}

export function readTaskFormDraft(storage:Storage,key:string|null):TaskFormDraft|null{
  if(!key)return null;
  try{return parseDraft(storage.getItem(key));}catch{return null;}
}

export function saveTaskFormDraft(storage:Storage,key:string|null,draft:TaskFormDraft):boolean{
  if(!key)return false;
  try{storage.setItem(key,JSON.stringify(draft));return true;}catch{return false;}
}

export function discardTaskFormDraft(storage:Storage,key:string|null,expectedDraft:TaskFormDraft):boolean{
  if(!key)return false;
  try{
    const current=parseDraft(storage.getItem(key));
    if(!current)return true;
    const same=current.revision===expectedDraft.revision&&
      current.contentVersion===expectedDraft.contentVersion&&
      current.reviewDecision===expectedDraft.reviewDecision&&
      Object.keys(current.values).length===Object.keys(expectedDraft.values).length&&
      Object.entries(current.values).every(([field,value])=>expectedDraft.values[field]===value);
    if(same)storage.removeItem(key);
    return true;
  }catch{return false;}
}

export function clearTaskFormDrafts(storage:Storage,identity:string):boolean{
  if(!identity)return false;
  try{
    const keys:string[]=[];
    for(let i=0;i<storage.length;i++){
      const key=storage.key(i);
      if(!key?.startsWith(prefix))continue;
      let scope:unknown;
      try{scope=JSON.parse(key.slice(prefix.length));}catch{continue;}
      if(Array.isArray(scope)&&scope.length===4&&scope[0]===identity&&
        typeof scope[1]==='string'&&typeof scope[2]==='string'&&kinds.has(scope[3]))keys.push(key);
    }
    for(const key of keys)storage.removeItem(key);
    return true;
  }catch{return false;}
}
