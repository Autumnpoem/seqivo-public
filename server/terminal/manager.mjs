import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readlinkSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {BoardError} from '../store.mjs';
import {nativeProcessTable} from '../codex-process-proof.mjs';
import {createTerminalRuntime,validateTerminalCwd} from './runtime.mjs';
import {createTmuxAdapter} from './tmux.mjs';
import {createWslSupport} from './wsl.mjs';
import {canonicalPsStart,inspectSessionWriters,inspectWorkspaceWriters} from './process-inspection.mjs';
import {createManagedPaneRegistry} from './managed-pane-registry.mjs';
import {inspectLinuxManagedWriters} from './linux-managed-writers.mjs';

const KEY='terminal.manager.v1';
const scopes=new Set(['view','input','create','default','takeover']);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const fail=(message,code='TERMINAL_INVALID',status=400)=>{throw new BoardError(message,status,code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const equalRef=(a,b)=>Boolean(a&&b&&a.serverName===b.serverName&&a.instanceId===b.instanceId&&a.sessionId===b.sessionId);
const validSessionRef=value=>value&&typeof value==='object'&&typeof value.serverName==='string'&&/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(value.serverName)&&
  typeof value.instanceId==='string'&&/^[a-f0-9]{64}$/.test(value.instanceId)&&typeof value.sessionId==='string'&&/^\$(0|[1-9]\d*)$/.test(value.sessionId);
const safeSize=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
const sameNative=(a,b)=>Boolean(a&&b&&a.pid===b.pid&&a.ppid===b.ppid&&
  a.euid===b.euid&&a.ruid===b.ruid&&a.startSec===b.startSec&&a.startUsec===b.startUsec);
// Group and UID can change after capture; neither change retires an original birth.
const sameBirth=(a,b)=>Boolean(a&&b&&a.pid===b.pid&&
  a.startSec===b.startSec&&a.startUsec===b.startUsec);
export const originalTerminalAttachmentPresent=(table,identity)=>
  sameBirth(table.get(identity.pid),identity);
const validBirth=row=>row&&Number.isSafeInteger(row.pid)&&row.pid>1&&
  Number.isSafeInteger(row.pgid)&&row.pgid>1&&Number.isSafeInteger(row.euid)&&row.euid>=0&&
  Number.isSafeInteger(row.ruid)&&row.ruid>=0&&Number.isSafeInteger(row.startSec)&&row.startSec>0&&
  Number.isSafeInteger(row.startUsec)&&row.startUsec>=0&&row.startUsec<1_000_000;
const wslTarget=p=>p.runtime==='wsl'?JSON.stringify([p.wsl.distro,p.wsl.user,p.wsl.uid]):null;
const defaultSuffix=p=>p.runtime==='wsl'?`:wsl:${hash(wslTarget(p))}`:'';
const profileBinding=p=>hash(JSON.stringify([p.id,p.projectId,p.cwd,p.serverName,p.tmuxExecutable||null,p.shell,
  ...(p.runtime==='wsl'?[p.wsl]:[])]));
function stableDescendant(pid,root,before,after){
  const seen=new Set();let current=pid;
  while(current&&!seen.has(current)){
    seen.add(current);
    const first=before.get(current),second=after.get(current);
    if(!sameNative(first,second))return false;
    if(current===root)return true;
    current=first.ppid;
  }
  return false;
}

/** Paired complete observations; only relevant roots and observed writer chains
 * must remain identical. Unrelated current-UID process churn is immaterial to
 * the human-input writer check, unlike executor retirement proof. */
export function verifyManagedObservedWriters({proofs,nativeBefore,nativeAfter,result}){
  const roots=[];
  for(const proof of proofs){
    if(!sameNative(nativeBefore.get(proof.identities.shell.pid),nativeAfter.get(proof.identities.shell.pid))||
      !sameNative(nativeBefore.get(proof.identities.supervisor.pid),nativeAfter.get(proof.identities.supervisor.pid)))
      fail('受管会话原进程身份已变化','PROCESS_PROOF_UNAVAILABLE',409);
    roots.push(proof.identities.shell.pid);
  }
  result.unownedWriters=result.unownedWriters.filter(writer=>
    !roots.some(rootPid=>stableDescendant(writer.pid,rootPid,nativeBefore,nativeAfter)));
  result.authorized=result.unownedWriters.length===0;
  result.scope+='-and-recorded-supervisor-shell-descendants';
  return result;
}

/** Core-owned authority. Only the local HTTP or authenticated node link may create contexts. */
export function createTerminalManager({store,control,emit=()=>{},executionState=()=>({active:[]}),now=Date.now,
  managedRecordRoot=null,managedPythonPath=null,pluginLifecycle=null,wslSupport=createWslSupport()}={}){
  const saved=store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY);
  let state=saved?JSON.parse(saved.value):{version:1,profiles:[],grants:[],defaults:{},defaultRevisions:{}};
  if(state.version!==1||!Array.isArray(state.profiles)||!Array.isArray(state.grants)||!state.defaults)fail('终端配置需要恢复','TERMINAL_STATE',500);
  if(!state.defaultRevisions||typeof state.defaultRevisions!=='object'||Array.isArray(state.defaultRevisions))state.defaultRevisions={};
  const connections=new Map(),tickets=new Map(),claims=new Map(),pendingTransfers=new Map();let closing=false,origin=null,link=null,serial=Promise.resolve(),queued=0,metadataReplacing=false,shutdownSealed=false,sealPromise=null;
  const managed=managedRecordRoot&&['darwin','linux'].includes(process.platform)
    ?createManagedPaneRegistry({store,recordRoot:managedRecordRoot,pythonPath:managedPythonPath}):null;
  const recoveryPython=managedPythonPath||process.env.TASKBOARD_PYTHON||
    resolve(dirname(process.execPath),'../../python/bin/python3');
  const enqueue=work=>{if(queued>=256)return Promise.reject(new BoardError('终端忙，请稍后重试',429,'RATE_LIMIT'));queued++;const pending=serial.then(work);serial=pending.catch(()=>{}).finally(()=>{queued--;});return pending;};
  const persist=()=>{store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(KEY,JSON.stringify(state));emit();};
  if(!state.namespace){state.namespace=randomBytes(16).toString('hex');persist();}
  const profileFor=profileId=>{const p=state.profiles.find(p=>p.id===profileId&&p.enabled);if(!p)fail('终端配置未启用','PROFILE_NOT_FOUND',404);return p;};
  const adapter=p=>p.runtime==='wsl'?wslSupport.adapter(p):createTmuxAdapter({executable:p.tmuxExecutable,serverName:p.serverName||'default'});
  const defaultKey=(ctx,p)=>`${ctx.local?(link?.state().nodeId||'local'):ctx.nodeId}:${ctx.local?(link?.state().ownerUserId||'local'):ctx.userId}:${p.id}${defaultSuffix(p)}`;
  function check(ctx,p,scope='view'){
    pluginLifecycle?.assertEnabled();
    if(closing)fail('终端正在关闭','SHUTTING_DOWN',503);
    if(ctx.isCurrent&&!ctx.isCurrent())fail('连接已中断，输入未发送','CONNECTION_CHANGED',409);
    if(!p.enabled)fail('终端已关闭','PROFILE_DISABLED',403);
    if(ctx.local===true)return;
    const g=state.grants.find(g=>g.nodeId===ctx.nodeId&&g.deviceId===ctx.deviceId&&g.profileId===p.id&&g.userId===ctx.userId&&!g.revoked);
    if(!g||g.revision!==ctx.grantRevision||!g.scopes.includes(scope))fail('此设备没有终端权限','GRANT_REQUIRED',403);
  }
  function assertWorkspaceFree(p){
    // Independent WSL terminals use Linux paths, not a host workspace claim.
    if(p.runtime==='wsl')return;
    if(!p.projectId&&store.projects().some(project=>project.directory&&overlaps(project.directory,p.cwd)))fail('终端目录与受管项目重叠，请先关联该项目','CONTROL_BINDING_REQUIRED',409);
    const projects=store.projects().filter(project=>project.id===p.projectId||project.directory&&overlaps(project.directory,p.cwd));
    // Until verified takeover is implemented, managed AI executions fence terminal writes.
    if(executionState().active.some(x=>projects.some(project=>project.id===x.projectId)))fail('AI 仍在使用此项目，请先停止并核对执行结果','EXECUTION_BUSY',409);
    if(projects.some(project=>store.tasks(project.id).some(t=>t.status==='running')))fail('项目仍有运行中的任务','EXECUTION_BUSY',409);
  }
  function overlaps(a,b){const within=(x,y)=>{const r=relative(x,y);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith(`..${sep}`);};return within(a,b)||within(b,a);}
  const actor=ctx=>ctx.local?'local-owner':`${ctx.userId}:${ctx.deviceId}`;
  const claimKey=(ctx,p)=>`${actor(ctx)}:${p.projectId}`;
  const canWrite=(ctx,p)=>{try{check(ctx,p,'input');return true;}catch{return false;}};
  const claimFor=(ctx,p)=>{const claim=claims.get(claimKey(ctx,p));return claim?.connectionId===ctx.connectionId?claim:null;};
  const transferAccount=source=>{
    const node=link?.state();
    if(!id(node?.nodeId)||!id(node?.ownerUserId)||
      source.ctx.local!==true&&source.ctx.nodeId!==node.nodeId)return null;
    return source.ctx.local===true?node.ownerUserId:source.ctx.userId;
  };
  function transferTarget(source,target,p){
    const account=transferAccount(source),node=link?.state();
    if(!account||!target||target===source||target.profileId!==p.id||target.requestedMode!=='tmux'||
      target.readOnly||target.runtime||target.ready||
      typeof target.send!=='function'||target.ctx.isCurrent&&!target.ctx.isCurrent())return false;
    if(target.ctx.local!==true&&(target.ctx.nodeId!==node.nodeId||target.ctx.userId!==account))return false;
    if(target.ctx.local===true&&account!==node.ownerUserId)return false;
    try{check(target.ctx,p,'input');check(target.ctx,p,'takeover');return true;}catch{return false;}
  }
  function endTransfer(transfer,reason){
    if(!transfer||pendingTransfers.get(transfer.id)!==transfer)return;
    pendingTransfers.delete(transfer.id);clearTimeout(transfer.timer);
    control.failTransfer({projectId:transfer.projectId,transferId:transfer.id,reason});
    for(const connectionId of [transfer.sourceId,transfer.targetId]){
      const client=connections.get(connectionId),profile=state.profiles.find(item=>item.id===transfer.profileId);
      if(client?.send&&profile){controlFrame(client,profile);client.send({type:'transferEnded',v:1,transferId:transfer.id,status:'unknown',reason});}
    }
  }
  function endTransfersFor(connectionId,reason){
    for(const transfer of [...pendingTransfers.values()])if([transfer.sourceId,transfer.targetId].includes(connectionId))endTransfer(transfer,reason);
  }
  async function reclaimRemote(c,p,selectedRef=null){
    const ctx=c.ctx;
    if(ctx.local===true||!p.projectId||c.readOnly)return;
    const key=claimKey(ctx,p),claim=claims.get(key);
    if(!claim||claim.connectionId===c.id||connections.has(claim.connectionId)||
      claim.nodeId!==ctx.nodeId||claim.deviceId!==ctx.deviceId||claim.userId!==ctx.userId||
      claim.profileId!==p.id||claim.grantRevision!==ctx.grantRevision)return;
    const entry=control?.state().find(item=>item.projectId===p.projectId);
    if(entry?.phase!=='human'||entry.actorId!==actor(ctx)||entry.generation!==claim.generation)return;
    check(ctx,p,'takeover');check(ctx,p,'input');
    let recovered;
    if(entry.mode==='existing'){
      if(!entry.authorizedSessionRefs?.length)return;
      await control.verifyExistingSession({projectId:p.projectId,token:claim.token,sessionRef:entry.authorizedSessionRefs[0]});
    }else if(entry.mode==='managed'&&claim.mode==='shell'){
      recovered=await control.reclaimManaged({projectId:p.projectId,actorId:actor(ctx),token:claim.token});
    }else if(entry.mode==='managed'&&claim.mode==='tmux'&&selectedRef){
      const snapshot=await adapter(p).list();
      if(!snapshot.available||!snapshot.sessions.some(item=>equalRef(item.sessionRef,selectedRef)))return;
      const liveSessionRefs=entry.authorizedSessionRefs.filter(ref=>snapshot.sessions.some(item=>equalRef(item.sessionRef,ref)));
      recovered=await control.reclaimManagedSelection({projectId:p.projectId,actorId:actor(ctx),token:claim.token,
        profileId:p.id,sessionRef:selectedRef,liveSessionRefs});
    }else return;
    check(ctx,profileFor(p.id),'takeover');check(ctx,p,'input');
    const current=control.state().find(item=>item.projectId===p.projectId);
    if(recovered&&recovered.phase!=='human')return;
    if(connections.has(claim.connectionId)||claims.get(key)!==claim||current?.phase!=='human'||
      current.generation!==(recovered?.generation??claim.generation))
      fail('原连接或控制代次已变化','CONTROL_STALE',409);
    if(recovered){claims.set(key,{...claim,token:recovered.token,generation:recovered.generation,
      connectionId:c.id,recoveredManaged:claim.mode==='tmux',sessionRef:selectedRef||claim.sessionRef});}
    else claim.connectionId=c.id;
  }
  function validClaim(ctx,p){
    if(!p.projectId)return true;
    const key=claimKey(ctx,p),claim=claims.get(key),entry=control?.state().find(item=>item.projectId===p.projectId);
    if(!claim||!entry||entry.generation!==claim.generation||entry.actorId!==actor(ctx)||
      ctx.local!==true&&(claim.nodeId!==ctx.nodeId||claim.deviceId!==ctx.deviceId||claim.userId!==ctx.userId||
        claim.profileId!==p.id||claim.grantRevision!==ctx.grantRevision)){if(claim?.connectionId===ctx.connectionId)claims.delete(key);return false;}
    // A local owner may reconnect after the prior PTY client was fully retired.
    // Remote devices retain their exact connection binding across disconnects.
    if(claim.connectionId!==ctx.connectionId){
      if(ctx.local===true&&!connections.has(claim.connectionId))claim.connectionId=ctx.connectionId;
      else return false;
    }
    if(entry.phase==='unknown'||entry.phase==='return_review')return true;
    if(entry.phase!=='human')return false;
    try{control.assertHuman({projectId:p.projectId,token:claim.token});return true;}
    catch{claims.delete(key);return false;}
  }
  function human(c,p){
    if(!p.projectId){assertWorkspaceFree(p);return;}
    if(managed?.hasUnresolved(p.projectId))fail('受管会话仍有未核实的进程，输入已冻结','MANAGED_PANE_UNKNOWN',409);
    if(!validClaim(c.ctx,p)||control.state().find(item=>item.projectId===p.projectId)?.phase!=='human')fail('请先接管项目，核实 AI 已停止后再操作终端','CONTROL_REQUIRED',409);
  }
  function assertManagedReady(projectId,additionalWorkspaces=[]){
    if(!Array.isArray(additionalWorkspaces)||additionalWorkspaces.some(path=>typeof path!=='string'||!isAbsolute(path)))
      fail('执行目录无法核验','MANAGED_PANE_UNKNOWN',409);
    const extraRoots=additionalWorkspaces.map(path=>realpathSync(path));
    if(['disabling','disabled_unknown'].includes(pluginLifecycle?.status())){
      let affected=false;
      try{
        const project=store.getProject(projectId),root=realpathSync(project.directory);
        affected=state.profiles.some(p=>{
          if(!p.enabled||p.runtime==='wsl')return false;
          if(p.projectId===projectId)return true;
          return [root,...extraRoots].some(directory=>overlaps(directory,realpathSync(p.cwd)));
        });
      }catch{affected=true;}
      if(affected)fail('终端停用结果未核实，执行已冻结','TERMINAL_PLUGIN_UNKNOWN',409);
    }
    // Backup/replay may await plugin checks after observing no active lease.
    // The same gate must fence all new permits, including platforms without
    // a managed-pane record root, until metadata replacement is finished.
    if(metadataReplacing)fail('数据恢复期间不能启动执行','MANAGED_PANE_UNKNOWN',409);
    if(!managed)return;
    if(managed.hasUnknownInventory())fail('受管会话私有记录与索引不一致，执行已冻结','MANAGED_PANE_UNKNOWN',409);
    const workspace=store.getProject(projectId).directory;
    for(const unresolved of managed.unresolvedProjects()){
      let other;
      try{other=store.getProject(unresolved).directory;}catch{fail('受管会话的项目身份未核实','MANAGED_PANE_UNKNOWN',409);}
      if(!workspace||!other||[workspace,...extraRoots].some(directory=>overlaps(directory,other)))fail('受管会话仍有未核实的进程，AI 暂不能启动','MANAGED_PANE_UNKNOWN',409);
    }
    for(const unparked of managed.unparkedProjects()){
      let other;
      try{other=store.getProject(unparked).directory;}catch{fail('受管会话项目身份未核实','MANAGED_PANE_UNKNOWN',409);}
      if(!workspace||!other||[workspace,...extraRoots].some(directory=>overlaps(directory,other)))fail('原受管 Shell 尚未停妥，AI 暂不能启动','MANAGED_PANE_UNKNOWN',409);
    }
  }
  async function parkManagedProject({projectId,token,generation,profileId,sessionRefs}){
    const entry=control.assertReturn({projectId,token,generation});
    if(entry.mode!=='managed'||entry.profileId!==profileId||entry.sessionRefs.length!==sessionRefs.length||
      entry.sessionRefs.some(ref=>!sessionRefs.some(other=>equalRef(ref,other)))||!managed)
      fail('原受管会话授权无法核实','MANAGED_PANE_UNKNOWN',409);
    const p=profileFor(profileId),items=managed.projectItems(projectId);
    if(p.projectId!==projectId||items.length!==sessionRefs.length||items.some(item=>
      item.profileId!==profileId||!sessionRefs.some(ref=>equalRef(item.sessionRef,ref))))
      fail('原受管会话记录无法核实','MANAGED_PANE_UNKNOWN',409);
    for(const item of items){
      control.assertReturn({projectId,token,generation});
      await managed.parkForReturn(item,p);
      control.assertReturn({projectId,token,generation});
    }
  }
  async function inspectParkedWriters({projectId,workspace,profileId,sessionRefs,token,generation}){
    const entry=control.assertReturn({projectId,token,generation});
    if(entry.mode!=='managed'||entry.profileId!==profileId||entry.sessionRefs.length!==sessionRefs.length||
      entry.sessionRefs.some(ref=>!sessionRefs.some(other=>equalRef(ref,other)))||!managed)
      fail('原受管会话授权无法核实','MANAGED_PANE_UNKNOWN',409);
    const p=profileFor(profileId);
    if(p.projectId!==projectId||entry.workspace!==workspace)fail('受管项目目录已变更','MANAGED_PANE_UNKNOWN',409);
    const result=await managed.inspectParked({projectId,workspace,profile:p,sessionRefs});
    control.assertReturn({projectId,token,generation});
    return result;
  }
  async function inspectReturnDirectories({projectId,workspace,profileId,sessionRefs,previousEvidence,token,generation}){
    const entry=control.assertReturn({projectId,token,generation});
    if(entry.mode==='existing'){
      const profile=profileFor(profileId);
      if(profile.projectId!==projectId||profile.cwd!==workspace||entry.profileId!==profileId||
        !Array.isArray(sessionRefs)||!sessionRefs.length||sessionRefs.length>16||
        !Array.isArray(previousEvidence)||previousEvidence.length!==sessionRefs.length)
        fail('已有会话原进程身份未能核实','PROCESS_PROOF_UNAVAILABLE',409);
      const panes=[];
      for(const ref of sessionRefs){
        const prior=previousEvidence.find(item=>equalRef(item.sessionRef,ref));
        if(!prior||!Array.isArray(prior.panes)||!prior.panes.length||prior.panes.length>64)
          fail('已有会话原进程身份未能核实','PROCESS_PROOF_UNAVAILABLE',409);
        for(const pane of prior.panes)if(!Number.isSafeInteger(pane.pid)||pane.pid<1||
          !canonicalPsStart(pane.startedAt)||!/^%\d+$/.test(pane.paneId))
          fail('已有会话原进程身份未能核实','PROCESS_PROOF_UNAVAILABLE',409);
        panes.push(...prior.panes);
      }
      const tmux=adapter(profile),first=await tmux.list();
      if(!first.available||sessionRefs.some(ref=>first.sessions.some(item=>equalRef(item.sessionRef,ref))))
        fail('原已有会话仍在运行，不能把当前目录标为已核实','PROCESS_PROOF_UNAVAILABLE',409);
      const pids=[...new Set(panes.map(pane=>pane.pid))];
      const observed=await new Promise(resolve=>execFile('/bin/ps',['-p',pids.join(','),'-o','pid=,lstart='],
        {timeout:5000,maxBuffer:32_768,env:{...process.env,LC_ALL:'C',LANG:'C'}},
        (error,stdout,stderr)=>resolve({error,stdout,stderr})));
      if(observed.stderr?.trim()||observed.error&&observed.error.code!==1)
        fail('原已有会话进程身份未能核实','PROCESS_PROOF_UNAVAILABLE',409);
      const rows=new Map();
      for(const line of String(observed.stdout||'').split('\n')){
        if(!line.trim())continue;
        const match=/^\s*(\d+)\s+(.+?)\s*$/.exec(line),pid=Number(match?.[1]),started=canonicalPsStart(match?.[2]);
        if(!match||!pids.includes(pid)||rows.has(pid)||!started)
          fail('原已有会话进程身份未能核实','PROCESS_PROOF_UNAVAILABLE',409);
        rows.set(pid,started);
      }
      if(panes.some(pane=>rows.get(pane.pid)===canonicalPsStart(pane.startedAt)))
        fail('原已有会话进程仍在运行','PROCESS_PROOF_UNAVAILABLE',409);
      const second=await tmux.list();
      control.assertReturn({projectId,token,generation});
      if(!second.available||sessionRefs.some(ref=>second.sessions.some(item=>equalRef(item.sessionRef,ref))))
        fail('原已有会话状态已变化','PROCESS_PROOF_UNAVAILABLE',409);
      return {verified:true,allOriginalSessionsRetired:true,directories:[]};
    }
    if(entry.mode!=='managed'||!managed||entry.profileId!==profileId||entry.workspace!==workspace||
      !Array.isArray(sessionRefs)||sessionRefs.length>16||
      entry.sessionRefs.length!==sessionRefs.length||entry.sessionRefs.some(ref=>!sessionRefs.some(other=>equalRef(ref,other))))
      fail('会话实际当前目录未能核实','PROCESS_PROOF_UNAVAILABLE',409);
    const profile=profileFor(profileId),items=managed.projectItems(projectId),root=realpathSync(workspace);
    if(profile.projectId!==projectId||items.length!==sessionRefs.length)
      fail('会话实际当前目录未能核实','PROCESS_PROOF_UNAVAILABLE',409);
    if(!items.length){
      if(managed.hasUnresolved(projectId))fail('受管会话身份未核实','PROCESS_PROOF_UNAVAILABLE',409);
      return {verified:true,directories:[]};
    }
    const directories=[];
    for(const item of items){
      control.assertReturn({projectId,token,generation});
      if(item.profileId!==profileId||!sessionRefs.some(ref=>equalRef(ref,item.sessionRef)))
        fail('会话实际当前目录未能核实','PROCESS_PROOF_UNAVAILABLE',409);
      const first=await managed.inspect(item,profile),identity=first.proof?.identities?.shell;
      if(first.status?.state!=='stopped'||first.status?.inputFrozen!==true||
        !Number.isSafeInteger(identity?.pid)||identity.pid<1)
        fail('会话实际当前目录未能核实','PROCESS_PROOF_UNAVAILABLE',409);
      let actual;
      if(process.platform==='linux'){
        try{actual=realpathSync(readlinkSync(`/proc/${identity.pid}/cwd`));}
        catch{fail('会话实际当前目录未能核实','PROCESS_PROOF_UNAVAILABLE',409);}
      }else{
        const observed=await new Promise(resolve=>execFile('/usr/sbin/lsof',
          ['-nP','-a','-p',String(identity.pid),'-d','cwd','-F0pfn'],
          {timeout:5000,maxBuffer:16_384,env:{...process.env,LC_ALL:'C',LANG:'C'}},
          (error,stdout,stderr)=>resolve({error,stdout,stderr})));
        if(observed.error||observed.stderr?.trim())fail('会话实际当前目录未能核实','PROCESS_PROOF_UNAVAILABLE',409);
        const fields=String(observed.stdout||'').split('\0').map(part=>part.replace(/^\n+/,''));
        const pids=fields.filter(part=>part.startsWith('p')),
          fds=fields.filter(part=>part.startsWith('f')),
          names=fields.filter(part=>part.startsWith('n'));
        if(pids.length!==1||pids[0]!==`p${identity.pid}`||fds.length!==1||fds[0]!=='fcwd'||names.length!==1||
          !isAbsolute(names[0].slice(1)))fail('会话实际当前目录未能核实','PROCESS_PROOF_UNAVAILABLE',409);
        try{actual=realpathSync(names[0].slice(1));}catch{fail('会话实际当前目录未能核实','PROCESS_PROOF_UNAVAILABLE',409);}
      }
      const path=relative(root,actual);
      if(path==='..'||path.startsWith(`..${sep}`)||isAbsolute(path)||path.length>240)
        fail('受管 Shell 当前目录不在项目中，交还仍保持暂停','SESSION_WORKSPACE_MISMATCH',409);
      const second=await managed.inspect(item,profile);
      if(second.status?.state!=='stopped'||second.status?.inputFrozen!==true||
        JSON.stringify(second.proof?.identities?.shell)!==JSON.stringify(identity))
        fail('会话实际当前目录未能核实','PROCESS_PROOF_UNAVAILABLE',409);
      control.assertReturn({projectId,token,generation});
      directories.push({sessionRef:item.sessionRef,path:path||'.'});
    }
    return {verified:true,directories};
  }
  async function verifyManagedForExecution(projectId,admittedJob=null){
    assertManagedReady(projectId);
    if(!managed)return;
    const workspace=store.getProject(projectId).directory;
    const items=store.projects().flatMap(project=>project.directory&&overlaps(workspace,project.directory)
      ?managed.projectItems(project.id):[]);
    if(!items.length)return;
    const before=control.handoffForProject(projectId)?.generation??null;
    for(const groupProject of new Set(items.map(item=>item.projectId))){
      if(!control.handoffForProject(groupProject))
        fail('原受管会话缺少已核实的人工交还','MANAGED_PANE_UNKNOWN',409);
      const related=items.filter(item=>item.projectId===groupProject);
      for(const profileId of new Set(related.map(item=>item.profileId))){
        const p=profileFor(profileId),group=related.filter(item=>item.profileId===profileId);
        const result=await managed.inspectParked({projectId:groupProject,workspace:store.getProject(groupProject).directory,
          profile:p,sessionRefs:group.map(item=>item.sessionRef),admittedJob});
        if(!result.verified||!result.quiescent||result.unknown||result.livePids.length)
          fail('原受管 Shell 或其他写入者未停止','MANAGED_PANE_UNKNOWN',409);
      }
    }
    assertManagedReady(projectId);
    if((control.handoffForProject(projectId)?.generation??null)!==before)
      fail('人工交还代次已变化','CONTROL_STALE',409);
  }
  async function verifyRetirementWorkspace({projectId,workspace,expectedHandoffGeneration,admittedJob=null}) {
    if(closing&&!shutdownSealed)fail('终端输入尚未封闭，不能核验退休现场','MANAGED_PANE_UNKNOWN',409);
    assertManagedReady(projectId);
    const original=control.retirementHandoff(projectId,expectedHandoffGeneration);
    if(!original||!managed)fail('原受管交还身份无法核实','MANAGED_PANE_UNKNOWN',409);
    const project=store.getProject(projectId),root=realpathSync(project.directory),target=realpathSync(workspace);
    if(original.workspace!==root)fail('原受管交还目录已变化','MANAGED_PANE_UNKNOWN',409);
    const p=profileFor(original.profileId),items=managed.projectItems(projectId);
    if(p.projectId!==projectId||items.length!==original.sessionRefs.length||
      items.some(item=>item.profileId!==p.id||!original.sessionRefs.some(ref=>equalRef(ref,item.sessionRef))))
      fail('原受管记录与交还会话不符','MANAGED_PANE_UNKNOWN',409);
    const parked=await managed.inspectParked({projectId,workspace:root,profile:p,sessionRefs:original.sessionRefs,admittedJob});
    if(!parked.verified||!parked.quiescent||parked.unknown||parked.livePids.length)
      fail('原受管 Shell 或其他写入者仍可能写入','MANAGED_PANE_UNKNOWN',409);
    if(target!==root){
      const other=await inspectWorkspaceWriters({workspace:target});
      if(!other.verified||!other.quiescent||other.unknown||other.livePids.length)
        fail('工作树目录仍有未核实的写入者','MANAGED_PANE_UNKNOWN',409);
    }
    const fresh=control.retirementHandoff(projectId,expectedHandoffGeneration);
    if(!fresh||fresh.phase!==original.phase||fresh.currentGeneration!==original.currentGeneration||
      fresh.workspace!==original.workspace||fresh.profileId!==original.profileId||
      fresh.sessionEvidenceDigest!==original.sessionEvidenceDigest||
      fresh.sessionRefs.length!==original.sessionRefs.length||
      fresh.sessionRefs.some(ref=>!original.sessionRefs.some(item=>equalRef(ref,item))))
      fail('交还代次或受管会话在退休核验期间变化','CONTROL_STALE',409);
    assertManagedReady(projectId);
    return {verified:true,quiescent:true,unknown:false,livePids:[],
      scope:process.platform==='linux'?'linux-parked-managed-pane-and-visible-writers':
        'macos-parked-managed-pane-and-visible-writers'};
  }
  function sealForShutdown(){
    if(sealPromise)return sealPromise;
    closing=true;tickets.clear();
    for(const c of connections.values())c.ready=false;
    sealPromise=(async()=>{
      await serial;
      const results=await Promise.allSettled([...connections.values()].map(destroy));
      if(results.some(result=>result.status==='rejected'))
        throw new AggregateError(results.filter(result=>result.status==='rejected').map(result=>result.reason),'终端输入未能封闭');
      shutdownSealed=true;
    })();
    return sealPromise;
  }
  async function freezeProject(projectId){
    const project=store.getProject(projectId);
    const affected=[...connections.values()].filter(c=>{
      const profile=state.profiles.find(p=>p.id===c.profileId);
      return !c.readOnly&&profile&&profile.runtime!=='wsl'&&(profile.projectId===projectId||profile.cwd&&overlaps(profile.cwd,project.directory));
    });
    for(const c of affected)c.ready=false;
    const results=await Promise.allSettled(affected.map(stopRuntime));
    if(results.some(r=>r.status==='rejected'))throw new AggregateError(results.filter(r=>r.status==='rejected').map(r=>r.reason),'受管会话输入未能封闭');
  }
  function controlFrame(c,p,requestId){
    const entry=control?.state().find(item=>item.projectId===p.projectId);
    const owned=validClaim(c.ctx,p);
    const requiresSessionSelection=!(entry?.mode==='managed'&&typeof control?.hasManagedSessionRefs==='function'&&control.hasManagedSessionRefs(p.projectId)===false);
    const canReconcileAcquire=Boolean(entry&&['unknown','human'].includes(entry.phase)&&
      (c.ctx.local===true||entry.phase==='unknown'&&entry.actorId===actor(c.ctx))&&
      !c.readOnly&&canWrite(c.ctx,p)&&(()=>{try{check(c.ctx,p,'takeover');return true;}catch{return false;}})());
    c.send?.({type:'control',v:1,...(requestId?{requestId}:{}),managed:Boolean(p.projectId),phase:entry?.phase||'ai_ready',generation:entry?.generation??null,mode:entry?.mode||null,
      authorizedSessionRefs:entry?.authorizedSessionRefs||[],requiresSessionSelection,canReconcileAcquire,reason:entry?.reason||null,
      unresolvedExecutions:p.projectId?executionState().active.filter(item=>item.projectId===p.projectId&&item.status==='unknown')
        .slice(0,16).map(item=>({taskId:item.taskId,commandId:item.commandId})):[],
      changes:entry?.phase==='return_review'?entry.returnReview?.changes||[]:entry?.changes||[],snapshotScope:entry?.snapshotScope||null,owned,
      ...(entry?.phase==='return_review'&&owned&&entry.returnReview?{returnReview:entry.returnReview}: {})});
  }
  function output(c,text){
    const bytes=Buffer.from(text);const frame={type:'output',v:1,epoch:c.epoch,offset:c.offset,data:bytes.toString('base64')};
    c.offset+=bytes.length;c.ring.push({frame,size:bytes.length,at:now()});c.ringBytes+=bytes.length;
    while(c.ringBytes>1_048_576||c.ring.length&&now()-c.ring[0].at>30_000)c.ringBytes-=c.ring.shift().size;
    try{check(c.ctx,profileFor(c.profileId));c.send?.(frame);}catch{/* Revocation/transport loss must stop output even while a close is queued. */}
  }
  function ready(c){c.send?.({type:'ready',v:1,connectionId:c.id,epoch:c.epoch,lastInputSeq:c.seq,sessionRef:c.sessionRef,mode:c.mode,readOnly:c.readOnly===true,cols:c.cols,rows:c.rows,offset:c.offset});}
  async function stopRuntime(c){
    c.ready=false;const runtime=c.runtime;
    c.runtimeGeneration=null;
    if(runtime&&!c.readOnly&&c.mode==='tmux')managed?.freeze(managed.find(c.sessionRef));
    if(runtime)await runtime.close();
    if(c.runtime===runtime)c.runtime=null;
  }
  async function destroy(c){clearTimeout(c.expiry);c.send=null;c.returnConnectionEpoch=(c.returnConnectionEpoch||0)+1;
    await stopRuntime(c);connections.delete(c.id);}
  async function attach(c,ref,mode){
    const p=profileFor(c.profileId);check(c.ctx,p);if(!c.readOnly&&canWrite(c.ctx,p))human(c,p);
    if(!c.readOnly&&mode==='shell'&&control?.state().find(item=>item.projectId===p.projectId)?.mode==='existing')
      fail('已有会话授权不包括独立 Shell','SESSION_NOT_AUTHORIZED',409);
    if(!c.readOnly&&mode==='tmux'&&control?.state().find(item=>item.projectId===p.projectId)?.mode==='existing')
      control.assertExistingSession({projectId:p.projectId,token:claimFor(c.ctx,p)?.token,sessionRef:ref});
    if(!c.readOnly&&mode==='tmux'&&control?.state().find(item=>item.projectId===p.projectId)?.mode==='managed'&&p.projectId)
      control.assertManagedSession({projectId:p.projectId,token:claimFor(c.ctx,p)?.token,profileId:p.id,sessionRef:ref});
    c.ready=false;c.epoch++;c.seq=-1;
    let command=p.shell,args=process.platform==='win32'?[]:['-l'],env=process.env;
    if(mode==='tmux'){
      const target=await adapter(p).attachTarget({sessionRef:ref,readOnly:c.readOnly});command=target.command;args=target.args;env=target.env;
    }else{if(c.readOnly)fail('只读连接不能打开 Shell','READ_ONLY',403);check(c.ctx,p,'input');if(mode!=='shell')fail('请选择 Shell 或 tmux');}
    await stopRuntime(c);check(c.ctx,profileFor(c.profileId));if(!c.readOnly&&canWrite(c.ctx,p))human(c,p);
    if(!c.readOnly&&mode==='tmux'&&control?.state().find(item=>item.projectId===p.projectId)?.mode==='existing')
      await control.verifyExistingSession({projectId:p.projectId,token:claimFor(c.ctx,p)?.token,sessionRef:ref});
    if(!c.readOnly&&mode==='tmux'&&control?.state().find(item=>item.projectId===p.projectId)?.mode==='managed'&&p.projectId)
      await control.verifyManagedSession({projectId:p.projectId,token:claimFor(c.ctx,p)?.token,profileId:p.id,sessionRef:ref});
    check(c.ctx,profileFor(c.profileId));if(!c.readOnly&&canWrite(c.ctx,p))human(c,p);
    const managedItem=mode==='tmux'&&!c.readOnly?managed?.find(ref):null;
    if(managedItem){
      await managed.resume(managedItem,p);
      try { check(c.ctx,profileFor(c.profileId),'input');human(c,p);
        if(control?.state().find(item=>item.projectId===p.projectId)?.mode==='managed')
          control.assertManagedSession({projectId:p.projectId,token:claimFor(c.ctx,p)?.token,profileId:p.id,sessionRef:ref});
      } catch(error) { managed.freeze(managedItem);throw error; }
    }
    c.mode=mode;c.sessionRef=ref||null;c.offset=0;c.ring=[];c.ringBytes=0;
    const runtimeGeneration=Symbol();c.runtimeGeneration=runtimeGeneration;
    try{c.runtime=createTerminalRuntime({shell:command,args,env,cwd:mode==='tmux'?homedir():p.cwd,cols:c.cols,rows:c.rows,maxChunkBytes:16_384,
      onData:data=>{if(c.runtimeGeneration===runtimeGeneration)output(c,data);},
      onExit:result=>{if(c.runtimeGeneration===runtimeGeneration){c.ready=false;c.runtime=null;c.send?.({type:'exit',v:1,epoch:c.epoch,reason:'process_exited',exitCode:result.exitCode});}}
    });}catch(error){managed?.freeze(managedItem);throw error;}
    c.ready=true;
    if(!c.readOnly&&p.projectId){const claim=claimFor(c.ctx,p);if(claim){claim.mode=mode;claim.sessionRef=ref||null;}}
    ready(c);
  }
  async function list(c,requestId){
    const p=profileFor(c.profileId);check(c.ctx,p);const snapshot=await adapter(p).list();
    check(c.ctx,profileFor(c.profileId));
    const key=defaultKey(c.ctx,p),defaultRef=state.defaults[key]||null;
    const entry=control?.state().find(item=>item.projectId===p.projectId);
    c.send?.({type:'sessions',v:1,requestId,items:snapshot.sessions.map(item=>({...item,authorized:entry?.phase==='human'&&entry.authorizedSessionRefs.some(ref=>equalRef(ref,item.sessionRef))||false})),available:snapshot.available,defaultRef,defaultRevision:state.defaultRevisions[key]||0,
      defaultAvailable:!defaultRef||snapshot.sessions.some(s=>equalRef(s.sessionRef,defaultRef))});
    return snapshot;
  }
  const contextKey=ctx=>JSON.stringify([Boolean(ctx.local),ctx.nodeId,ctx.deviceId,ctx.userId,ctx.profileId,ctx.grantRevision]);
  async function frame(ctx,input,send){
    pluginLifecycle?.assertEnabled();
    if(metadataReplacing)fail('数据恢复期间不能打开或修改终端','MANAGED_PANE_UNKNOWN',409);
    if(!input||typeof input!=='object'||input.v!==1)fail('无效的终端消息');
    const p=profileFor(ctx.profileId);check(ctx,p);
    if(p.runtime==='wsl'&&input.type==='open'&&input.mode!=='tmux')
      fail('此配置连接 WSL tmux；普通 Shell 请使用原生终端配置','WSL_TMUX_ONLY',400);
    if(!id(ctx.connectionId))fail('无效连接');
    let c=connections.get(ctx.connectionId);
    if(c&&contextKey(c.ctx)!==contextKey(ctx))fail('连接身份已变化','CONNECTION_CHANGED',403);
    if(!c){
      if(connections.size>=16)fail('终端连接已达到上限','CONNECTION_LIMIT',429);
      if(input.type!=='open')fail('请先打开终端','OPEN_REQUIRED',409);
      if(input.readOnly!==undefined&&typeof input.readOnly!=='boolean')fail('只读状态无效');
      if(input.readOnly&&input.mode!=='tmux')fail('只读连接仅支持 tmux','READ_ONLY',403);
      if(!input.readOnly&&!canWrite(ctx,p))fail('没有可写连接权限，请使用只读查看','GRANT_REQUIRED',403);
      c={id:ctx.connectionId,ctx:{...ctx},profileId:p.id,requestedMode:input.mode,readOnly:input.readOnly===true,epoch:0,seq:-1,offset:0,ring:[],ringBytes:0,ready:false,runtime:null,send,cols:80,rows:24};
      connections.set(c.id,c);
    }
    clearTimeout(c.expiry);c.expiryGeneration=(c.expiryGeneration||0)+1;c.send=send;c.ctx={...ctx};
    switch(input.type){
      case 'open':{
        const recoveryRef=input.recoverSessionRef;
        if(recoveryRef!==undefined&&(input.mode!=='tmux'||!validSessionRef(recoveryRef)||c.runtime))fail('原会话恢复请求无效','INVALID_SESSION_REF',400);
        try{await reclaimRemote(c,p,recoveryRef||state.defaults[defaultKey(ctx,p)]||claims.get(claimKey(ctx,p))?.sessionRef||null);}
        catch(error){if(recoveryRef&&['CONTROL_STALE','SESSION_NOT_AUTHORIZED','SESSION_NOT_FOUND'].includes(error.code)){controlFrame(c,p);c.send({type:'error',v:1,code:error.code,message:error.message});return;}throw error;}
        controlFrame(c,p);
        if((input.readOnly===true)!==c.readOnly||c.readOnly&&input.mode!=='tmux')fail('连接的只读状态不可更改','READ_ONLY',403);
        if(input.mode!=='tmux'&&input.mode!=='shell')fail('请选择 Shell 或 tmux');
        c.requestedMode=input.mode;
        if(!safeSize(input.cols,20,300)||!safeSize(input.rows,5,100))fail('终端尺寸无效');
        c.cols=input.cols;c.rows=input.rows;
        if(c.runtime&&c.ready){
          if(input.redraw===true){
            if(c.mode==='tmux'){await attach(c,c.sessionRef,'tmux');return list(c);}
            c.send({type:'error',v:1,code:'OUTPUT_GAP',message:'部分历史输出已丢失。Shell 仍在运行，请明确确认后继续当前现场。'});return;
          }
          if(input.acceptGap===true){c.epoch++;c.seq=-1;c.ring=[];c.ringBytes=0;ready(c);return;}
          c.runtime.resize(c.cols,c.rows);
          ready(c);const from=Number.isSafeInteger(input.resumeOffset)?input.resumeOffset:c.offset;
          const first=c.ring[0]?.frame.offset??c.offset;
          if(from<first||from>c.offset)c.send({type:'gap',v:1,epoch:c.epoch,nextOffset:c.offset});
          else for(const item of c.ring)if(item.frame.offset>=from)c.send(item.frame);
          await list(c);return;
        }
        if(input.mode==='shell'){await attach(c,null,'shell');return;}
        const snapshot=await list(c);const entry=control?.state().find(item=>item.projectId===p.projectId);
        const authorized=entry?.mode==='existing'&&entry.phase==='human'?entry.authorizedSessionRefs:[];
        const claim=claimFor(ctx,p);
        const ref=recoveryRef||(entry?.mode==='existing'&&authorized.length&&claim?.recoveredManaged===true
          ?authorized.find(item=>equalRef(item,claim.sessionRef))||authorized[0]
          :state.defaults[defaultKey(ctx,p)]||claim?.recoveredManaged&&claim.sessionRef||null);
        if(recoveryRef&&!snapshot.sessions.some(s=>equalRef(s.sessionRef,recoveryRef))){c.send({type:'error',v:1,code:'SESSION_NOT_FOUND',message:'原会话已结束或身份已变化，请明确选择存活会话。'});return;}
        if(ref&&snapshot.sessions.some(s=>equalRef(s.sessionRef,ref))){
          if(!c.readOnly&&p.projectId&&!validClaim(ctx,p)){c.send({type:'error',v:1,code:'CONTROL_REQUIRED',message:'原执行权未能核对，请明确核对现场后再选择原会话。'});return;}
          try{await attach(c,ref,'tmux');}
          catch(error){if(recoveryRef&&['CONTROL_REQUIRED','CONTROL_STALE','SESSION_NOT_AUTHORIZED','SESSION_NOT_FOUND'].includes(error.code)){c.send({type:'error',v:1,code:error.code,message:error.message});return;}throw error;}
        }
        else c.send({type:'error',v:1,code:ref?'DEFAULT_UNAVAILABLE':snapshot.available?'NEEDS_SELECTION':'TMUX_UNAVAILABLE',message:ref?'默认会话已结束，请重新选择':snapshot.available?'请选择会话或新建会话':p.runtime==='wsl'?'这个 WSL 目标暂不可用，请在电脑检查发行版、账户和 tmux。使用 Windows Shell 请另选原生配置。':'未检测到 tmux，可先使用普通 Shell'});
        return;
      }
      case 'list':return list(c,input.requestId);
      case 'select':
        if(input.epoch!==c.epoch)fail('会话已变化，请刷新','INPUT_STALE',409);
        if(!c.readOnly&&p.projectId)await reclaimRemote(c,p,input.sessionRef);
        if(!c.readOnly&&p.projectId){
          try{const entry=control?.state().find(item=>item.projectId===p.projectId);
            if(entry?.mode==='existing')control.assertExistingSession({projectId:p.projectId,token:claimFor(ctx,p)?.token,sessionRef:input.sessionRef});
            else if(entry?.mode==='managed')control.assertManagedSession({projectId:p.projectId,token:claimFor(ctx,p)?.token,profileId:p.id,sessionRef:input.sessionRef});}
          catch(error){if(error.code==='SESSION_NOT_AUTHORIZED'){c.send?.({type:'error',v:1,code:error.code,message:error.message,sessionRef:input.sessionRef,requestId:input.requestId});return;}throw error;}
        }
        await attach(c,input.sessionRef,'tmux');
        // Selecting a surviving pane may complete same-device reclaim after an
        // expired default prevented reclaim during open. Report the new claim
        // only after the selected pane has passed attach and identity checks.
        if(!c.readOnly&&p.projectId)controlFrame(c,p);
        return list(c,input.requestId);
      case 'create':{
        if(c.readOnly)fail('只读连接不能新建会话','READ_ONLY',403);
        check(ctx,p,'create');human(c,p);
        if(control?.state().find(item=>item.projectId===p.projectId)?.mode==='existing')fail('已有会话授权范围不能新建会话，请先交还或切换受管模式','SESSION_NOT_AUTHORIZED',409);
        if(input.epoch!==c.epoch)fail('会话已变化，请刷新','INPUT_STALE',409);
        // A managed Shell inside the workspace is otherwise an unowned writer
        // during proof of the newly created tmux pane.
        if(c.mode==='shell')await stopRuntime(c);
        let item,managedItem;
        if(managed&&p.projectId){
          if(managed.hasUnresolved(p.projectId))fail('受管会话启动结果尚未核实，请在本机恢复原会话','MANAGED_PANE_UNKNOWN',409);
          const claim=claimFor(ctx,p);
          try{
            managedItem=await managed.prepare({profile:p,actorId:actor(ctx),generation:claim.generation,
              sessionName:input.name,cols:c.cols,rows:c.rows});
          }catch(error){
            if(managed.hasUnknownInventory()){
              try{control.markManagedUnknown({projectId:p.projectId,token:claim.token,generation:claim.generation});}
              catch{/* A stale claimant cannot freeze another generation. */}
              await freezeProject(p.projectId);
            }
            throw error;
          }
          try {
            check(ctx,profileFor(p.id),'create');control.assertHuman({projectId:p.projectId,token:claim.token});
            item=await managed.start(managedItem,p);
            check(ctx,profileFor(p.id),'create');human(c,p);
            await control.registerManagedSession({projectId:p.projectId,token:claimFor(ctx,p)?.token,
              actorId:actor(ctx),profileId:p.id,sessionRef:item.sessionRef});
            check(ctx,profileFor(p.id),'create');await attach(c,item.sessionRef,'tmux');
          } catch(error) {
            managed.markUnknown(managedItem);
            try{control.markManagedUnknown({projectId:p.projectId,token:claim.token,generation:claim.generation});}catch{/* Stale authority cannot overwrite another generation. */}
            await freezeProject(p.projectId);
            throw error;
          }
        }else{
          item=await adapter(p).create({name:input.name,cwd:p.runtime==='wsl'?p.wsl.cwd:p.cwd});
          if(p.projectId)await control.registerManagedSession({projectId:p.projectId,token:claimFor(ctx,p)?.token,
            actorId:actor(ctx),profileId:p.id,sessionRef:item.sessionRef});
          check(ctx,profileFor(p.id),'create');await attach(c,item.sessionRef,'tmux');
        }
        return list(c,input.requestId);
      }
      case 'default':{
        check(ctx,p,'default');await adapter(p).attachTarget({sessionRef:input.sessionRef});check(ctx,profileFor(p.id),'default');
        const key=defaultKey(ctx,p),revision=state.defaultRevisions[key]||0;
        if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)fail('请刷新默认会话版本','DEFAULT_REVISION_REQUIRED',409);
        if(input.expectedRevision!==revision)fail('默认会话已在其他设备变化，请刷新后重新选择','DEFAULT_CONFLICT',409);
        state.defaults[key]=input.sessionRef;state.defaultRevisions[key]=revision+1;persist();return list(c,input.requestId);
      }
      case 'input':{
        if(c.readOnly)fail('只读连接不能输入','READ_ONLY',403);
        check(ctx,p,'input');human(c,p);
        if(control?.state().find(item=>item.projectId===p.projectId)?.mode==='existing')
          await control.verifyExistingSession({projectId:p.projectId,token:claimFor(ctx,p)?.token,sessionRef:c.sessionRef});
        if(p.projectId&&c.mode==='tmux'&&control?.state().find(item=>item.projectId===p.projectId)?.mode==='managed')
          await control.verifyManagedSession({projectId:p.projectId,token:claimFor(ctx,p)?.token,profileId:p.id,sessionRef:c.sessionRef});
        check(ctx,profileFor(p.id));human(c,p);
        if(!c.ready||!c.runtime||input.epoch!==c.epoch||!Number.isSafeInteger(input.seq)||input.seq<=c.seq)fail('旧输入已丢弃','INPUT_STALE',409);
        if(typeof input.data!=='string'||input.data.length>22000||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data))fail('输入无效');
        const bytes=Buffer.from(input.data,'base64');if(bytes.length>16384||bytes.toString('base64')!==input.data)fail('输入编码或长度无效');
        let decoded;try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('输入不是完整的 UTF-8 文本');}
        c.seq=input.seq;c.runtime.write(decoded);
        c.send({type:'inputAck',v:1,epoch:c.epoch,seq:c.seq,status:'written'});return;
      }
      case 'resize':
        if(!c.ready||input.epoch!==c.epoch)fail('终端未就绪','INPUT_STALE',409);
        if(!safeSize(input.cols,20,300)||!safeSize(input.rows,5,100))fail('终端尺寸无效');
        c.cols=input.cols;c.rows=input.rows;c.runtime.resize(c.cols,c.rows);return;
      case 'list-control-targets':{
        if(input.requestId!==undefined&&!id(input.requestId))fail('请求标识无效');
        if(c.readOnly||!p.projectId)fail('此连接不能转移控制权','CONTROL_REQUIRED',409);
        check(ctx,p,'takeover');check(ctx,p,'input');human(c,p);
        const entry=control.state().find(item=>item.projectId===p.projectId);
        if(entry?.phase!=='human'||!entry.authorizedSessionRefs?.length||
          [...connections.values()].some(item=>!item.readOnly&&item.mode==='shell'&&item.runtime&&
            state.profiles.find(profile=>profile.id===item.profileId)?.projectId===p.projectId))
          fail('仅已授权的 tmux 会话可转移控制权','TRANSFER_UNSUPPORTED',409);
        const items=[...connections.values()].filter(item=>transferTarget(c,item,p)).map(item=>({connectionId:item.id,
          deviceId:item.ctx.local===true?null:item.ctx.deviceId||null,local:item.ctx.local===true,
          ...(item.ctx.local===true?{label:'这台电脑'}:{})}));
        c.send?.({type:'controlTargets',v:1,...(input.requestId?{requestId:input.requestId}:{}),items});return;
      }
      case 'transfer-control':{
        if(!id(input.targetConnectionId)||input.requestId!==undefined&&!id(input.requestId)||
          !Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<1||
          input.expectedGeneration>=Number.MAX_SAFE_INTEGER)fail('转移请求无效');
        if(c.readOnly||!p.projectId)fail('此连接不能转移控制权','CONTROL_REQUIRED',409);
        check(ctx,p,'takeover');check(ctx,p,'input');human(c,p);
        const entry=control.state().find(item=>item.projectId===p.projectId),claim=claimFor(ctx,p);
        if(entry?.phase!=='human'||entry.generation!==input.expectedGeneration||!claim||
          !entry.authorizedSessionRefs?.length)fail('人工控制权已变化','CONTROL_STALE',409);
        if([...connections.values()].some(item=>!item.readOnly&&item.mode==='shell'&&item.runtime&&
          state.profiles.find(profile=>profile.id===item.profileId)?.projectId===p.projectId))
          fail('当前普通 Shell 不能保留 PTY 转移，请先明确退出 Shell','TRANSFER_UNSUPPORTED',409);
        const target=connections.get(input.targetConnectionId);
        if(!transferTarget(c,target,p))fail('目标连接已断开或未获同账号终端权限','TRANSFER_TARGET_UNAVAILABLE',409);
        const transferId=randomUUID(),expiresAt=now()+60_000;
        const started=control.beginTransfer({projectId:p.projectId,token:claim.token,actorId:actor(ctx),
          targetActorId:actor(target.ctx),targetConnectionId:target.id,profileId:p.id,
          expectedGeneration:input.expectedGeneration,transferId,expiresAt});
        const transfer={id:transferId,sourceId:c.id,targetId:target.id,sourceCtx:ctx,targetCtx:target.ctx,
          projectId:p.projectId,profileId:p.id,expiresAt,sealed:false,timer:null};
        pendingTransfers.set(transferId,transfer);
        try{
          await Promise.all([...connections.values()].filter(item=>!item.readOnly&&
            state.profiles.find(profile=>profile.id===item.profileId)?.projectId===p.projectId).map(stopRuntime));
          check(transfer.sourceCtx,p,'input');check(transfer.sourceCtx,p,'takeover');
          if(!c.send||connections.get(c.id)!==c||!transferTarget(c,target,p)||
            transfer.targetCtx?.isCurrent&&!transfer.targetCtx.isCurrent()||pendingTransfers.get(transferId)!==transfer)
            throw new Error('目标或原连接在封闭输入期间已变化');
          transfer.sealed=true;
          transfer.timer=setTimeout(()=>{void enqueue(()=>endTransfer(transfer,'控制权转移确认已过期')).catch(()=>{});},60_000);
          transfer.timer.unref?.();
          controlFrame(c,p);
          c.send?.({type:'transferPending',v:1,transferId,expiresAt,targetConnectionId:target.id,generation:started.generation,
            ...(input.requestId?{requestId:input.requestId}:{})});
          target.send?.({type:'controlOffer',v:1,transferId,expiresAt,projectId:p.projectId,profileId:p.id,
            fromDeviceId:ctx.local===true?null:ctx.deviceId||null});
        }catch(error){endTransfer(transfer,error.message||'原连接输入未能封闭');}
        return;
      }
      case 'accept-control':{
        if(!id(input.transferId)||input.requestId!==undefined&&!id(input.requestId))fail('转移确认无效');
        const transfer=pendingTransfers.get(input.transferId),source=transfer&&connections.get(transfer.sourceId);
        if(!transfer||transfer.targetId!==c.id||transfer.projectId!==p.projectId||transfer.profileId!==p.id||!transfer.sealed)
          fail('控制权转移已失效','CONTROL_STALE',409);
        let sourceValid=false;
        try{check(transfer.sourceCtx,p,'input');check(transfer.sourceCtx,p,'takeover');sourceValid=true;}catch{}
        if(!sourceValid||!source?.send||connections.get(source.id)!==source||
          transfer.targetCtx?.isCurrent&&!transfer.targetCtx.isCurrent()||!transferTarget(source,c,p)||now()>=transfer.expiresAt){
          endTransfer(transfer,'目标授权、连接或确认期限已变化');return;
        }
        const result=control.acceptTransfer({projectId:p.projectId,transferId:transfer.id,
          targetActorId:actor(ctx),targetConnectionId:c.id,profileId:p.id});
        if(result.phase!=='human'||!result.token){endTransfer(transfer,'控制权转移确认已过期');return;}
        pendingTransfers.delete(transfer.id);clearTimeout(transfer.timer);
        claims.delete(claimKey(source.ctx,p));
        claims.set(claimKey(ctx,p),{token:result.token,generation:result.generation,connectionId:c.id,
          nodeId:ctx.nodeId||null,deviceId:ctx.deviceId||null,userId:ctx.userId||null,profileId:p.id,
          grantRevision:ctx.grantRevision??null,mode:'tmux',sessionRef:null});
        c.send?.({type:'transferAccepted',v:1,transferId:transfer.id,
          ...(input.requestId?{requestId:input.requestId}:{})});
        controlFrame(c,p);
        source.send?.({type:'transferCompleted',v:1,transferId:transfer.id});controlFrame(source,p);return;
      }
      case 'cancel-transfer':{
        if(!id(input.transferId)||input.requestId!==undefined&&!id(input.requestId))fail('取消请求无效');
        const transfer=pendingTransfers.get(input.transferId);
        if(!transfer||![transfer.sourceId,transfer.targetId].includes(c.id))fail('控制权转移已失效','CONTROL_STALE',409);
        endTransfer(transfer,'控制权转移已取消');return;
      }
      case 'detach':{
        if(input.requestId!==undefined&&!id(input.requestId))fail('断开请求标识无效');
        const epoch=c.epoch;
        await destroy(c);
        // The browser may retire its socket only after the old PTY client has
        // actually closed; otherwise a fresh ticket races the retained claim.
        if(!ctx.isCurrent||ctx.isCurrent())send?.({type:'exit',v:1,epoch,reason:'detached',exitCode:null,
          ...(input.requestId?{requestId:input.requestId}:{})});
        return;
      }
      case 'takeover':
      case 'takeover-existing':
      case 'extend-existing':
      case 'return':
      case 'return-prepare':
      case 'return-confirm':
      case 'return-cancel':
      case 'reconcile-control':{
        try{
        if(input.type==='reconcile-control'&&(
          input.requestId!==undefined&&!id(input.requestId)||
          input.sessionRef!==undefined&&(input.action!=='acquire'||!validSessionRef(input.sessionRef))))
          fail('恢复核对请求无效');
        if(input.type==='reconcile-control'&&ctx.local!==true&&input.sessionRef!==undefined)
          fail('远端核对后须从原授权会话中明确选择','SESSION_NOT_AUTHORIZED',409);
        if(c.readOnly)fail('只读连接不能接管或交还','READ_ONLY',403);
        check(ctx,p,'takeover');if(!p.projectId||!control)fail('这个终端尚未关联受管项目','CONTROL_UNMANAGED',409);
        const key=claimKey(ctx,p),claimToken=claimFor(ctx,p)?.token,
          connectionEpoch=c.returnConnectionEpoch||0;let operation;
        if(input.type!=='takeover'&&input.endUnknownCommands!==undefined)fail('此操作不能结束旧轮次');
        if(input.type==='takeover'){
          const authorize=()=>{
            check(ctx,p,'takeover');
            if(!canWrite(ctx,p)||closing||c.send!==send||connections.get(c.id)!==c||
              (c.returnConnectionEpoch||0)!==connectionEpoch||profileFor(p.id)!==p)
              fail('接管连接或授权已变化','CONTROL_STALE',409);
          };
          authorize();
          if(input.endUnknownCommands!==undefined){
            const active=executionState().active;
            if(!Array.isArray(input.endUnknownCommands)||!input.endUnknownCommands.length||input.endUnknownCommands.length>16||
              input.endUnknownCommands.some(item=>!item||!active.some(lease=>lease.projectId===p.projectId&&
                lease.provider==='codex-autocontinue'&&lease.status==='unknown'&&lease.taskId===item.taskId&&lease.commandId===item.commandId)))
              fail('旧轮次已变化，请重新打开接管确认','CONTROL_STALE',409);
          }
          operation=control.acquire({projectId:p.projectId,profileId:p.id,actorId:actor(ctx),
            endUnknownCommands:input.endUnknownCommands,authorize});
        }
        else if(input.type==='takeover-existing')operation=control.acquireExisting({projectId:p.projectId,actorId:actor(ctx),profileId:p.id,sessionRefs:input.sessionRefs,trustedOwner:ctx.local===true});
        else if(input.type==='extend-existing')operation=control.extendExisting({projectId:p.projectId,token:claimFor(ctx,p)?.token,sessionRefs:input.sessionRefs});
        else if(input.type==='return'||input.type==='return-prepare')operation=control.release({projectId:p.projectId,token:claimToken,profileId:p.id,notes:input.notes||''});
        else if(input.type==='return-confirm')operation=control.confirmReturn({projectId:p.projectId,token:claimToken,
          actorId:actor(ctx),profileId:p.id,reviewId:input.reviewId,expectedGeneration:input.expectedGeneration,
          authorize:()=>{check(ctx,p,'takeover');if(ctx.isCurrent&&!ctx.isCurrent()||
            closing||c.send!==send||connections.get(c.id)!==c||
            (c.returnConnectionEpoch||0)!==connectionEpoch||
            claimFor(ctx,p)?.token!==claimToken||
            control.state().find(item=>item.projectId===p.projectId)?.generation!==input.expectedGeneration)
            fail('交还连接或授权已变化','CONTROL_STALE',409);}});
        else if(input.type==='return-cancel')operation=control.cancelReturn({projectId:p.projectId,token:claimFor(ctx,p)?.token,
          actorId:actor(ctx),profileId:p.id,reviewId:input.reviewId,expectedGeneration:input.expectedGeneration});
        else {
          let managedSelection;
          const entry=control.state().find(item=>item.projectId===p.projectId);
          if(ctx.local===true&&input.action==='acquire'&&entry?.mode==='managed'&&
            ['unknown','human'].includes(entry.phase)&&control.hasManagedSessionRefs(p.projectId)){
            const available=await adapter(p).list();
            if(!available.available||available.sessions.length>256)fail('受管会话列表无法核实','PROCESS_PROOF_UNAVAILABLE',409);
            managedSelection={profileId:p.id,sessionRef:input.sessionRef||state.defaults[defaultKey(ctx,p)]||null,
              availableSessionRefs:available.sessions.map(item=>item.sessionRef)};
          }
          operation=control.reconcile({projectId:p.projectId,actorId:actor(ctx),token:claimFor(ctx,p)?.token,
            action:input.action,trustedOwner:ctx.local===true,managedSelection,profileId:p.id});
        }
        controlFrame(c,p);const result=await operation;
        if(result.phase==='human'&&result.token)claims.set(key,{token:result.token,generation:result.generation,connectionId:c.id,
          nodeId:ctx.nodeId||null,deviceId:ctx.deviceId||null,userId:ctx.userId||null,profileId:p.id,grantRevision:ctx.grantRevision??null,
          mode:result.mode==='existing'?'tmux':null,sessionRef:result.mode==='existing'?result.authorizedSessionRefs?.[0]||null:null});
        if(result.phase==='return_review'&&result.token)claims.set(key,{token:result.token,generation:result.generation,connectionId:c.id,
          nodeId:ctx.nodeId||null,deviceId:ctx.deviceId||null,userId:ctx.userId||null,profileId:p.id,grantRevision:ctx.grantRevision??null});
        if(result.phase==='ai_ready'||input.type==='return-cancel')claims.delete(key);
        if(ctx.isCurrent&&!ctx.isCurrent())return;
        controlFrame(c,p,input.type==='reconcile-control'?input.requestId:undefined);return;
        }catch(error){
          if(input.type==='reconcile-control'&&id(input.requestId)){
            c.send?.({type:'error',v:1,code:error.code||'TERMINAL_INVALID',message:error.message||'恢复核对失败',requestId:input.requestId});
            return;
          }
          throw error;
        }
      }
      default:fail('未知终端操作');
    }
  }
  function disconnect(connectionId,ttlMs=30_000){const c=connections.get(connectionId);if(!c)return;c.send=null;
    c.returnConnectionEpoch=(c.returnConnectionEpoch||0)+1;
    void enqueue(()=>{endTransfersFor(connectionId,'转移连接已断开');const p=state.profiles.find(item=>item.id===c.profileId);
      const claim=p?.projectId?claimFor(c.ctx,p):null;
      if(claim)control?.invalidateReturnReview({projectId:p.projectId,token:claim.token,generation:claim.generation});
    }).catch(()=>{});
    clearTimeout(c.expiry);const expiryGeneration=c.expiryGeneration=(c.expiryGeneration||0)+1;
    // Once the PTY actually exited there is no resumable output or write path.
    // Retire this socket immediately so a fresh connection can prove a new claim.
    if(!c.ready&&!c.runtime){void enqueue(()=>c.expiryGeneration===expiryGeneration&&c.send===null&&!c.runtime?destroy(c):undefined).catch(()=>{});return;}
    c.expiry=setTimeout(()=>{void enqueue(()=>c.expiryGeneration===expiryGeneration?destroy(c):undefined).catch(()=>{});},Math.min(30_000,Math.max(0,ttlMs)));c.expiry.unref();}
  async function request(method,path,body={}){
    if(closing)fail('终端正在关闭','SHUTTING_DOWN',503);
    if(!['/api/terminal/status','/api/terminal/diagnostics'].includes(path)&&
      !(method==='DELETE'&&/^\/api\/terminal\/grants\//.test(path)))pluginLifecycle?.assertEnabled();
    // Core routes /api/terminal/* only to the local owner. These categories
    // describe this process's first failed observation; they grant no control.
    if(method==='GET'&&path==='/api/terminal/diagnostics')
      return managed?.diagnostics()||{supported:false,scope:'current-process-observation-not-authorization',
        inventoryUnknown:false,firstInventoryFailure:null,items:[]};
    if(method==='GET'&&path==='/api/terminal/wsl')return wslSupport.discover();
    if(method==='GET'&&path==='/api/terminal/status'){
      const profiles=await Promise.all(state.profiles.map(async p=>{const info=await adapter(p).inspect();return {...p,tmuxAvailable:info.available,...(info.reason?{tmuxReason:info.reason}:{})};}));
      let pendingDevices=[];try{pendingDevices=(await link?.pending())?.devices||[];}catch{/* Offline enrollment must not prevent local terminal use. */}
      return {mode:'local',platform:process.platform,enabled:(!pluginLifecycle||pluginLifecycle.status()==='ready')&&profiles.some(p=>p.enabled),plugin:pluginLifecycle?.state(),profiles,grants:state.grants.filter(g=>!g.revoked),pendingDevices,connections:[...connections.values()].map(c=>({id:c.id,profileId:c.profileId,mode:c.mode,ready:c.ready})),link:link?.state()||{status:'disconnected'}};
    }
    if(method==='POST'&&path==='/api/terminal/profiles'){
      if(!id(body.id)||typeof body.label!=='string'||!body.label.trim()||body.label.length>80||typeof body.enabled!=='boolean')fail('请填写终端名称');
      if(!state.profiles.some(p=>p.id===body.id)&&state.profiles.length>=8)fail('最多配置 8 个终端','PROFILE_LIMIT',429);
      if(body.serverName&&body.allowSharedServer!==true)fail('接入已有 tmux server 会授权其中全部会话，请确认范围','SHARED_SERVER_CONFIRMATION',409);
      const runtime=body.runtime??'native',previous=state.profiles.find(p=>p.id===body.id);
      if(!['native','wsl'].includes(runtime))fail('请选择原生终端或 WSL tmux');
      if(previous&&(previous.runtime||'native')!==runtime)
        fail('更换运行环境请新增配置，原设备授权不会转移','PROFILE_TARGET_CHANGED',409);
      if(runtime==='wsl'&&body.projectId)fail('WSL 独立终端不能关联 AI 受管项目','WSL_PROJECT_UNSUPPORTED',400);
      if(runtime==='wsl'&&body.tmuxExecutable)fail('WSL 使用所选发行版中的 tmux，不接受宿主路径','WSL_INVALID_EXECUTABLE',400);
      const wsl=runtime==='wsl'?await wslSupport.configure({distro:body.wslDistro,cwd:body.wslCwd}):null;
      if(previous?.runtime==='wsl'&&wslTarget(previous)!==wslTarget({runtime,wsl}))
        fail('发行版或 Linux 账户已变化，请新增配置并重新授权设备','PROFILE_TARGET_CHANGED',409);
      const project=body.projectId?store.getProject(body.projectId):null;
      const cwd=validateTerminalCwd(runtime==='wsl'?homedir():project?.directory||body.cwd||homedir());
      if(runtime!=='wsl'&&!project&&store.projects().some(item=>item.directory&&overlaps(item.directory,cwd)))fail('终端目录与受管项目重叠，请先关联该项目','CONTROL_BINDING_REQUIRED',409);
      const profile={id:body.id,label:body.label.trim(),cwd,projectId:project?.id||null,enabled:body.enabled,runtime,...(wsl?{wsl}:{}),
        shell:body.shell||(process.platform==='win32'?process.env.COMSPEC:process.env.SHELL||(process.platform==='darwin'?'/bin/zsh':'/bin/sh')),serverName:body.serverName||`seqivo_${hash(state.namespace+':'+body.id).slice(0,24)}`,allowSharedServer:body.allowSharedServer===true,tmuxExecutable:body.tmuxExecutable||process.env.TMUX_PATH};
      await adapter(profile).inspect();
      pluginLifecycle?.assertEnabled();
      for(const c of connections.values())if(c.profileId===body.id)await destroy(c);
      state.profiles=state.profiles.filter(p=>p.id!==body.id);state.profiles.push(profile);persist();link?.refresh();return profile;
    }
    if(method==='POST'&&path==='/api/terminal/tickets'){
      const p=profileFor(body.profileId);if(!origin)fail('终端接口未就绪','TERMINAL_UNAVAILABLE',503);
      const connectionId=body.resumeConnectionId||randomUUID();if(!id(connectionId))fail('无效连接');
      if(body.resumeConnectionId){const current=connections.get(connectionId);if(!current||!current.ctx.local||current.profileId!==p.id)fail('原终端连接无法恢复','RESUME_UNAVAILABLE',409);}
      for(const [key,ticket]of tickets)if(ticket.expiresAt<=now())tickets.delete(key);
      if(tickets.size>=32)fail('连接请求过多','TICKET_LIMIT',429);
      const secret=randomBytes(32).toString('base64url'),expiresAt=now()+30000;
      tickets.set(hash(secret),{connectionId,profileId:p.id,local:true,userId:'local',expiresAt});
      return {ticket:secret,expiresAt,connectionId,wsUrl:origin.replace(/^http/,'ws')+'/api/terminal/ws'};
    }
    if(method==='POST'&&path==='/api/terminal/grants'){
      const p=profileFor(body.profileId);
      if(!id(body.deviceId)||!Array.isArray(body.scopes)||!body.scopes.includes('view')||body.scopes.some(s=>!scopes.has(s)))fail('授权范围无效');
      if(!link)fail('请先连接服务器','NODE_OFFLINE',503);
      const pending=(await link.pending()).devices.find(d=>d.deviceId===body.deviceId);if(!pending)fail('设备请求已过期','DEVICE_NOT_FOUND',404);
      const result=await link.grant({...body,action:'grant'});
      pluginLifecycle?.assertEnabled();
      state.grants=state.grants.filter(g=>!(g.deviceId===body.deviceId&&g.profileId===p.id));
      state.grants.push({deviceId:body.deviceId,profileId:p.id,userId:pending.userId,nodeId:link.state().nodeId,scopes:[...new Set(body.scopes)],revision:result.revision,revoked:false});persist();return result;
    }
    const revoke=path.match(/^\/api\/terminal\/grants\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/);
    if(method==='DELETE'&&revoke){
      for(const g of state.grants)if(g.deviceId===revoke[1]&&g.profileId===revoke[2])g.revoked=true;persist();
      const affected=[...connections.values()].filter(c=>c.ctx.deviceId===revoke[1]&&c.profileId===revoke[2]);
      for(const c of affected){endTransfersFor(c.id,'目标设备授权已撤销');const profile=state.profiles.find(p=>p.id===c.profileId);
        const claim=profile?.projectId?claimFor(c.ctx,profile):null;
        if(claim)control?.invalidateReturnReview({projectId:profile.projectId,token:claim.token,generation:claim.generation,
          reason:'交还授权已撤销，需重新核对'});
      }
      for(const [key,claim]of claims)if(claim.deviceId===revoke[1]&&claim.profileId===revoke[2])claims.delete(key);
      for(const c of affected){const profile=state.profiles.find(p=>p.id===c.profileId);if(profile?.projectId)claims.delete(claimKey(c.ctx,profile));}
      for(const c of affected)c.send=null;
      const results=await Promise.allSettled([...affected.map(destroy),link?.grant({action:'revoke',deviceId:revoke[1],profileId:revoke[2]})]);
      const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
      return {revoked:true};
    }
    fail('终端接口不存在','NOT_FOUND',404);
  }
  return {request:(...args)=>args[0]==='DELETE'&&/^\/api\/terminal\/grants\//.test(args[1])?request(...args):enqueue(()=>request(...args)),frame:(...args)=>enqueue(()=>frame(...args)),disconnect,
    assertPluginLifecycleChangeSafe(){
      if(metadataReplacing||closing)fail('数据恢复或关闭期间不能切换终端插件','TERMINAL_PLUGIN_BUSY',409);
    },
    assertPluginDisableSafe(){
      if([...connections.values()].some(c=>!c.readOnly&&(c.mode==='shell'&&c.runtime||c.requestedMode==='shell')))
        fail('普通 Shell 无法在停用时保留，请先明确退出或断开该会话','TERMINAL_SHELL_ACTIVE',409);
    },
    preparePluginDisable(){
      tickets.clear();
      for(const c of connections.values()){c.ready=false;c.send=null;}
      return enqueue(async()=>{
        if(pluginLifecycle?.status()!=='disabling'||closing||metadataReplacing)
          fail('终端停用现场已变化','TERMINAL_PLUGIN_UNKNOWN',409);
        if(connections.size===0&&!managed?.hasUnknownInventory()&&!managed?.unresolvedProjects().length)
          return {zeroAttachments:true};
        // Cold proof is optional for an ordinary same-process disable. Without
        // complete evidence, the surviving intent remains unknown after loss.
        const unavailable={zeroAttachments:false,coldProofSupported:false};
        if(!managed||managed.hasUnknownInventory()||managed.unresolvedProjects().length||
          connections.size>16)return unavailable;
        const before=[...connections.values()].map(c=>({connection:c,runtime:c.runtime}));
        if(before.some(({connection:c,runtime})=>runtime&&
          (c.mode!=='tmux'||!validSessionRef(c.sessionRef)||!id(c.id))))return unavailable;
        const live=before.filter(item=>item.runtime);
        let table;
        if(live.length){
          const profile=state.profiles.find(p=>p.id===live[0].connection.profileId);
          if(!profile)return unavailable;
          try{table=await managed.processTable(profile);}catch{return unavailable;}
        }
        if(pluginLifecycle?.status()!=='disabling'||closing||metadataReplacing||
          connections.size!==before.length||before.some(({connection:c,runtime})=>
            connections.get(c.id)!==c||c.runtime!==runtime))
          return unavailable;
        const attachments=live.map(({connection:c,runtime})=>{
          const profile=state.profiles.find(p=>p.id===c.profileId);
          const identity=table?.get(runtime.pid);
          if(!profile||!identity||identity.ppid!==process.pid||
            identity.euid!==process.geteuid()||identity.ruid!==process.getuid()||
            !validBirth(identity)||c.sessionRef.serverName!==profile.serverName)return null;
          return {connectionId:c.id,profileId:c.profileId,profileBinding:profileBinding(profile),
            sessionRef:c.sessionRef,identity:Object.fromEntries(
              ['pid','pgid','euid','ruid','startSec','startUsec'].map(key=>[key,identity[key]]))};
        });
        if(attachments.some(item=>!item)||
          new Set(attachments.map(item=>item.identity.pid)).size!==attachments.length)return unavailable;
        return {zeroAttachments:false,coldProofSupported:true,
          connectionCount:before.length,runtimeCount:live.length,attachments};
      });
    },
    suspendForPlugin(){
      tickets.clear();
      for(const c of connections.values()){c.ready=false;c.send=null;}
      return enqueue(async()=>{
        const results=await Promise.allSettled([...connections.values()].map(c=>{
          endTransfersFor(c.id,'终端插件已停用');return destroy(c);
        }));
        if(results.some(result=>result.status==='rejected'))
          throw new AggregateError(results.filter(result=>result.status==='rejected').map(result=>result.reason),'终端附着关闭结果未知');
      });
    },
    async verifyPluginRecovery({sameProcessRetry=false,coldZeroAttachments=false,coldAttachments=null}={}){
      if(connections.size||managed?.hasUnknownInventory()||managed?.unresolvedProjects().length)
        fail('原终端附着或受管记录尚未核实','TERMINAL_PLUGIN_UNKNOWN',409);
      if(coldAttachments){
        if(pluginLifecycle?.status()!=='disabled_unknown'||!managed||
          !Array.isArray(coldAttachments)||coldAttachments.length>16)
          fail('原终端附着记录无法核实','TERMINAL_PLUGIN_UNKNOWN',409);
        for(const item of coldAttachments){
          const p=state.profiles.find(profile=>profile.id===item.profileId);
          if(!p||profileBinding(p)!==item.profileBinding||
            !validSessionRef(item.sessionRef)||item.sessionRef.serverName!==p.serverName||
            !validBirth(item.identity)||item.identity.euid!==process.geteuid()||
            item.identity.ruid!==process.getuid())
            fail('原终端附着记录与现场不符','TERMINAL_PLUGIN_UNKNOWN',409);
        }
        const profile=state.profiles.find(p=>p.id===coldAttachments[0]?.profileId)||state.profiles[0];
        if(!profile)fail('原终端配置无法核实','TERMINAL_PLUGIN_UNKNOWN',409);
        let table;
        try{table=await nativeProcessTable(recoveryPython,15000,{allVisible:true});}
        catch{fail('原终端进程状态无法核实','TERMINAL_PLUGIN_UNKNOWN',409);}
        if(coldAttachments.some(item=>originalTerminalAttachmentPresent(table,item.identity)))
          fail('原终端附着仍在运行','TERMINAL_PLUGIN_UNKNOWN',409);
        if(managed.hasUnknownInventory()||managed.unresolvedProjects().length)
          fail('受管终端现场未核实','TERMINAL_PLUGIN_UNKNOWN',409);
        return;
      }
      // Unknown shutdown may have left an untracked ordinary PTY. It cannot be
      // promoted to a clean disable merely because this process has no socket.
      if(pluginLifecycle?.status()==='disabled_unknown'&&!sameProcessRetry&&!coldZeroAttachments)
        fail('原终端进程归属无法核实，请人工处理后恢复','TERMINAL_PLUGIN_UNKNOWN',409);
    },
    initializeManaged:()=>managed?.initialize(state.profiles)||Promise.resolve(),
    inspectExisting:async({projectId,workspace,profileId,sessionRefs,previousEvidence,retiredSessionRefs=[]})=>{
      const p=profileFor(profileId);
      if(p.projectId!==projectId||p.cwd!==workspace||!Array.isArray(sessionRefs)||!sessionRefs.length||sessionRefs.length>16||
        sessionRefs.some(ref=>ref.serverName!==p.serverName||ref.instanceId!==sessionRefs[0].instanceId))
        fail('已有会话与项目绑定不符','INVALID_SESSION_REF',409);
      if(process.platform==='linux'&&retiredSessionRefs.length)
        fail('Linux 尚不能核实已结束会话','PROCESS_PROOF_UNAVAILABLE',409);
      const tmux=adapter(p),sessions=await tmux.sessionsPanes(sessionRefs);
      if(retiredSessionRefs.length){
        if(!Array.isArray(previousEvidence)||retiredSessionRefs.some(ref=>!previousEvidence.some(item=>equalRef(item.sessionRef,ref)&&
          Array.isArray(item.panes)&&item.panes.length&&item.panes.every(pane=>Number.isSafeInteger(pane.pid)&&pane.pid>0&&
            canonicalPsStart(pane.startedAt)))))fail('已结束会话缺少原进程身份证据','PROCESS_PROOF_UNAVAILABLE',409);
        const listed=await tmux.list();
        if(!listed.available||retiredSessionRefs.some(ref=>listed.sessions.some(item=>equalRef(item.sessionRef,ref))))
          fail('原会话仍存在或状态不可核实','PROCESS_PROOF_UNAVAILABLE',409);
        const retiredPanes=retiredSessionRefs.flatMap(ref=>previousEvidence.find(item=>equalRef(item.sessionRef,ref)).panes);
        if(retiredPanes.some(pane=>!/^%\d+$/.test(pane.paneId)))
          fail('原 pane 身份证据不完整','PROCESS_PROOF_UNAVAILABLE',409);
        const pidSet=[...new Set(retiredPanes.map(pane=>pane.pid))];
        const observed=await new Promise(resolve=>execFile('/bin/ps',['-p',pidSet.join(','),'-o','pid=,lstart='],
          {encoding:'utf8',timeout:5000,maxBuffer:128*1024,env:{...process.env,LC_ALL:'C',LANG:'C'}},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
        if(observed.stderr?.trim()||observed.error&&(observed.error.code!==1||observed.stdout?.trim()))
          fail('原 pane 进程状态无法核实','PROCESS_PROOF_UNAVAILABLE',409);
        const rows=new Map();
        for(const line of (observed.stdout||'').split('\n')){
          if(!line.trim())continue;
          const match=/^\s*(\d+)\s+(.+?)\s*$/.exec(line),pid=match&&Number(match[1]);
          const startedAt=match&&canonicalPsStart(match[2]);
          if(!match||!Number.isSafeInteger(pid)||!pidSet.includes(pid)||rows.has(pid)||!startedAt)
            fail('原 pane 进程身份不明确','PROCESS_PROOF_UNAVAILABLE',409);
          rows.set(pid,startedAt);
        }
        for(const pane of retiredPanes)if(rows.get(pane.pid)===canonicalPsStart(pane.startedAt))
          fail('原 pane 进程仍在运行','PROCESS_PROOF_UNAVAILABLE',409);
      }
      let root,otherProjects;
      try{
        root=realpathSync(workspace);
        otherProjects=store.projects().filter(project=>project.id!==projectId&&project.directory)
          .map(project=>({name:project.name,root:realpathSync(project.directory)}));
      }catch{fail('无法核实项目目录，请检查项目配置','SESSION_WORKSPACE_MISMATCH',409);}
      const within=(base,path)=>{const rel=relative(base,path);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`);};
      for(const session of sessions){
        const newSelection=!previousEvidence?.some(item=>equalRef(item.sessionRef,session.sessionRef));
        for(const pane of session.panes){
          let cwd;
          try{cwd=realpathSync(pane.cwd);}catch{fail('无法核实会话当前目录，请重新选择会话','SESSION_WORKSPACE_MISMATCH',409);}
          const other=otherProjects.find(project=>within(project.root,cwd));
          if(other)fail(`会话当前位于其他受管项目「${other.name}」，请切换到该项目配置`,'SESSION_WORKSPACE_MISMATCH',409);
          if(newSelection&&!within(root,cwd))fail('新接入的会话当前目录不在绑定项目内，请先在原终端切换到项目目录','SESSION_WORKSPACE_MISMATCH',409);
        }
      }
      if(process.platform==='linux'){
        if(control?.state().find(entry=>entry.projectId===projectId)?.mode!=='managed'||
          retiredSessionRefs.length||!managed||managed.hasUnknownInventory())
          fail('受管会话原进程身份无法核实','PROCESS_PROOF_UNAVAILABLE',409);
        const selected=sessions.map(session=>({session,item:managed.find(session.sessionRef)}));
        if(selected.some(({item})=>!item||item.status!=='started'))
          fail('会话缺少已启动的受管记录','PROCESS_PROOF_UNAVAILABLE',409);
        const proofs=[];
        for(const {item} of selected)proofs.push((await managed.inspect(item,p)).proof);
        const result=await inspectLinuxManagedWriters({workspace,sessions,proofs,previousEvidence,
          selectedIdentities:pids=>managed.selectedIdentities(p,pids)});
        if(result.verified!==true||result.unknown!==false||result.authorized!==true)
          fail('受管会话写入者未能核实','PROCESS_PROOF_UNAVAILABLE',409);
        for(let index=0;index<selected.length;index++){
          const after=(await managed.inspect(selected[index].item,p)).proof;
          if(!equalRef(after.sessionRef,proofs[index].sessionRef)||
             JSON.stringify(after.identities)!==JSON.stringify(proofs[index].identities))
            fail('受管会话原进程身份已变化','PROCESS_PROOF_UNAVAILABLE',409);
        }
        if(profileFor(profileId)!==p)fail('终端配置已变更','PROFILE_CHANGED',409);
        return result;
      }
      const registered=managed?sessions.map(session=>({session,item:managed.find(session.sessionRef)})).filter(x=>x.item):[];
      let nativeBefore;
      if(registered.length){
        for(const {item} of registered)await managed.inspect(item,p);
        nativeBefore=await managed.observeProcessTable(p);
      }
      const result=await inspectSessionWriters({workspace,sessions,previousEvidence});
      if(registered.length){
        if(result.verified!==true||result.unknown!==false||!Array.isArray(result.unownedWriters))
          fail('受管会话写入者未能核实','PROCESS_PROOF_UNAVAILABLE',409);
        const nativeAfter=await managed.observeProcessTable(p),proofs=[];
        for(const {item} of registered){
          const {proof}=await managed.inspect(item,p);
          if(!equalRef(item.sessionRef,proof.sessionRef))
            fail('受管会话原进程身份已变化','PROCESS_PROOF_UNAVAILABLE',409);
          proofs.push(proof);
        }
        verifyManagedObservedWriters({proofs,nativeBefore,nativeAfter,result});
      }
      if(retiredSessionRefs.length){
        const listed=await tmux.list();
        if(!listed.available||retiredSessionRefs.some(ref=>listed.sessions.some(item=>equalRef(item.sessionRef,ref))))
          fail('原会话状态在核验期间变化','PROCESS_PROOF_UNAVAILABLE',409);
        result.retiredSessionRefs=retiredSessionRefs;
      }
      if(profileFor(profileId)!==p)fail('终端配置已变更','PROFILE_CHANGED',409);
      return result;
    },
    sealProject:freezeProject,
    assertManagedReady,
    parkManagedProject,inspectParkedWriters,inspectReturnDirectories,verifyManagedForExecution,verifyRetirementWorkspace,sealForShutdown,
    closeConnection:connectionId=>{const c=connections.get(connectionId);if(c){c.send=null;c.returnConnectionEpoch=(c.returnConnectionEpoch||0)+1;}
      return enqueue(async()=>{endTransfersFor(connectionId,'转移连接已关闭');if(c&&connections.get(connectionId)===c)await destroy(c);});},
    closeRemote:()=>{for(const c of connections.values())if(!c.ctx.local){c.send=null;c.returnConnectionEpoch=(c.returnConnectionEpoch||0)+1;}
      return enqueue(async()=>{for(const c of connections.values())if(!c.ctx.local){endTransfersFor(c.id,'远程连接已关闭');await destroy(c);}});},
    profiles:()=>!pluginLifecycle||pluginLifecycle.status()==='ready'?state.profiles.filter(p=>p.enabled).map(({id,label,runtime})=>({id,label,...(runtime==='wsl'?{runtime}:{})})):[],
    hasConnections:()=>connections.size>0,
    beginMetadataReplacement(){
      if(metadataReplacing)fail('数据恢复已经在进行','MANAGED_PANE_UNKNOWN',409);
      if(pluginLifecycle?.transitioning())fail('终端插件正在切换状态','TERMINAL_PLUGIN_BUSY',409);
      if(pluginLifecycle&&!['ready','disabled'].includes(pluginLifecycle.status()))
        fail('终端插件状态未核实，不能替换数据','TERMINAL_PLUGIN_UNKNOWN',409);
      metadataReplacing=true;
      return ()=>{metadataReplacing=false;};
    },
    assertMetadataReplacementSafe:metadata=>{pluginLifecycle?.assertMetadataReplacementSafe(metadata);managed?.assertMetadataReplacementSafe(metadata);},
    bindOwner:({nodeId,userId})=>enqueue(()=>{if(!id(nodeId)||!id(userId))return;let changed=false;for(const p of state.profiles){const suffix=defaultSuffix(p),old=`local:local:${p.id}${suffix}`,next=`${nodeId}:${userId}:${p.id}${suffix}`;if(state.defaults[old]){if(!state.defaults[next]){state.defaults[next]=state.defaults[old];state.defaultRevisions[next]=state.defaultRevisions[old]||0;}delete state.defaults[old];delete state.defaultRevisions[old];changed=true;}}if(changed)persist();}),
    blocksProject:projectId=>{try{assertManagedReady(projectId);}catch{return true;}
      const project=store.getProject(projectId);return [...connections.values()].some(c=>{const p=state.profiles.find(p=>p.id===c.profileId);return !c.readOnly&&p?.runtime!=='wsl'&&(p?.projectId===projectId||project.directory&&p?.cwd&&overlaps(project.directory,p.cwd))&&c.runtime;});},
    setOrigin:value=>{origin=value;},setLink:value=>{link=value;},
    consumeTicket(value){pluginLifecycle?.assertEnabled();if(typeof value!=='string')fail('终端授权无效','UNAUTHORIZED',401);const key=hash(value),ticket=tickets.get(key);tickets.delete(key);if(!ticket||ticket.expiresAt<=now())fail('终端授权已过期','UNAUTHORIZED',401);return ticket;},
    async close(){const sealed=sealForShutdown();const linked=link?.close();
      const settled=await Promise.allSettled([sealed,linked]);
      for(const transfer of [...pendingTransfers.values()])endTransfer(transfer,'终端服务已关闭');
      managed?.close();
      if(settled.some(r=>r.status==='rejected'))throw new AggregateError(settled.filter(r=>r.status==='rejected').map(r=>r.reason),'终端关闭未完成');}
  };
}
