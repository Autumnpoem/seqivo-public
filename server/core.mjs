import { createSshManager } from './ssh/manager.mjs';
import { Store, BoardError } from './store.mjs';
import { FileBridge } from './files.mjs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync, mkdirSync, realpathSync, lstatSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { acquireLock } from './lock.mjs';
import { loadPlugins, unavailableAutocontinue } from './plugin-loader.mjs';
import { createRemoteLink } from './remote-client.mjs';
import { createWorkflow } from './workflow.mjs';
import { createWorktreeManager } from './worktrees.mjs';
import { createExecutionLeases } from './execution-leases.mjs';
import { createExecutionWriteGate } from './execution-write-gate.mjs';
import { createConversations } from './conversations.mjs';
import { createRemoteExecution } from './remote-execution.mjs';
import { createInbox } from './inbox.mjs';
import { createTerminalManager } from './terminal/manager.mjs';
import { createTerminalPluginLifecycle } from './terminal/plugin-lifecycle.mjs';
import { createTerminalNodeLink } from './terminal/node-link.mjs';
import { createTerminalControl } from './terminal/control.mjs';
import { inspectWorkspaceWriters } from './terminal/process-inspection.mjs';
import { formatHandoffContext } from './terminal/handoff-context.mjs';
import { createPreviewRegistry } from './preview/registry.mjs';
import { createPreviewNodeLink } from './preview/node-link.mjs';
import { createLocalPreview } from './preview/local.mjs';
import { createPreviewRecords } from './preview/records.mjs';
import { createControlledPreviewBuilds } from './preview/controlled-build.mjs';
import { createPreviewRetest } from './preview/retest.mjs';
import { bootIdentity, readJobRecord, readRetiredJobRecord } from './macos-executor-job-record.mjs';
import { observeExecutorJobCohort } from './macos-executor-job.mjs';
import { createStartupCohortDiagnostics } from './executor-startup-diagnostics.mjs';
import { nativeSelectedIdentities } from './terminal/process-identities.mjs';
import { nativeProcessTable } from './codex-process-proof.mjs';
import { createLinuxExecutorAuthority } from './linux-executor-authority.mjs';
import { returnedDispositionPayloads } from './unknown-disposition-sync.mjs';

const pathOverlaps = (a,b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !isAbsolute(a) || !isAbsolute(b)) return true;
  const within = (x,y) => { const r=relative(x,y); return r==='' || r!=='..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
  return within(a,b) || within(b,a);
};

