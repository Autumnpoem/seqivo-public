import {spawn} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {delimiter,isAbsolute,resolve} from 'node:path';

const WORKER=fileURLToPath(new URL('./plugin-worker.mjs',import.meta.url));
const MAX_FRAME=1_000_000;
const TIMEOUT={initialize:10_000,state:5_000,configure:15_000,enable:15_000,disable:20_000,check:30_000,setPolicy:15_000,reconcile:30_000,createSession:30_000,getExecution:30_000,getSessionBinding:20_000,quiesce:90_000,resume:90_000,pause:90_000,conversation:20_000,close:8_000};
const ACTIONS=new Set(Object.keys(TIMEOUT));
const AMBIGUOUS_ACTIONS=new Set(['createSession','resume','pause','quiesce']);
const READ_PERMISSIONS=new Set(['task.read','tasks.read','task.write','tasks.write','task.resume','task.pause','thread.verify','thread.create']);
const WRITE_PERMISSIONS=new Set(['task.write','tasks.write','task.resume','task.pause']);
const RUN_FIELDS=new Set(['status','blockedReason']);

function serializeError(error){return {message:error?.message||String(error),status:Number.isInteger(error?.status)?error.status:undefined,code:typeof error?.code==='string'?error.code:undefined};}
function reviveError(value){const error=new Error(value?.message||'Plugin RPC failed');if(Number.isInteger(value?.status))error.status=value.status;if(typeof value?.code==='string')error.code=value.code;return error;}
function fault(message,code='PLUGIN_UNAVAILABLE'){const error=new Error(message);error.code=code;return error;}
function validId(value){return typeof value==='string'&&value.length>0&&value.length<=300;}
function allowed(perms,set){return [...set].some(item=>perms.has(item));}

