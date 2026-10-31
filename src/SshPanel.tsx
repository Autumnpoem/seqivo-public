import {useNativeBack} from './lib/use-native-back';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ChevronDown, Computer, Plus, Server, Settings2, ShieldCheck, X } from 'lucide-react';
import { errorMessage, ReadTimeoutError, request } from './api';
import {isSshNetworkFailure, sameSshRecovery, sshRecoveryCanIssueTicket, sshRecoveryProbeDelay,
  SSH_RECOVERY_WINDOW_MS} from './lib/ssh-recovery';
import {focusTerminalEscapeTarget,handleTerminalFocusEscape} from './lib/terminal-keyboard-escape';
import '@xterm/xterm/css/xterm.css';
import './ssh.css';

type Session = { id:string; name:string; server:string; windows:number };
type Host = { id:string; name:string; host:string; port:number; username:string; kind:'server'|'computer';
  group:string; authMethod:'password'|'key'; tmuxServer:string; jumpHostId:string|null; revision:number;
  hasCredential:boolean; fingerprint:string|null; defaultSession:Session|null };
type Secret = { password?:string; privateKey?:string; passphrase?:string };
type Challenge = { challenge:string; name:string; host:string; port:number; fingerprint:string; previousFingerprint:string|null; changed:boolean };
type Library = { hosts:Host[]; library:'local'|'account'; allowPrivateTargets:boolean };
type RecoveryIntent = { hostId:string; hostRevision:number; session:Session };
type RecoveryCycle = {intent:RecoveryIntent;startedAt:number;ticketAttempts:number;probes:number;
  lastProbeAt:number;timer:number|null;probing:boolean};
type HostInput = Pick<Host,'name'|'host'|'port'|'username'|'kind'|'group'|'authMethod'|'tmuxServer'|'jumpHostId'>;
const blank = (kind:Host['kind']):HostInput => ({name:'',host:'',port:22,username:'',kind,group:'',authMethod:'password',tmuxServer:'default',jumpHostId:null});
const same = (a:Session|null,b:Session|null) => Boolean(a&&b&&a.id===b.id&&a.server===b.server);