export async function createCore({dataDir,pluginDir,workspace,desktop=false,files=true,workflowExecutors,
  managedPythonPath=null,previewPythonPath=managedPythonPath,onStartup=()=>{},onShutdown=()=>{}}) {
  const unlock=acquireLock(dataDir);let ssh,store,plugin,plugins,bridge,remote,workflow,worktrees,workflowTimer,leases,conversations,inbox,terminal,terminalPlugin,control,previewRegistry,previewRecords,previewLocal,previewLink,previewBuilds,previewRetest,tickPromise,closing=false;
  const executionWriteBootId=randomUUID();
  const linuxExecutors=new Map();
  const activeRequests=new Set();
  const startupDiagnostics=createStartupCohortDiagnostics({dataDir,observe:observeExecutorJobCohort});
  try {
  store=new Store(join(dataDir,'board.sqlite'));
  ssh=createSshManager({dataDir:join(dataDir,'ssh'),allowPrivateTargets:true});
  mkdirSync(join(dataDir,'worktrees'),{recursive:true,mode:0o700});
  worktrees=createWorktreeManager({store,rootDir:join(dataDir,'worktrees'),authorizeMerge:input=>worktrees.reviewDecision(input),
    assertSaveAllowed:entry=>{control.assertMayStart(entry.projectId,[entry.path]);terminal.assertManagedReady(entry.projectId,[entry.path]);}});
  previewRegistry=createPreviewRegistry({dataDir});
  previewRecords=createPreviewRecords({dbPath:join(dataDir,'preview-records','records.sqlite')});
  previewLocal=createLocalPreview({store,registry:previewRegistry,records:previewRecords,desktop});
  onStartup('database');
  const events=new EventEmitter();const changed=()=>events.emit('change');store.on('change',changed);
  terminalPlugin=createTerminalPluginLifecycle({store,intentPath:join(dataDir,'terminal-plugin-intent.json'),emit:changed});
  const remoteExecution=createRemoteExecution({store,isClosing:()=>closing});
  control=createTerminalControl({store,beforeAcquire:projectId=>{previewBuilds?.assertNoUnfencedIntents(projectId);worktrees.assertMayExecute(projectId);},
    inspectWriters:input=>input.parked?terminal.inspectParkedWriters(input):inspectWorkspaceWriters(input),
    inspectDirectories:input=>terminal.inspectReturnDirectories(input),
    inspectExisting:input=>terminal.inspectExisting(input),parkManaged:input=>terminal.parkManagedProject(input),
    sealHuman:input=>terminal.sealProject(input.projectId),quiesce:async input=>{
    // Compare against each reservation's original persisted real workspace.
    // Current project bindings alone cannot reconstruct a running writer's path.
    const active=leases.activeOverlaps(input.projectId);
    if(active.some(item=>item.projectId!==input.projectId))throw new BoardError('重叠项目仍有执行租约，不能停止其他项目的进程',409,'EXECUTION_BUSY');
    if(active.some(item=>item.provider!=='codex-autocontinue'))throw new BoardError('此执行工具尚不能证明子进程停止，不能接管',409,'PROCESS_PROOF_UNAVAILABLE');
    for(const other of store.projects()){
      if(other.id===input.projectId||!store.tasks(other.id).some(task=>task.status==='running'))continue;
      let otherWorkspace;
      try{otherWorkspace=realpathSync(other.directory);if(otherWorkspace!==other.directory)throw Error('binding changed');}
      catch{throw new BoardError('其他运行中项目的目录无法核实，不能接管',409,'EXECUTION_WORKSPACE_CHANGED');}
      if(pathOverlaps(input.workspace,otherWorkspace))throw new BoardError('重叠项目仍有运行中任务，不能停止其他项目的进程',409,'EXECUTION_BUSY');
    }
    const hostPath=join(dataDir,'plugins','codex-autocontinue','codex-autocontinue.json');
    if(existsSync(hostPath)){
      const stat=lstatSync(hostPath);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid())
        throw new BoardError('原执行器记录无法核实',409,'EXECUTION_UNCONFIRMED');
      const host=JSON.parse(readFileSync(hostPath,'utf8'));
      for(const command of Object.values(host.commands||{})){
        if(!command.disposition||store.getTask(command.taskId)?.projectId!==input.projectId)continue;
        const recorded=leases.dispositions().find(row=>row.taskId===command.taskId&&row.commandId===command.commandId);
        if(JSON.stringify(recorded)!==JSON.stringify(command.disposition))
          throw new BoardError('原命令处置记录无法核实',409,'EXECUTION_UNCONFIRMED');
      }
    }
    const codex=plugins?.get('codex-autocontinue');
    if(codex?.quiesce)return codex.quiesce(input);
    if(active.length||store.tasks(input.projectId).some(task=>task.status==='running'||task.conversationId))throw new BoardError('执行器进程状态无法核实',409,'PROCESS_PROOF_UNAVAILABLE');
    return {verified:true,quiescent:true,unknown:false,livePids:[],scope:'core-no-configured-executor-or-bound-conversations'};
  }});
  leases=createExecutionLeases({store,inspect:input=>plugins?.get(input.provider)?.getExecution(input)??{status:'unknown'},beforeReserve:(projectId,workspace)=>{previewBuilds?.assertNoUnfencedIntents(projectId);control.assertMayStart(projectId);terminal?.assertManagedReady(projectId);worktrees.assertMayExecute(projectId,workspace?[workspace]:[]);},
    resolveWorktree:({taskId,worktreeId})=>worktrees.binding({id:worktreeId,taskId}).path});
  const managedRecordRoot=join(dataDir,'terminal-managed-records');
  if(['darwin','linux'].includes(process.platform))mkdirSync(managedRecordRoot,{recursive:true,mode:0o700});
  terminal=createTerminalManager({store,control,emit:changed,executionState:()=>leases.state(),
    managedRecordRoot,managedPythonPath,pluginLifecycle:terminalPlugin});
  terminalPlugin.bindManager(terminal);
  store.beforeMetadataReplace=metadata=>{terminal.assertMetadataReplacementSafe(metadata);previewBuilds?.assertMetadataReplacementSafe();};
  await terminal.initializeManaged();
  inbox=createInbox({store});
  store.inbox=inbox;
  store.handoffContext=id=>formatHandoffContext(control.handoffForProject(id));
  store.requestDecision=(taskId,input,source)=>inbox.requestDecision(taskId,input,source);
  const resolveWorkspace=({taskId,worktreeId=null})=>{
    const task=store.getTask(taskId);
    return worktreeId ? {directory:worktrees.binding({id:worktreeId,taskId}).path,worktreeId} :
      {directory:store.getProject(task.projectId).directory,worktreeId:null};
  };
  const bundledPython=resolve(dirname(process.execPath),'../../python/bin/python3');
  const linuxPython=managedPythonPath||process.env.TASKBOARD_PYTHON||
    (existsSync(bundledPython)?bundledPython:'python3');
  const linuxAuthority=createLinuxExecutorAuthority({store,dataDir,pythonPath:linuxPython,
    control,terminal,resolveWorkspace,leases});
  const sameLinux=(a,b)=>Boolean(a&&b&&a.kind==='linux-proc'&&b.kind==='linux-proc'&&
    ['pid','ppid','pgid','euid','ruid','bootId','startTicks'].every(key=>a[key]===b[key]));
  const linuxBinding=(input,requireCommand=true)=>{
    const task=store.getTask(input.taskId),workspace=resolveWorkspace(input),
      handoff=control.handoffForProject(task.projectId);
    if(process.platform!=='linux'||(task.executionProvider||'codex-autocontinue')!=='codex-autocontinue'||
      !handoff||!control.retirementHandoff(task.projectId,handoff.generation)||
      workspace.directory!==input.workspace||workspace.worktreeId!==(input.worktreeId||null))
      throw new BoardError('原受管交还与任务执行器绑定不符',409,'EXECUTION_BINDING_CHANGED');
    const saved=linuxExecutors.get(task.id);
    if(requireCommand&&(!saved||!saved.commands.has(input.commandId)||
      saved.workspace!==workspace.directory||saved.worktreeId!==workspace.worktreeId||
      saved.projectId!==task.projectId||saved.generation!==handoff.generation))
      throw new BoardError('Linux 原任务执行器身份未核实',409,'PROCESS_PROOF_UNAVAILABLE');
    return {task,workspace,handoff,saved};
  };
  const linuxObserved=async saved=>{
    const rows=await nativeSelectedIdentities(linuxPython,
      [saved.worker.pid,saved.bridge.pid,saved.appServer.pid],15000);
    if(!sameLinux(rows.get(saved.worker.pid),saved.worker)||
      !sameLinux(rows.get(saved.bridge.pid),saved.bridge)||
      !sameLinux(rows.get(saved.appServer.pid),saved.appServer))
      throw new BoardError('Linux 原任务进程身份已变化',409,'PROCESS_PROOF_UNAVAILABLE');
    return {members:[saved.worker,saved.bridge,saved.appServer]};
  };
  const verifyLinuxExecutorAdmission=async input=>{
    if(input.recordId)return linuxAuthority.admit(input);
    if(process.platform!=='linux'||!Number.isSafeInteger(input?.trustedWorkerPid)||input.trustedWorkerPid<2||
      !Number.isSafeInteger(input.bridgePid)||input.bridgePid<2||
      !Number.isSafeInteger(input.appServerPid)||input.appServerPid<2||
      new Set([input.trustedWorkerPid,input.bridgePid,input.appServerPid]).size!==3)
      throw new BoardError('Linux 执行器请求无效',409,'PROCESS_PROOF_UNAVAILABLE');
    const {task,workspace,handoff,saved}=linuxBinding(input,false);
    control.assertMayStart(task.projectId);
    const before=await nativeSelectedIdentities(linuxPython,
      [input.trustedWorkerPid,input.bridgePid,input.appServerPid],15000);
    const worker=before.get(input.trustedWorkerPid),bridge=before.get(input.bridgePid),
      appServer=before.get(input.appServerPid);
    if(worker.ppid!==process.pid||bridge.ppid!==worker.pid||appServer.ppid!==bridge.pid||
      new Set([worker.bootId,bridge.bootId,appServer.bootId]).size!==1||
      saved&&(!sameLinux(saved.worker,worker)||!sameLinux(saved.bridge,bridge)||
        !sameLinux(saved.appServer,appServer)||saved.projectId!==task.projectId||
        saved.workspace!==workspace.directory||saved.worktreeId!==workspace.worktreeId||
        saved.generation!==handoff.generation)||
      [...linuxExecutors].some(([taskId,item])=>taskId!==task.id&&item.bridge.pid===bridge.pid))
      throw new BoardError('Linux 执行器原进程归属不符',409,'PROCESS_PROOF_UNAVAILABLE');
    const candidate={worker,bridge,appServer};
    await terminal.verifyManagedForExecution(task.projectId,{members:[worker,bridge,appServer]});
    const fresh=linuxBinding(input,false);
    if(fresh.task.revision!==task.revision||fresh.task.contentVersion!==task.contentVersion||
      fresh.task.conversationId!==task.conversationId||fresh.handoff.generation!==handoff.generation)
      throw new BoardError('Linux 执行器核验期间任务已变化',409,'EXECUTION_BINDING_CHANGED');
    await linuxObserved(candidate);
    if(saved) saved.commands.add(input.commandId);
    else linuxExecutors.set(task.id,{...candidate,projectId:task.projectId,
      workspace:workspace.directory,worktreeId:workspace.worktreeId,generation:handoff.generation,
      commands:new Set([input.commandId])});
    return {verified:true,scope:'linux-original-worker-bridge-appserver-and-managed-handoff'};
  };
  const linuxAdmittedJob=async(input,task,generation)=>{
    if(linuxAuthority.has(task.id,input.commandId))return linuxAuthority.live(input,task,generation);
    const saved=linuxExecutors.get(task.id);
    if(!saved||!saved.commands.has(input.commandId)||saved.projectId!==task.projectId||
      saved.workspace!==resolveWorkspace(input).directory||
      saved.worktreeId!==(input.worktreeId||null)||saved.generation!==generation)
      throw new BoardError('Linux 执行器原授权已变化',409,'PROCESS_PROOF_UNAVAILABLE');
    return linuxObserved(saved);
  };
  const verifyLinuxBridgeRetirementWorkspace=async input=>{
    try{
      if(process.platform!=='linux')throw new Error('unsupported_platform');
      const saved=linuxExecutors.get(input.taskId),task=store.getTask(input.taskId),
        binding=resolveWorkspace(input),original=control.retirementHandoff(task.projectId,input.expectedHandoffGeneration);
      if(!saved||!saved.commands.has(input.commandId)||!original||
        saved.worker.pid!==input.trustedWorkerPid||saved.bridge.pid!==input.bridgePid||
        saved.appServer.pid!==input.appServerPid||saved.projectId!==task.projectId||
        saved.workspace!==input.workspace||binding.directory!==input.workspace||
        saved.worktreeId!==(input.worktreeId||null)||
        saved.generation!==input.expectedHandoffGeneration)
        throw new Error('binding_changed');
      const worker=await nativeSelectedIdentities(linuxPython,[saved.worker.pid],15000);
      if(!sameLinux(worker.get(saved.worker.pid),saved.worker))throw new Error('worker_changed');
      const gone=async()=>{
        const rows=await nativeProcessTable(linuxPython,15000,{allVisible:true});
        for(const identity of [saved.bridge,saved.appServer])if(rows.has(identity.pid))
          throw new Error('original_executor_not_gone');
      };
      await gone();
      const result=await terminal.verifyRetirementWorkspace({projectId:task.projectId,
        workspace:input.workspace,expectedHandoffGeneration:input.expectedHandoffGeneration,
        admittedJob:{members:[saved.worker]}});
      await gone();
      const fresh=store.getTask(task.id),after=control.retirementHandoff(task.projectId,input.expectedHandoffGeneration);
      if(fresh.projectId!==task.projectId||fresh.conversationId!==task.conversationId||
        resolveWorkspace(input).directory!==input.workspace||!after||
        after.currentGeneration!==original.currentGeneration||
        after.sessionEvidenceDigest!==original.sessionEvidenceDigest||
        !sameLinux((await nativeSelectedIdentities(linuxPython,[saved.worker.pid],15000)).get(saved.worker.pid),saved.worker))
        throw new Error('binding_changed');
      linuxExecutors.delete(task.id);
      return result;
    }catch{throw new BoardError('Linux 原执行器退休现场未能核实',409,'PROCESS_PROOF_UNAVAILABLE');}
  };
  const startupRecordRoot=()=>{
    try{return realpathSync(join(dataDir,'plugins','codex-autocontinue','executor-jobs'));}
    catch{throw new BoardError('原任务执行器记录不可用',409,'EXECUTION_STARTUP_UNKNOWN');}
  };
  const readStartupRecord=async(recordId,taskId,workspace)=>{
    try{return await readJobRecord(startupRecordRoot(),recordId,taskId,workspace);}
    catch{throw new BoardError('原任务执行器记录无法核实',409,'EXECUTION_STARTUP_UNKNOWN');}
  };
  const sameStartupCohort=(a,b)=>a?.length===b?.length&&
    a.every(row=>b.some(other=>row.pid===other.pid&&row.euid===other.euid&&
      row.ruid===other.ruid&&row.startSec===other.startSec&&row.startUsec===other.startUsec&&
      row.uniqueid===other.uniqueid&&row.pidversion===other.pidversion&&
      row.coalition?.resource===other.coalition?.resource));
  const startupEvidence=async(input,phase)=>{
    if(process.platform!=='darwin'||!input?.startupId||!input?.recordId||input.provider!=='codex-autocontinue')
      throw new BoardError('任务执行器启动身份未确认',409,'EXECUTION_STARTUP_UNKNOWN');
    const lease=leases.startupFor(input);
    const task=store.getTask(input.taskId),binding=resolveWorkspace({taskId:task.id,worktreeId:lease.worktreeId||null});
    const generation=control.handoffForProject(task.projectId)?.generation??null;
    if(task.projectId!==lease.projectId||task.executionProvider&&task.executionProvider!=='codex-autocontinue'||
      binding.directory!==input.workspace||
      lease.conversationId&&lease.conversationId!==task.conversationId||
      generation!==lease.expectedHandoffGeneration||lease.recordId!==input.recordId||
      !lease.ready)
      throw new BoardError('任务或人工交还身份已变化',409,'EXECUTION_BINDING_CHANGED');
    const root=startupRecordRoot();
    const record=await readStartupRecord(input.recordId,task.id,binding.directory);
    const evidence=await startupDiagnostics.observe(phase,{recordRoot:root,recordId:input.recordId,
      taskId:task.id,workspace:binding.directory,pythonPath:record.pythonPath});
    if(!evidence.verified||evidence.unknown)
      throw new BoardError('任务执行器当前身份未能核实',409,'EXECUTION_STARTUP_UNKNOWN');
    return {lease,task,binding,generation,evidence};
  };
  const reserveExecutorStartup=async input=>{
    if(closing)throw new BoardError('程序正在关闭',503,'EXECUTION_STARTUP_UNKNOWN');
    await remoteExecution.check({taskId:input.taskId,commandId:input.requestCommandId});
    if(closing)throw new BoardError('程序正在关闭',503,'EXECUTION_STARTUP_UNKNOWN');
    const task=store.getTask(input.taskId),binding=resolveWorkspace(input);
    if(input.workspace!==binding.directory||input.worktreeId!==binding.worktreeId||
      task.revision!==input.expectedRevision||task.projectId!==input.projectId)
      throw new BoardError('任务启动绑定已变化',409,'EXECUTION_BINDING_CHANGED');
    const generation=control.handoffForProject(task.projectId)?.generation??null;
    if(generation!==input.expectedHandoffGeneration)
      throw new BoardError('人工交还代次已变化',409,'CONTROL_STALE');
    await terminal.verifyManagedForExecution(task.projectId);
    const fresh=store.getTask(task.id),freshBinding=resolveWorkspace(input);
    if(fresh.revision!==task.revision||fresh.contentVersion!==task.contentVersion||
      fresh.projectId!==task.projectId||fresh.conversationId!==task.conversationId||
      freshBinding.directory!==binding.directory||freshBinding.worktreeId!==binding.worktreeId||
      (control.handoffForProject(task.projectId)?.generation??null)!==generation)
      throw new BoardError('任务启动核验期间绑定已变化',409,'EXECUTION_BINDING_CHANGED');
    control.assertMayStart(task.projectId);terminal.assertManagedReady(task.projectId);
    if(terminal.blocksProject(task.projectId))throw new BoardError('终端仍在使用此工作区',409,'TERMINAL_CONTROLLED');
    if(closing)throw new BoardError('程序正在关闭',503,'EXECUTION_STARTUP_UNKNOWN');
    return leases.reserveStartup({...input,provider:'codex-autocontinue'});
  };
  const bindExecutorStartup=async input=>{
    // The durable startup row has no recordId until this first bind. Lookup
    // its original grant, then validate the prepared record and bind that ID
    // atomically; later callers cannot replace it with a different record.
    const lease=leases.startupFor({taskId:input.taskId,startupId:input.startupId,
      provider:'codex-autocontinue'});
    if(lease.status!=='startup'||lease.recordId)
      throw new BoardError('任务启动记录已绑定',409,'EXECUTION_STARTUP_UNKNOWN');
    const binding=leases.bindingFor({taskId:input.taskId,commandId:input.startupId});
    const record=await readStartupRecord(input.recordId,input.taskId,binding.workspace);
    if(record.phase!=='prepared'||record.attempted||record.identity!==null)
      throw new BoardError('任务启动记录无法核实',409,'EXECUTION_STARTUP_UNKNOWN');
    return leases.bindStartup({...input,provider:'codex-autocontinue'});
  };
  const confirmExecutorStartup=async input=>{
    const lease=leases.startupFor({...input,provider:'codex-autocontinue'});
    if(lease.status!=='startup'||lease.recordId!==input.recordId)
      throw new BoardError('任务启动记录已变化',409,'EXECUTION_STARTUP_UNKNOWN');
    const binding=leases.bindingFor({taskId:input.taskId,commandId:input.startupId});
    const beforeTask=store.getTask(input.taskId);
    if(beforeTask.projectId!==lease.projectId||beforeTask.revision!==lease.expectedRevision||
      beforeTask.executionProvider&&beforeTask.executionProvider!=='codex-autocontinue'||
      binding.workspace!==lease.workspace||(binding.worktreeId||null)!==(lease.worktreeId||null)||
      (control.handoffForProject(lease.projectId)?.generation??null)!==lease.expectedHandoffGeneration)
      throw new BoardError('任务启动绑定已变化',409,'EXECUTION_BINDING_CHANGED');
    const record=await readStartupRecord(input.recordId,input.taskId,binding.workspace);
    const evidence=await startupDiagnostics.observe('confirm.first',{recordRoot:startupRecordRoot(),recordId:input.recordId,
      taskId:input.taskId,workspace:binding.workspace,pythonPath:record.pythonPath});
    if(!evidence.verified||evidence.unknown)throw new BoardError('任务执行器身份未能核实',409,'EXECUTION_STARTUP_UNKNOWN');
    await terminal.verifyManagedForExecution(lease.projectId,evidence);
    const secondEvidence=await startupDiagnostics.observe('confirm.second',{recordRoot:startupRecordRoot(),recordId:input.recordId,
      taskId:input.taskId,workspace:binding.workspace,pythonPath:record.pythonPath});
    if(!secondEvidence.verified||!sameStartupCohort(evidence.members,secondEvidence.members)){
      startupDiagnostics.record('confirm.cross_check',input.recordId,{verified:false});
      throw new BoardError('任务执行器进程群在核验中变化',409,'EXECUTION_STARTUP_UNKNOWN');
    }
    const current=leases.startupFor({...input,provider:'codex-autocontinue'});
    const afterTask=store.getTask(input.taskId),afterBinding=resolveWorkspace({taskId:input.taskId,worktreeId:lease.worktreeId||null});
    if(current.recordId!==lease.recordId||current.expectedHandoffGeneration!==lease.expectedHandoffGeneration||
      current.status!=='startup'||afterTask.projectId!==beforeTask.projectId||
      afterTask.revision!==lease.expectedRevision||
      afterTask.executionProvider&&afterTask.executionProvider!=='codex-autocontinue'||
      afterTask.revision!==beforeTask.revision||afterTask.contentVersion!==beforeTask.contentVersion||
      afterTask.conversationId!==beforeTask.conversationId||afterTask.status!==beforeTask.status||
      afterBinding.directory!==binding.workspace||afterBinding.worktreeId!==lease.worktreeId||
      (control.handoffForProject(lease.projectId)?.generation??null)!==lease.expectedHandoffGeneration)
      throw new BoardError('任务启动代次已变化',409,'EXECUTION_BINDING_CHANGED');
    return leases.confirmStartup({...input,provider:'codex-autocontinue'});
  };
  const bindExecutorConversation=async input=>{
    const lease=leases.startupFor({...input,provider:'codex-autocontinue'});
    const task=store.getTask(input.taskId);
    if(lease.purpose!=='session'||lease.status!=='startup'||lease.recordId!==input.recordId||
      task.projectId!==lease.projectId||task.conversationId!==input.threadId||
      (control.handoffForProject(task.projectId)?.generation??null)!==lease.expectedHandoffGeneration)
      throw new BoardError('原会话启动绑定已变化',409,'EXECUTION_BINDING_CHANGED');
    return leases.bindStartupConversation({...input,provider:'codex-autocontinue'});
  };
  const verifyExecutorStartup=async input=>{
    const before=await startupEvidence({...input,provider:'codex-autocontinue'},'verify.first');
    await terminal.verifyManagedForExecution(before.task.projectId,before.evidence);
    const after=await startupEvidence({...input,provider:'codex-autocontinue'},'verify.second');
    if(after.task.revision!==before.task.revision||after.task.contentVersion!==before.task.contentVersion||
      after.task.conversationId!==before.task.conversationId||after.task.status!==before.task.status||
      after.lease.commandId!==before.lease.commandId||after.lease.status!==before.lease.status||
      !sameStartupCohort(before.evidence.members,after.evidence.members)){
      startupDiagnostics.record('verify.cross_check',input.recordId,{verified:false});
      throw new BoardError('任务执行器现场在核验中发生变化',409,'EXECUTION_BINDING_CHANGED');
    }
    control.assertMayStart(after.task.projectId);terminal.assertManagedReady(after.task.projectId);
    return {verified:true,scope:'original-task-job-and-managed-pane'};
  };
  const retireExecutorStartup=async input=>{
    const exact={...input,provider:'codex-autocontinue'};
    if(input.shutdownUnknown!==undefined){
      const receipt=input.shutdownUnknown;
      if(input.settledCommands.length||receipt?.version!==1||
        (receipt.stopCause!==undefined&&receipt.stopCause!=='provider_approval')||
        receipt.taskId!==input.taskId||
        receipt.startupId!==input.startupId||receipt.recordId!==input.recordId)
        throw new BoardError('原退出收据身份不符',409,'EXECUTION_STARTUP_UNKNOWN');
      const original=leases.startupFor(exact);
      const task=store.getTask(input.taskId);
      const binding=resolveWorkspace({taskId:input.taskId,worktreeId:original.worktreeId||null});
      const handoffBefore=receipt.expectedHandoffGeneration===null?null:
        control.retirementHandoff(task.projectId,receipt.expectedHandoffGeneration);
      if(original.recordId!==input.recordId||original.projectId!==receipt.projectId||
        original.commandId!==receipt.commandId||original.conversationId!==receipt.threadId||
        original.workspace!==receipt.workspace||binding.directory!==receipt.workspace||
        binding.worktreeId!==(receipt.worktreeId||null)||
        task.projectId!==receipt.projectId||task.conversationId!==receipt.threadId||
        (original.worktreeId||null)!==(receipt.worktreeId||null)||
        original.expectedHandoffGeneration!==receipt.expectedHandoffGeneration||
        receipt.proofScope!==(receipt.expectedHandoffGeneration===null
          ?'macos-original-task-job-coalition-known-descendants-and-current-writers'
          :'macos-original-task-job-coalition-known-descendants-and-managed-handoff')||
        (receipt.expectedHandoffGeneration!==null&&!handoffBefore))
        throw new BoardError('原退出租约绑定已变化',409,'EXECUTION_BINDING_CHANGED');
      const hostProof=()=>{
        try{
          const path=join(dataDir,'plugins','codex-autocontinue','codex-autocontinue.json');
          const stat=lstatSync(path);
          if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||
            stat.uid!==process.getuid()||stat.size>16_000_000)
            throw new Error('host_state_untrusted');
          const state=JSON.parse(readFileSync(path,'utf8'));
          const marker=state.executors?.[`task:${input.taskId}`];
          const command=state.commands?.[`${input.taskId}:${receipt.commandId}`];
          const {recordGeneration,proofScope,...intent}=receipt;
          if(marker?.kind!=='macos-job'||!['stopping','retirement_unknown','stopped_unknown'].includes(marker.status)||
            marker.recordId!==input.recordId||marker.startupId!==input.startupId||
            marker.taskId!==input.taskId||marker.projectId!==receipt.projectId||
            marker.pid!==receipt.bridgePid||marker.workspace!==receipt.workspace||
            (marker.worktreeId||null)!==(receipt.worktreeId||null)||
            (marker.expectedHandoffGeneration??null)!==receipt.expectedHandoffGeneration||
            marker.lastCommandId!==receipt.commandId||marker.threadId!==receipt.threadId||
            JSON.stringify(marker.shutdownStopIntent)!==JSON.stringify(intent)||
            marker.captureComplete!==true||!Array.isArray(marker.knownIdentities)||
            marker.knownIdentities.length<2||
            JSON.stringify(marker.shutdownStopProof)!==JSON.stringify(receipt)||
            marker.shutdownStoppedReceipt&&
              JSON.stringify(marker.shutdownStoppedReceipt)!==JSON.stringify(receipt)||
            command?.taskId!==input.taskId||command.commandId!==receipt.commandId||
            command.threadId!==receipt.threadId||command.turnId!==receipt.turnId||
            command.bridgePid!==receipt.bridgePid||command.workspace!==receipt.workspace||
            !(['running','unknown'].includes(command.status)||
              receipt.stopCause==='provider_approval'&&command.status==='awaiting_approval')||
            command.stopProof?.status==='verified')
            throw new Error('host_shutdown_binding_changed');
          return {markerStatus:marker.status,commandStatus:command.status};
        }catch{throw new BoardError('原退出意图无法核实',409,'EXECUTION_STARTUP_UNKNOWN');}
      };
      const beforeHost=hostProof();
      const historical=original.status==='unknown'&&
        JSON.stringify(original.shutdownStoppedReceipt)===JSON.stringify(receipt);
      const readShutdownRecord=async()=>{
        if(!historical)return readStartupRecord(input.recordId,input.taskId,receipt.workspace);
        try{
          const root=startupRecordRoot();
          const old=await readRetiredJobRecord(root,input.recordId,input.taskId,receipt.workspace);
          // The historical reader is never authority for a same-boot job.
          if(old.boot===(await bootIdentity()))return readStartupRecord(input.recordId,input.taskId,receipt.workspace);
          return old;
        }catch{throw new BoardError('原任务执行器历史退休记录无法核实',409,'EXECUTION_STARTUP_UNKNOWN');}
      };
      const record=await readShutdownRecord();
      if(record.phase!=='retired'||record.attempted!==true||!record.identity||
        record.ioFault!==false||record.generation<receipt.recordGeneration||
        record.identity.pid!==receipt.bridgePid)
        throw new BoardError('原执行器退出尚未证实',409,'EXECUTION_STARTUP_UNKNOWN');
      const finalRecord=await readShutdownRecord();
      const current=leases.startupFor(exact);
      const finalTask=store.getTask(input.taskId);
      const finalBinding=resolveWorkspace({taskId:input.taskId,worktreeId:original.worktreeId||null});
      const handoffAfter=receipt.expectedHandoffGeneration===null?null:
        control.retirementHandoff(task.projectId,receipt.expectedHandoffGeneration);
      const afterHost=hostProof();
      if(finalRecord.phase!=='retired'||finalRecord.generation!==record.generation||
        current.status!==original.status||current.commandId!==original.commandId||
        current.recordId!==original.recordId||current.workspace!==original.workspace||
        JSON.stringify(current.shutdownStoppedReceipt||null)!==JSON.stringify(original.shutdownStoppedReceipt||null)||
        finalTask.projectId!==task.projectId||finalTask.conversationId!==task.conversationId||
        finalTask.revision!==task.revision||finalTask.contentVersion!==task.contentVersion||
        finalBinding.directory!==binding.directory||finalBinding.worktreeId!==binding.worktreeId||
        JSON.stringify(handoffAfter)!==JSON.stringify(handoffBefore)||
        JSON.stringify(afterHost)!==JSON.stringify(beforeHost))
        throw new BoardError('原退出核验期间绑定已变化',409,'EXECUTION_BINDING_CHANGED');
      return leases.markShutdownStoppedUnknown({...exact,receipt});
    }
    let lease,alreadyRetired=false;
    try{lease=leases.startupFor(exact);}
    catch(error){
      if(error?.code!=='EXECUTION_NOT_FOUND')throw error;
      lease=leases.retiredStartupFor(exact);alreadyRetired=true;
    }
    if(lease.recordId!==input.recordId)
      throw new BoardError('任务执行器仍有命令或身份已变化',409,'EXECUTION_STARTUP_UNKNOWN');
    const binding=alreadyRetired?{workspace:lease.workspace}:
      leases.bindingFor({taskId:input.taskId,commandId:lease.commandId});
    const record=await readStartupRecord(input.recordId,input.taskId,binding.workspace);
    if(record.phase!=='retired'||record.attempted&&!record.identity)
      throw new BoardError('原执行器退出尚未证实',409,'EXECUTION_STARTUP_UNKNOWN');
    // Retirement removes only this executor's lease. Human reacquisition may
    // already have moved ai_ready to stopping, so it cannot require the
    // pre-execution gate; the job's original retired record remains mandatory.
    const finalRecord=await readStartupRecord(input.recordId,input.taskId,binding.workspace);
    if(finalRecord.phase!=='retired'||finalRecord.generation!==record.generation)
      throw new BoardError('原执行器退出记录已变化',409,'EXECUTION_STARTUP_UNKNOWN');
    const current=alreadyRetired?leases.retiredStartupFor(exact):leases.startupFor(exact);
    if(current.status!==lease.status||current.commandId!==lease.commandId||current.recordId!==lease.recordId||
      current.projectId!==lease.projectId||current.workspace!==lease.workspace||
      JSON.stringify(current.retirementReceipt||null)!==JSON.stringify(lease.retirementReceipt||null))
      throw new BoardError('执行器退出核验期间控制权已变化',409,'EXECUTION_BINDING_CHANGED');
    const expectedCommand=alreadyRetired?current.retirementReceipt.commandId:
      current.status==='startup'?null:current.commandId;
    const receipt=expectedCommand===null?null:input.settledCommands.find(row=>row.commandId===expectedCommand);
    if(expectedCommand!==null&&(!receipt||alreadyRetired&&receipt.status!==current.retirementReceipt.settledStatus))
      throw new BoardError('原执行命令结果未确认',409,'EXECUTION_UNCONFIRMED');
    return leases.retireStartup({...exact,
      settledCommandId:receipt?.commandId||null,settledStatus:receipt?.status||null});
  };
  const disposeStoppedUnknownExecutor=async input=>{
    if(process.platform!=='darwin'||closing)
      throw new BoardError('原执行器处置不可用',409,'EXECUTION_UNCONFIRMED');
    const receipt=input.shutdownReceipt,task=store.getTask(input.taskId);
    if(!task||receipt?.version!==1||receipt.taskId!==task.id||
      receipt.startupId!==input.startupId||receipt.recordId!==input.recordId||
      receipt.projectId!==task.projectId||input.controlConsent?.projectId!==task.projectId||
      !input.controlConsent?.id)
      throw new BoardError('原未知命令与处置确认不符',409,'EXECUTION_UNCONFIRMED');
    const existing=leases.dispositions().find(row=>row.taskId===task.id&&
      row.startupId===input.startupId&&row.recordId===input.recordId);
    if(existing){
      const consent=control.unknownDispositionConsent(task.projectId);
      const current=control.state().find(row=>row.projectId===task.projectId);
      if(current?.phase!=='stopping'||current.workspace!==existing.workspace||
        consent?.id!==input.controlConsent.id||consent.projectId!==task.projectId||
        consent.workspace!==existing.workspace||consent.actorId!==existing.actorId||
        consent.profileId!==existing.profileId||consent.generation!==existing.generation||
        !consent.commands.some(row=>row.taskId===task.id&&row.commandId===receipt.commandId)||
        JSON.stringify(existing.shutdownReceipt)!==JSON.stringify(receipt))
        throw new BoardError('原处置收据或当前接管确认已变化',409,'CONTROL_STALE');
      return existing;
    }
    const consent=control.authorizeUnknownDisposition({projectId:task.projectId,
      consentId:input.controlConsent.id,taskId:task.id,commandId:receipt.commandId});
    const lease=leases.startupFor({taskId:task.id,startupId:input.startupId,
      provider:'codex-autocontinue',recordId:input.recordId});
    const binding=resolveWorkspace({taskId:task.id,worktreeId:lease.worktreeId||null});
    const selected=new Set(consent.commands.map(row=>`${row.taskId}:${row.commandId}`));
    if(!selected.size||selected.size>16||selected.size!==consent.commands.length||
      consent.workspace!==binding.directory||
      lease.status!=='unknown'||lease.projectId!==task.projectId||
      lease.commandId!==receipt.commandId||lease.conversationId!==task.conversationId||
      lease.workspace!==receipt.workspace||binding.directory!==receipt.workspace||
      binding.worktreeId!==(receipt.worktreeId||null)||
      lease.expectedHandoffGeneration!==receipt.expectedHandoffGeneration||
      JSON.stringify(lease.shutdownStoppedReceipt)!==JSON.stringify(receipt)||
      receipt.proofScope!==(receipt.expectedHandoffGeneration===null
        ?'macos-original-task-job-coalition-known-descendants-and-current-writers'
        :'macos-original-task-job-coalition-known-descendants-and-managed-handoff')||
      leases.activeOverlaps(task.projectId).some(row=>!selected.has(`${row.taskId}:${row.commandId}`)))
      throw new BoardError('原未知命令租约或工作区已变化',409,'EXECUTION_UNCONFIRMED');
    const hostProof=()=>{
      try{
        const path=join(dataDir,'plugins','codex-autocontinue','codex-autocontinue.json');
        const stat=lstatSync(path);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||
          stat.uid!==process.getuid()||stat.size>16_000_000)throw Error('host_state_untrusted');
        const state=JSON.parse(readFileSync(path,'utf8'));
        const marker=state.executors?.[`task:${task.id}`];
        const command=state.commands?.[`${task.id}:${receipt.commandId}`];
        const {recordGeneration,proofScope,...intent}=receipt;
        if(marker?.kind!=='macos-job'||marker.status!=='stopped_unknown'||
          marker.taskId!==task.id||marker.projectId!==task.projectId||
          marker.startupId!==input.startupId||marker.recordId!==input.recordId||
          marker.pid!==receipt.bridgePid||marker.workspace!==receipt.workspace||
          marker.threadId!==receipt.threadId||marker.lastCommandId!==receipt.commandId||
          (marker.worktreeId||null)!==(receipt.worktreeId||null)||
          (marker.expectedHandoffGeneration??null)!==receipt.expectedHandoffGeneration||
          marker.captureComplete!==true||!Array.isArray(marker.knownIdentities)||
          marker.knownIdentities.length<2||
          JSON.stringify(marker.shutdownStopIntent)!==JSON.stringify(intent)||
          JSON.stringify(marker.shutdownStopProof)!==JSON.stringify(receipt)||
          JSON.stringify(marker.shutdownStoppedReceipt)!==JSON.stringify(receipt)||
          command?.status!=='unknown'||command.disposition||
          command.taskId!==task.id||command.commandId!==receipt.commandId||
          command.threadId!==receipt.threadId||command.turnId!==receipt.turnId||
          command.bridgePid!==receipt.bridgePid||command.workspace!==receipt.workspace||
          (command.worktreeId||null)!==(receipt.worktreeId||null)||
          command.stopProof?.status==='verified'||
          Object.values(state.commands).some(other=>{
            if(other===command||store.getTask(other.taskId)?.projectId!==task.projectId)return false;
            const otherKey=`${other.taskId}:${other.commandId}`;
            if(other.disposition){
              const original=leases.dispositions().find(row=>row.taskId===other.taskId&&row.commandId===other.commandId);
              return JSON.stringify(original)!==JSON.stringify(other.disposition);
            }
            if(!['sending','running','unknown','awaiting_approval'].includes(other.status))return false;
            const otherMarker=state.executors?.[`task:${other.taskId}`];
            return !selected.has(otherKey)||other.status!=='unknown'||
              otherMarker?.status!=='stopped_unknown'||
              otherMarker.lastCommandId!==other.commandId||
              JSON.stringify(otherMarker.shutdownStopProof)!==JSON.stringify(otherMarker.shutdownStoppedReceipt);
          }))
          throw Error('host_shutdown_binding_changed');
        return JSON.stringify({marker,command});
      }catch{throw new BoardError('原执行器停止收据无法核实',409,'EXECUTION_UNCONFIRMED');}
    };
    const beforeHost=hostProof();
    const record=await readStartupRecord(input.recordId,task.id,receipt.workspace);
    if(record.phase!=='retired'||record.attempted!==true||!record.identity||
      record.ioFault!==false||record.generation<receipt.recordGeneration||
      record.identity.pid!==receipt.bridgePid)
      throw new BoardError('原执行器物理退休未确认',409,'EXECUTION_UNCONFIRMED');
    const finalRecord=await readStartupRecord(input.recordId,task.id,receipt.workspace);
    const finalConsent=control.authorizeUnknownDisposition({projectId:task.projectId,
      consentId:consent.id,taskId:task.id,commandId:receipt.commandId});
    const current=leases.startupFor({taskId:task.id,startupId:input.startupId,
      provider:'codex-autocontinue',recordId:input.recordId});
    const finalTask=store.getTask(task.id),finalBinding=resolveWorkspace({taskId:task.id,worktreeId:lease.worktreeId||null});
    if(finalRecord.phase!=='retired'||finalRecord.generation!==record.generation||
      JSON.stringify(finalConsent)!==JSON.stringify(consent)||
      JSON.stringify(current)!==JSON.stringify(lease)||
      finalTask.projectId!==task.projectId||finalTask.revision!==task.revision||
      finalTask.contentVersion!==task.contentVersion||finalTask.conversationId!==task.conversationId||
      finalBinding.directory!==binding.directory||finalBinding.worktreeId!==binding.worktreeId||
      hostProof()!==beforeHost)
      throw new BoardError('原未知命令处置核验期间现场变化',409,'EXECUTION_BINDING_CHANGED');
    return leases.retireStoppedUnknownForHuman({taskId:task.id,startupId:input.startupId,
      provider:'codex-autocontinue',recordId:input.recordId,receipt,
      disposition:{version:1,id:consent.id,projectId:task.projectId,taskId:task.id,
        commandId:receipt.commandId,startupId:input.startupId,recordId:input.recordId,
        threadId:receipt.threadId,turnId:receipt.turnId,workspace:receipt.workspace,
        worktreeId:receipt.worktreeId||null,actorId:consent.actorId,profileId:consent.profileId,
        generation:consent.generation,providerOutcome:'unknown',reason:'human_disposition',
        disposedAt:new Date().toISOString(),shutdownReceipt:structuredClone(receipt)}});
  };
  const verifyRetirementWorkspace=async input=>{try{
    const {taskId,recordId,workspace,worktreeId,expectedHandoffGeneration}=input;
    if(process.platform!=='darwin'||!Number.isSafeInteger(expectedHandoffGeneration)||
      expectedHandoffGeneration<1||!terminal)
      throw new BoardError('原受管交还证明不可用',409,'MANAGED_PANE_UNKNOWN');
    const task=store.getTask(taskId),project=store.getProject(task.projectId);
    if((task.executionProvider||'codex-autocontinue')!=='codex-autocontinue'||
      resolveWorkspace({taskId,worktreeId}).directory!==workspace||realpathSync(workspace)!==workspace||
      realpathSync(project.directory)!==project.directory)
      throw new BoardError('退休任务或真实目录身份已变化',409,'EXECUTION_BINDING_CHANGED');
    const before=control.retirementHandoff(task.projectId,expectedHandoffGeneration);
    if(!before)throw new BoardError('原受管交还代次不存在',409,'CONTROL_STALE');
    const recordRoot=join(dataDir,'plugins','codex-autocontinue','executor-jobs');
    const record=await readJobRecord(recordRoot,recordId,taskId,workspace);
    if(record.phase!=='retired'||record.attempted!==true||!record.identity)
      throw new BoardError('原任务执行器尚未证明退出',409,'PROCESS_PROOF_UNAVAILABLE');
    await terminal.verifyRetirementWorkspace({projectId:task.projectId,workspace,expectedHandoffGeneration});
    const currentRecord=await readJobRecord(recordRoot,recordId,taskId,workspace);
    // The record read awaits filesystem/boot checks. Re-read all mutable
    // bindings after that last await, just before issuing this proof.
    const fresh=store.getTask(taskId),freshProject=store.getProject(task.projectId);
    const after=control.retirementHandoff(task.projectId,expectedHandoffGeneration);
    if(fresh.projectId!==task.projectId||fresh.revision!==task.revision||
      fresh.contentVersion!==task.contentVersion||fresh.conversationId!==task.conversationId||
      fresh.executionProvider!==task.executionProvider||
      resolveWorkspace({taskId,worktreeId}).directory!==workspace||
      realpathSync(freshProject.directory)!==project.directory||!after||
      after.phase!==before.phase||after.currentGeneration!==before.currentGeneration||
      after.workspace!==before.workspace||after.profileId!==before.profileId||
      after.sessionEvidenceDigest!==before.sessionEvidenceDigest||
      after.sessionRefs.length!==before.sessionRefs.length||
      currentRecord.generation!==record.generation||currentRecord.phase!=='retired')
      throw new BoardError('任务、交还或执行器记录在核验期间变化',409,'EXECUTION_BINDING_CHANGED');
    return {verified:true,quiescent:true,unknown:false,livePids:[],scope:'macos-parked-managed-pane-and-visible-writers'};
  }catch(error){
    const allowed=new Set(['MANAGED_PANE_UNKNOWN','EXECUTION_BINDING_CHANGED','CONTROL_STALE','PROCESS_PROOF_UNAVAILABLE']);
    throw new BoardError('受管任务退休现场未能核实',409,allowed.has(error?.code)?error.code:'MANAGED_PANE_UNKNOWN');
  }
  };
  const authorizeExecution=async input=>{
    if(closing)throw new BoardError('程序正在关闭，不能启动任务',503);
    await remoteExecution.check(input);
    if(closing)throw new BoardError('程序正在关闭，不能启动任务',503);
    const task=store.getTask(input.taskId),{directory,worktreeId}=resolveWorkspace(input);
    const handoffGeneration=control.handoffForProject(task.projectId)?.generation??null;
    if(input.workspace!==undefined&&input.workspace!==directory)throw new BoardError('执行目录与登记工作树不符',409,'EXECUTION_WORKSPACE_CHANGED');
    const startup=input.startupId?await startupEvidence({...input,provider:'codex-autocontinue'},'authorize.first'):null;
    await terminal.verifyManagedForExecution(task.projectId,startup?.evidence||
      (process.platform==='linux'&&(handoffGeneration!==null||linuxAuthority.has(task.id,input.commandId))
        ?await linuxAdmittedJob(input,task,handoffGeneration):null));
    const startupAfter=startup?await startupEvidence({...input,provider:'codex-autocontinue'},'authorize.second'):null;
    if(startup&&!sameStartupCohort(startup.evidence.members,startupAfter.evidence.members)){
      startupDiagnostics.record('authorize.cross_check',input.recordId,{verified:false});
      throw new BoardError('执行器进程群在核验中变化',409,'EXECUTION_STARTUP_UNKNOWN');
    }
    const fresh=store.getTask(input.taskId),freshWorkspace=resolveWorkspace(input);
    if(fresh.projectId!==task.projectId||freshWorkspace.directory!==directory||freshWorkspace.worktreeId!==worktreeId||
      fresh.revision!==task.revision||fresh.contentVersion!==task.contentVersion||
      fresh.conversationId!==task.conversationId||fresh.status!==task.status||
      fresh.executionProvider!==task.executionProvider)
      throw new BoardError('执行任务或目录在进程核验期间已变更',409,'EXECUTION_BINDING_CHANGED');
    if((control.handoffForProject(task.projectId)?.generation??null)!==handoffGeneration)
      throw new BoardError('人工交还代次已变化，请重新读取现场',409,'CONTROL_STALE');
    if(startup){
      const latest=leases.startupFor({...input,provider:'codex-autocontinue'});
      if(latest.purpose!=='turn'||latest.recordId!==startup.lease.recordId||latest.status!=='startup'||
        latest.commandId!==startup.lease.commandId)
        throw new BoardError('任务启动租约已变化',409,'EXECUTION_STARTUP_UNKNOWN');
    }
    if(input.expectedRevision!==undefined)store.checkRevision(fresh,input.expectedRevision);
    control.assertMayStart(task.projectId);terminal.assertManagedReady(task.projectId);
    if(terminal.blocksProject(task.projectId))throw new BoardError('终端正在使用此工作区，请先交还执行权',409,'TERMINAL_CONTROLLED');
    // Read persisted plans even while plugins are starting: auto-resume timers may fire before workflow initialization.
    const saved=store.db.prepare('SELECT value FROM metadata WHERE key=?').get('workflow.v1');
    const plans=saved?JSON.parse(saved.value).plans:[];
    if(plans.some(p=>p.members.some(m=>['running','sending','unknown','pausing'].includes(m.status)&&
      (m.taskId===task.id||pathOverlaps(m.workspace,directory)||p.projectId===task.projectId&&(!worktreeId||!m.worktreeId))&&
      !(m.taskId===task.id&&m.provider===input.provider&&m.commandId===input.commandId))))throw new BoardError('协作计划正在使用该任务或目录',409,'EXECUTION_BUSY');
    const reservation=leases.reserve(input);
    if(reservation.maySend!==true)throw new BoardError('该命令已取得过执行许可，请先核对原执行结果',409,'EXECUTION_DUPLICATE');
    return reservation;
  };
  const revalidateExecution=async input=>{
    if(closing)throw new BoardError('程序正在关闭，不能启动任务',503);
    await remoteExecution.check(input);
    if(closing)throw new BoardError('程序正在关闭，不能启动任务',503);
    // The worker cannot read SQLite synchronously. Compare its send baseline
    // here after the last network wait, before returning the send permission.
    const before=store.getTask(input.taskId),beforeWorkspace=resolveWorkspace(input);
    const handoffGeneration=control.handoffForProject(before.projectId)?.generation??null;
    const startup=input.startupId?await startupEvidence({...input,provider:'codex-autocontinue'},'revalidate.first'):null;
    await terminal.verifyManagedForExecution(before.projectId,startup?.evidence||
      (process.platform==='linux'&&(handoffGeneration!==null||linuxAuthority.has(before.id,input.commandId))
        ?await linuxAdmittedJob(input,before,handoffGeneration):null));
    const startupAfter=startup?await startupEvidence({...input,provider:'codex-autocontinue'},'revalidate.second'):null;
    if(startup&&!sameStartupCohort(startup.evidence.members,startupAfter.evidence.members)){
      startupDiagnostics.record('revalidate.cross_check',input.recordId,{verified:false});
      throw new BoardError('执行器进程群在核验中变化',409,'EXECUTION_STARTUP_UNKNOWN');
    }
    const current=store.getTask(input.taskId),currentWorkspace=resolveWorkspace(input);
    if(current.projectId!==before.projectId||currentWorkspace.directory!==beforeWorkspace.directory||
      currentWorkspace.worktreeId!==beforeWorkspace.worktreeId||current.revision!==before.revision||
      current.contentVersion!==before.contentVersion||current.conversationId!==before.conversationId||
      current.status!==before.status||current.executionProvider!==before.executionProvider)
      throw new BoardError('执行任务或目录在进程核验期间已变更',409,'EXECUTION_BINDING_CHANGED');
    if((control.handoffForProject(current.projectId)?.generation??null)!==handoffGeneration)
      throw new BoardError('人工交还代次已变化，请重新读取现场',409,'CONTROL_STALE');
    if(startup){
      const latest=leases.startupFor({...input,provider:'codex-autocontinue'});
      if(latest.recordId!==startup.lease.recordId||latest.status!==startup.lease.status||
        latest.commandId!==startup.lease.commandId||
        (latest.purpose==='session'
          ? latest.status!=='startup'||!!current.conversationId
          : latest.status!=='reserved'||latest.commandId!==input.commandId))
        throw new BoardError('任务启动租约已变化',409,'EXECUTION_STARTUP_UNKNOWN');
    }
    control.assertMayStart(current.projectId);
    terminal.assertManagedReady(current.projectId);
    worktrees.assertMayExecute(current.projectId);
    if(terminal.blocksProject(current.projectId))throw new BoardError('终端正在使用此工作区，请先交还执行权',409,'TERMINAL_CONTROLLED');
    if(input.expectedRevision!==undefined)store.checkRevision(current,input.expectedRevision);
    if(input.expectedConversationId!==undefined&&(current.conversationId||null)!==(input.expectedConversationId||null))throw new BoardError('执行会话已变更',409,'EXECUTION_BINDING_CHANGED');
    const expected=resolveWorkspace({taskId:current.id,worktreeId:input.worktreeId||null});
    if(input.expectedDirectory!==undefined&&expected.directory!==input.expectedDirectory)throw new BoardError('执行目录已变更',409,'EXECUTION_WORKSPACE_CHANGED');
    if(input.worktreeId&&current.conversationId&&input.expectedConversationId&&input.expectedDirectory){
      const binding=leases.bindingFor(input);
      if(binding.workspace!==input.expectedDirectory||binding.worktreeId!==(input.worktreeId||null))
        throw new BoardError('执行租约与会话工作树不符',409,'EXECUTION_BINDING_CHANGED');
    }
    if(input.expectedHandoffGeneration!==undefined&&
      (control.handoffForProject(current.projectId)?.generation??null)!==input.expectedHandoffGeneration)
      throw new BoardError('人工交还摘要已变更，请重新读取现场',409,'CONTROL_STALE');
  };
  plugins=await loadPlugins({pluginDir:[pluginDir,join(dataDir,'extensions')],dataDir:join(dataDir,'plugins'),coreOwned:{'local-terminal':terminalPlugin},onShutdown:event=>onShutdown(event),context:{getTask:id=>store.getTask(id),getProject:id=>{const handoff=control.handoffForProject(id);return {...store.getProject(id),handoff,
    retirementHandoffGeneration:handoff&&control.retirementHandoff(id,handoff.generation)?.generation||null};},resolveWorkspace,updateTask:(id,patch,revision)=>store.updateTask(id,patch,revision),authorizeExecution,revalidateExecution,verifyRetirementWorkspace,
    verifyLinuxExecutorAdmission,verifyLinuxBridgeRetirementWorkspace,
    verifyLinuxJobRetirement:input=>linuxAuthority.retire(input),
    reserveExecutorStartup,bindExecutorStartup,confirmExecutorStartup,bindExecutorConversation,
    verifyExecutorStartup,retireExecutorStartup,disposeStoppedUnknownExecutor,emit:changed}});
  onStartup('plugins');
  plugin=plugins.get('codex-autocontinue')||unavailableAutocontinue((await plugins.state()).find(p=>p.id==='codex-autocontinue')?.lastError);
  conversations=createConversations({store,plugin,selectedProjects:()=>remote?.state().projectIds||[],beforeRemoteOperation:input=>remoteExecution.check({...input,required:true}),emit:changed});
  if(workspace&&!store.projects().some(p=>p.directory===resolve(workspace)))store.importProject(workspace);
  bridge=files?new FileBridge(store):null;
  // Slow local/network folders must not prevent the database-backed board from opening.
  if(bridge)void bridge.start().catch(()=>{});
  onStartup('files-started');
  const executors=workflowExecutors||new Map((await plugins.state()).filter(p=>p.capabilities?.includes('task.resume')).map(p=>[p.id,{
    start:async(input)=>{const task=store.getTask(input.taskId);store.checkRevision(task,input.expectedRevision);if((task.executionProvider||'codex-autocontinue')!==p.id||resolveWorkspace(input).directory!==input.workspace)throw new BoardError('执行工具或目录已变更',409);if(input.worktreeId){const detail=await worktrees.inspect(input.worktreeId);if(detail.phase!=='ready'||detail.taskId!==task.id||detail.path!==input.workspace)throw new BoardError('工作树身份已变化',409,'WORKTREE_BINDING_CHANGED');}if(!task.conversationId)throw new BoardError('请先为每个成员绑定独立会话',409);return plugins.get(p.id).resume(input);},
    pause:input=>plugins.get(p.id).pause(input),
    inspect:input=>plugins.get(p.id).getExecution(input),
    canStart:input=>leases.workflowMayContinue({...input,provider:p.id}),
  }]));
  workflow=createWorkflow({store,executors,worktrees,emit:changed});
  onStartup('workflow');
  workflowTimer=setInterval(()=>{if(tickPromise||closing)return;tickPromise=(async()=>{await leases.reconcile();if(!closing)await workflow.tick();})().catch(()=>{}).finally(()=>{tickPromise=null;});},3000);workflowTimer.unref();
  const executionWriteGate=createExecutionWriteGate({leases,control,terminal,worktrees,workflow,
    previewBuilds:()=>previewBuilds,isClosing:()=>closing,bootId:executionWriteBootId});
  const state=async()=>{const pluginState=await plugin.state();const inboxState=inbox.sync({executions:leases.state(),policies:pluginState.policies});
    const observedAt=new Date().toISOString(),rawProjects=store.projects(),rawTasks=store.tasks();
    const byProject=new Map(rawProjects.map(project=>[project.id,project]));
    const projects=rawProjects.map(project=>({...project,conversationStart:executionWriteGate.project(project,observedAt,pluginState)}));
    const tasks=rawTasks.map(task=>({...task,executionWrite:byProject.has(task.projectId)
      ?executionWriteGate.task(task,byProject.get(task.projectId),observedAt,pluginState)
      :{v:1,bootId:executionWriteBootId,observedAt,taskRevision:task.revision,contentVersion:task.contentVersion,
        message:{state:'unknown',reasonCode:'BINDING_UNAVAILABLE'},continue:{state:'unknown',reasonCode:'BINDING_UNAVAILABLE'},start:{state:'unknown',reasonCode:'BINDING_UNAVAILABLE'}}}));
    return {projects,tasks,settings:store.settings(),plugin:pluginState,events:store.events(),inbox:inboxState,remote:remote?.state(),capabilities:{desktop,remote:true,inbox:true,preview:true,taskCreation:true,taskStart:true},connection:{mode:desktop?'local':'server',updatedAt:observedAt},fileErrors:bridge?Object.fromEntries([...bridge.errors].filter(([k])=>rawProjects.some(p=>p.id===k))):{}};};
  remote=await createRemoteLink({dataDir,getState:state,getConversations:(projectIds,taskIds)=>conversations.getMany(projectIds,taskIds),
    getReturnedDispositions:input=>closing?[]:returnedDispositionPayloads({dataDir,store,leases,control,conversations,
      identity:remote?.terminalCredentials(),...input}),request:(method,path,body,authorization)=>{
    if(authorization?.action==='create_task')return (async()=>{
      if(method!=='POST'||path!=='/api/tasks'||body?.projectId!==authorization.projectId||body?.commandId!==authorization.commandId)
        throw new BoardError('远程建任务命令不匹配',403,'REMOTE_TASK_FORBIDDEN');
      await authorization.revalidate();
      const identity=remote.terminalCredentials();
      if(closing||!identity||identity.nodeId!==authorization.nodeId||identity.epoch!==authorization.epoch||
        !remote.state().projectIds.includes(authorization.projectId)||!authorization.actor?.tenantId||!authorization.actor?.subjectId)
        throw new BoardError('远程建任务授权已变化',403,'REMOTE_TASK_FORBIDDEN');
      const {projectId,commandId,...fields}=body;
      return store.createRemoteTask({tenantId:authorization.actor.tenantId,nodeId:identity.nodeId,
        subjectId:authorization.actor.subjectId,commandId,projectId,body:fields});
    })();
    const operation=()=>request(method,path,body,'remote-controller');
    return ['continue','message','create_conversation','start_task'].includes(authorization?.action)?remoteExecution.run(authorization,operation):operation();
  },getCreatedTaskReceipt:probe=>{
    const identity=remote.terminalCredentials();
    if(closing||!identity||identity.nodeId!==probe.nodeId||identity.epoch!==probe.epoch||
      !remote.state().projectIds.includes(probe.projectId)||!probe.actor?.tenantId||!probe.actor?.subjectId)return null;
    const saved=store.remoteTaskCreation({tenantId:probe.actor.tenantId,nodeId:identity.nodeId,
      subjectId:probe.actor.subjectId,commandId:probe.commandId,projectId:probe.projectId});
    return saved?{taskId:saved.taskId,status:'planned',revision:1}:null;
  },emit:changed});
  terminal.setLink(createTerminalNodeLink({manager:terminal,credentials:()=>remote.terminalCredentials(),emit:changed}));
  previewLink=createPreviewNodeLink({registry:previewRegistry,credentials:()=>remote.terminalCredentials(),
    retestAuthority:async manifests=>{
      const identity=remote.terminalCredentials();
      if(closing||!identity||!Array.isArray(manifests)||manifests.length!==2)
        throw new BoardError('预览授权已变化',403,'PREVIEW_FORBIDDEN');
      for(const manifest of manifests){
        if(!remote.state().projectIds?.includes(manifest.projectId))
          throw new BoardError('预览项目授权已变化',403,'PREVIEW_FORBIDDEN');
        const task=store.getTask(manifest.taskId),project=store.getProject(manifest.projectId);
        if(task.projectId!==project.id)throw new BoardError('预览任务归属已变化',409,'PREVIEW_VERSION');
        previewLocal.assertDirectory(manifest.previewId,project.directory);
      }
      if(manifests[0].projectId!==manifests[1].projectId||manifests[0].taskId!==manifests[1].taskId)
        throw new BoardError('预览版本不属于同一任务',409,'PREVIEW_VERSION');
    },
    compareRetest:async manifests=>previewRetest.compare(
      await previewLocal.build(manifests[0].previewId),
      await previewLocal.build(manifests[1].previewId)),
    records:previewRecords,recordAuthority:async manifest=>{
      if(closing||!remote.terminalCredentials()||!remote.state().projectIds?.includes(manifest.projectId))
        throw new BoardError('预览项目授权已变化',403,'PREVIEW_FORBIDDEN');
      const task=store.getTask(manifest.taskId),project=store.getProject(manifest.projectId);
      if(task.projectId!==project.id||task.contentVersion!==manifest.contentVersion)
        throw new BoardError('预览版本已变化',409,'PREVIEW_VERSION');
      previewLocal.assertDirectory(manifest.previewId,project.directory);
      return true;
    },
    recoveryStoreId:store.previewFeedbackStoreId(),
    createFeedbackTask:async input=>{
      if(closing||!remote.terminalCredentials()||!remote.state().projectIds?.includes(input.projectId))
        throw new BoardError('预览项目授权已变化',403,'PREVIEW_FORBIDDEN');
      const task=store.createPreviewFeedbackTask(input);
      return {taskId:task.id};
    },reconcileFeedbackTask:async(input,options)=>{
      if(closing||!remote.terminalCredentials()||!remote.state().projectIds?.includes(input.projectId))
        throw new BoardError('预览项目授权已变化',403,'PREVIEW_FORBIDDEN');
      return store.reconcilePreviewFeedbackTask(input,options);
    }});
  if(remote.terminalCredentials())void previewLink.refresh().catch(()=>{});
  previewBuilds=createControlledPreviewBuilds({store,leases,registry:previewRegistry,
    local:previewLocal,records:previewRecords,dataDir,pythonPath:previewPythonPath,
    link:()=>previewLink,emit:changed,isClosing:()=>closing,
    nodeBinding:()=>{const identity=remote.terminalCredentials();
      if(!identity?.url||!identity?.token||!identity?.nodeId||!Number.isSafeInteger(identity.epoch))return null;
      return createHash('sha256').update(JSON.stringify([identity.url,identity.token,identity.nodeId,identity.epoch])).digest('hex');},
    resolveWorktree:({taskId,worktreeId})=>worktrees.binding({id:worktreeId,taskId}).path,
    assertAuthority:({task,project,row})=>{
      if(closing||!remote.terminalCredentials()||!remote.state().projectIds?.includes(project.id))
        throw new BoardError('受控构建项目授权不可用',409,'BUILD_BINDING_CHANGED');
      const workspace=row.workspace;
      control.assertMayStart(project.id,[workspace]);
      terminal.assertManagedReady(project.id,[workspace]);
      worktrees.assertMayExecute(project.id,[workspace]);
      for(const other of store.projects()){
        if(!store.tasks(other.id).some(item=>item.status==='running'))continue;
        let path;
        try{path=realpathSync(other.directory);}catch{throw new BoardError('运行中项目目录不能核实',409,'BUILD_BUSY');}
        if(pathOverlaps(workspace,path))throw new BoardError('重叠项目仍在执行',409,'BUILD_BUSY');
      }
      if(task.projectId!==project.id)throw new BoardError('任务项目已变化',409,'BUILD_BINDING_CHANGED');
    },assertHistoricalAuthority:({task,project})=>{
      if(closing||!remote.terminalCredentials()||!remote.state().projectIds?.includes(project.id)||
        task.projectId!==project.id)
        throw new BoardError('原预览项目授权不可用',409,'BUILD_BINDING_CHANGED');
    }});
  previewRetest=createPreviewRetest({store,builds:previewBuilds,local:previewLocal,
    resolveWorktree:({taskId,worktreeId})=>worktrees.binding({id:worktreeId,taskId}).path});
  previewLocal.bindRetestComparator(previewRetest.compare);
  onStartup('core-ready');
  let desktopPreviewOrigin=null;
  const previewTransport=desktop?{bind(listener){
    const address=listener?.listening===true&&listener.address?.();
    if(address?.address!=='127.0.0.1'||!Number.isSafeInteger(address.port)||address.port<1||address.port>65535)
      throw new BoardError('本机预览传输地址不可用',503,'PREVIEW_TRANSPORT_UNAVAILABLE');
    const origin=`http://127.0.0.1:${address.port}`;
    if(desktopPreviewOrigin&&desktopPreviewOrigin!==origin)
      throw new BoardError('本机预览传输地址已固定',409,'PREVIEW_TRANSPORT_CHANGED');
    desktopPreviewOrigin=origin;
  }}:null;
  async function request(method,path,input={},role='owner') {
    if(closing)throw new BoardError('任务服务正在关闭',503,'SHUTTING_DOWN');
    const operation=dispatchRequest(method,path,input,role);
    activeRequests.add(operation);
    try{return await operation;}finally{activeRequests.delete(operation);}
  }
  async function dispatchRequest(method,path,input,role) {
    if(typeof path!=='string'||!path.startsWith('/api/'))throw new BoardError('未知接口',404);
    if(!input||typeof input!=='object'||Array.isArray(input))throw new BoardError('请求必须是对象');
    const url=new URL(path,'http://local');path=url.pathname;
    const parts=path.split('/').filter(Boolean).map(decodeURIComponent);
    if(parts[1]==='plugins'&&parts[2]==='local-terminal'&&role!=='owner')
      throw new BoardError('内置终端插件仅允许本机拥有者操作',403,'TERMINAL_FORBIDDEN');
    if(path==='/api/preview/transport'&&method==='GET'&&!url.search){
      if(role!=='owner')throw new BoardError('本机预览地址仅允许拥有者读取',403,'PREVIEW_FORBIDDEN');
      if(!desktop||!desktopPreviewOrigin)
        throw new BoardError('本机预览传输地址不可用',503,'PREVIEW_TRANSPORT_UNAVAILABLE');
      return {kind:'desktop-loopback',origin:desktopPreviewOrigin};
    }
    if(path.startsWith('/api/previews'))return previewLocal.request(method,url.pathname+url.search,input,role);
    if(path.startsWith('/api/ssh/')){
      if(role!=='owner')throw new BoardError('SSH 仅允许本机拥有者访问',403,'SSH_FORBIDDEN');
      return ssh.request(method,path,input,{owner:'local-owner',local:true,validate:()=>!closing});
    }
    if(path.startsWith('/api/terminal/')){
      if(role!=='owner')throw new BoardError('终端配置仅允许本机拥有者操作',403,'TERMINAL_FORBIDDEN');
      return terminal.request(method,path,input);
    }
    if(path.startsWith('/api/preview/')){
      if(role!=='owner')throw new BoardError('预览登记仅允许本机拥有者操作',403,'PREVIEW_FORBIDDEN');
      if(parts[2]==='retest-mappings'&&parts.length===4&&!url.search){
        if(method==='GET')return previewRetest.mapping(parts[3]);
        if(method==='PUT')return previewRetest.put(parts[3],input);
      }
      if(method==='POST'&&path==='/api/preview/controlled-builds')
        return previewBuilds.start(input);
      if(parts[2]==='controlled-builds'&&parts.length===4){
        if(method==='GET')return previewBuilds.state(parts[3]);
      }
      if(method==='POST'&&parts[2]==='controlled-builds'&&parts[4]==='reconcile'&&parts.length===5&&
        Object.keys(input).length===0)return previewBuilds.reconcile(parts[3]);
      if(method==='POST'&&path==='/api/preview/builds'){
        const task=store.getTask(input.taskId),project=store.getProject(input.projectId);
        if(task.projectId!==project.id||task.contentVersion!==input.contentVersion||!project.directory)
          throw new BoardError('预览任务或源码版本已变化',409,'PREVIEW_VERSION');
        if(!remote.terminalCredentials()||!remote.state().projectIds?.includes(project.id))
          throw new BoardError('请先连接并授权此项目的 Hub 节点',409,'PREVIEW_NODE_REQUIRED');
        const apiTarget=input.apiTarget??'static';
        if(!['static','records-v1'].includes(apiTarget))throw new BoardError('未知预览数据目标',400,'PREVIEW_TARGET');
        const manifest=await previewRegistry.register({projectId:project.id,taskId:task.id,contentVersion:task.contentVersion,
          projectDir:project.directory,distDir:input.distDir,environment:input.environment,dataMode:input.dataMode,
          apiTarget,dataStoreId:apiTarget==='records-v1'?randomUUID():null});
        const freshTask=store.getTask(task.id),freshProject=store.getProject(project.id);
        if(freshTask.projectId!==project.id||freshTask.contentVersion!==task.contentVersion||
          freshProject.directory!==project.directory||!remote.state().projectIds?.includes(project.id))
          throw new BoardError('预览登记期间任务或项目已变化',409,'PREVIEW_VERSION');
        if(apiTarget==='records-v1')previewRecords.bind({previewId:manifest.previewId,projectId:manifest.projectId,
          taskId:manifest.taskId,contentVersion:manifest.contentVersion,artifactDigest:manifest.artifactDigest,
          dataStoreId:manifest.dataStoreId});
        previewLocal.record(manifest,task.criteria,project.directory);
        await previewLink.refresh();await previewLink.register(manifest.previewId);
        const {files,...publicManifest}=manifest;
        return {preview:publicManifest};
      }
      throw new BoardError('预览接口不存在',404,'NOT_FOUND');
    }
    if(method==='GET'&&path==='/api/state')return state();
    if(method==='GET'&&path==='/api/inbox')return inbox.sync({executions:leases.state(),policies:(await plugin.state()).policies});
    if(method==='GET'&&path==='/api/plugin')return plugin.state();
    if(method==='GET'&&path==='/api/plugins')return plugins.state();
    if(method==='GET'&&path==='/api/remote')return remote.state();
    if(method==='GET'&&parts[1]==='tasks'&&parts[3]==='conversation'&&parts.length===4){
      if(!['owner','remote-controller'].includes(role))throw new BoardError('无权读取会话',403);
      return conversations.get(parts[2],role==='remote-controller');
    }
    if(method==='GET'&&path==='/api/history')return store.history(Object.fromEntries(url.searchParams));
    if(method==='GET'&&parts[1]==='projects'&&parts[3]==='file-reporting'&&parts.length===4){
      if(role!=='owner')throw new BoardError('请在项目所在电脑上查看接入设置',403,'FILE_REPORTING_FORBIDDEN');
      const project=store.getProject(parts[2]);
      return bridge?bridge.reporting(project.id):{enabled:false,directory:project.directory,
        phase:'disabled',instructionPath:'.taskboard/REPORTING.md',prompt:'',lastReport:null,lastAccepted:null,instructions:null,rule:null,
        problem:'当前服务未启用本地文件接收，请使用启用了文件接收的序程桌面或本机服务。'};
    }
    if(method==='POST'&&parts[1]==='projects'&&parts[3]==='file-reporting'&&parts[4]==='rule'&&parts.length===5){
      if(role!=='owner')throw new BoardError('请在项目所在电脑上修改接入规则',403,'FILE_REPORTING_FORBIDDEN');
      const project=store.getProject(parts[2]);
      if(!bridge)throw new BoardError('当前服务未启用本地文件接收',409,'FILE_REPORTING_DISABLED');
      if(!project.directory||input.expectedDirectory!==project.directory)
        throw new BoardError('项目目录已变更，请刷新后重试',409,'FILE_REPORTING_REBOUND');
      if(!['codex','claude'].includes(input.provider))throw new BoardError('未知的 AI 工具',400,'FILE_REPORTING_PROVIDER');
      return bridge.installReportingRule(project.id,input.provider,input.expectedDirectory);
    }
    if(method==='GET'&&parts[1]==='projects'&&parts[3]==='context')return {markdown:store.context(parts[2])};
    if(role==='viewer')throw new BoardError('当前连接只能查看',403,'READ_ONLY');
    if(method==='POST'&&path==='/api/events/ingest')return store.applyEvent(input,role==='reporter'?'mcp':'api');
    if(role==='reporter'&&!(method==='POST'&&parts[1]==='tasks'&&parts.length===4&&parts[3]==='decisions'))throw new BoardError('AI 接口只允许读取背景、汇报进度、提交证据和明确请求决策',403);
    if(role==='remote-controller'&&!(parts[1]==='tasks'&&['continue','pause','evidence','review','message','start'].includes(parts[3])&&method==='POST'||parts[1]==='tasks'&&parts.length===6&&parts[3]==='inbox'&&parts[5]==='actions'&&method==='POST'||parts[1]==='tasks'&&parts.length===3&&method==='PATCH'||method==='POST'&&path==='/api/conversations'))throw new BoardError('远程连接不允许此操作',403);
    if(method==='GET'&&path==='/api/workflow')return workflow.state();
    if(parts[1]==='worktrees'){
      if(role!=='owner')throw new BoardError('工作树管理仅允许本机拥有者操作',403,'WORKTREE_FORBIDDEN');
      if(method==='GET'&&parts.length===2)return worktrees.list({projectId:url.searchParams.get('projectId')||undefined});
      if(method==='GET'&&parts.length===3&&parts[2]==='base')return worktrees.projectBase(url.searchParams.get('projectId'));
      if(method==='POST'&&parts.length===2)return worktrees.create(input);
      const id=parts[2];
      if(method==='GET'&&parts.length===4&&parts[3]==='save-preview')return worktrees.savePreview(id);
      if(method==='GET'&&parts.length===4&&parts[3]==='save')return worktrees.saveStatus({id,requestId:url.searchParams.get('requestId')});
      if(method==='POST'&&parts.length===4&&parts[3]==='save')return worktrees.save({...input,id});
      if(method==='POST'&&parts.length===5&&parts[3]==='save'&&parts[4]==='reconcile')
        return worktrees.reconcileSave({id,requestId:input.requestId});
      if(method==='GET'&&parts.length===4&&parts[3]==='binding'){
        const detail=await worktrees.inspect(id);
        const task=store.getTask(detail.taskId);
        if(task.projectId!==detail.projectId)throw new BoardError('工作树任务或项目身份已变化',409,'WORKTREE_BINDING_CHANGED');
        const base={worktreeId:id,taskId:task.id,conversationId:task.conversationId||null,verified:false};
        if(detail.phase!=='ready')return {...base,status:'unconfirmed'};
        if(!task.conversationId)return {...base,status:'unbound'};
        const provider=task.executionProvider||'codex-autocontinue';
        let reported;
        try{reported=await plugins.get(provider)?.getSessionBinding({taskId:task.id});}
        catch{return {...base,status:'unconfirmed'};}
        const current=store.getTask(task.id);
        const binding=worktrees.binding({id,taskId:task.id});
        if(current.projectId!==detail.projectId||current.conversationId!==task.conversationId||binding.path!==detail.path)
          return {...base,status:'unconfirmed'};
        if(reported?.status==='unbound'&&reported.verified===false)return {...base,status:'unbound'};
        if(reported?.status!=='bound'||reported.verified!==true||reported.taskId!==task.id||
            reported.conversationId!==task.conversationId||reported.worktreeId!==id||reported.workspace!==detail.path)
          return {...base,status:'unconfirmed'};
        return {...base,status:'bound',verified:true,resumable:reported.resumable===true};
      }
      if(method==='GET'&&parts.length===3)return worktrees.inspect(id);
      if(method==='POST'&&parts.length===4){
        if(parts[3]==='review'){
          const detail=await worktrees.inspect(id);
          if(detail.phase==='ready'){
            if(detail.dirty||detail.targetDirty||detail.head!==input.sourceHead||detail.targetHead!==input.targetHead)
              throw new BoardError('工作树或目标版本已变化，请重新审查',409,'WORKTREE_REVIEW_STALE');
            if(leases.state().active.some(item=>item.taskId===detail.taskId))throw new BoardError('工作树仍有活动执行租约',409,'EXECUTION_BUSY');
          }else if(['merging','conflict'].includes(detail.phase)){
            if(detail.head!==input.sourceHead||detail.mergeSourceHead!==input.sourceHead||
                detail.mergeTargetHead!==input.targetHead||detail.targetHead!==input.targetHead||
                !detail.indexTree||detail.indexTree!==input.expectedIndexTree||detail.stagedPatchTruncated||
                detail.conflictFiles.length||detail.targetStatus?.includes('??'))
              throw new BoardError('请先解决冲突、检查暂存差异并刷新索引版本',409,'WORKTREE_REVIEW_STALE');
          }else throw new BoardError('工作树不在可审查状态',409,'WORKTREE_PHASE');
          return worktrees.recordReview({id,reviewId:input.reviewId||randomUUID(),sourceHead:input.sourceHead,
            targetHead:input.targetHead,actor:'owner',indexTree:detail.phase==='ready'?null:input.expectedIndexTree});
        }
        if(parts[3]==='merge'){
          const detail=await worktrees.inspect(id);
          if(leases.state().active.some(item=>item.projectId===detail.projectId)||
             workflow.state().plans.some(p=>p.projectId===detail.projectId&&p.members.some(m=>['sending','running','pausing','unknown'].includes(m.status))))
            throw new BoardError('项目仍有执行者，不能合入',409,'EXECUTION_BUSY');
          return worktrees.prepareMerge({id,expectedTargetHead:input.expectedTargetHead,reviewId:input.reviewId});
        }
        if(parts[3]==='finalize'){
          const detail=await worktrees.inspect(id);
          if(input.confirmReviewed!==true||detail.indexTree!==input.expectedIndexTree||detail.stagedPatchTruncated||
              !['merging','conflict'].includes(detail.phase))
            throw new BoardError('请核对当前暂存差异与索引版本，再明确确认合入',409,'WORKTREE_INDEX_REVIEW_REQUIRED');
          return worktrees.finalizeMerge({id,expectedIndexTree:input.expectedIndexTree});
        }
        if(parts[3]==='cleanup'){
          const detail=await worktrees.inspect(id);
          if(leases.state().active.some(item=>item.taskId===detail.taskId))throw new BoardError('工作树仍有活动执行租约',409,'EXECUTION_BUSY');
          return worktrees.cleanup(id);
        }
      }
      throw new BoardError('工作树接口不存在',404,'NOT_FOUND');
    }
    if(method==='GET'&&path==='/api/executions')return leases.state();
    if(method==='POST'&&path==='/api/workflow/plans')return workflow.createPlan(input);
    if(method==='POST'&&parts[1]==='workflow'&&parts[2]==='plans'&&parts.length===5){const action=parts[4];if(!['start','pause','reconcile'].includes(action))throw new BoardError('未知协作操作',404);return workflow[action](parts[3],input);}
    if(method==='POST'&&path==='/api/remote/connect'){
      if(!Array.isArray(input.projectIds)||!input.projectIds.length)throw new BoardError('请选择要同步的项目');
      for(const projectId of input.projectIds)store.getProject(projectId);
      await remote.configure(input);void previewLink.refresh().catch(()=>{});return remote.state();
    }
    if(method==='POST'&&path==='/api/remote/login'){
      if(role!=='owner')throw new BoardError('只有本地拥有者可以登录',403);
      if(!Array.isArray(input.projectIds)||!input.projectIds.length)throw new BoardError('请选择要同步的项目');
      for(const projectId of input.projectIds)store.getProject(projectId);
      await remote.login(input);void previewLink.refresh().catch(()=>{});return remote.state();
    }
    if(method==='POST'&&path==='/api/remote/disconnect'){await remote.disconnect();await previewLink.refresh();return remote.state();}
    if(method==='GET'&&path==='/api/backup')return store.exportArchive();
    if(method==='POST'&&['/api/backup/restore','/api/maintenance/replay'].includes(path)){
      const endMetadataReplacement=terminal.beginMetadataReplacement();
      try {
      if(input.confirm!==true)throw new BoardError('请明确确认恢复或回放操作');
      if(remote.state().status!=='disconnected')throw new BoardError('请先断开远程同步再恢复或回放',409);
      if(workflow.state().plans.some(p=>['active','pause_pending'].includes(p.status)||p.members.some(m=>['running','sending','unknown','pausing'].includes(m.status))))throw new BoardError('请先暂停协作计划并核对未知执行结果',409);
      if(leases.state().active.length)throw new BoardError('请先核对尚未结束的执行租约',409);
      if(terminal.hasConnections())throw new BoardError('请先关闭终端连接再恢复数据',409);
      const active=(await plugin.state()).policies?.some(p=>['running','sending','unknown'].includes(p.status));
      if(active||store.tasks().some(t=>t.status==='running'))throw new BoardError('请先停止运行中的任务并核对未知执行结果',409);
      if((await plugins.state()).some(p=>p.id!=='local-terminal'&&p.enabled))throw new BoardError('请先关闭自动执行插件再恢复或回放',409);
      try{await bridge?.pause();return path.endsWith('restore')?store.restoreArchive(input.archive):store.replay();}finally{bridge?.resume();}
      } finally { endMetadataReplacement(); }
    }
    if(parts[1]==='plugins'&&parts.length===4){
      const extension=plugins.get(parts[2]);if(!extension)throw new BoardError('插件不可用',404);
      const action=parts[3],operation={enable:'enable',disable:'disable',check:'check',config:'configure'}[action];
      if(!operation||method!==(action==='config'?'PATCH':'POST'))throw new BoardError('未知插件操作',404);
      const result=await extension[operation](input);changed();return result??extension.state();
    }
    if(method==='POST'&&path==='/api/projects')return store.project(input);
    if(method==='POST'&&path==='/api/projects/import')return store.importProject(input.path);
    if(method==='PATCH'&&parts[1]==='projects'&&parts.length===3)return store.bindDirectory(parts[2],input);
    if(method==='POST'&&path==='/api/tasks')return store.createTask(input);
    if(method==='POST'&&path==='/api/conversations')return conversations.create(input,role==='remote-controller');
    if(parts[1]==='tasks'&&parts[2]){
      const taskId=parts[2];
      const execution=()=>{const provider=store.getTask(taskId).executionProvider||'codex-autocontinue';const extension=plugins.get(provider);if(!extension)throw new BoardError('执行工具插件不可用',409);return extension;};
      if(method==='PATCH'&&parts.length===3)return store.updateTask(taskId,input,input.expectedRevision);
      if(method==='POST'&&parts.length===4&&parts[3]==='decisions')return inbox.requestDecision(taskId,input,role==='reporter'?'mcp':'api');
      if(method==='POST'&&parts.length===6&&parts[3]==='inbox'&&parts[5]==='actions'){
        const item=inbox.state().items.find(value=>value.id===parts[4]);
        if(!item||item.taskId!==taskId)throw new BoardError('收件箱项目不属于该任务',404,'INBOX_NOT_FOUND');
        if(role==='remote-controller'&&!item.shareWithRemote)throw new BoardError('此项目仅可在本地处理',403,'INBOX_PRIVATE');
        const {remoteActor,...actionInput}=input;
        return inbox.act(parts[4],actionInput,role==='remote-controller'?{role,id:remoteActor}:role);
      }
      if(method==='POST'&&parts[3]==='evidence')return store.addEvidence(taskId,input);
      if(method==='POST'&&parts.length===4&&parts[3]==='verify'){
        if(role!=='owner')throw new BoardError('只有本地拥有者可以记录测试验证',403,'VERIFICATION_FORBIDDEN');
        return store.verify(taskId,input);
      }
      if(method==='POST'&&parts.length===5&&parts[3]==='verification-checks'){
        if(role!=='owner')throw new BoardError('只有本地拥有者可以修改验证待办',403,'VERIFICATION_FORBIDDEN');
        return store.setVerificationCheck(taskId,parts[4],input);
      }
      if(method==='POST'&&parts[3]==='review')return store.review(taskId,input,role==='remote-controller'?input.remoteActor:null);
      if(method==='POST'&&parts[3]==='issues'&&parts[5]==='resolve')return store.resolveIssue(taskId,parts[4],input.expectedRevision);
      if(method==='POST'&&parts[3]==='continue'){
        const task=store.getTask(taskId),directory=store.getProject(task.projectId).directory;
        if(workflow.state().plans.some(p=>p.members.some(m=>['running','sending','unknown','pausing'].includes(m.status)&&(m.taskId===taskId||pathOverlaps(m.workspace,directory)))))throw new BoardError('协作计划正在使用该任务或目录，请在计划中操作',409);
        return execution().resume({taskId,expectedRevision:input.expectedRevision,commandId:input.commandId});
      }
      if(method==='POST'&&parts.length===4&&parts[3]==='start')return conversations.startTask(taskId,input,role==='remote-controller');
      if(method==='POST'&&parts.length===4&&parts[3]==='message')return conversations.message(taskId,input,role==='remote-controller');
      if(method==='POST'&&parts[3]==='session'){
        if(input.worktreeId!==undefined){
          if(role!=='owner')throw new BoardError('只有本机拥有者可以创建工作树会话',403,'WORKTREE_FORBIDDEN');
          const detail=await worktrees.inspect(input.worktreeId);
          if(detail.taskId!==taskId||detail.phase!=='ready')throw new BoardError('工作树未绑定该任务',409,'WORKTREE_BINDING_CHANGED');
        }
        return execution().createSession({taskId,expectedRevision:input.expectedRevision,commandId:input.commandId,
          workspaceWrite:input.workspaceWrite===true,...(input.worktreeId?{worktreeId:input.worktreeId}: {})});
      }
      if(method==='POST'&&parts[3]==='pause')return execution().pause({taskId,expectedRevision:input.expectedRevision});
    }
    if(method==='PATCH'&&path==='/api/settings')return store.setSettings(input);
    if(method==='PATCH'&&path==='/api/plugin/config'){const r=await plugin.configure(input);changed();return r??plugin.state();}
    if(method==='POST'&&path==='/api/plugin/enable'){const r=await plugin.enable();changed();return r??plugin.state();}
    if(method==='POST'&&path==='/api/plugin/disable'){const r=await plugin.disable();changed();return r??plugin.state();}
    if(method==='POST'&&path==='/api/plugin/check'){const r=await plugin.check();changed();return r??plugin.state();}
    if(method==='POST'&&path==='/api/plugin/policy'){const r=await plugin.setPolicy(input);changed();return r??plugin.state();}
    if(method==='POST'&&path==='/api/plugin/reconcile'){const r=await plugin.reconcile(input);await leases.reconcile();changed();return r??plugin.state();}
    throw new BoardError('接口不存在',404,'NOT_FOUND');
  }
  let closePromise;
  const reportShutdown=(stage,status)=>{try{
    const result=onShutdown({stage,status});
    if(result&&typeof result.then==='function')void Promise.resolve(result).catch(()=>{});
  }catch{/* Diagnostics cannot change shutdown behavior. */}};
  const observeShutdown=(stage,work)=>{
    reportShutdown(stage,'started');
    try{return Promise.resolve(work()).then(value=>{reportShutdown(stage,'fulfilled');return value;},error=>{reportShutdown(stage,'rejected');throw error;});}
    catch(error){reportShutdown(stage,'rejected');return Promise.reject(error);}
  };
  return {store,plugin,remote,workflow,worktrees,leases,inbox,terminal,ssh,previewRegistry,previewLocal,previewTransport,events,state,request,close:()=>closePromise??=(async()=>{closing=true;unlock.markUnsafe();clearInterval(workflowTimer);const drain=workflow.close();bridge?.close();let safe=false;try{
    const failures=[];
    const settle=async(stage,work)=>{try{await observeShutdown(stage,work);}catch(error){failures.push(error);}};
    await settle('ssh',()=>ssh.close());
    await settle('terminal_seal',()=>terminal.sealForShutdown());
    await settle('controlled_preview_builds',()=>previewBuilds?.close());
    await settle('plugins',()=>plugins.close());
    await settle('terminal',()=>terminal.close());
    const results=await Promise.allSettled([
      observeShutdown('preview',()=>previewLink?.close()),
      observeShutdown('conversations',()=>conversations?.close()),
      observeShutdown('remote',()=>remote?.close()),
      observeShutdown('workflow',()=>drain),
      observeShutdown('file_bridge',()=>bridge?.pause()),
      observeShutdown('tick',()=>tickPromise),
      observeShutdown('active_requests',()=>Promise.allSettled([...activeRequests])),
    ]);
    failures.push(...results.filter(r=>r.status==='rejected').map(r=>r.reason));
    if(failures.length)throw new AggregateError(failures,'部分执行器未能确认进程已停止');safe=true;
  }finally{store.off('change',changed);previewRecords?.close();store.close();if(safe)unlock();}})()};
  } catch(error) {closing=true;clearInterval(workflowTimer);bridge?.close();let safe=false;try{
    const failures=[];
    for(const [name,work] of [['ssh',()=>ssh?.close()],['terminal_seal',()=>terminal?.sealForShutdown()],['controlled_preview_builds',()=>previewBuilds?.close()],['plugins',()=>plugins?.close()],['terminal',()=>terminal?.close()]])
      try{await work();}catch(failure){failures.push(new Error(`${name}: ${failure.message}`,{cause:failure}));}
    const results=await Promise.allSettled([previewLink?.close(),conversations?.close(),workflow?.close(),remote?.close(),bridge?.pause(),tickPromise,Promise.allSettled([...activeRequests])]);
    failures.push(...results.filter(r=>r.status==='rejected').map(r=>r.reason));
    if(failures.length)throw new AggregateError(failures,'初始化失败后未能确认进程已停止');safe=true;
  }catch(shutdownError){unlock.markUnsafe();throw shutdownError;}finally{previewRecords?.close();store?.close();if(safe)unlock();}throw error;}
}
