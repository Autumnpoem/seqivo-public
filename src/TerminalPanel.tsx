import {useNativeBack} from './lib/use-native-back';
import {useCallback,useEffect,useMemo,useRef,useState,type FormEvent} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {ChevronDown,CloudOff,Keyboard,PlugZap,RefreshCw,ShieldCheck,TerminalSquare,X} from 'lucide-react';
import {ApiError,errorMessage,request} from './api';
import type {BoardState} from './types';
import {TerminalClient} from './terminal-client';
import TerminalReturnReview from './TerminalReturnReview';
import type {ControlState,ControlTarget,HubTerminalStatus,LocalTerminalStatus,SessionRef,TerminalProfile,TerminalSession,TerminalStatus,TerminalScope,TransferEvent,WslAvailability} from './terminal-types';
import '@xterm/xterm/css/xterm.css';
import {focusTerminalEscapeTarget,handleTerminalFocusEscape} from './lib/terminal-keyboard-escape';
import {canAutoRevealTerminal,isTerminalControlFocus} from './lib/terminal-mobile-focus';
import './terminal.css';

type Target={nodeId?:string;profileId:string;profile:TerminalProfile;scopes:TerminalScope[]};
type ReachabilityBinding={client:TerminalClient;targetKey:string;mode:'local'|'hub';deviceId:string|null;projectId:string|null|undefined;scopes:string};
type ReachabilityCheck={binding:ReachabilityBinding;cycle:number};
type PendingPaste={text:string;client:TerminalClient;context:NonNullable<TerminalClient['inputContext']>};
type ProfileDraft={id:string|null;runtime:'native'|'wsl';label:string;projectId:string;cwd:string;distro:string;wslCwd:string;serverName:string;tmuxExecutable:string;allowSharedServer:boolean};
const newProfileDraft=(projectId=''):ProfileDraft=>({id:null,runtime:'native',label:'',projectId,cwd:'',distro:'',wslCwd:'',serverName:'',tmuxExecutable:'',allowSharedServer:false});
function sameRef(a:SessionRef|null,b:SessionRef|null){return !!a&&!!b&&a.serverName===b.serverName&&a.instanceId===b.instanceId&&a.sessionId===b.sessionId;}
function shortId(value:string){return value.slice(0,8);}
function targetLabel(value:ControlTarget){return value.local?'这台电脑':`设备 ${value.deviceId?shortId(value.deviceId):'未知'} · 连接 ${shortId(value.connectionId)}`;}
function statusLabel(value:string){return ({connecting:'正在连接',authenticating:'正在验证',opening:'正在打开',ready:'已连接',selecting:'请选择会话',redrawing:'正在重绘',output_gap:'输出不完整',control_wait:'等待接管',disconnecting:'正在断开',disconnected:'已断开',error:'连接出错'} as Record<string,string>)[value]||value;}
function isLocal(value:TerminalStatus):value is LocalTerminalStatus{return 'mode'in value&&value.mode==='local';}
function targetsFor(status:TerminalStatus):Target[]{
  if(isLocal(status))return !status.enabled||status.plugin&&(status.plugin.status!=='ready'||status.plugin.enabled!==true)?[]:status.profiles.filter(profile=>profile.enabled!==false).map(profile=>({profileId:profile.id,profile,scopes:profile.runtime==='wsl'?['view','input','create','default']:['view','input','create','default','takeover']}));
  return status.nodes.flatMap(node=>node.profiles.flatMap(profile=>{const grant=status.grants.find(item=>item.nodeId===node.nodeId&&item.profileId===profile.id);return grant?[{nodeId:node.nodeId,profileId:profile.id,profile,scopes:profile.runtime==='wsl'?grant.scopes.filter(scope=>scope!=='takeover'):grant.scopes}]:[];}));
}
function scopeKey(scopes:TerminalScope[]){return [...scopes].sort().join(',');}
const OWNER_SESSION_RECOVERY_NOTICE='正在核对选中的原会话；默认会话不会改变。';

