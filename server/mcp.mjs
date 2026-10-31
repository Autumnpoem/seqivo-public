import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const dataDir=resolve(process.env.TUIJIN_DATA_DIR||'.runtime');
async function api(method,path,body){
  const access=JSON.parse(await readFile(join(dataDir,'access.json'),'utf8'));
  let base=process.env.TUIJIN_URL;
  if(!base){try{base=JSON.parse(await readFile(join(dataDir,'connection.json'),'utf8')).url;}catch{base='http://127.0.0.1:4317';}}
  const res=await fetch(new URL(path,base),{method,headers:{Authorization:`Bearer ${access.reporter}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  const value=await res.json();if(!res.ok)throw Error(value.error||'任务服务不可用');return value;
}
const str={type:'string'};
const sourceConversation={type:'object',properties:{provider:str,conversationId:str,label:str},required:['provider','conversationId'],additionalProperties:false};
const tools=[
  {name:'project_context',description:'读取真实项目目标、约束、进度与下一步；新对话开始时使用。',inputSchema:{type:'object',properties:{projectId:str},required:['projectId'],additionalProperties:false}},
  {name:'task_list',description:'查看任务与修订号。完成以验收为准，未验收不应声称完成。',inputSchema:{type:'object',properties:{projectId:str},additionalProperties:false}},
  {name:'task_create',description:'为已有项目新增任务及验收条件；运行会话由用户在看板绑定。',inputSchema:{type:'object',properties:{projectId:str,title:str,goal:str,sourceConversation,criteria:{type:'array',items:str}},required:['projectId','title','goal','criteria'],additionalProperties:false}},
  {name:'task_report',description:'更新任务当前进度、实施方案与执行状态；不能直接通过验收。',inputSchema:{type:'object',properties:{taskId:str,expectedRevision:{type:'integer'},summary:str,approach:str,nextStep:str,sourceConversation,status:{type:'string',enum:['planned','running','blocked','submitted','failed']},implementationRef:str,blockedReason:str},required:['taskId','expectedRevision','summary'],additionalProperties:false}},
  {name:'task_decision',description:'请求人工作出具体决策，显示发生了什么、影响及选项取舍；不会代替用户答复或自动执行。重复请求沿用 requestId。详细内容默认仅在桌面，明确允许手机查看时设置 shareWithRemote。',inputSchema:{type:'object',properties:{taskId:str,expectedRevision:{type:'integer',minimum:1},requestId:{type:'string',minLength:1,maxLength:100},title:str,summary:str,impact:str,shareWithRemote:{type:'boolean'},options:{type:'array',maxItems:10,items:{type:'object',properties:{id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,100}$'},label:str,consequence:str},required:['id','label','consequence'],additionalProperties:false}}},required:['taskId','expectedRevision','requestId','title','summary','impact'],additionalProperties:false}},
  {name:'task_evidence',description:'附加可核验产物位置与说明，标记为 AI 自报证据，供验收者核对。',inputSchema:{type:'object',properties:{taskId:str,expectedRevision:{type:'integer'},summary:str,reference:str},required:['taskId','expectedRevision','summary','reference'],additionalProperties:false}}
];
async function call(name,args){
  if(name==='project_context')return api('GET',`/api/projects/${encodeURIComponent(args.projectId)}/context`);
  if(name==='task_list'){const s=await api('GET','/api/state');return {projects:s.projects,tasks:s.tasks.filter(t=>!args.projectId||t.projectId===args.projectId)};}
  const {taskId,expectedRevision,projectId,...payload}=args;const type={task_create:'task.create',task_report:'task.update',task_evidence:'evidence.add',task_decision:'decision.request'}[name];
  if(!type)throw Error('未知工具');return api('POST','/api/events/ingest',{eventId:randomUUID(),type,taskId,expectedRevision,projectId,payload});
}
const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
rl.on('line',async line=>{let req;try{
  if(line.length>1_000_000)throw Error('请求过大');req=JSON.parse(line);if(req.id===undefined)return;let result;
  if(req.method==='initialize')result={protocolVersion:['2025-11-25','2025-06-18','2024-11-05'].includes(req.params?.protocolVersion)?req.params.protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'tuijin-taskboard',version:'0.1.0'},instructions:'先读取项目背景与现有任务，保留原始验收要求。汇报进度与证据不代表验收通过。'};
  else if(req.method==='ping')result={};
  else if(req.method==='tools/list')result={tools};
  else if(req.method==='tools/call'){
    try {result={content:[{type:'text',text:JSON.stringify(await call(req.params.name,req.params.arguments||{}))}]};}
    catch(e){result={isError:true,content:[{type:'text',text:e.message}]};}
  }else throw Error('不支持的方法');
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');
}catch(e){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req?.id??null,error:{code:-32600,message:e.message}})+'\n');}});