export async function createIsolatedPlugin({entry,manifest,context,dataDir,pluginDir,timeouts={},trustedBuiltIn=false}){
  if(typeof entry!=='string'||!manifest||typeof manifest.id!=='string')throw new TypeError('Plugin entry and manifest are required');
  const permissions=new Set(Array.isArray(manifest.permissions)?manifest.permissions:[]);
  const linuxBuiltIn=process.platform==='linux'&&trustedBuiltIn&&manifest.id==='codex-autocontinue';
  const executableBaseDirectory=linuxBuiltIn?process.cwd():null;
  if(linuxBuiltIn)mkdirSync(dataDir,{recursive:true,mode:0o700});
  const child=spawn(process.execPath,[WORKER],{stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32',
    ...(linuxBuiltIn?{cwd:dataDir,env:{...process.env,
      ...(typeof process.env.PATH==='string'?{PATH:process.env.PATH.split(delimiter)
        .map(part=>isAbsolute(part)?part:resolve(executableBaseDirectory,part||'.')).join(delimiter)}:{})}}:{})});
  const pending=new Map();
  let sequence=0,buffer=Buffer.alloc(0),unavailable=null,closing=null,exited=false;
  const unavailableState=()=>({id:manifest.id,name:manifest.name||manifest.id,version:manifest.version||'unknown',enabled:false,available:false,status:'unavailable',lastError:unavailable?.message||'Plugin process is unavailable'});
  function send(frame){
    const wire=JSON.stringify(frame)+'\n';
    if(Buffer.byteLength(wire)>MAX_FRAME)throw fault('Plugin RPC message exceeds 1 MB','RPC_TOO_LARGE');
    if(!child.stdin.writable)throw fault('Plugin process input is closed');
    child.stdin.write(wire);
  }
  function rejectPending(error){for(const [id,item] of pending){clearTimeout(item.timer);pending.delete(id);item.reject(AMBIGUOUS_ACTIONS.has(item.method)?fault(`Plugin ${item.method} result is unknown: ${error.message}`,'UNKNOWN_RESULT'):error);}}
  function markUnavailable(error){if(unavailable)return;unavailable=error;rejectPending(error);}
  async function callback(message){
    const {id,method,args}=message;
    try{
      if(typeof id!=='string'||!Array.isArray(args)||Buffer.byteLength(JSON.stringify(args))>MAX_FRAME)throw fault('Invalid callback request','INVALID_CALLBACK');
      let result;
      if(method==='resolveWorkspace'){
        if(!permissions.has('task.resume')&&!permissions.has('thread.create'))throw fault('Plugin lacks workspace permission','PERMISSION_DENIED');
        if(args.length!==1||!validId(args[0]?.taskId)||args[0].worktreeId!==null&&args[0].worktreeId!==undefined&&!validId(args[0].worktreeId))
          throw fault('Invalid workspace binding','INVALID_CALLBACK');
        result=await context.resolveWorkspace({taskId:args[0].taskId,worktreeId:args[0].worktreeId||null});
      }else if(['reserveExecutorStartup','bindExecutorStartup','confirmExecutorStartup','bindExecutorConversation','verifyExecutorStartup','retireExecutorStartup'].includes(method)){
        if(!trustedBuiltIn||manifest.id!=='codex-autocontinue'||!permissions.has('task.resume')||
          typeof context[method]!=='function')throw fault('Executor startup authority is not available','PERMISSION_DENIED');
        const input=args[0];
        const fields={reserveExecutorStartup:['taskId','startupId','requestCommandId','projectId','workspace','worktreeId','purpose','expectedRevision','expectedHandoffGeneration'],
          bindExecutorStartup:['taskId','startupId','recordId'],
          confirmExecutorStartup:['taskId','startupId','recordId'],
          bindExecutorConversation:['taskId','startupId','recordId','threadId'],
          verifyExecutorStartup:['taskId','startupId','recordId','workspace'],
          retireExecutorStartup:['taskId','startupId','recordId','settledCommands','shutdownUnknown']};
        const allowed=fields[method];
        if(args.length!==1||!input||typeof input!=='object'||Array.isArray(input)||
          Object.keys(input).some(key=>!allowed.includes(key))||allowed.filter(key=>key!=='shutdownUnknown').some(key=>!Object.hasOwn(input,key))||
          !validId(input.taskId)||!validId(input.startupId)||
          (method==='reserveExecutorStartup' ?
            !validId(input.requestCommandId)||!validId(input.projectId)||
            typeof input.workspace!=='string'||!isAbsolute(input.workspace)||input.workspace.length>4096||
            input.worktreeId!==null&&!validId(input.worktreeId)||
            !['session','turn'].includes(input.purpose)||
            !Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||
            input.expectedHandoffGeneration!==null&&
              (!Number.isSafeInteger(input.expectedHandoffGeneration)||input.expectedHandoffGeneration<1) :
            !/^[a-f0-9]{32}$/.test(input.recordId)||
            method==='retireExecutorStartup'&&input.shutdownUnknown!==undefined&&(
              !input.shutdownUnknown||typeof input.shutdownUnknown!=='object'||Array.isArray(input.shutdownUnknown)||
              ![
                'bridgePid,commandId,expectedHandoffGeneration,projectId,proofScope,recordGeneration,recordId,startupId,taskId,threadId,turnId,version,workspace,worktreeId',
                'bridgePid,commandId,expectedHandoffGeneration,projectId,proofScope,recordGeneration,recordId,startupId,stopCause,taskId,threadId,turnId,version,workspace,worktreeId',
              ].includes(Object.keys(input.shutdownUnknown).sort().join(','))||
              Object.hasOwn(input.shutdownUnknown,'stopCause')&&
                input.shutdownUnknown.stopCause!=='provider_approval'||
              input.shutdownUnknown.version!==1||!validId(input.shutdownUnknown.taskId)||
              !validId(input.shutdownUnknown.projectId)||!validId(input.shutdownUnknown.startupId)||
              !/^[a-f0-9]{32}$/.test(input.shutdownUnknown.recordId)||
              !validId(input.shutdownUnknown.commandId)||!validId(input.shutdownUnknown.threadId)||
              !validId(input.shutdownUnknown.turnId)||!Number.isSafeInteger(input.shutdownUnknown.bridgePid)||
              !['macos-original-task-job-coalition-known-descendants-and-managed-handoff',
                'macos-original-task-job-coalition-known-descendants-and-current-writers'].includes(input.shutdownUnknown.proofScope)||
              input.shutdownUnknown.bridgePid<2||!Number.isSafeInteger(input.shutdownUnknown.recordGeneration)||
              input.shutdownUnknown.recordGeneration<1||
              typeof input.shutdownUnknown.workspace!=='string'||!isAbsolute(input.shutdownUnknown.workspace)||
              input.shutdownUnknown.workspace.length>4096||
              input.shutdownUnknown.worktreeId!==null&&!validId(input.shutdownUnknown.worktreeId)||
              input.shutdownUnknown.expectedHandoffGeneration!==null&&
                (!Number.isSafeInteger(input.shutdownUnknown.expectedHandoffGeneration)||input.shutdownUnknown.expectedHandoffGeneration<1))||
            method==='retireExecutorStartup'&&(!Array.isArray(input.settledCommands)||
              input.settledCommands.length>512||input.settledCommands.some(row=>!row||
                typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='commandId,status'||
                !validId(row.commandId)||!['completed','failed','paused','not_started'].includes(row.status)))||
            method==='bindExecutorConversation'&&!validId(input.threadId)||
            method==='verifyExecutorStartup'&&(!isAbsolute(input.workspace)||input.workspace.length>4096)))
          throw fault('Invalid executor startup callback','INVALID_CALLBACK');
        result=await context[method](input);
      }else if(method==='disposeStoppedUnknownExecutor'){
        if(process.platform!=='darwin'||!trustedBuiltIn||manifest.id!=='codex-autocontinue'||
          !permissions.has('task.resume')||typeof context[method]!=='function')
          throw fault('Stopped executor disposition is not available','PERMISSION_DENIED');
        const input=args[0],receipt=input?.shutdownReceipt,consent=input?.controlConsent;
        if(args.length!==1||!input||typeof input!=='object'||Array.isArray(input)||
          Object.keys(input).sort().join(',')!=='controlConsent,recordId,shutdownReceipt,startupId,taskId'||
          !validId(input.taskId)||!validId(input.startupId)||!/^[a-f0-9]{32}$/.test(input.recordId)||
          !receipt||typeof receipt!=='object'||Array.isArray(receipt)||receipt.version!==1||
          receipt.taskId!==input.taskId||receipt.startupId!==input.startupId||
          receipt.recordId!==input.recordId||!validId(receipt.commandId)||
          !consent||typeof consent!=='object'||Array.isArray(consent)||
          Object.keys(consent).sort().join(',')!=='id,projectId'||
          !validId(consent.id)||!validId(consent.projectId))
          throw fault('Invalid stopped executor disposition callback','INVALID_CALLBACK');
        result=await context[method](input);
      }else if(['verifyLinuxExecutorAdmission','verifyLinuxBridgeRetirementWorkspace','verifyLinuxJobRetirement'].includes(method)){
        if(process.platform!=='linux'||!trustedBuiltIn||manifest.id!=='codex-autocontinue'||
          !permissions.has('task.resume')||typeof context[method]!=='function')
          throw fault('Linux executor proof is not available','PERMISSION_DENIED');
        const input=args[0];
        const fields=method==='verifyLinuxExecutorAdmission'
          ?['taskId','commandId','workspace','worktreeId','bridgePid','appServerPid']
          :['taskId','commandId','workspace','worktreeId','expectedHandoffGeneration','bridgePid','appServerPid'];
        const job=method==='verifyLinuxJobRetirement'||method==='verifyLinuxExecutorAdmission'&&input?.recordId!==undefined;
        if(job)fields.push('recordId');
        if(args.length!==1||!input||typeof input!=='object'||Array.isArray(input)||
          Object.keys(input).sort().join(',')!==fields.sort().join(',')||
          !validId(input.taskId)||!validId(input.commandId)||
          job&&!/^[a-f0-9]{32}$/.test(input.recordId)||
          typeof input.workspace!=='string'||!isAbsolute(input.workspace)||input.workspace.length>4096||
          input.worktreeId!==null&&!validId(input.worktreeId)||
          !Number.isSafeInteger(input.bridgePid)||input.bridgePid<2||
          !(method==='verifyLinuxJobRetirement'&&input.appServerPid===null)&&
            (!Number.isSafeInteger(input.appServerPid)||input.appServerPid<2)||
          input.bridgePid===input.appServerPid||
          method==='verifyLinuxBridgeRetirementWorkspace'&&
            (!Number.isSafeInteger(input.expectedHandoffGeneration)||input.expectedHandoffGeneration<1)||
          method==='verifyLinuxJobRetirement'&&input.expectedHandoffGeneration!==null&&
            (!Number.isSafeInteger(input.expectedHandoffGeneration)||input.expectedHandoffGeneration<1))
          throw fault('Invalid Linux executor proof request','INVALID_CALLBACK');
        result=await context[method]({...input,trustedWorkerPid:child.pid});
      }else if(method==='authorizeExecution'||method==='revalidateExecution'){
        if(!permissions.has('task.resume')&&!(method==='revalidateExecution'&&permissions.has('thread.create')))throw fault('Plugin lacks execution permission','PERMISSION_DENIED');
        if(args.length!==1||!validId(args[0]?.taskId)||!validId(args[0]?.commandId))throw fault('Invalid execution authorization','INVALID_CALLBACK');
        const input={taskId:args[0].taskId,commandId:args[0].commandId};
        if(args[0].worktreeId!==undefined){if(args[0].worktreeId!==null&&!validId(args[0].worktreeId))throw fault('Invalid worktree ID','INVALID_CALLBACK');input.worktreeId=args[0].worktreeId;}
        if(args[0].workspace!==undefined){if(typeof args[0].workspace!=='string'||args[0].workspace.length>4096)throw fault('Invalid workspace','INVALID_CALLBACK');input.workspace=args[0].workspace;}
        if(args[0].expectedRevision!==undefined){if(!Number.isInteger(args[0].expectedRevision)||args[0].expectedRevision<1)throw fault('Invalid expected revision','INVALID_CALLBACK');input.expectedRevision=args[0].expectedRevision;}
        if(args[0].startupId!==undefined||args[0].recordId!==undefined){
          if(!trustedBuiltIn||manifest.id!=='codex-autocontinue'||!validId(args[0].startupId)||
            !/^[a-f0-9]{32}$/.test(args[0].recordId))throw fault('Invalid executor startup binding','INVALID_CALLBACK');
          input.startupId=args[0].startupId;input.recordId=args[0].recordId;
        }
        if(method==='revalidateExecution'){
          if(args[0].expectedConversationId!==undefined){if(args[0].expectedConversationId!==null&&!validId(args[0].expectedConversationId))throw fault('Invalid expected conversation','INVALID_CALLBACK');input.expectedConversationId=args[0].expectedConversationId;}
          if(args[0].expectedDirectory!==undefined){if(typeof args[0].expectedDirectory!=='string'||args[0].expectedDirectory.length>4096)throw fault('Invalid expected directory','INVALID_CALLBACK');input.expectedDirectory=args[0].expectedDirectory;}
          if(args[0].expectedHandoffGeneration!==undefined){if(args[0].expectedHandoffGeneration!==null&&(!Number.isSafeInteger(args[0].expectedHandoffGeneration)||args[0].expectedHandoffGeneration<1))throw fault('Invalid expected handoff generation','INVALID_CALLBACK');input.expectedHandoffGeneration=args[0].expectedHandoffGeneration;}
        }
        result=await context[method]?.(input);
      }else if(method==='verifyRetirementWorkspace'){
        const input=args[0],fields=['taskId','recordId','workspace','worktreeId','expectedHandoffGeneration'];
        if(!trustedBuiltIn||manifest.id!=='codex-autocontinue'||!permissions.has('task.resume')||
          typeof context.verifyRetirementWorkspace!=='function')throw fault('Retirement proof is not available','PERMISSION_DENIED');
        if(args.length!==1||!input||typeof input!=='object'||Array.isArray(input)||
          Object.keys(input).some(key=>!fields.includes(key))||fields.some(key=>!Object.hasOwn(input,key))||!validId(input.taskId)||
          !/^[a-f0-9]{32}$/.test(input.recordId)||typeof input.workspace!=='string'||
          input.workspace.length>4096||!isAbsolute(input.workspace)||
          input.worktreeId!==null&&input.worktreeId!==undefined&&!validId(input.worktreeId)||
          !Number.isSafeInteger(input.expectedHandoffGeneration)||input.expectedHandoffGeneration<1)
          throw fault('Invalid retirement proof request','INVALID_CALLBACK');
        result=await context.verifyRetirementWorkspace({taskId:input.taskId,recordId:input.recordId,
          workspace:input.workspace,worktreeId:input.worktreeId??null,
          expectedHandoffGeneration:input.expectedHandoffGeneration});
      }else if(method==='emit'){
        if(args.length)throw fault('emit takes no arguments','INVALID_CALLBACK');
        result=await context.emit();
      }else if(method==='getTask'||method==='getProject'){
        if(!allowed(permissions,READ_PERMISSIONS))throw fault('Plugin lacks task read permission','PERMISSION_DENIED');
        if(args.length!==1||!validId(args[0]))throw fault('Invalid entity ID','INVALID_CALLBACK');
        result=await context[method](args[0]);
      }else if(method==='updateTask'){
        if(!allowed(permissions,WRITE_PERMISSIONS))throw fault('Plugin lacks task write permission','PERMISSION_DENIED');
        if(args.length!==3||!validId(args[0])||!args[1]||typeof args[1]!=='object'||Array.isArray(args[1])||!Number.isInteger(args[2]))throw fault('Invalid task update','INVALID_CALLBACK');
        if(!permissions.has('task.write')&&!permissions.has('tasks.write')&&Object.keys(args[1]).some(key=>!RUN_FIELDS.has(key)))throw fault('Run plugin cannot change task baseline','PERMISSION_DENIED');
        result=await context.updateTask(args[0],args[1],args[2]);
      }else throw fault('Callback is not allowed','PERMISSION_DENIED');
      send({type:'response',id,result:result??null});
    }catch(error){try{send({type:'response',id,error:serializeError(error)});}catch{}}
  }
  function receive(line){
    let message;
    try{message=JSON.parse(line);}catch{markUnavailable(fault('Plugin wrote invalid RPC JSON'));void terminateTree().catch(()=>{});return;}
    if(message?.type==='request'){void callback(message);return;}
    if(message?.type!=='response'||typeof message.id!=='string'){markUnavailable(fault('Plugin wrote invalid RPC frame'));void terminateTree().catch(()=>{});return;}
    const item=pending.get(message.id);if(!item)return;
    pending.delete(message.id);clearTimeout(item.timer);
    message.error?item.reject(reviveError(message.error)):item.resolve(message.result);
  }
  child.stdout.on('data',chunk=>{
    if(unavailable)return;
    buffer=Buffer.concat([buffer,chunk]);
    let index;while((index=buffer.indexOf(10))!==-1){
      const frame=buffer.subarray(0,index);buffer=buffer.subarray(index+1);
      if(frame.length>MAX_FRAME){markUnavailable(fault('Plugin RPC output exceeds 1 MB','RPC_TOO_LARGE'));void terminateTree().catch(()=>{});return;}
      if(frame.length)receive(frame.toString('utf8'));if(unavailable)return;
    }
    if(buffer.length>MAX_FRAME){markUnavailable(fault('Plugin RPC output exceeds 1 MB','RPC_TOO_LARGE'));void terminateTree().catch(()=>{});}
  });
  child.stderr.on('data',()=>{ /* plugin diagnostics stay off the RPC and public state channels */ });
  child.once('error',error=>markUnavailable(fault(`Plugin process failed: ${error.message}`)));
  child.stdin.on('error',error=>markUnavailable(fault(`Plugin input failed: ${error.message}`)));
  child.once('exit',(code,signal)=>{exited=true;markUnavailable(fault(`Plugin process exited (${code??signal})`));});

  function rpc(method,args=[],timeout=timeouts[method]??
    (method==='close'&&trustedBuiltIn&&manifest.id==='codex-autocontinue'?60_000:TIMEOUT[method])){
    if(!ACTIONS.has(method))return Promise.reject(fault('Plugin method is not allowed','INVALID_METHOD'));
    if(unavailable)return Promise.reject(unavailable);
    if(!Array.isArray(args))return Promise.reject(fault('Plugin arguments must be an array','INVALID_REQUEST'));
    if(!Number.isInteger(timeout)||timeout<1||timeout>120_000)return Promise.reject(fault('Invalid RPC timeout','INVALID_REQUEST'));
    const id=`host-${++sequence}`;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        pending.delete(id);
        const error=fault(`Plugin ${method} timed out`,AMBIGUOUS_ACTIONS.has(method)?'UNKNOWN_RESULT':'PLUGIN_TIMEOUT');
        markUnavailable(error);
        void terminateTree().catch(()=>{});
        reject(error);
      },timeout);
      pending.set(id,{method,resolve,reject,timer});
      try{send({type:'request',id,method,args});}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
    });
  }
  function waitExit(ms){if(exited)return Promise.resolve(true);return new Promise(resolve=>{const timer=setTimeout(()=>{child.off('exit',done);resolve(false);},ms);const done=()=>{clearTimeout(timer);resolve(true);};child.once('exit',done);});}
  async function terminateTree(){
    if(process.platform==='win32'){
      if(exited)return;
      const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
      const outcome=await new Promise(resolve=>{const timer=setTimeout(()=>{killer.kill();resolve('timeout');},2500);killer.once('error',()=>{clearTimeout(timer);resolve('error');});killer.once('exit',code=>{clearTimeout(timer);resolve(code);});});
      if(outcome!==0||!(await waitExit(2000)))throw fault('Plugin process tree shutdown could not be confirmed','SHUTDOWN_UNCONFIRMED');
      return;
    }
    const group=()=>{try{process.kill(-child.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
    const waitGroupExit=async ms=>{
      const deadline=performance.now()+ms;
      while(true){
        if(exited&&!group())return true;
        const remaining=deadline-performance.now();if(remaining<=0)return false;
        await new Promise(resolve=>setTimeout(resolve,Math.min(25,remaining)));
      }
    };
    if(group())try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
    await waitGroupExit(8500);
    if(group()){try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}await waitGroupExit(1500);}
    if(group()||!exited)throw fault('Plugin process group shutdown could not be confirmed','SHUTDOWN_UNCONFIRMED');
  }
  try{await rpc('initialize',[{entry,dataDir,pluginDir,
    ...(linuxBuiltIn?{executableBaseDirectory}:{})}]);}
  catch(error){try{await terminateTree();}catch(shutdown){throw new AggregateError([error,shutdown],'Plugin startup failed and shutdown is unconfirmed');}throw error;}
  const proxy={
    state:async()=>unavailable?unavailableState():rpc('state').catch(error=>{if(unavailable)return unavailableState();throw error;}),
    configure:config=>rpc('configure',[config]),enable:()=>rpc('enable'),disable:()=>rpc('disable'),check:()=>rpc('check'),
    setPolicy:input=>rpc('setPolicy',[input]),reconcile:input=>rpc('reconcile',[input]),createSession:input=>rpc('createSession',[input]),getExecution:input=>rpc('getExecution',[input]),getSessionBinding:input=>rpc('getSessionBinding',[input]),quiesce:input=>rpc('quiesce',[input]),resume:input=>rpc('resume',[input]),pause:input=>rpc('pause',[input]),conversation:input=>rpc('conversation',[input]),
    close:()=>{
      if(closing)return closing;
      closing=(async()=>{
        let closeError;
        const exitedBeforeClose=Boolean(unavailable);
        if(!unavailable){try{await rpc('close');}catch(error){closeError=error;}}
        try{await terminateTree();}catch(error){throw new AggregateError(closeError?[closeError,error]:[error],'Plugin shutdown is unconfirmed');}
        if(exitedBeforeClose)throw fault('Plugin exited before close; descendant shutdown is unconfirmed','SHUTDOWN_UNCONFIRMED');
        if(closeError)throw closeError;
      })();
      return closing;
    },
  };
  return proxy;
}