export default function TerminalPanel({board,projectId}:{board:BoardState;projectId?:string}){
  const [status,setStatus]=useState<TerminalStatus|null>(null);
  const [loading,setLoading]=useState(true);
  const [statusLoadError,setStatusLoadError]=useState(false);
  const [browserOnline,setBrowserOnline]=useState(()=>navigator.onLine);
  const [error,setError]=useState('');
  const [notice,setNoticeState]=useState('');
  const [busy,setBusy]=useState(false);
  const [targetKey,setTargetKey]=useState('');
  const [shellMode,setShellMode]=useState(false);
  const [readOnlyMode,setReadOnlyMode]=useState(false);
  const [connection,setConnection]=useState('disconnected');
  const [connectionMessage,setConnectionMessage]=useState('');
  const [sessions,setSessions]=useState<TerminalSession[]>([]);
  const [tmuxAvailable,setTmuxAvailable]=useState(true);
  const [defaultRef,setDefaultRef]=useState<SessionRef|null>(null);
  const [currentRef,setCurrentRef]=useState<SessionRef|null>(null);
  const [drawer,setDrawer]=useState(false);
  const [existingPicker,setExistingPicker]=useState<'takeover'|'extend'|null>(null);
  const [existingSelection,setExistingSelection]=useState<SessionRef[]>([]);
  const [createName,setCreateName]=useState('');
  const [deviceLabel,setDeviceLabel]=useState('我的手机');
  const [enrollCode,setEnrollCode]=useState('');
  const [confirmationExpiresAt,setConfirmationExpiresAt]=useState<number|null>(null);
  const [grantDevice,setGrantDevice]=useState('');
  const [grantCode,setGrantCode]=useState('');
  const [grantScopes,setGrantScopes]=useState<TerminalScope[]>(['view','input','create','default']);
  const [control,setControl]=useState<ControlState|null>(null);
  const [takeoverConfirm,setTakeoverConfirm]=useState(false);
  const [takeoverUnknownConsentKey,setTakeoverUnknownConsentKey]=useState('');
  const [recoveryConfirm,setRecoveryConfirm]=useState(false);
  const [recoverySelection,setRecoverySelection]=useState<SessionRef|null>(null);
  const [recoveryOptions,setRecoveryOptions]=useState<TerminalSession[]>([]);
  const [recoveryListPending,setRecoveryListPending]=useState(false);
  const [recoverySelectionPending,setRecoverySelectionPending]=useState(false);
  const [releaseConfirm,setReleaseConfirm]=useState(false);
  const [returnNotes,setReturnNotes]=useState('');
  const [lastControlAction,setLastControlAction]=useState<'acquire'|'release'>('acquire');
  const [transferTargets,setTransferTargets]=useState<ControlTarget[]|null>(null);
  const [transferChoice,setTransferChoice]=useState('');
  const [transferRequesting,setTransferRequesting]=useState(false);
  const [transferActive,setTransferActive]=useState<{transferId:string;expiresAt:number;targetConnectionId:string}|null>(null);
  const [transferOffer,setTransferOffer]=useState<{transferId:string;expiresAt:number;fromDeviceId:string|null}|null>(null);
  const [transferAccepting,setTransferAccepting]=useState(false);
  const [profileDraft,setProfileDraft]=useState<ProfileDraft>(()=>newProfileDraft(projectId));
  const [profileEditorOpen,setProfileEditorOpen]=useState(false);
  const [wslAvailability,setWslAvailability]=useState<WslAvailability|null>(null);
  const [wslAvailabilityError,setWslAvailabilityError]=useState('');
  const lastTakeoverUnknownKeyRef=useRef('[]');
  const [wslAvailabilityLoading,setWslAvailabilityLoading]=useState(false);
  const [ctrlArmed,setCtrlArmed]=useState(false);
  const [pendingPaste,setPendingPaste]=useState<PendingPaste|null>(null);
  const hostRef=useRef<HTMLDivElement>(null);
  const xtermRef=useRef<Terminal|null>(null);
  const fitRef=useRef<FitAddon|null>(null);
  const clientRef=useRef<TerminalClient|null>(null);
  const reachabilityBindingRef=useRef<ReachabilityBinding|null>(null);
  const targetRef=useRef('');
  const defaultAfterCreate=useRef(false);
  const extensionPending=useRef(false);
  const disconnectPending=useRef(false);
  const ctrlArmedRef=useRef(false);
  const pendingPasteRef=useRef<PendingPaste|null>(null);
  const recoveryListRequestRef=useRef<string|null>(null);
  const transferResultNoticeRef=useRef<{client:TerminalClient;transferId:string|null;message:string;source:'ended'|'failed'}|null>(null);
  const mobileCanRevealRef=useRef(false);
  const mobileRevealRequestedRef=useRef(false);
  const mobileManualViewRef=useRef(false);
  const mobileLayoutFrameRef=useRef<number|null>(null);
  function setNotice(message:string){transferResultNoticeRef.current=null;setNoticeState(message);}
  function setTransferResultNotice(client:TerminalClient,transferId:string|null,source:'ended'|'failed',message:string){
    transferResultNoticeRef.current={client,transferId,source,message};setNoticeState(message);
  }
  function clearResolvedTransferNotice(client:TerminalClient,ref:SessionRef|null){
    const tagged=transferResultNoticeRef.current;
    if(!tagged||tagged.client!==client||!ref||!sameRef(client.currentRef,ref)||!client.canInput)return;
    transferResultNoticeRef.current=null;
    setNoticeState(current=>current===tagged.message?'':current);
  }
  function clearPendingPaste(){pendingPasteRef.current=null;setPendingPaste(null);}
  function clearTransferUi(){setTransferTargets(null);setTransferChoice('');setTransferRequesting(false);setTransferActive(null);setTransferOffer(null);setTransferAccepting(false);}
  function lockInputUi(){clearPendingPaste();ctrlArmedRef.current=false;setCtrlArmed(false);}
  function confirmPaste(){const pending=pendingPasteRef.current;clearPendingPaste();if(!pending)return;if(clientRef.current!==pending.client||!pending.client.matchesInputContext(pending.context)){setNotice('终端现场已变化，旧粘贴内容未发送。请核对后重新粘贴。');return;}xtermRef.current?.paste(pending.text);}
  const selected=useMemo(()=>targetsFor(status||{device:null,nodes:[],grants:[]}).find(item=>`${item.nodeId||'local'}/${item.profileId}`===targetKey),[status,targetKey]);
  const local=status?isLocal(status):board.connection.mode!=='hub';
  const localOwner=local&&(board.capabilities.role===undefined||board.capabilities.role==='owner');
  const canControl=Boolean(selected?.scopes.includes('input'));
  const readOnly=!canControl||readOnlyMode;
  const canCreate=Boolean(selected?.scopes.includes('create'));
  const canDefault=Boolean(selected?.scopes.includes('default'));
  const currentSession=sessions.find(item=>sameRef(item.sessionRef,currentRef));
  const unresolvedExecutions=control?.managed===true&&!shellMode?control.unresolvedExecutions||[]:[];
  const unresolvedExecutionKey=JSON.stringify(unresolvedExecutions.map(({taskId,commandId})=>({taskId,commandId})));
  useEffect(()=>{
    if(lastTakeoverUnknownKeyRef.current!==unresolvedExecutionKey){
      if(lastTakeoverUnknownKeyRef.current){setTakeoverConfirm(false);setTakeoverUnknownConsentKey('');}
      lastTakeoverUnknownKeyRef.current=unresolvedExecutionKey;
    }
  },[unresolvedExecutionKey]);
  const staleDefault=Boolean(defaultRef&&!sessions.some(item=>sameRef(item.sessionRef,defaultRef)));
  const selectedDefault=existingSelection.some(ref=>sameRef(ref,defaultRef));
  const activeConnection=['connecting','authenticating','opening','ready','selecting','redrawing','output_gap','control_wait','disconnecting'].includes(connection);
  mobileCanRevealRef.current=connection==='ready'&&Boolean(clientRef.current?.canInput)&&!readOnly&&!drawer&&!existingPicker&&!pendingPaste&&!takeoverConfirm&&!recoveryConfirm&&!releaseConfirm&&!transferTargets&&!transferRequesting&&!transferActive&&!transferOffer&&!transferAccepting;
  const layoutMobileTerminal=useCallback((focus=false)=>{
    if(mobileLayoutFrameRef.current!==null)cancelAnimationFrame(mobileLayoutFrameRef.current);
    mobileLayoutFrameRef.current=requestAnimationFrame(()=>{
      mobileLayoutFrameRef.current=null;
      const screen=hostRef.current;if(!screen)return;
      if(window.innerWidth>760){screen.style.removeProperty('--terminal-mobile-screen-height');document.documentElement.style.removeProperty('--terminal-mobile-keyboard-inset');document.documentElement.style.removeProperty('--terminal-mobile-visible-height');return;}
      const workspace=screen.closest('.terminal-workspace-active');
      if(!workspace){document.documentElement.style.removeProperty('--terminal-mobile-keyboard-inset');document.documentElement.style.removeProperty('--terminal-mobile-visible-height');return;}
      const keys=workspace.querySelector<HTMLElement>('.terminal-keys');
      const session=workspace.querySelector<HTMLElement>('.terminal-session-bar');
      const nav=document.querySelector<HTMLElement>('.mobile-nav');
      const viewport=window.visualViewport;
      const visibleHeight=viewport?.height||window.innerHeight;
      // Some WebViews leave fixed bars at the layout viewport bottom while the IME
      // shrinks only visualViewport. Measure their unadjusted position each time.
      document.documentElement.style.setProperty('--terminal-mobile-keyboard-inset','0px');
      const visibleBottom=(viewport?.offsetTop||0)+visibleHeight;
      const inset=Math.max(0,Math.ceil((nav?.getBoundingClientRect().bottom||window.innerHeight)-visibleBottom));
      document.documentElement.style.setProperty('--terminal-mobile-keyboard-inset',`${inset}px`);
      document.documentElement.style.setProperty('--terminal-mobile-visible-height',`${visibleHeight}px`);
      const reserved=(keys?.getBoundingClientRect().height||56)+(session?.getBoundingClientRect().height||0)+(nav?.getBoundingClientRect().height||62)+24;
      screen.style.setProperty('--terminal-mobile-screen-height',`${Math.max(140,Math.min(350,Math.floor(visibleHeight-reserved)))}px`);
      requestAnimationFrame(()=>{
        try{fitRef.current?.fit();clientRef.current?.resize();}catch{/* Hidden terminal can have zero dimensions. */}
        if(!canAutoRevealTerminal(mobileCanRevealRef.current,mobileManualViewRef.current,document.activeElement))return;
        const top=(viewport?.offsetTop||0)+8;
        const rect=screen.getBoundingClientRect();
        const keysTop=keys?.getBoundingClientRect().top??visibleHeight;
        if(rect.top<top||rect.bottom>keysTop-8)window.scrollBy({top:rect.top-top,behavior:'instant'});
        if(focus)xtermRef.current?.focus();
      });
    });
  },[]);
  useEffect(()=>{
    const viewport=window.visualViewport;
    const resize=()=>layoutMobileTerminal(false);
    viewport?.addEventListener('resize',resize);window.addEventListener('resize',resize);
    let touchStart=0;
    const touchBegin=(event:TouchEvent)=>{touchStart=event.touches[0]?.clientY||0;};
    const touchMove=(event:TouchEvent)=>{if((event.touches[0]?.clientY||0)>touchStart+12)mobileManualViewRef.current=true;};
    const wheel=(event:WheelEvent)=>{if(event.deltaY< -8)mobileManualViewRef.current=true;};
    const controlFocus=(event:FocusEvent)=>{if(window.innerWidth<=760&&isTerminalControlFocus(event.target))mobileManualViewRef.current=true;};
    window.addEventListener('touchstart',touchBegin,{passive:true});window.addEventListener('touchmove',touchMove,{passive:true});window.addEventListener('wheel',wheel,{passive:true});
    document.addEventListener('focusin',controlFocus);
    return()=>{viewport?.removeEventListener('resize',resize);window.removeEventListener('resize',resize);window.removeEventListener('touchstart',touchBegin);window.removeEventListener('touchmove',touchMove);window.removeEventListener('wheel',wheel);document.removeEventListener('focusin',controlFocus);if(mobileLayoutFrameRef.current!==null)cancelAnimationFrame(mobileLayoutFrameRef.current);document.documentElement.style.removeProperty('--terminal-mobile-keyboard-inset');document.documentElement.style.removeProperty('--terminal-mobile-visible-height');};
  },[layoutMobileTerminal]);
  useEffect(()=>{if(activeConnection)layoutMobileTerminal(false);else{document.documentElement.style.removeProperty('--terminal-mobile-keyboard-inset');document.documentElement.style.removeProperty('--terminal-mobile-visible-height');}},[activeConnection,layoutMobileTerminal]);
  useEffect(()=>{if(connection!=='ready'||!mobileRevealRequestedRef.current)return;if(!mobileCanRevealRef.current){if(pendingPaste||takeoverConfirm||recoveryConfirm||releaseConfirm||transferTargets||transferRequesting||transferActive||transferOffer||transferAccepting)mobileRevealRequestedRef.current=false;return;}mobileRevealRequestedRef.current=false;mobileManualViewRef.current=false;layoutMobileTerminal(true);},[connection,currentRef,drawer,control,pendingPaste,takeoverConfirm,recoveryConfirm,releaseConfirm,transferTargets,transferRequesting,transferActive,transferOffer,transferAccepting,layoutMobileTerminal]);
  const load=useCallback(async(reachability?:ReachabilityCheck)=>{setLoading(true);try{const value=await request<TerminalStatus>('GET','/api/terminal/status');if(reachability&&(clientRef.current!==reachability.binding.client||reachabilityBindingRef.current!==reachability.binding||targetRef.current!==reachability.binding.targetKey||reachability.binding.client.recoveryCycle!==reachability.cycle))return;setStatus(value);setStatusLoadError(false);setError('');if(reachability){
    const {binding,cycle}=reachability;
    if(clientRef.current===binding.client&&reachabilityBindingRef.current===binding&&targetRef.current===binding.targetKey&&binding.client.recoveryCycle===cycle){
      const target=targetsFor(value).find(item=>`${item.nodeId||'local'}/${item.profileId}`===binding.targetKey);
      const mode=isLocal(value)?'local':'hub',deviceId=isLocal(value)?null:value.device?.deviceId||null;
      if(target&&mode===binding.mode&&deviceId===binding.deviceId&&target.profile.projectId===binding.projectId&&scopeKey(target.scopes)===binding.scopes)binding.client.resumeAfterReachable(cycle);
      else binding.client.invalidateReachableWake(cycle);
    }
  }}catch(e){if(reachability&&(clientRef.current!==reachability.binding.client||reachabilityBindingRef.current!==reachability.binding||targetRef.current!==reachability.binding.targetKey||reachability.binding.client.recoveryCycle!==reachability.cycle))return;setStatusLoadError(true);setError(errorMessage(e));if(reachability&&e instanceof ApiError&&[401,403].includes(e.status))reachability.binding.client.invalidateReachableWake(reachability.cycle);}finally{setLoading(false);}},[]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{
    if(!localOwner||!status||!isLocal(status)||status.platform!=='win32'){
      setWslAvailability(null);setWslAvailabilityError('');setWslAvailabilityLoading(false);return;
    }
    let active=true;setWslAvailabilityLoading(true);setWslAvailabilityError('');
    void request<WslAvailability>('GET','/api/terminal/wsl').then(value=>{if(active)setWslAvailability(value);})
      .catch(cause=>{if(active){setWslAvailability(null);setWslAvailabilityError(errorMessage(cause));}})
      .finally(()=>{if(active)setWslAvailabilityLoading(false);});
    return()=>{active=false;};
  },[localOwner,status]);
  useEffect(()=>{const options=targetsFor(status||{device:null,nodes:[],grants:[]});if(!options.length){setTargetKey('');return;}setTargetKey(current=>options.some(item=>`${item.nodeId||'local'}/${item.profileId}`===current)?current:`${options[0].nodeId||'local'}/${options[0].profileId}`);},[status]);
  useEffect(()=>{if(selected?.profile.runtime==='wsl'&&shellMode)setShellMode(false);},[selected?.profile.runtime,shellMode]);
  useEffect(()=>{
    const host=hostRef.current;if(!host)return;
    const xterm=new Terminal({cursorBlink:true,convertEol:false,scrollback:3000,fontFamily:'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',fontSize:13,theme:{background:'#111927',foreground:'#e9eef8',cursor:'#7bb4ff',selectionBackground:'#547dbd88'}});
    const fit=new FitAddon();xterm.loadAddon(fit);xterm.open(host);xtermRef.current=xterm;fitRef.current=fit;
    // Android WebView can dispatch a printable keypress while an IME composition
    // is active, then xterm's compositionend sends the same committed text.
    // Let the composition path own those keys; ordinary keypresses stay intact.
    let composing=false,compositionCommitPending=false;
    let compositionCommitTimer:number|undefined;
    const textarea=xterm.textarea;
    textarea?.setAttribute('aria-describedby','terminal-keyboard-help');
    const compositionStart=()=>{composing=true;compositionCommitPending=false;if(compositionCommitTimer!==undefined)window.clearTimeout(compositionCommitTimer);};
    const compositionEnd=()=>{if(!composing)return;composing=false;compositionCommitPending=true;if(compositionCommitTimer!==undefined)window.clearTimeout(compositionCommitTimer);compositionCommitTimer=window.setTimeout(()=>{compositionCommitPending=false;compositionCommitTimer=undefined;},0);};
    const compositionBlur=()=>{composing=false;compositionCommitPending=false;if(compositionCommitTimer!==undefined)window.clearTimeout(compositionCommitTimer);compositionCommitTimer=undefined;};
    const nextKey=(event:KeyboardEvent)=>{if(event.target===textarea&&compositionCommitPending&&!['Shift','Control','Alt','Meta'].includes(event.key))compositionCommitPending=false;};
    const committedInput=(event:Event)=>{const input=event as InputEvent;if(event.target===textarea&&compositionCommitPending&&input.inputType==='insertText'&&input.data)event.stopPropagation();};
    textarea?.addEventListener('compositionstart',compositionStart);
    textarea?.addEventListener('compositionend',compositionEnd);
    textarea?.addEventListener('blur',compositionBlur);
    host.addEventListener('keydown',nextKey,true);
    host.addEventListener('input',committedInput,true);
    xterm.attachCustomKeyEventHandler(event=>{
      if(handleTerminalFocusEscape(event,()=>{
        const workspace=host.closest('.terminal-workspace');
        focusTerminalEscapeTarget(
          workspace?.querySelector<HTMLButtonElement>('.terminal-session-bar button')||null,
          workspace?.querySelector<HTMLElement>('#terminal-keyboard-help')||null,
        );
      }))return false;
      return !(event.type==='keypress'&&event.isComposing&&composing&&event.key.length===1&&!event.ctrlKey&&!event.altKey&&!event.metaKey);
    });
    const resize=()=>{try{fit.fit();clientRef.current?.resize();}catch{/* Hidden panel can have zero dimensions. */}};
    const observer=new ResizeObserver(resize);observer.observe(host);window.setTimeout(resize,0);
    const onPaste=(event:ClipboardEvent)=>{
      event.preventDefault();event.stopPropagation();
      if(pendingPasteRef.current)return;
      const value=event.clipboardData?.getData('text/plain')||'';
      if(!value)return;
      if(value.length>32768||new TextEncoder().encode(value).length>32768){setNotice('粘贴内容超过 32 KiB，未发送。请分段粘贴。');return;}
      const client=clientRef.current,context=client?.inputContext;
      if(!client||!context){setNotice('终端尚未就绪，粘贴内容未发送。');return;}
      ctrlArmedRef.current=false;setCtrlArmed(false);
      if(/[\x00-\x1f\x7f]/.test(value)){
        const pending={text:value,client,context};pendingPasteRef.current=pending;setPendingPaste(pending);
        (event.target as HTMLElement).blur();return;
      }
      xterm.paste(value);
    };
    host.addEventListener('paste',onPaste,true);
    const data=xterm.onData(value=>{
      if(pendingPasteRef.current)return;
      if(ctrlArmedRef.current){
        ctrlArmedRef.current=false;setCtrlArmed(false);
        if(value.length===1&&/^[a-z@\[\\\]\^_]$/i.test(value))clientRef.current?.input(String.fromCharCode(value.toUpperCase().charCodeAt(0)&31));
        else setNotice('Ctrl 组合键支持单个英文字母和常用符号；该按键未发送。');
        return;
      }
      clientRef.current?.input(value);
    });
    return()=>{host.removeEventListener('paste',onPaste,true);host.removeEventListener('keydown',nextKey,true);host.removeEventListener('input',committedInput,true);textarea?.removeEventListener('compositionstart',compositionStart);textarea?.removeEventListener('compositionend',compositionEnd);textarea?.removeEventListener('blur',compositionBlur);if(compositionCommitTimer!==undefined)window.clearTimeout(compositionCommitTimer);observer.disconnect();data.dispose();pendingPasteRef.current=null;clientRef.current?.dispose();clientRef.current=null;xterm.dispose();xtermRef.current=null;fitRef.current=null;};
  },[]);
  useEffect(()=>{if(targetRef.current===targetKey)return;targetRef.current=targetKey;clearPendingPaste();clearTransferUi();recoveryListRequestRef.current=null;setRecoverySelection(null);setRecoveryOptions([]);setRecoveryListPending(false);setRecoverySelectionPending(false);clientRef.current?.dispose();clientRef.current=null;reachabilityBindingRef.current=null;setConnection('disconnected');setNotice('');setControl(null);setTakeoverConfirm(false);setRecoveryConfirm(false);setReleaseConfirm(false);setReadOnlyMode(false);setExistingPicker(null);setExistingSelection([]);extensionPending.current=false;setCurrentRef(null);setSessions([]);setDefaultRef(null);xtermRef.current?.clear();},[targetKey]);
  useEffect(()=>{const onOffline=()=>{setBrowserOnline(false);clearPendingPaste();clientRef.current?.pauseForOffline();};const wake=()=>{const client=clientRef.current,binding=reachabilityBindingRef.current;void load(client&&binding?.client===client?{binding,cycle:client.recoveryCycle}:undefined);client?.resume();};const onOnline=()=>{setBrowserOnline(true);wake();};const onForeground=()=>{setBrowserOnline(navigator.onLine);if(navigator.onLine)wake();};const onVisible=()=>{if(document.visibilityState==='visible')onForeground();};window.addEventListener('offline',onOffline);window.addEventListener('online',onOnline);window.addEventListener('pageshow',onForeground);document.addEventListener('visibilitychange',onVisible);return()=>{window.removeEventListener('offline',onOffline);window.removeEventListener('online',onOnline);window.removeEventListener('pageshow',onForeground);document.removeEventListener('visibilitychange',onVisible);};},[load]);
  const size=()=>({cols:Math.max(20,Math.min(300,xtermRef.current?.cols||80)),rows:Math.max(5,Math.min(100,xtermRef.current?.rows||24))});
  function connect(){
    if(disconnectPending.current||!selected||!navigator.onLine)return;
    mobileRevealRequestedRef.current=true;
    clearPendingPaste();
    clientRef.current?.dispose();defaultAfterCreate.current=false;extensionPending.current=false;clearTransferUi();recoveryListRequestRef.current=null;setRecoverySelection(null);setRecoveryOptions([]);setRecoveryListPending(false);setRecoverySelectionPending(false);setError('');setNotice('');setConnectionMessage('');setControl(null);setTakeoverConfirm(false);setRecoveryConfirm(false);setReleaseConfirm(false);setExistingPicker(null);setExistingSelection([]);setCurrentRef(null);setSessions([]);setDefaultRef(null);xtermRef.current?.clear();
    const client=new TerminalClient({nodeId:selected.nodeId,profileId:selected.profileId,mode:readOnly||selected.profile.runtime==='wsl'?'tmux':shellMode?'shell':'tmux',readOnly,ticketControl:selected.scopes.some(scope=>scope!=='view'),inputAllowed:canControl&&!readOnly,takeoverAllowed:selected.scopes.includes('takeover')&&!readOnly,projectId:selected.profile.projectId},{
      onState:(next,message)=>{setConnection(next);if(message||next==='ready')setConnectionMessage(message||'');if(next!=='ready'){clearPendingPaste();ctrlArmedRef.current=false;setCtrlArmed(false);}if(['error','disconnected','control_wait','output_gap'].includes(next))mobileRevealRequestedRef.current=false;if(['error','disconnected'].includes(next))setRecoverySelectionPending(false);if(next==='selecting'&&!client.isTransferLocked){setDrawer(true);setTransferAccepting(false);}},
      onSessions:(items,def,available,_revision,requestId)=>{setSessions(items);setDefaultRef(def);setTmuxAvailable(available);if(requestId&&requestId===recoveryListRequestRef.current){recoveryListRequestRef.current=null;setRecoveryOptions(items);setRecoveryListPending(false);}},
      onReady:(ref)=>{clearPendingPaste();setCurrentRef(ref);if(ref)setRecoverySelectionPending(false);setDrawer(false);clearResolvedTransferNotice(client,ref);if(ref&&sameRef(client.currentRef,ref)&&client.canInput)setNoticeState(current=>current===OWNER_SESSION_RECOVERY_NOTICE?'':current);if(ref&&defaultAfterCreate.current){defaultAfterCreate.current=false;client.setDefault(ref);}if(window.innerWidth>760)xtermRef.current?.focus();else if(!ref||!client.canInput)mobileRevealRequestedRef.current=false;},
      onOutput:data=>xtermRef.current?.write(data),
      onClear:()=>xtermRef.current?.reset(),
      onNotice:message=>setNotice(message),
      onControl:value=>{
        if(!client.canInput)lockInputUi();
        if(Object.hasOwn(value,'unresolvedExecutions')){
          const nextList=value.managed===true&&!shellMode?value.unresolvedExecutions||[]:[];
          const nextKey=JSON.stringify(nextList.map(({taskId,commandId})=>({taskId,commandId})));
          if(lastTakeoverUnknownKeyRef.current!==nextKey){setTakeoverConfirm(false);setTakeoverUnknownConsentKey('');lastTakeoverUnknownKeyRef.current=nextKey;}
        }
        // Server snapshots explicitly replace the current reason. A local
        // reconnect callback omits it and cannot resolve an unknown outcome.
        setControl(previous=>({...previous,...value,managed:value.managed??previous?.managed,
          canReconcileAcquire:value.canReconcileAcquire===true,
          returnReview:Object.hasOwn(value,'returnReview')?value.returnReview:null,
          reason:Object.hasOwn(value,'reason')?value.reason:previous?.reason}));
        clearResolvedTransferNotice(client,client.currentRef);if(value.phase!=='ai_ready')setTakeoverConfirm(false);if(value.phase==='human'&&value.mode==='existing'&&value.owned&&extensionPending.current&&!client.isTransferLocked){extensionPending.current=false;setDrawer(true);setNotice('新会话已通过复核。请在列表中再次点击目标会话切换。');}
      },
      onTransfer:(event:TransferEvent)=>{
        if(event.type==='targets'){setTransferTargets(event.items);setTransferChoice('');setNotice(event.items.length?'请选择要接续的在线设备。':'没有其他已授权且在线的可写终端连接。');}
        if(event.type==='offer'){lockInputUi();setDrawer(false);setExistingPicker(null);setExistingSelection([]);setTransferOffer({transferId:event.transferId,expiresAt:event.expiresAt,fromDeviceId:event.fromDeviceId});setConnectionMessage('另一台设备请求把 tmux 操作权转到这里。确认前不会输入，也不会重发旧命令。');}
        if(event.type==='pending'){lockInputUi();setTransferRequesting(false);setTransferTargets(null);setTransferActive({transferId:event.transferId,expiresAt:event.expiresAt,targetConnectionId:event.targetConnectionId});setNotice('等待目标设备明确接受。当前设备已停止输入，原 tmux 程序继续运行。');}
        if(event.type==='accepted'){lockInputUi();setTransferOffer(null);setTransferAccepting(true);setConnectionMessage('已接受转移，正在等待电脑确认新的执行权。请稍后明确选择会话。');}
        if(event.type==='completed'){lockInputUi();setTransferActive(null);setNotice('操作权已转到另一台设备。当前设备不能继续输入；tmux 程序仍在运行。');}
        if(event.type==='ended'){lockInputUi();clearTransferUi();setTransferResultNotice(client,event.transferId,'ended',`转移未完成：${event.reason} 原 tmux 会话保留，输入继续锁定；请重新核对控制权。`);}
        if(event.type==='failed'){lockInputUi();clearTransferUi();setTransferResultNotice(client,null,'failed',`转移未完成：${event.reason} 原 tmux 会话保留，请重新连接后核对控制权。`);}
        if(event.type==='cleared'){lockInputUi();clearTransferUi();}
      },
      onControlRequired:()=>{setTakeoverConfirm(false);setDrawer(false);},
      onDefaultConflict:()=>{if(!client.isTransferLocked)setDrawer(true);},
      onSessionUnauthorized:ref=>{if(client.isTransferLocked)return;setExistingPicker('extend');setExistingSelection(ref?[ref]:[]);setDrawer(true);setNotice('此会话尚未授权写入。选中它并确认扩展，复核通过后再点击会话切换。');},
    },size);
    clientRef.current=client;
    reachabilityBindingRef.current={client,targetKey,mode:local?'local':'hub',deviceId:local?null:!status||isLocal(status)?null:status.device?.deviceId||null,projectId:selected.profile.projectId,scopes:scopeKey(selected.scopes)};
    void client.connect();
  }
  async function disconnect(){const client=clientRef.current;if(!client||disconnectPending.current)return;clearPendingPaste();clearTransferUi();
    disconnectPending.current=true;setConnection('disconnecting');setNotice('');setDrawer(false);setExistingPicker(null);setExistingSelection([]);
    try{await client.disconnect();}finally{disconnectPending.current=false;if(clientRef.current===client){clientRef.current=null;reachabilityBindingRef.current=null;}setCurrentRef(null);setDrawer(false);}}
  function toggleDrawer(){if(disconnectPending.current||clientRef.current?.isTransferLocked)return;setDrawer(value=>!value);if(!drawer)clientRef.current?.list();}
  function openExistingPicker(purpose:'takeover'|'extend'){setExistingPicker(purpose);setExistingSelection([]);setDrawer(true);clientRef.current?.list();}
  function toggleExisting(ref:SessionRef){setExistingSelection(previous=>previous.some(item=>sameRef(item,ref))?previous.filter(item=>!sameRef(item,ref)):previous.length>=16?previous:[...previous,ref]);}
  function confirmExisting(){
    const refs=existingSelection.filter(ref=>sessions.some(item=>sameRef(item.sessionRef,ref)));
    if(!existingPicker||!refs.length||refs.length>16)return;
    if(existingPicker==='takeover'&&canDefault&&!refs.some(ref=>sameRef(ref,defaultRef))){setNotice('请先把一个已选会话设为默认，接入成功后会自动打开。');return;}
    const sent=existingPicker==='takeover'?clientRef.current?.requestExistingTakeover(refs):clientRef.current?.extendExisting(refs);
    if(!sent){setNotice('会话接入请求未送达，请核对连接与权限。');return;}
    extensionPending.current=existingPicker==='extend';setExistingPicker(null);setExistingSelection([]);setDrawer(false);
    setLastControlAction('acquire');setNotice('电脑正在核对选中的会话与写入者；完成前不能输入。');
  }
  function selectSession(ref:SessionRef){if(disconnectPending.current)return;if(recoverySelectionPending&&!control?.authorizedSessionRefs?.some(item=>sameRef(item,ref))){setNotice('此会话不是本次核对确认的原授权会话，不能接续。');return;}mobileRevealRequestedRef.current=true;clientRef.current?.select(ref);setDrawer(false);}
  function saveDefault(ref:SessionRef){if(disconnectPending.current||recoverySelectionPending)return;if(!clientRef.current?.setDefault(ref)){setNotice('默认会话请求未送达或已有请求待确认，请核对连接后重试。');return;}setNotice('正在保存默认会话…');}
  function createSession(event:FormEvent){event.preventDefault();if(disconnectPending.current||recoverySelectionPending)return;const name=createName.trim();if(!name)return;defaultAfterCreate.current=!defaultRef&&canDefault;clientRef.current?.create(name);setCreateName('');setDrawer(false);}
  function specialKey(value:string){if(!clientRef.current?.input(value)){setNotice('终端尚未就绪，按键未发送。');return;}xtermRef.current?.focus();}
  function takeOver(){
    const consented=unresolvedExecutions.length>0&&takeoverUnknownConsentKey===unresolvedExecutionKey;
    const intent=consented?unresolvedExecutions:undefined;
    if(!clientRef.current?.requestTakeover(intent))setNotice('接管请求未送达或旧轮次清单已变化，请重新核对后再试。');
    else setLastControlAction('acquire');
    setTakeoverConfirm(false);setTakeoverUnknownConsentKey('');
  }
  function returnToAi(){lockInputUi();if(!clientRef.current?.returnControl(returnNotes.trim()))setNotice('交还核对请求未送达，请重新核对现场。');else{setLastControlAction('release');setNotice('正在准备交还内容核对；确认前不会交还给 AI。');}}
  function confirmReturn(){lockInputUi();if(!clientRef.current?.confirmReturn())setNotice('本次核对已失效，不能确认交还；请正式核对现场。');else setNotice('已提交交还确认，等待电脑重新核对；此时不能输入。');}
  function cancelReturn(){lockInputUi();if(!clientRef.current?.cancelReturn())setNotice('取消请求未送达；交还状态仍未确认，请正式核对现场。');else setNotice('已请求取消本次交还，输入保持关闭；等待电脑核对。');}
  function beginOwnerRecovery(){setRecoveryConfirm(true);setDrawer(false);setRecoverySelection(null);setRecoveryOptions([]);setRecoveryListPending(false);recoveryListRequestRef.current=null;if(localOwner&&control?.mode==='managed'&&!shellMode&&control.requiresSessionSelection!==false){setRecoveryListPending(true);const requestId=clientRef.current?.list();recoveryListRequestRef.current=requestId||null;if(!requestId){setRecoveryListPending(false);setNotice('实时会话列表未送达，请检查连接后重试。');}}}
  function recoverOwnerControl(){const needsSession=localOwner&&control?.mode==='managed'&&!shellMode&&control.requiresSessionSelection!==false;const selection=needsSession?recoverySelection:undefined;if(needsSession&&(!selection||recoveryListPending||!recoveryOptions.some(item=>sameRef(item.sessionRef,selection)))){setNotice('请先从最新列表明确选择仍存在的原会话。');return;}if(!clientRef.current?.reconcileControl('acquire',selection||undefined))setNotice('恢复核对请求未送达，请检查连接。');else{setLastControlAction('acquire');setRecoverySelectionPending(!selection&&!shellMode&&control?.requiresSessionSelection!==false);setNotice(localOwner?(needsSession?OWNER_SESSION_RECOVERY_NOTICE:'正在核对执行器及其他写入者；不会自动新建或接入。'):'正在核对本设备原有执行权。核对通过后仍需从原授权会话中明确选择；不会改默认或重发输入。');}setRecoveryConfirm(false);}
  function releaseOwnerControl(){lockInputUi();if(!clientRef.current?.reconcileControl('release'))setNotice('交还核对请求未送达，请检查连接。');else{setLastControlAction('release');setNotice('正在准备交还内容核对；确认前不会交还给 AI。');}setReleaseConfirm(false);}
  function listTransferTargets(){if(!clientRef.current?.listControlTargets()){setNotice('当前连接不能转移 tmux 操作权。请核对执行权、设备授权与连接。');return;}setTransferTargets([]);setTransferChoice('');setNotice('正在查找已授权且在线的连接…');}
  function confirmTransfer(){if(!transferChoice)return;lockInputUi();if(!clientRef.current?.transferControl(transferChoice)){setNotice('转移请求未确认送达，输入已锁定；请核对控制权。');return;}setTransferRequesting(true);setTransferTargets(null);setNotice('转移请求已发出，当前设备已停止输入，等待目标设备接受。');}
  function acceptTransfer(){if(!transferOffer)return;lockInputUi();if(!clientRef.current?.acceptControl(transferOffer.transferId)){setNotice('接受请求未送达，请核对连接；终端仍不能输入。');return;}setTransferAccepting(true);setConnectionMessage('已请求接续，等待电脑确认。确认后请明确选择 tmux 会话。');}
  function cancelTransfer(){const id=transferActive?.transferId||transferOffer?.transferId;if(!id)return;lockInputUi();if(!clientRef.current?.cancelTransfer(id)){setNotice('取消请求未送达，请核对控制权；终端仍不能输入。');return;}setNotice('已请求取消；需要电脑重新核对控制权，终端输入仍关闭。');}
  async function enroll(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{const value=await request<{confirmationCode:string;expiresAt?:number}>('POST','/api/terminal/devices',{label:deviceLabel.trim()});setEnrollCode(value.confirmationCode);setConfirmationExpiresAt(value.expiresAt??null);setNotice('请在电脑的本机 owner 界面核对确认码并授权。');await load();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  async function requestNewConfirmation(){setBusy(true);setError('');try{const value=await request<{deviceId:string;confirmationCode:string;expiresAt:number}>('POST','/api/terminal/devices/confirmation',{});setEnrollCode(value.confirmationCode);setConfirmationExpiresAt(value.expiresAt);setNotice('已生成新的确认码。请在电脑的本机 owner 界面核对并批准所需终端配置。');await load();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  function startNewProfile(runtime:'native'|'wsl'='native'){
    setProfileDraft({...newProfileDraft(windowsOwner?'':projectId),runtime,label:`终端 ${((localStatus?.profiles.length||0)+1)}`,
      distro:runtime==='wsl'?wslAvailability?.distributions[0]||'':''});setProfileEditorOpen(true);setError('');
  }
  function startEditProfile(profile:TerminalProfile){
    setProfileDraft({id:profile.id,runtime:profile.runtime||'native',label:profile.label,projectId:profile.projectId||'',cwd:profile.cwd||'',
      distro:profile.wsl?.distro||'',wslCwd:profile.wsl?.cwd||'',serverName:profile.allowSharedServer?profile.serverName||'':'',tmuxExecutable:profile.tmuxExecutable||'',allowSharedServer:profile.allowSharedServer===true});
    setProfileEditorOpen(true);setError('');
  }
  const windowsOwner=Boolean(localOwner&&status&&isLocal(status)&&status.platform==='win32');
  const wslPathValid=profileDraft.wslCwd.trim().startsWith('/')&&!/[\x00-\x1f\x7f]/.test(profileDraft.wslCwd);
  const windowsCwdValid=!windowsOwner||Boolean(profileDraft.projectId)||!profileDraft.cwd.trim()||/^[A-Za-z]:[\\/]/.test(profileDraft.cwd.trim())||/^\\\\[^\\]+\\[^\\]+/.test(profileDraft.cwd.trim());
  const profileDraftValid=Boolean(profileDraft.label.trim()&&(!profileDraft.serverName.trim()||profileDraft.allowSharedServer)&&
    (profileDraft.runtime==='native'&&windowsCwdValid||profileDraft.runtime==='wsl'&&windowsOwner&&wslAvailability?.supported&&wslAvailability.available&&wslAvailability.distributions.includes(profileDraft.distro)&&wslPathValid));
  async function saveProfile(event:FormEvent){
    event.preventDefault();if(!profileDraftValid)return;setBusy(true);setError('');
    const id=profileDraft.id||`terminal-${crypto.randomUUID()}`;
    const server=profileDraft.serverName.trim()?{serverName:profileDraft.serverName.trim(),allowSharedServer:true as const}:{};
    const body=profileDraft.runtime==='wsl'
      ?{id,label:profileDraft.label.trim(),enabled:true,runtime:'wsl' as const,wslDistro:profileDraft.distro,wslCwd:profileDraft.wslCwd.trim(),...server}
      :{id,label:profileDraft.label.trim(),enabled:true,...(profileDraft.projectId?{projectId:profileDraft.projectId}:profileDraft.cwd.trim()?{cwd:profileDraft.cwd.trim()}:{}),...(profileDraft.tmuxExecutable.trim()?{tmuxExecutable:profileDraft.tmuxExecutable.trim()}:{}),...server};
    try{await request('POST','/api/terminal/profiles',body);setProfileEditorOpen(false);setProfileDraft(newProfileDraft(windowsOwner?'':projectId));await load();setNotice('终端配置已保存。');}
    catch(cause){setError(errorMessage(cause));}finally{setBusy(false);}
  }
  function cancelProfileEdit(){setProfileEditorOpen(false);setProfileDraft(newProfileDraft(windowsOwner?'':projectId));}
  async function grant(event:FormEvent){event.preventDefault();if(!grantDevice||!grantCode)return;setBusy(true);setError('');try{await request('POST','/api/terminal/grants',{deviceId:grantDevice,profileId:selected?.profileId||'default',scopes:selected?.profile.runtime==='wsl'?grantScopes.filter(scope=>scope!=='takeover'):grantScopes,confirmationCode:grantCode.trim()});setGrantCode('');await load();setNotice('终端权限已授予该设备。');}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  async function revoke(deviceId:string,profileId:string){setBusy(true);setError('');try{await request('DELETE',`/api/terminal/grants/${encodeURIComponent(deviceId)}/${encodeURIComponent(profileId)}`);await load();setNotice('该设备的终端权限已撤销。');}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  const hubStatus=status&&!isLocal(status)?status as HubTerminalStatus:null;
  const localStatus=status&&isLocal(status)?status:null;
  const availabilityLabel=!browserOnline?'手机离线':activeConnection?statusLabel(connection):loading?'正在检查终端':statusLoadError?'终端状态获取失败':!status?'终端状态未确认':hubStatus&&!hubStatus.device?'请先登记这台浏览器':hubStatus&&(hubStatus.device?.status==='pending'||!hubStatus.grants.some(grant=>grant.scopes.includes('view')))?'等待电脑授权':hubStatus&&!targetsFor(hubStatus).length?'已授权终端暂不可连接':statusLabel(connection);
  useNativeBack(()=>{
    if(pendingPaste){clearPendingPaste();return true;}
    if(drawer){setDrawer(false);setExistingPicker(null);setExistingSelection([]);return true;}
    if(takeoverConfirm){setTakeoverConfirm(false);return true;}
    if(recoveryConfirm){setRecoveryConfirm(false);setRecoverySelection(null);recoveryListRequestRef.current=null;return true;}
    if(releaseConfirm){setReleaseConfirm(false);return true;}
    if(transferTargets!==null){setTransferTargets(null);setTransferChoice('');return true;}
    if(busy||transferRequesting||transferActive||transferOffer||transferAccepting||control&&['stopping','return_check','return_review','transfer_pending'].includes(control.phase)){
      setNotice('请先在当前页面处理接管或交还事项，再返回。');return true;
    }
    return false;
  },true);
  return <div className="content-page terminal-page">
    <div className="terminal-heading"><div><h2><TerminalSquare size={21}/> 连接工作区</h2><p>连接已授权电脑上的真实 Shell 和 tmux 会话。tmux 会话与看板对话分开。</p></div><button className="secondary" type="button" onClick={()=>void load()} disabled={loading} aria-label="刷新终端状态"><RefreshCw size={16}/></button></div>
    {error&&<p className="alert" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
    {localStatus?.plugin&&localStatus.plugin.status!=='ready'&&<section className="terminal-setup" role="status"><h3>{localStatus.plugin.status==='disabled'?'本机终端入口已停用':'本机终端状态待核实'}</h3><p>{localStatus.plugin.status==='disabled'?'原有 tmux 会话仍保留。请在电脑的插件页启用终端入口。':'输入已关闭。请在电脑的插件页检查终端状态；确认前不能启用。'}</p>{localStatus.plugin.lastError&&<p className="alert">{localStatus.plugin.lastError}</p>}</section>}
    {pendingPaste&&<div className="terminal-paste-backdrop"><section className="terminal-paste-dialog" role="dialog" aria-modal="true" aria-label="确认多行粘贴"><h3>确认多行粘贴</h3><p>粘贴内容包含换行或控制字符，可能立即执行命令。确认前不会发送到终端。</p><pre>{JSON.stringify(pendingPaste.text.slice(0,240))}{pendingPaste.text.length>240?'…':''}</pre><p>共 {new TextEncoder().encode(pendingPaste.text).length} 字节。请核对目标会话与命令。</p><div><button className="secondary" type="button" onClick={clearPendingPaste}>取消</button><button className="primary" type="button" onClick={confirmPaste}>确认粘贴</button></div></section></div>}
    {localStatus&&localOwner&&<details className="terminal-admin terminal-profile-admin"><summary>本机终端配置（{localStatus.profiles.length}/8）</summary><p>原生配置可继续使用临时普通 Shell。WSL 配置是独立终端，不绑定任务执行权；工作目录不构成文件隔离，请勿让 AI 和此终端同时修改同一工作区。</p>{windowsOwner&&(wslAvailabilityLoading?<p role="status">正在检查已安装的 WSL 发行版…</p>:wslAvailabilityError?<p className="terminal-profile-warning">WSL 发行版列表暂不可用：{wslAvailabilityError}。原生终端仍可配置。</p>:wslAvailability?.reason&&!wslAvailability.available?<p className="terminal-profile-warning">{wslAvailability.reason}。原生终端仍可配置。</p>:null)}<div className="terminal-profile-list">{localStatus.profiles.map(profile=><article className="terminal-profile-row" key={profile.id}><div><strong>{profile.label}</strong><small>{profile.runtime==='wsl'?`WSL · ${profile.wsl?.distro||'发行版待核对'} · ${profile.wsl?.user||'Linux 用户未知'} (UID ${profile.wsl?.uid??'?'})`:`原生终端 · ${board.projects.find(project=>project.id===profile.projectId)?.name||profile.cwd||'用户目录'}`}</small>{profile.runtime==='wsl'&&profile.wsl?.cwd&&<small>工作目录：{profile.wsl.cwd}</small>}{profile.tmuxReason&&<small>{profile.tmuxReason}</small>}</div><button type="button" className="secondary" disabled={busy||Boolean(localStatus.connections?.some(connection=>connection.profileId===profile.id&&connection.ready))} onClick={()=>startEditProfile(profile)}>编辑</button></article>)}</div>{profileEditorOpen?<form className="terminal-profile-form" onSubmit={saveProfile}><h4>{profileDraft.id?'编辑终端配置':'新增终端配置'}</h4><label>连接名称<input value={profileDraft.label} maxLength={80} onChange={event=>setProfileDraft(current=>({...current,label:event.target.value}))} required/></label>{windowsOwner&&<label>运行环境<select value={profileDraft.runtime} disabled={Boolean(profileDraft.id)} onChange={event=>{const runtime=event.target.value as 'native'|'wsl';setProfileDraft(current=>({...current,runtime,projectId:runtime==='wsl'?'':current.projectId,cwd:runtime==='wsl'?'':current.cwd,distro:runtime==='wsl'?wslAvailability?.distributions[0]||'':'',wslCwd:runtime==='wsl'?'':current.wslCwd,serverName:'',allowSharedServer:false}));}}><option value="native">Windows 原生</option><option value="wsl" disabled={!wslAvailability?.supported||!wslAvailability.available}>WSL 发行版</option></select></label>}{profileDraft.id&&<p>运行类型固定；如需更换 Windows 原生/WSL 目标或 WSL 发行版，请新增配置。</p>}{profileDraft.runtime==='wsl'?<><label>已安装的 WSL 发行版<select value={profileDraft.distro} disabled={Boolean(profileDraft.id)} onChange={event=>setProfileDraft(current=>({...current,distro:event.target.value}))} required><option value="">选择发行版</option>{profileDraft.distro&&!wslAvailability?.distributions.includes(profileDraft.distro)&&<option value={profileDraft.distro}>{profileDraft.distro} · 当前绑定</option>}{(wslAvailability?.distributions||[]).map(name=><option key={name} value={name}>{name}</option>)}</select></label>{profileDraft.id&&<p>发行版与 Linux 账户绑定不可编辑；需要更换时新增配置。</p>}<label>Linux 工作目录<input value={profileDraft.wslCwd} onChange={event=>setProfileDraft(current=>({...current,wslCwd:event.target.value}))} placeholder="输入 WSL 内的绝对路径" required/></label>{profileDraft.wslCwd&&!wslPathValid&&<small className="terminal-profile-warning">请输入以 / 开头的 Linux 绝对路径。</small>}<p>工作目录由你提供，不会自动猜测 Windows 到 WSL 的路径映射。这个独立终端不获得任务或 AI 接管权限。</p></>:<><label>{windowsOwner?'终端范围':'关联项目'}<select value={profileDraft.projectId} onChange={event=>setProfileDraft(current=>({...current,projectId:event.target.value}))}><option value="">独立终端（不关联项目）</option>{board.projects.map(project=><option key={project.id} value={project.id}>关联项目：{project.name}</option>)}</select></label>{!profileDraft.projectId&&<><label>宿主工作目录（可选）<input value={profileDraft.cwd} onChange={event=>setProfileDraft(current=>({...current,cwd:event.target.value}))} placeholder={windowsOwner?'留空使用系统默认目录，例如 C:\Users\Alice':'留空使用系统默认目录'}/></label>{windowsOwner&&profileDraft.cwd.trim()&&!windowsCwdValid&&<small className="terminal-profile-warning">请输入 Windows 绝对路径（例如 C:\Users\Alice 或 \\\\server\\share）。</small>}<p className="terminal-profile-help">独立终端不要指向看板中已关联的受管项目目录；服务端会拒绝与受管项目重叠的目录。</p></>}</>}<details><summary>tmux 高级设置</summary><label>tmux server 名称（留空使用独立服务）<input value={profileDraft.serverName} maxLength={80} onChange={event=>setProfileDraft(current=>({...current,serverName:event.target.value,allowSharedServer:false}))} placeholder="填已有 server 名称以接入现有会话"/></label>{profileDraft.serverName.trim()&&<label className="terminal-shared-confirm"><input type="checkbox" checked={profileDraft.allowSharedServer} onChange={event=>setProfileDraft(current=>({...current,allowSharedServer:event.target.checked}))}/><span>我确认此配置可访问该 tmux server 的全部会话；工作目录不限制文件访问。</span></label>}{profileDraft.runtime==='native'&&<label>tmux 可执行文件路径（可选）<input value={profileDraft.tmuxExecutable} onChange={event=>setProfileDraft(current=>({...current,tmuxExecutable:event.target.value}))} placeholder="留空使用系统 tmux"/></label>}</details>{profileDraft.runtime==='wsl'&&profileDraft.id&&<p>保存配置可能断开正在使用它的连接；请先完成当前命令。</p>}{profileDraft.runtime==='native'&&profileDraft.id&&localStatus.connections?.some(item=>item.profileId===profileDraft.id)&&<p>保存配置会断开正在使用它的终端连接。</p>}<div className="terminal-profile-actions"><button type="button" className="secondary" onClick={cancelProfileEdit}>取消</button><button type="submit" className="primary" disabled={busy||!profileDraftValid||profileDraft.runtime==='wsl'&&(!wslAvailability?.available||wslAvailabilityLoading)}>{busy?'正在保存…':'保存配置'}</button></div></form>:<button type="button" className="secondary terminal-profile-add" disabled={busy||localStatus.profiles.length>=8||localStatus.plugin?.status==='disabled'} onClick={()=>startNewProfile('native')}>新增终端配置</button>}{localStatus.profiles.length>=8&&<p className="terminal-profile-help">已达到 8 个终端配置上限。可编辑现有配置。</p>}{windowsOwner&&<p className="terminal-profile-help">WSL 当前不可用时仍可新增 Windows 原生终端；WSL 可选择这台 Windows 电脑已安装的发行版。</p>}</details>}
    {hubStatus&&!hubStatus.device&&<section className="terminal-setup"><h3>登记这台浏览器</h3><p>登记后在电脑上核对确认码并单独授予终端权限。</p><form onSubmit={enroll}><label>设备名称<input value={deviceLabel} maxLength={80} onChange={e=>setDeviceLabel(e.target.value)} required/></label><button className="primary" disabled={busy}>登记设备</button></form></section>}
    {hubStatus?.device?.status==='pending'&&<section className="terminal-setup"><h3>等待电脑批准</h3><p>{hubStatus.device.label} 已登记。请在电脑上核对并批准这个设备。</p></section>}
    {hubStatus?.device&&<section className="terminal-setup terminal-confirmation"><h3>终端设备授权确认码</h3><p>首次批准或新增终端配置授权时，在电脑本机 owner 界面核对确认码。申请新码不会自动扩大现有权限。</p>{enrollCode&&<p className="terminal-code">确认码：<code>{enrollCode}</code>{confirmationExpiresAt&&<span> · 有效至 {new Date(confirmationExpiresAt).toLocaleString()}</span>}</p>}<button className="secondary" type="button" disabled={busy||!navigator.onLine} onClick={()=>void requestNewConfirmation()}>申请新的授权确认码</button></section>}
    {localStatus&&localOwner&&<details className="terminal-admin"><summary><ShieldCheck size={17}/> 设备授权与配置</summary><p>仅在这台电脑上核对待批准设备的确认码。授权范围可单独撤销。</p><div className="terminal-admin-grid"><form onSubmit={grant}><label>待批准设备<select value={grantDevice} onChange={e=>setGrantDevice(e.target.value)} required><option value="">选择设备</option>{(localStatus.pendingDevices||[]).map(device=><option key={device.deviceId} value={device.deviceId}>{device.label} · {device.deviceId.slice(0,8)}</option>)}</select></label><label>手机显示的确认码<input value={grantCode} onChange={e=>setGrantCode(e.target.value)} autoComplete="off" required/></label><fieldset><legend>授权范围</legend>{(['view','input','create','default','takeover'] as TerminalScope[]).filter(scope=>selected?.profile.runtime!=='wsl'||scope!=='takeover').map(scope=><label key={scope}><input type="checkbox" checked={grantScopes.includes(scope)} onChange={()=>setGrantScopes(value=>value.includes(scope)?value.filter(item=>item!==scope):[...value,scope])}/>{({view:'查看',input:'输入',create:'新建会话',default:'设置默认',takeover:'接管任务执行权'} as Record<TerminalScope,string>)[scope]}</label>)}</fieldset><button className="primary" disabled={busy||!grantDevice||!grantScopes.includes('view')}>批准设备</button></form><div><h4>已授权设备</h4>{localStatus.grants.length?localStatus.grants.map(item=><div className="terminal-grant" key={`${item.deviceId}/${item.profileId}`}><span>{item.deviceId?.slice(0,8)} · {item.profileId} · {item.scopes.join('、')}</span><button className="secondary" type="button" disabled={busy||!item.deviceId} onClick={()=>item.deviceId&&void revoke(item.deviceId,item.profileId)}>撤销</button></div>):<p>暂无授权。</p>}</div></div></details>}
    {selected?.profile.runtime!=='wsl'&&control?.managed===true&&connection!=='disconnecting'&&<section className={`terminal-control terminal-control-${control.phase}`} aria-label="任务执行权">
      <div className="terminal-control-heading"><strong>任务执行权：{control.phase==='human'&&!control.owned?'由其他设备处理':({ai_ready:'由 AI 管理',stopping:'正在确认停止',human:'由我处理',return_check:'正在核对交还',return_review:'请核对交还内容',transfer_pending:'正在转移到另一台设备',unknown:'现场待核对',unmanaged:'独立终端'} as Record<typeof control.phase,string>)[control.phase]}</strong>{control.phase==='human'&&control.owned&&clientRef.current?.canInput&&<span>已确认可以在终端输入</span>}</div>
      {control.reason&&<p role="status">{control.reason}</p>}
      {control.phase==='ai_ready'&&selected?.scopes.includes('takeover')&&canControl&&!readOnly&&!shellMode&&<div className="terminal-existing-entry"><p>已有 tmux 会话可保留正在运行的 CLI。先选择可操作的会话，电脑核对后 Seqivo AI 暂停；未选中的会话仍可只读查看。</p><button className="primary" type="button" onClick={()=>openExistingPicker('takeover')}>操作已有会话</button></div>}
      {control.phase==='ai_ready'&&selected?.scopes.includes('takeover')&&canControl&&!readOnly&&<>{takeoverConfirm?<div className="terminal-control-confirm"><p>电脑将停止受管 AI 执行并核对进程。确认完成前，终端输入保持关闭。</p>{!shellMode&&unresolvedExecutions.length>0&&<div><p>检测到以下旧轮次待处置：</p><ul>{unresolvedExecutions.map(item=><li key={`${item.taskId}/${item.commandId}`}><div>{board.tasks.find(task=>task.id===item.taskId)?.title||'未同步名称的任务'}</div><small style={{display:'block',opacity:0.72,overflowWrap:'anywhere'}}>原轮次：<code style={{overflowWrap:'anywhere'}}>{item.commandId}</code></small></li>)}</ul><label><input type="checkbox" checked={takeoverUnknownConsentKey===unresolvedExecutionKey} onChange={event=>setTakeoverUnknownConsentKey(event.target.checked?unresolvedExecutionKey:'')}/> 结束这些旧轮次，结果仍待核实</label><p>这会保留原输出并将旧结果继续记为未知。交还后如需继续工作，必须另发新指令；不会自动续跑。</p></div>}<button className="primary" type="button" onClick={takeOver}>{takeoverUnknownConsentKey===unresolvedExecutionKey&&unresolvedExecutions.length>0?'结束所列旧轮次并接管':'确认停止并接管'}</button><button className="secondary" type="button" onClick={()=>{setTakeoverConfirm(false);setTakeoverUnknownConsentKey('');}}>取消</button></div>:<button className="primary" type="button" onClick={()=>{setTakeoverUnknownConsentKey('');setTakeoverConfirm(true);}}>我来处理</button>}</>}
      {control.phase==='ai_ready'&&(!selected?.scopes.includes('takeover')||!canControl)&&<p>当前设备没有接管授权，终端输入保持关闭。</p>}
      {control.phase==='human'&&control.owned&&!clientRef.current?.isTransferLocked&&selected?.scopes.includes('takeover')&&<div className="terminal-return"><label>交还说明（可选）<textarea value={returnNotes} onChange={event=>setReturnNotes(event.target.value)} maxLength={2000} rows={2} placeholder="记录已做的修改和需继续核对的事项"/></label><button className="secondary" type="button" disabled={!clientRef.current?.canInput} onClick={returnToAi}>核对交还内容</button></div>}
      {control.phase==='return_review'&&control.returnReview&&<TerminalReturnReview review={control.returnReview} canConfirm={Boolean(clientRef.current?.canConfirmReturn)} canCancel={Boolean(clientRef.current?.canCancelReturn)} onConfirm={confirmReturn} onCancel={cancelReturn}/>}
      {control.phase==='return_review'&&!control.returnReview&&<p>交还核对内容未能确认，输入保持关闭；请重新核对现场。</p>}
      {control.phase==='human'&&control.owned&&shellMode&&<p>普通 Shell 的保留现场转移尚未支持。断开普通 Shell 会结束进程；请先完成当前命令。</p>}
      {control.phase==='human'&&control.owned&&!shellMode&&!readOnly&&selected?.scopes.includes('takeover')&&<div className="terminal-transfer"><p>把当前 tmux 操作权转到另一台已授权的在线设备。目标设备需明确接受；原程序保留。这与“交还给 AI”是两种不同操作。</p><button className="secondary" type="button" disabled={!clientRef.current?.canTransfer||transferTargets!==null||transferRequesting||!!transferActive} onClick={listTransferTargets}>转到另一台设备</button></div>}
      {control.phase==='transfer_pending'&&<p>转移尚未完成，当前设备不能输入。目标设备接受后，需在目标设备明确选择会话。</p>}
      {control.phase==='human'&&control.owned&&!clientRef.current?.isTransferLocked&&control.mode==='existing'&&!readOnly&&<div className="terminal-existing-entry"><p>当前仅可写入已核对的会话。新增会话需再次明确选择并复核；临时切换不会更改默认。其他已连接的 tmux 客户端仍可能输入，请与同事协调操作。</p><button className="secondary" type="button" onClick={()=>openExistingPicker('extend')}>增加可操作会话</button></div>}
      {control.phase==='human'&&!control.owned&&<p>此设备没有当前执行权，终端输入保持关闭。</p>}
      {control.canReconcileAcquire===true&&!readOnly&&selected?.scopes.includes('takeover')&&canControl&&((control.phase==='human'&&!control.owned)||control.phase==='unknown')&&<div className="terminal-control-confirm">{recoveryConfirm?<>
        <p>{localOwner?'本机 owner 将重新停止执行器并核对现场写入者。':'电脑将核对本设备原有执行权、执行器与现场写入者。'}核对通过前输入保持关闭；核对后仍需明确选择原会话。</p>
        {localOwner&&control.mode==='managed'&&!shellMode&&(control.requiresSessionSelection===false?<p>尚未建立受管会话，仍将核对执行器和其他写入者。核对通过也不会自动新建会话或改变默认会话。</p>:<div className="terminal-recovery-choice"><strong>选择仍存在的原受管会话</strong><p>列表只显示实时会话；电脑还会核对它是否为原授权身份。选择不会改变默认会话，也不会授权新会话。</p>{recoveryListPending?<p>正在刷新实时会话…</p>:recoveryOptions.length?recoveryOptions.map(item=><label key={JSON.stringify(item.sessionRef)}><input type="radio" name="terminal-recovery-session" checked={sameRef(recoverySelection,item.sessionRef)} onChange={()=>setRecoverySelection(item.sessionRef)}/><span>{item.name}{sameRef(defaultRef,item.sessionRef)?' · 原默认':''}</span></label>):<p>没有可选的存活会话；请检查电脑上的 tmux 现场。</p>}</div>)}
        {!localOwner&&!shellMode&&<p>核对通过后只会列出原授权会话，请再明确选择存活的原会话；不会自动接入默认会话。</p>}
        <button className="primary" type="button" disabled={localOwner&&control.mode==='managed'&&!shellMode&&control.requiresSessionSelection!==false&&(recoveryListPending||!recoverySelection)} onClick={recoverOwnerControl}>确认核对并恢复</button>
        <button className="secondary" type="button" onClick={()=>{setRecoveryConfirm(false);setRecoverySelection(null);recoveryListRequestRef.current=null;}}>取消</button>
      </>:<button className="secondary" type="button" onClick={beginOwnerRecovery}>{localOwner?'恢复其他设备的执行权':'核对并恢复本设备执行权'}</button>}</div>}
      {['stopping','return_check'].includes(control.phase)&&<p>正在由电脑核对执行状态。此时不能输入或交还第二次请求。</p>}
      {control.phase==='unknown'&&<><p>执行权结果尚未确认，终端输入保持关闭。请重新核对实际进程和文件状态。</p>{localOwner&&selected?.scopes.includes('takeover')&&control.owned&&<div className="terminal-control-confirm">{releaseConfirm?<><p>本机将重新检查项目写入者和文件状态。随后须查看交还内容并再次明确确认；此操作不会自动关闭已有 CLI。</p><button className="primary" type="button" onClick={releaseOwnerControl}>准备交还核对</button><button className="secondary" type="button" onClick={()=>setReleaseConfirm(false)}>取消</button></>:<button className="secondary" type="button" onClick={()=>setReleaseConfirm(true)}>核对交还内容</button>}</div>}</>}
      {control.changes&&control.changes.length>0&&<details className="terminal-changes"><summary>本次核对的文件变化（{control.changes.length}）</summary><p>{control.snapshotScope==='git-tracked-and-nonignored-untracked'?'核对范围：Git 已跟踪及未忽略的未跟踪文件；Git 忽略文件未纳入。':control.snapshotScope==='directory-tree-excluding-git-metadata'?'核对范围：项目目录树（不含 Git 元数据）。':'核对范围未明确，请手动检查可能遗漏的文件。'}</p><ul>{control.changes.map((change,index)=><li key={`${change.path}-${index}`}><code>{change.path}</code><span>{change.kind}</span></li>)}</ul></details>}
    </section>}
    {transferTargets!==null&&<section className="terminal-transfer-panel" aria-label="选择接续设备"><h3>选择接续设备</h3><p>仅显示同账号、已授权且在线的可写终端连接。确认后此设备立即停止输入，目标设备仍需明确接受。</p>{transferTargets.length?<div className="terminal-transfer-targets">{transferTargets.map(item=><label key={item.connectionId}><input type="radio" name="terminal-transfer-target" value={item.connectionId} checked={transferChoice===item.connectionId} onChange={()=>setTransferChoice(item.connectionId)}/><span>{targetLabel(item)}</span></label>)}</div>:<p>正在查找或暂无可接续的设备。</p>}<div className="terminal-transfer-actions"><button className="primary" type="button" disabled={!transferChoice} onClick={confirmTransfer}>确认转移</button><button className="secondary" type="button" onClick={()=>{setTransferTargets(null);setTransferChoice('');}}>取消</button></div></section>}
    {(transferRequesting||transferActive)&&<section className="terminal-transfer-panel" aria-label="等待接续"><h3>等待另一台设备接续</h3><p>当前设备已停止输入，tmux 程序仍在运行。目标设备必须明确接受。{transferActive?`请求有效至 ${new Date(transferActive.expiresAt).toLocaleTimeString()}。`:''}</p>{transferActive&&<button className="secondary" type="button" onClick={cancelTransfer}>取消转移并等待核对</button>}</section>}
    {transferOffer&&<section className="terminal-transfer-panel terminal-transfer-offer" aria-label="接续终端操作权"><h3>在此设备接续 tmux</h3><p>来自设备 {transferOffer.fromDeviceId?shortId(transferOffer.fromDeviceId):'这台电脑'} 的操作权转移请求，有效至 {new Date(transferOffer.expiresAt).toLocaleTimeString()}。接受后请在会话列表中明确选择，不会重发先前输入。</p><div className="terminal-transfer-actions"><button className="primary" type="button" disabled={transferAccepting} onClick={acceptTransfer}>在此设备接续</button><button className="secondary" type="button" onClick={cancelTransfer}>拒绝并等待核对</button></div></section>}
    <section className={`terminal-workspace${activeConnection?' terminal-workspace-active':''}${shellMode&&!readOnly?' terminal-workspace-shell':''}`} aria-label="终端工作区">
      <div className="terminal-toolbar"><label className="terminal-target-label">目标电脑与配置<select value={targetKey} disabled={activeConnection} onChange={e=>setTargetKey(e.target.value)}>{!selected&&<option value="">暂无可连接的终端</option>}{targetsFor(status||{device:null,nodes:[],grants:[]}).map(item=><option key={`${item.nodeId||'local'}/${item.profileId}`} value={`${item.nodeId||'local'}/${item.profileId}`}>{item.nodeId?`${item.nodeId.slice(0,8)} · `:'本机 · '}{item.profile.label}{!item.nodeId&&item.profile.runtime==='wsl'&&item.profile.wsl?` · WSL ${item.profile.wsl.distro}`:''}</option>)}</select></label><span className={`terminal-state terminal-state-${connection}`} role="status">{availabilityLabel}</span></div>
      {selected&&<label className="terminal-mode"><input type="checkbox" checked={readOnly} disabled={activeConnection||!canControl} onChange={e=>{setReadOnlyMode(e.target.checked);if(e.target.checked)setShellMode(false);}}/> 只读查看已有 tmux 会话（无需接管，无法输入或新建）</label>}
      {selected&&canControl&&!readOnly&&selected.profile.runtime!=='wsl'&&<label className="terminal-mode"><input type="checkbox" checked={shellMode} disabled={activeConnection} onChange={e=>setShellMode(e.target.checked)}/> 使用临时普通 Shell（关闭后不保留进程）</label>}
      <div className="terminal-actions"><button className="primary" type="button" onClick={connect} disabled={!selected||activeConnection||!navigator.onLine||Boolean(hubStatus&&hubStatus.device?.status!=='approved')}><PlugZap size={16}/> 连接终端</button><button className="secondary" type="button" disabled={!activeConnection||connection==='disconnecting'} onClick={()=>void disconnect()}>断开</button>{connection==='output_gap'&&shellMode&&<button className="secondary" type="button" onClick={()=>clientRef.current?.acceptShellGap()}>继续当前 Shell（历史输出不完整）</button>}{connectionMessage&&<span role="status">{connectionMessage}</span>}</div>
      <div className="terminal-screen" ref={hostRef} aria-label="交互式终端输出" data-testid="terminal-screen"/>
      <div className="terminal-keys" role="group" aria-label="终端辅助按键"><span><Keyboard size={14}/> 快捷键</span><span id="terminal-keyboard-help" tabIndex={-1}>Shift+Esc 返回页面控件</span><button type="button" aria-pressed={ctrlArmed} onClick={()=>{ctrlArmedRef.current=!ctrlArmedRef.current;setCtrlArmed(ctrlArmedRef.current);xtermRef.current?.focus();}} disabled={!clientRef.current?.canInput}>Ctrl</button>{[['Esc','\x1b'],['Tab','\t'],['Ctrl+C','\x03'],['↑','\x1b[A'],['↓','\x1b[B'],['←','\x1b[D'],['→','\x1b[C']].map(([label,key])=><button key={label} type="button" onClick={()=>specialKey(key)} disabled={!clientRef.current?.canInput}>{label}</button>)}</div>
      {(!shellMode||readOnly)&&<div className="terminal-session-bar"><button type="button" onClick={toggleDrawer} disabled={!activeConnection||connection==='disconnecting'||clientRef.current?.isTransferLocked} aria-expanded={drawer} aria-controls="terminal-session-drawer"><span>会话：{currentSession?.name|| (currentRef?'当前会话':'未选择')}</span><ChevronDown size={17}/></button><span>{defaultRef&&sameRef(defaultRef,currentRef)?'★ 默认':''}</span></div>}
      {drawer&&(!shellMode||readOnly)&&<div className="terminal-drawer" id="terminal-session-drawer">
        <div className="terminal-drawer-head"><div><strong>{existingPicker?'选择要操作的会话':'tmux 会话'}</strong><small>来自已授权电脑的实时列表</small></div><button type="button" aria-label="关闭会话列表" onClick={()=>{setDrawer(false);setExistingPicker(null);setExistingSelection([]);}}><X size={18}/></button></div>
        {staleDefault&&<p className="terminal-default-stale">原默认会话不在实时列表中。可先选择存活会话或明确新建，再单独点“设为默认”；同名新会话不会自动替代。</p>}
        {existingPicker&&<p className="terminal-existing-hint">选择 1–16 个同一电脑的真实会话。现有 CLI 程序会保留，Seqivo AI 暂停；只有选中的会话可写。默认会话会在接入后自动打开。</p>}
        {recoverySelectionPending&&<p role="status">核对通过后，请在已授权的原会话中明确选择。不会自动打开默认会话。</p>}
        <div className="terminal-session-list">{sessions.some(item=>!recoverySelectionPending||control?.authorizedSessionRefs?.some(ref=>sameRef(ref,item.sessionRef)))?sessions.filter(item=>!recoverySelectionPending||control?.authorizedSessionRefs?.some(ref=>sameRef(ref,item.sessionRef))).map(item=><div className="terminal-session-row" key={JSON.stringify(item.sessionRef)}>
          {existingPicker&&<label className="terminal-existing-choice"><input type="checkbox" aria-label={`选择会话 ${item.name}`} checked={existingSelection.some(ref=>sameRef(ref,item.sessionRef))} disabled={existingPicker==='extend'&&item.authorized===true} onChange={()=>toggleExisting(item.sessionRef)}/></label>}
          <button type="button" onClick={()=>selectSession(item.sessionRef)} disabled={Boolean(existingPicker)||sameRef(currentRef,item.sessionRef)&&connection==='ready'}><strong>{item.name}</strong><small>{sameRef(currentRef,item.sessionRef)?'当前 · ':''}{sameRef(defaultRef,item.sessionRef)?'★ 默认 · ':''}{item.authorized?'已可操作 · ':''}{item.attached?'已有客户端连接':'未被其他客户端连接'}</small></button>
          <button className="terminal-default-button" type="button" disabled={recoverySelectionPending||!canDefault||sameRef(defaultRef,item.sessionRef)} onClick={()=>saveDefault(item.sessionRef)}>设为默认</button>
        </div>):<p className="terminal-empty"><CloudOff size={17}/> {recoverySelectionPending?'没有可接续的原授权会话；保持输入关闭，请在电脑核对现场。':tmuxAvailable?'暂无可用会话，可新建一个。':selected?.profile.runtime==='wsl'?'这个 WSL 目标暂不可用，请在电脑检查发行版、账户和 tmux。使用 Windows Shell 请另选原生配置。':'这台电脑未检测到 tmux，请安装或切换到普通 Shell。'}</p>}</div>
        {existingPicker&&<div className="terminal-existing-confirm"><p>{existingPicker==='takeover'&&canDefault&&!selectedDefault?'先在已选会话中设置一个默认会话。':`已选 ${existingSelection.length} 个会话，复核通过前不能输入。`}</p><button className="primary" type="button" disabled={!existingSelection.length||existingSelection.length>16||existingPicker==='takeover'&&canDefault&&!selectedDefault} onClick={confirmExisting}>{existingPicker==='takeover'?'确认接入并保留程序':'确认扩展会话授权'}</button></div>}
        {!recoverySelectionPending&&!existingPicker&&canCreate&&!readOnly&&tmuxAvailable&&<form className="terminal-create" onSubmit={createSession}><label>新建真实会话<input value={createName} onChange={e=>setCreateName(e.target.value)} maxLength={80} placeholder="例如：开发主线" required/></label><button className="secondary" type="submit">{!defaultRef&&canDefault?'新建并设为默认':'新建并连接'}</button></form>}
        <button className="terminal-refresh" type="button" onClick={()=>clientRef.current?.list()}><RefreshCw size={14}/> 刷新列表</button>
      </div>}
    </section>
  </div>;
}