function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}) {
  const ref=useRef<HTMLDivElement>(null);
  useNativeBack(()=>{onClose();return true;},true);
  useEffect(()=>{
    const prior=document.activeElement as HTMLElement|null;
    ref.current?.querySelector<HTMLElement>('input,button')?.focus();
    return()=>{if(prior?.isConnected)prior.focus();};
  },[]);
  return <div className="ssh-modal-backdrop" onKeyDown={event=>{
    if(event.key==='Escape'){event.preventDefault();onClose();}
    if(event.key==='Tab'){
      const elements=Array.from(ref.current?.querySelectorAll<HTMLElement>('input:not([disabled]),button:not([disabled]),select,textarea,a[href]')||[]);
      const first=elements[0],last=elements.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  }}><div ref={ref} className="ssh-modal" role="dialog" aria-modal="true" aria-label={title}>
    <div className="ssh-heading"><h3>{title}</h3><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={20}/></button></div>{children}
  </div></div>;
}
function SecretFields({method,value,onChange}:{method:Host['authMethod'];value:Secret;onChange:(value:Secret)=>void}) {
  return method==='password'?<label>SSH 密码<input type="password" autoComplete="off" value={value.password||''} onChange={e=>onChange({password:e.target.value})}/></label>:
    <><label>私钥<textarea spellCheck={false} autoComplete="off" rows={5} value={value.privateKey||''} placeholder="粘贴 OpenSSH / PEM 私钥" onChange={e=>onChange({...value,privateKey:e.target.value})}/></label>
      <label>私钥口令（如有）<input type="password" autoComplete="off" value={value.passphrase||''} onChange={e=>onChange({...value,passphrase:e.target.value})}/></label></>;
}
function HostForm({host,kind,hosts,library,onClose,onSaved}:{host:Host|null;kind:Host['kind'];hosts:Host[];library:Library['library'];onClose:()=>void;onSaved:(host:Host,secret?:Secret)=>void}) {
  const [value,setValue]=useState<HostInput>(host||blank(kind));
  const [secret,setSecret]=useState<Secret>({});
  const [remember,setRemember]=useState(false),[forget,setForget]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const set=<K extends keyof HostInput>(key:K,v:HostInput[K])=>setValue(current=>({...current,[key]:v}));
  async function save(e:FormEvent) {
    e.preventDefault();setBusy(true);setError('');
    try {
      const result=await request<Host>(host?'PUT':'POST',host?`/api/ssh/hosts/${host.id}`:'/api/ssh/hosts',
        {...value,...(host?{expectedRevision:host.revision}:{}),rememberCredential:remember,
          forgetCredential:forget,...(remember?{credentials:secret}:{})});
      const supplied=secret.password||secret.privateKey?secret:undefined;
      setSecret({});onSaved(result,supplied);
    } catch(e){setError(errorMessage(e));} finally {setBusy(false);}
  }
  return <Modal title={host?'编辑 SSH 连接':'添加 SSH 连接'} onClose={()=>{if(!busy)onClose();}}>
    <form onSubmit={save} className="ssh-form">
      <div className="ssh-form-row"><label>连接名称<input required maxLength={80} value={value.name} placeholder="例如：开发服务器" onChange={e=>set('name',e.target.value)}/></label>
        <label>列表<select value={value.kind} onChange={e=>set('kind',e.target.value as Host['kind'])}><option value="server">服务器</option><option value="computer">电脑</option></select></label></div>
      <div className="ssh-form-row"><label>IP 或域名<input required autoCapitalize="none" autoCorrect="off" spellCheck={false} value={value.host} placeholder="例如：dev.example.com" onChange={e=>set('host',e.target.value)}/></label>
        <label>端口<input required type="number" min={1} max={65535} value={value.port} onChange={e=>set('port',Number(e.target.value))}/></label></div>
      <label>SSH 用户名<input required autoCapitalize="none" autoCorrect="off" autoComplete="off" value={value.username} placeholder="目标机器上的系统账号" onChange={e=>set('username',e.target.value)}/></label>
      <label>登录方式<select value={value.authMethod} onChange={e=>{set('authMethod',e.target.value as Host['authMethod']);setSecret({});setRemember(false);}}><option value="password">密码</option><option value="key">私钥</option></select></label>
      <SecretFields method={value.authMethod} value={secret} onChange={setSecret}/>
      <label className="ssh-check"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/>保存登录凭据，下次直接连接</label>
      {remember?<p className="ssh-help">凭据加密保存到{library==='local'?'这台电脑':'当前序程服务器'}，不会返回给网页。{library==='account'?'服务器管理员仍能读取；仅在你信任的服务上保存。':''}</p>:
        <p className="ssh-help">{host?.hasCredential?'留空使用已保存的凭据；新输入仅用于这次连接。':'密码或私钥仅用于这次连接，不会保存。'}</p>}
      {host?.hasCredential&&!remember&&<label className="ssh-check"><input type="checkbox" checked={forget} onChange={e=>setForget(e.target.checked)}/>删除已保存的登录凭据</label>}
      <details><summary>高级设置</summary><div className="ssh-form">
        <label>分组<input maxLength={60} value={value.group} placeholder="可选，例如：工作 / 家里" onChange={e=>set('group',e.target.value)}/></label>
        <label>跳板机<select value={value.jumpHostId||''} onChange={e=>set('jumpHostId',e.target.value||null)}><option value="">直接连接</option>{hosts.filter(h=>h.id!==host?.id&&!h.jumpHostId).map(h=><option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
        <label>tmux 服务名称<input value={value.tmuxServer} onChange={e=>set('tmuxServer',e.target.value)}/></label>
        <p className="ssh-help">普通 tmux 使用 default；只有原来通过 tmux -L 启动时才需要修改。</p>
        {host?.fingerprint&&<p className="ssh-fingerprint">已信任指纹：{host.fingerprint}</p>}
      </div></details>
      {error&&<p className="alert" role="alert">{error}</p>}
      <div className="ssh-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy}>{busy?'保存中…':'保存并连接'}</button></div>
    </form>
  </Modal>;
}

export default function SshPanel({onManaged}:{onManaged:()=>void}) {
  const [library,setLibrary]=useState<Library>({hosts:[],library:'local',allowPrivateTargets:true});
  const [kind,setKind]=useState<Host['kind']>('server'),[search,setSearch]=useState('');
  const [editing,setEditing]=useState<Host|null|undefined>(undefined);
  const [selected,setSelected]=useState<Host|null>(null);
  const [login,setLogin]=useState<Host|null>(null),[secret,setSecret]=useState<Secret>({}),[jumpSecret,setJumpSecret]=useState<Secret>({});
  const [challenge,setChallenge]=useState<Challenge|null>(null);
  const [sessions,setSessions]=useState<Session[]>([]),[current,setCurrent]=useState<Session|null>(null),[defaultSession,setDefault]=useState<Session|null>(null);
  const [available,setAvailable]=useState(true),[drawer,setDrawer]=useState(false),[newName,setNewName]=useState('');
  const [status,setStatus]=useState('未连接'),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [connected,setConnected]=useState(false),[ready,setReady]=useState(false);
  const [recoveringInitial,setRecoveringInitial]=useState(false);
  const [manualRecovery,setManualRecovery]=useState<RecoveryIntent|null>(null);
  const [remove,setRemove]=useState<Host|null>(null);
  const screen=useRef<HTMLDivElement>(null),term=useRef<Terminal|null>(null),fit=useRef<FitAddon|null>(null);
  const sessionBar=useRef<HTMLButtonElement>(null),headerAction=useRef<HTMLButtonElement>(null),backButton=useRef<HTMLButtonElement>(null),drawerElement=useRef<HTMLElement>(null),keyboardHelp=useRef<HTMLParagraphElement>(null);
  const socket=useRef<WebSocket|null>(null),generation=useRef<string|null>(null),sequence=useRef(0),epoch=useRef(0);
  const recoverySelectionSocket=useRef<WebSocket|null>(null);
  const selectedRef=useRef<Host|null>(null),currentRef=useRef<Session|null>(null),modeRef=useRef<'tmux'|'shell'|null>(null);
  const resuming=useRef<RecoveryIntent|null>(null),loginRecovery=useRef<RecoveryIntent|null>(null),mounted=useRef(true);
  const inFlightRecovery=useRef<RecoveryIntent|null>(null);
  const recoveryCycle=useRef<RecoveryCycle|null>(null),manualRecoveryRef=useRef<RecoveryIntent|null>(null),explicitRecovery=useRef(false);
  const autoRecoveryUsed=useRef(false),stableRecoveryTimer=useRef<number|null>(null);
  const jump=login?.jumpHostId?library.hosts.find(h=>h.id===login.jumpHostId):null;
  function returnToHosts(){resuming.current=null;disconnect();setSelected(null);selectedRef.current=null;void refresh();}
  useNativeBack(()=>{
    if(editing!==undefined||login||challenge||remove)return false;
    if(busy)return true;
    if(drawer){setDrawer(false);sessionBar.current?.focus();return true;}
    if(selected){returnToHosts();return true;}
    return false;
  },true);
  function offerManualRecovery(intent:RecoveryIntent|null){manualRecoveryRef.current=intent;setManualRecovery(intent);}
  function clearRecoveryCycle(){
    const cycle=recoveryCycle.current;
    if(cycle?.timer!==null&&cycle?.timer!==undefined)window.clearTimeout(cycle.timer);
    recoveryCycle.current=null;
  }
  function ensureRecoveryCycle(intent:RecoveryIntent):RecoveryCycle {
    const current=recoveryCycle.current;
    if(current&&sameSshRecovery(current.intent,intent))return current;
    clearRecoveryCycle();
    const cycle={intent,startedAt:Date.now(),ticketAttempts:0,probes:0,lastProbeAt:0,timer:null,probing:false};
    recoveryCycle.current=cycle;return cycle;
  }
  function stopAutomaticRecovery(intent:RecoveryIntent,message:string,offer=true){
    clearRecoveryCycle();resuming.current=null;autoRecoveryUsed.current=false;explicitRecovery.current=false;
    offerManualRecovery(offer?intent:null);setStatus(message);
  }
  function scheduleRecoveryProbe(cycle:RecoveryCycle){
    if(recoveryCycle.current!==cycle||cycle.timer!==null||cycle.probing)return;
    const remaining=SSH_RECOVERY_WINDOW_MS-(Date.now()-cycle.startedAt);
    if(remaining<=0||cycle.ticketAttempts>=3||cycle.probes>=20){
      stopAutomaticRecovery(cycle.intent,'原会话自动恢复次数已用尽，请明确核对原会话');return;
    }
    if(document.visibilityState!=='visible')return;
    cycle.timer=window.setTimeout(()=>{cycle.timer=null;void probeRecovery(cycle);},Math.min(remaining,sshRecoveryProbeDelay(cycle.probes)));
  }
  async function probeRecovery(cycle:RecoveryCycle){
    if(recoveryCycle.current!==cycle||cycle.probing||socket.current||document.visibilityState!=='visible')return;
    if(!sshRecoveryCanIssueTicket(cycle.ticketAttempts,cycle.startedAt,Date.now())||cycle.probes>=20){
      stopAutomaticRecovery(cycle.intent,'原会话自动恢复次数已用尽，请明确核对原会话');return;
    }
    // Focus/online events may accelerate a scheduled probe, but cannot flood GET.
    if(Date.now()-cycle.lastProbeAt<10000){
      if(cycle.timer===null){
        const remaining=SSH_RECOVERY_WINDOW_MS-(Date.now()-cycle.startedAt);
        cycle.timer=window.setTimeout(()=>{cycle.timer=null;void probeRecovery(cycle);},
          Math.min(remaining,10000-(Date.now()-cycle.lastProbeAt)));
      }
      return;
    }
    if(cycle.timer!==null){window.clearTimeout(cycle.timer);cycle.timer=null;}
    cycle.probing=true;cycle.probes++;cycle.lastProbeAt=Date.now();
    const atEpoch=epoch.current;
    try{
      const result=await request<Library>('GET','/api/ssh/hosts');
      if(recoveryCycle.current!==cycle||epoch.current!==atEpoch||!mounted.current)return;
      if(document.visibilityState!=='visible'){resuming.current=cycle.intent;return;}
      const host=result.hosts.find(item=>item.id===cycle.intent.hostId);
      if(!host||host.revision!==cycle.intent.hostRevision||selectedRef.current?.id!==host.id){
        stopAutomaticRecovery(cycle.intent,'主机资料已变化；不会自动进入默认会话',false);return;
      }
      setLibrary(result);resuming.current=null;autoRecoveryUsed.current=true;choose(host,undefined,cycle.intent);
    }catch(error){
      if(recoveryCycle.current!==cycle||epoch.current!==atEpoch||!mounted.current)return;
      if(!isSshNetworkFailure(error)&&!(error instanceof ReadTimeoutError)){
        stopAutomaticRecovery(cycle.intent,'原会话恢复已停止，请核对连接和授权',false);setError(errorMessage(error));
      }else setStatus('网络尚未恢复；将有限次数核对原 tmux 会话');
    }finally{
      cycle.probing=false;
      if(recoveryCycle.current===cycle&&resuming.current)scheduleRecoveryProbe(cycle);
    }
  }
  function disconnect(message='已断开',preserveRecovery=false) {
    if(stableRecoveryTimer.current!==null){window.clearTimeout(stableRecoveryTimer.current);stableRecoveryTimer.current=null;}
    if(!preserveRecovery){resuming.current=null;clearRecoveryCycle();offerManualRecovery(null);explicitRecovery.current=false;}
    loginRecovery.current=null;inFlightRecovery.current=null;setLogin(null);setSecret({});setJumpSecret({});
    epoch.current++;const old=socket.current;socket.current=null;recoverySelectionSocket.current=null;generation.current=null;
    currentRef.current=null;modeRef.current=null;
    old?.close();setConnected(false);setReady(false);setRecoveringInitial(false);setChallenge(null);setStatus(message);
  }
  function currentRecovery():RecoveryIntent|null {
    const host=selectedRef.current,session=currentRef.current;
    return socket.current&&generation.current&&modeRef.current==='tmux'&&host&&session
      ?{hostId:host.id,hostRevision:host.revision,session}:null;
  }
  const refresh=async()=>{
    try {const result=await request<Library>('GET','/api/ssh/hosts');if(mounted.current)setLibrary(result);}
    catch(e){if(mounted.current)setError(errorMessage(e));}
  };
  useEffect(()=>{
    mounted.current=true;void refresh();
    return()=>{mounted.current=false;epoch.current++;resuming.current=null;loginRecovery.current=null;clearRecoveryCycle();manualRecoveryRef.current=null;
      if(stableRecoveryTimer.current!==null)window.clearTimeout(stableRecoveryTimer.current);
      socket.current?.close();socket.current=null;generation.current=null;currentRef.current=null;modeRef.current=null;};
  },[]);
  useEffect(()=>{
    const shelveLoginRecovery=()=>{
      if(!socket.current&&loginRecovery.current){
        const recovery=loginRecovery.current;
        if(explicitRecovery.current){explicitRecovery.current=false;offerManualRecovery(recovery);resuming.current=null;}
        else {resuming.current=recovery;autoRecoveryUsed.current=false;}
        disconnect('网络中断；返回后核对原 tmux 会话',true);return true;
      }
      return false;
    };
    const resume=(recovery:RecoveryIntent)=>{resuming.current=recovery;void probeRecovery(ensureRecoveryCycle(recovery));};
    const offline=()=>{if(shelveLoginRecovery()||!socket.current)return;
      const wasTmux=modeRef.current==='tmux';
      const exact=currentRecovery()||inFlightRecovery.current,recovery=autoRecoveryUsed.current&&!inFlightRecovery.current?null:exact;resuming.current=recovery;
      disconnect(recovery?'网络中断；将核对原 tmux 会话，输入不会自动补发':wasTmux?'原 tmux 会话自动恢复未稳定；请重新连接后核对':'网络中断；普通 Shell 不会自动重开',Boolean(recovery));
      if(exact&&!recovery)offerManualRecovery(exact);};
    const visible=()=>{
      if(document.visibilityState==='hidden'){if(shelveLoginRecovery())return;if(socket.current){const wasTmux=modeRef.current==='tmux'||Boolean(inFlightRecovery.current);const exact=currentRecovery()||inFlightRecovery.current,recovery=autoRecoveryUsed.current&&!inFlightRecovery.current?null:exact;resuming.current=recovery;
        disconnect(recovery?'远程 tmux 已保留；返回后核对原会话':wasTmux?'原 tmux 会话自动恢复未稳定；请重新连接后核对':'普通 Shell 已断开，请手动重新连接',Boolean(recovery));
        if(exact&&!recovery)offerManualRecovery(exact);}}
      else if(resuming.current){resume(resuming.current);}
    };
    window.addEventListener('offline',offline);window.addEventListener('online',visible);window.addEventListener('focus',visible);window.addEventListener('pageshow',visible);document.addEventListener('visibilitychange',visible);
    return()=>{window.removeEventListener('offline',offline);window.removeEventListener('online',visible);window.removeEventListener('focus',visible);window.removeEventListener('pageshow',visible);document.removeEventListener('visibilitychange',visible);};
  },[library.hosts]);
  function send(type:string,values:Record<string,unknown>={}) {
    if(!socket.current||socket.current.readyState!==WebSocket.OPEN||!navigator.onLine||document.visibilityState!=='visible')return false;
    socket.current.send(JSON.stringify({v:1,type,...values}));return true;
  }
  function sendInput(data:string) {
    if(!generation.current)return;
    if(!send('input',{generation:generation.current,sequence:sequence.current+1,data}))return;
    sequence.current++;
  }
  useEffect(()=>{
    if(!screen.current||!selected)return;
    const terminal=new Terminal({cursorBlink:true,fontSize:14,fontFamily:'SFMono-Regular, Menlo, Consolas, monospace',
      scrollback:5000,theme:{background:'#101722',foreground:'#e4eaf4'},allowProposedApi:false,disableStdin:true});
    const addon=new FitAddon();terminal.loadAddon(addon);terminal.open(screen.current);term.current=terminal;fit.current=addon;
    if(terminal.textarea){terminal.textarea.tabIndex=-1;terminal.textarea.setAttribute('aria-describedby','ssh-terminal-keyboard-help');}
    terminal.attachCustomKeyEventHandler(event=>{
      if(handleTerminalFocusEscape(event,()=>{
        focusTerminalEscapeTarget(sessionBar.current,keyboardHelp.current);
      }))return false;
      if(event.ctrlKey&&event.shiftKey&&!event.altKey&&!event.metaKey&&!event.isComposing&&
        (event.code==='KeyM'||(!event.code||event.code==='Unidentified')&&event.key.toLowerCase()==='m')){
        event.preventDefault();
        if(event.type==='keydown'){
          focusTerminalEscapeTarget(sessionBar.current,keyboardHelp.current);
        }
        return false;
      }
      return true;
    });
    const resize=()=>{try{addon.fit();send('resize',{rows:terminal.rows,cols:terminal.cols});}catch{/* hidden */}};
    const observer=new ResizeObserver(resize);observer.observe(screen.current);resize();
    const input=terminal.onData(sendInput);
    return()=>{input.dispose();observer.disconnect();terminal.dispose();term.current=null;fit.current=null;};
  },[selected?.id]);
  useEffect(()=>{
    const terminal=term.current;
    if(terminal){terminal.options.disableStdin=!ready;if(terminal.textarea)terminal.textarea.tabIndex=ready?0:-1;}
  },[ready,selected?.id]);
  useEffect(()=>{
    if(drawer&&connected){
      const first=drawerElement.current?.querySelector<HTMLButtonElement>('.ssh-session-select:not([disabled])');
      (first||drawerElement.current?.querySelector<HTMLButtonElement>('[aria-label="收起会话列表"]'))?.focus();
    }
  },[drawer,connected,recoveringInitial]);
  function choose(host:Host,provided?:Secret,recovery:RecoveryIntent|null=null) {
    if(!recovery){autoRecoveryUsed.current=false;clearRecoveryCycle();offerManualRecovery(null);explicitRecovery.current=false;}
    setError('');setNotice('');resuming.current=null;loginRecovery.current=recovery;
    const bridge=host.jumpHostId?library.hosts.find(h=>h.id===host.jumpHostId):null;
    if(!host.hasCredential&&!provided||bridge&&!bridge.hasCredential){setSecret(provided||{});setJumpSecret({});setLogin(host);}
    else void connect(host,provided,undefined,recovery);
  }
  async function recoverOriginalSession(){
    const intent=manualRecoveryRef.current;
    if(!intent||busy)return;
    const atEpoch=epoch.current;
    setBusy(true);setError('');setStatus('正在核对原会话的主机资料…');
    try{
      const result=await request<Library>('GET','/api/ssh/hosts');
      if(!mounted.current||epoch.current!==atEpoch||manualRecoveryRef.current!==intent)return;
      const host=result.hosts.find(item=>item.id===intent.hostId);
      if(!host||host.revision!==intent.hostRevision||selectedRef.current?.id!==host.id){
        offerManualRecovery(null);setStatus('主机资料已变化；原会话不能按旧身份恢复');return;
      }
      setLibrary(result);explicitRecovery.current=true;choose(host,undefined,intent);
    }catch(error){
      if(!mounted.current||epoch.current!==atEpoch||manualRecoveryRef.current!==intent)return;
      setError(errorMessage(error));
      if(!isSshNetworkFailure(error)&&!(error instanceof ReadTimeoutError))offerManualRecovery(null);
      setStatus('原会话尚未恢复；不会进入默认会话');
    }finally{if(mounted.current&&epoch.current===atEpoch)setBusy(false);}
  }
  async function connect(host:Host,provided?:Secret,providedJump?:Secret,recovery:RecoveryIntent|null=null) {
    if(recovery&&!explicitRecovery.current){
      const cycle=ensureRecoveryCycle(recovery);
      if(!sshRecoveryCanIssueTicket(cycle.ticketAttempts,cycle.startedAt,Date.now())){
        stopAutomaticRecovery(recovery,'原会话自动恢复次数已用尽，请明确核对原会话');return;
      }
      cycle.ticketAttempts++;
      if(cycle.timer!==null){window.clearTimeout(cycle.timer);cycle.timer=null;}
    }
    disconnect('已断开',Boolean(recovery));loginRecovery.current=null;inFlightRecovery.current=recovery;
    setSelected(host);selectedRef.current=host;setSessions([]);setCurrent(null);setDefault(host.defaultSession);
    setStatus('正在连接…');setBusy(true);setRecoveringInitial(Boolean(recovery));setError('');setNotice('');setDrawer(false);
    const attempt=epoch.current;
    try {
      const ticket=await request<{ticket:string;websocketUrl:string}>('POST','/api/ssh/tickets',{hostId:host.id,credentials:provided,jumpCredentials:providedJump,
        ...(recovery?{recoverSession:{id:recovery.session.id,server:recovery.session.server},expectedHostRevision:recovery.hostRevision}:{})});
      if(!mounted.current||attempt!==epoch.current)return;
      if(recovery&&document.visibilityState!=='visible'){
        if(explicitRecovery.current){explicitRecovery.current=false;offerManualRecovery(recovery);}
        else {resuming.current=recovery;autoRecoveryUsed.current=false;}
        setRecoveringInitial(false);setStatus('原 tmux 会话保留；返回后重新核对');return;
      }
      const url=new URL(ticket.websocketUrl,location.href);url.protocol=url.protocol==='https:'?'wss:':url.protocol==='http:'?'ws:':url.protocol;
      const ws=new WebSocket(url);socket.current=ws;let recoveredReady=false,awaitingRecovery=recovery,recoveryMissing=false,reportedError=false;
      ws.onopen=()=>{if(socket.current===ws)ws.send(JSON.stringify({v:1,type:'auth',ticket:ticket.ticket}));};
      ws.onmessage=event=>{
        if(socket.current!==ws)return;
        try{
          const value=JSON.parse(event.data);
          if(value.type==='hostKey'){setChallenge(value);setStatus('请确认服务器身份');}
          else if(value.type==='connected'){setConnected(true);setStatus('SSH 已连接');setSelected(value.host);selectedRef.current=value.host;void refresh();}
          else if(value.type==='sessions'){
            setSessions(value.sessions);setAvailable(value.available);setDefault(value.defaultSession);
            if(Number.isInteger(value.hostRevision)&&value.hostRevision>0&&selectedRef.current?.id===host.id){
              const updated={...selectedRef.current,revision:value.hostRevision,defaultSession:value.defaultSession};
              selectedRef.current=updated;setSelected(updated);
              setLibrary(current=>({...current,hosts:current.hosts.map(item=>item.id===updated.id?updated:item)}));
            }
            if(!generation.current)setDrawer(true);
          }
          else if(value.type==='recoverySettled'&&awaitingRecovery&&value.outcome==='missing'&&same(value.session,awaitingRecovery.session)){
            awaitingRecovery=null;inFlightRecovery.current=null;recoveryMissing=true;setRecoveringInitial(false);setDrawer(true);
            clearRecoveryCycle();offerManualRecovery(null);explicitRecovery.current=false;
            setStatus('原会话未能核对，请明确选择仍存在的会话');
          }
          else if(value.type==='ready'){
            if(recoveryMissing&&recoverySelectionSocket.current!==ws){setError('原会话恢复现场已变化；输入未开放。');disconnect();return;}
            if(awaitingRecovery&&!same(value.session,awaitingRecovery.session)){setError('原 tmux 会话身份未核对成功；输入未开放。');disconnect();return;}
            if(awaitingRecovery){recoveredReady=true;awaitingRecovery=null;setRecoveringInitial(false);
              inFlightRecovery.current=null;
              clearRecoveryCycle();offerManualRecovery(null);explicitRecovery.current=false;
              stableRecoveryTimer.current=window.setTimeout(()=>{stableRecoveryTimer.current=null;
                if(socket.current===ws&&generation.current===value.generation)autoRecoveryUsed.current=false;
              },30000);}
            generation.current=value.generation;sequence.current=0;currentRef.current=value.session;modeRef.current=value.mode==='tmux'?'tmux':'shell';
            setCurrent(value.session);setReady(true);setDrawer(false);setStatus('已连接');term.current?.reset();
            if(term.current){term.current.options.disableStdin=false;if(term.current.textarea)term.current.textarea.tabIndex=0;}
            try{fit.current?.fit();}catch{}send('resize',{rows:term.current?.rows,cols:term.current?.cols});term.current?.focus();}
          else if(value.type==='output'&&value.generation===generation.current)term.current?.write(value.data);
          else if(value.type==='exit'){generation.current=null;currentRef.current=null;modeRef.current=null;setReady(false);setStatus(value.message);setDrawer(true);}
          else if(value.type==='error'){if(awaitingRecovery){reportedError=true;inFlightRecovery.current=null;clearRecoveryCycle();resuming.current=null;explicitRecovery.current=false;offerManualRecovery(null);}setError(value.message);setBusy(false);}
          else if(value.type==='notice')setNotice(value.message);
          else if(value.type==='disconnected')setNotice(value.message);
        }catch{setError('终端响应无法识别，请重新连接。');disconnect();}
      };
      ws.onclose=event=>{if(socket.current!==ws)return;
        const exact=currentRecovery();
        const next=event.code===1006&&(!recovery||recoveredReady||recoveryMissing&&recoverySelectionSocket.current===ws)&&!autoRecoveryUsed.current?exact:null;
        socket.current=null;inFlightRecovery.current=null;recoverySelectionSocket.current=null;generation.current=null;currentRef.current=null;modeRef.current=null;setConnected(false);setReady(false);setRecoveringInitial(false);setChallenge(null);
        if(next){resuming.current=next;setStatus('连接中断；将核对原 tmux 会话，不会重发输入');
          queueMicrotask(()=>{if(resuming.current===next)void probeRecovery(ensureRecoveryCycle(next));});}
        else if(recovery&&!recoveredReady&&!recoveryMissing&&!reportedError&&event.code===1006){
          if(explicitRecovery.current){explicitRecovery.current=false;offerManualRecovery(recovery);setStatus('原会话尚未恢复；请明确重试核对');}
          else {autoRecoveryUsed.current=false;resuming.current=recovery;setStatus('网络中断；将有限次数核对原 tmux 会话');scheduleRecoveryProbe(ensureRecoveryCycle(recovery));}
        }else if(exact&&autoRecoveryUsed.current){offerManualRecovery(exact);setStatus('原会话自动恢复未稳定；请明确核对原会话');}
        else setStatus('已断开，可重新连接');};
      ws.onerror=()=>{if(socket.current===ws)setError('终端连接失败，请检查网络或服务器配置。');};
    }catch(e){if(attempt===epoch.current){setRecoveringInitial(false);
      if(recovery&&isSshNetworkFailure(e)){
        setError('网络暂不可达；原 tmux 会话仍保留，不会重发输入');
        if(explicitRecovery.current){explicitRecovery.current=false;offerManualRecovery(recovery);setStatus('请在网络恢复后明确核对原会话');}
        else {autoRecoveryUsed.current=false;resuming.current=recovery;setStatus('等待网络恢复并核对原 tmux 会话');scheduleRecoveryProbe(ensureRecoveryCycle(recovery));}
      }else{if(recovery){clearRecoveryCycle();resuming.current=null;explicitRecovery.current=false;offerManualRecovery(null);}
        setError(errorMessage(e));setStatus('连接失败');}
    }}
    finally{if(attempt===epoch.current)setBusy(false);}
  }
  function selectSession(session:Session|null) {
    if(recoveringInitial)return;
    recoverySelectionSocket.current=socket.current;
    autoRecoveryUsed.current=false;
    if(stableRecoveryTimer.current!==null){window.clearTimeout(stableRecoveryTimer.current);stableRecoveryTimer.current=null;}
    generation.current=null;currentRef.current=null;modeRef.current=null;setReady(false);setStatus('正在打开…');
    send(session?'select':'shell',session?{session}:{});
  }
  const filtered=library.hosts.filter(h=>h.kind===kind&&`${h.name} ${h.host} ${h.username} ${h.group}`.toLowerCase().includes(search.toLowerCase()));
  const active=selected!==null;
  return <div className={`ssh-page ${active?'ssh-active':''}`}>
    {!active?<><div className="ssh-heading"><div><h2>终端</h2><p>连接你的服务器和电脑，继续原来的工作。</p></div><button className="primary" onClick={()=>setEditing(null)}><Plus size={17}/>添加连接</button></div>
      <div className="ssh-library-bar"><div className="ssh-tabs" role="group" aria-label="主机列表"><button aria-pressed={kind==='server'} onClick={()=>setKind('server')}><Server size={17}/>服务器</button><button aria-pressed={kind==='computer'} onClick={()=>setKind('computer')}><Computer size={17}/>电脑</button></div>
        <input aria-label="搜索主机" placeholder="搜索名称、地址或分组" value={search} onChange={e=>setSearch(e.target.value)}/></div>
      {error&&<p className="alert" role="alert">{error}</p>}
      <div className="ssh-host-grid">{filtered.map(host=><article className="ssh-host-card" key={host.id}>
        <button className="ssh-host-open" onClick={()=>choose(host)}><span className="ssh-host-icon">{host.kind==='server'?<Server/>:<Computer/>}</span><strong>{host.name}</strong><span>{host.username}@{host.host}:{host.port}</span><small>{host.group||'SSH 连接'}{host.defaultSession?` · 默认：${host.defaultSession.name}`:''}</small></button>
        <div className="ssh-host-actions"><button onClick={()=>setEditing(host)} aria-label={`编辑 ${host.name}`}><Settings2 size={16}/>编辑</button><button onClick={()=>{setError('');setRemove(host);}}>移除</button></div>
      </article>)}</div>
      {!filtered.length&&<div className="ssh-empty"><Server size={32}/><h3>{search?'没有匹配的连接':`添加第一台${kind==='server'?'服务器':'电脑'}`}</h3><p>填写 IP、用户名和密码或密钥，即可连接目标机器。</p><button className="secondary" onClick={()=>setEditing(null)}>添加 SSH 连接</button></div>}
      <div className="ssh-library-footer"><span>{library.library==='local'?'本机主机库 · SSH 从这台电脑发起':'账号主机库 · SSH 通过当前序程服务连接'}</span><button className="secondary" onClick={onManaged}>本机与已绑定电脑</button></div>
    </>:<>
      <div className="ssh-heading ssh-terminal-heading"><button ref={backButton} className="secondary" onClick={returnToHosts}>返回主机列表</button>
        <div><strong>{selected.name}</strong><small>{selected.username}@{selected.host}:{selected.port} · {status}</small></div>
        <button ref={headerAction} className="secondary" disabled={busy} onClick={()=>connected?disconnect():choose(selected)}>{connected?'断开':'新连接'}</button></div>
      {!connected&&<p className="ssh-help">主动新连接会尝试默认会话；原 tmux 会话不会因此关闭。暂时断线会核对断线前的会话。</p>}
      {!connected&&manualRecovery&&selected.id===manualRecovery.hostId&&<button className="secondary" disabled={busy} onClick={()=>void recoverOriginalSession()}>恢复原会话</button>}
      {error&&<p className="alert" role="alert">{error}</p>}{notice&&<p className="ssh-help" role="status">{notice}</p>}
      <div ref={screen} className="ssh-screen" aria-label="SSH 终端"/>
      <p id="ssh-terminal-keyboard-help" ref={keyboardHelp} tabIndex={-1} className="ssh-help">Shift+Esc 返回页面控件；Ctrl+Shift+M 返回会话选择</p>
      <div className="ssh-shortcuts" aria-label="终端快捷键">{[['Esc','\x1b'],['Tab','\t'],['Ctrl C','\x03'],['↑','\x1b[A'],['↓','\x1b[B'],['←','\x1b[D'],['→','\x1b[C']].map(([label,data])=><button key={label} disabled={!ready} onClick={()=>{sendInput(data);term.current?.focus();}}>{label}</button>)}</div>
      <button ref={sessionBar} className="ssh-session-bar" disabled={!connected||recoveringInitial} onClick={()=>{const opening=!drawer;setDrawer(opening);if(opening)send('list');else sessionBar.current?.focus();}}><span>会话：{current?.name||(ready?'普通 Shell':'选择 tmux 会话')}</span><ChevronDown size={18}/></button>
      {drawer&&connected&&<section ref={drawerElement} className="ssh-session-drawer" aria-label="tmux 会话">
        <div className="ssh-heading"><strong>此主机上的 tmux 会话</strong><button className="icon-button" aria-label="收起会话列表" onClick={()=>{setDrawer(false);sessionBar.current?.focus();}}><X size={20}/></button></div>
        {!available&&<p>此连接暂时无法读取 tmux。你可以先打开普通 Shell，检查或安装 tmux。</p>}
        {available&&!sessions.length&&<p>当前用户还没有 tmux 会话，可以新建一个。</p>}
        {sessions.map(session=><div key={`${session.server}/${session.id}`} className="ssh-session-row"><button className="ssh-session-select" disabled={recoveringInitial} onClick={()=>selectSession(session)}><strong>{session.name}</strong><span>{session.windows} 个窗口{same(current,session)?' · 当前':''}{same(defaultSession,session)?' · 默认':''}</span></button><button className="secondary" disabled={recoveringInitial} onClick={()=>send('default',{session:same(defaultSession,session)?null:session})}>{same(defaultSession,session)?'取消默认':'设为默认'}</button></div>)}
        {defaultSession&&!sessions.some(session=>same(defaultSession,session))&&<div className="ssh-session-row"><span>默认会话未显示在当前列表中。</span><button className="secondary" disabled={recoveringInitial} onClick={()=>send('default',{session:null})}>取消默认</button></div>}
        {available&&<form className="ssh-create-session" onSubmit={e=>{e.preventDefault();if(recoveringInitial)return;recoverySelectionSocket.current=socket.current;autoRecoveryUsed.current=false;
          if(stableRecoveryTimer.current!==null){window.clearTimeout(stableRecoveryTimer.current);stableRecoveryTimer.current=null;}
          generation.current=null;currentRef.current=null;modeRef.current=null;setReady(false);send('create',{name:newName});setNewName('');}}><input aria-label="新会话名称" required pattern="[A-Za-z0-9_][A-Za-z0-9_-]{0,63}" value={newName} placeholder="新会话名称，例如 main" onChange={e=>setNewName(e.target.value)}/><button className="secondary" disabled={recoveringInitial}>新建</button></form>}
        <button className="secondary" disabled={recoveringInitial} onClick={()=>selectSession(null)}>打开普通 Shell</button>
        <p className="ssh-help">切换不会关闭原 tmux 中的程序。下次连接自动进入默认会话。</p>
      </section>}
    </>}
    {editing!==undefined&&<HostForm host={editing} kind={kind} hosts={library.hosts} library={library.library} onClose={()=>setEditing(undefined)} onSaved={(host,provided)=>{setEditing(undefined);setKind(host.kind);void refresh();choose(host,provided);}}/>}
    {login&&<Modal title={`连接 ${login.name}`} onClose={()=>{if(loginRecovery.current){clearRecoveryCycle();resuming.current=null;offerManualRecovery(null);autoRecoveryUsed.current=false;}
      loginRecovery.current=null;explicitRecovery.current=false;setLogin(null);setSecret({});setJumpSecret({});}}>
      <form className="ssh-form" onSubmit={e=>{e.preventDefault();const target=login;const credential=secret.password||secret.privateKey?secret:undefined;const jumpCredential=jumpSecret;
        const recovery=loginRecovery.current;loginRecovery.current=null;setLogin(null);setSecret({});setJumpSecret({});void connect(target,credential,jump?.hasCredential?undefined:jumpCredential,recovery);}}>
        <p>{login.username}@{login.host}:{login.port}</p>
        {!login.hasCredential&&<SecretFields method={login.authMethod} value={secret} onChange={setSecret}/>}
        {jump&&!jump.hasCredential&&<><h4>跳板机：{jump.name}</h4><SecretFields method={jump.authMethod} value={jumpSecret} onChange={setJumpSecret}/></>}
        <p className="ssh-help">本次输入不会保存。可在编辑连接时选择保存凭据。</p><button className="primary">连接 SSH</button>
      </form>
    </Modal>}
    {challenge&&<Modal title={challenge.changed?'服务器身份发生变化':'首次连接，确认服务器身份'} onClose={()=>disconnect()}>
      <div className="ssh-form"><ShieldCheck size={28}/><p>{challenge.name} · {challenge.host}:{challenge.port}</p><code className="ssh-fingerprint">{challenge.fingerprint}</code>
        {challenge.changed&&<p className="alert">与之前保存的指纹不同。请向服务器管理员核对，未确认前不要继续。</p>}
        <p>请与目标机器的 SSH 主机公钥指纹核对。确认后才会发送登录凭据。</p>
        <div className="ssh-actions"><button className="secondary" onClick={()=>disconnect()}>取消连接</button><button className="primary" onClick={()=>{send('trust',{challenge:challenge.challenge,fingerprint:challenge.fingerprint,approve:true,replace:challenge.changed});setChallenge(null);setStatus('正在登录…');}}>已核对，信任并连接</button></div>
      </div>
    </Modal>}
    {remove&&<Modal title={`移除 ${remove.name}`} onClose={()=>setRemove(null)}><p>只移除保存的连接资料，不会删除目标机器上的文件或 tmux 会话。</p>{error&&<p className="alert" role="alert">{error}</p>}<div className="ssh-actions"><button className="secondary" onClick={()=>setRemove(null)}>取消</button><button className="primary" onClick={()=>{void request('POST',`/api/ssh/hosts/${remove.id}/remove`,{expectedRevision:remove.revision}).then(()=>{setRemove(null);void refresh();}).catch(e=>setError(errorMessage(e)));}}>移除连接</button></div></Modal>}
  </div>;
}
