import {useNativeBack} from './lib/use-native-back';
import {Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode} from 'react';
import {Activity, AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, Circle, ClipboardCheck, FolderOpen, History, Inbox, Layers2, Menu, MessageCircle, Minus, Moon, Pause, Play, Plug, Plus, RefreshCw, Settings2, Smartphone, Sun, TerminalSquare, UserRound, Workflow, X} from 'lucide-react';
import {ApiError, clearToken, errorMessage, getState, getToken, isDesktop, request, subscribe} from './api';
import type {AccountUser, BoardState, CommandReceipt, PluginState, Project, ReconcileResult, Task, Theme} from './types';
import {reviewRejectionText} from './receipt-messages';
import {createDesktopStartupGate} from './lib/desktop-startup';
import {continueGate,freshTaskGate,startTaskGate} from './execution-write-gate';
import type {DesktopStartupStatus} from './types';
import {AccountSettings,LoginPanel} from './AccountPanel';
import ConversationPanel from './ConversationPanel';
import {clearConversationDrafts} from './conversation-drafts';
import {clearInboxDrafts,clearInboxSubmittedDrafts} from './inbox-drafts';
import {taskFormDraftKey,readTaskFormDraft,saveTaskFormDraft,discardTaskFormDraft,clearTaskFormDrafts,taskCreateAvailabilityReason,hubTaskCreateBody,confirmedHubTaskId,type TaskFormDraft} from './task-form-drafts';
import CommandRecovery from './CommandRecovery';
import RemotePanel from './RemotePanel';
import DataPanel from './DataPanel';
import PluginCatalog from './PluginCatalog';
import AutoContinuePolicies, {type PolicyChange} from './AutoContinuePolicies';
import WorkflowPanel from './WorkflowPanel';
import InboxPanel from './InboxPanel';
import SupervisionPanel from './SupervisionPanel';
import ProjectHandoff from './ProjectHandoff';
import ProjectConnection from './ProjectConnection';
import {VerificationBadge, VerificationDetails, verificationState, verificationLabels, type VerificationState} from './Verification';

type Page = 'connection' | 'supervision' | 'inbox' | 'tasks' | 'conversations' | 'issues' | 'handoff' | 'plugins' | 'records' | 'remote' | 'terminal' | 'workflow' | 'account';
type Dialog = 'project' | 'import' | 'task' | 'edit' | 'evidence' | 'review' | null;
type DialogTaskBinding={dialog:'edit'|'evidence'|'review';taskId:string;projectId:string;revision:number;contentVersion:Task['contentVersion'];accountId:string;authGeneration:number};
type ReviewFeedback={accountId:string;authGeneration:number;projectId:string;taskId:string;commandId:string;status:'pending'|'failed'|'unknown'|'confirmed';text:string};
const TerminalPanel=lazy(()=>import('./TerminalWorkspace'));
const PreviewPanel=lazy(()=>import('./PreviewPanel'));
class TerminalLoadBoundary extends Component<{children:ReactNode},{failed:boolean}>{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div className="empty-state" role="alert"><h2>终端界面需要重新载入</h2><p>页面文件可能已更新。重新载入前，请先确认电脑上的终端现场；未确认的输入不会自动重发。</p><button className="primary" type="button" onClick={()=>window.location.reload()}>重新载入页面</button></div>:this.props.children;}
}
class PreviewLoadBoundary extends Component<{children:ReactNode},{failed:boolean}>{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div className="empty-state" role="alert"><h2>预览界面需要重新载入</h2><p>页面文件可能已更新。重新载入后请核对已提交的反馈；页面不会自动补交。</p><button className="primary" type="button" onClick={()=>window.location.reload()}>重新载入页面</button></div>:this.props.children;}
}
const directoryName = (path:string) => path.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
const floating = new URLSearchParams(location.search).get('floating') === '1';
const statusText: Record<Task['status'], string> = {planned:'待开始',running:'进行中',paused:'已暂停',blocked:'遇到阻碍',submitted:'待验收',failed:'失败',cancelled:'已取消'};
const executionTools=[{id:'codex-autocontinue',name:'Codex'},{id:'claude-code',name:'Claude Code'},{id:'cursor-agent',name:'Cursor Agent'}] as const;
function executionName(id?:string){return executionTools.find(tool=>tool.id===id)?.name||id||'Codex'}
const navItems: {id: Page; text: string; icon: typeof Circle}[] = [
  {id:'supervision',text:'任务督办',icon:Layers2}, {id:'inbox',text:'需要我处理',icon:Inbox}, {id:'tasks',text:'任务清单',icon:ClipboardCheck}, {id:'conversations',text:'对话',icon:MessageCircle}, {id:'issues',text:'交付偏差',icon:AlertCircle},
  {id:'workflow',text:'协作计划',icon:Workflow},
  {id:'connection',text:'项目接入',icon:FolderOpen}, {id:'handoff',text:'项目交接',icon:Layers2}, {id:'plugins',text:'接入与插件',icon:Plug},
  {id:'records',text:'记录备份',icon:History}, {id:'remote',text:'手机连接',icon:Smartphone}, {id:'terminal',text:'远程终端',icon:TerminalSquare}, {id:'account',text:'账号',icon:UserRound},
];
function dateText(value?: string | null) {if (!value) return '暂无'; const d = new Date(value); return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}
function isCompleted(task: Task) {return task.acceptance === 'passed' && task.status === 'submitted'}
function groupOf(task: Task) {return isCompleted(task) ? 'done' : task.status === 'planned' ? 'todo' : 'active'}
function receiptPending(receipt:CommandReceipt){return ['queued','received','sending'].includes(receipt.status)||(receipt.status==='running'&&receipt.result==null&&!receipt.error)}
type PendingTaskCommand={id:string;action:string;taskId?:string;projectId?:string;accountId?:string;status?:string;draftKey?:string;confirmedTaskId?:string};
function commandText(receipt:CommandReceipt,action:string){
  const rejection=reviewRejectionText(receipt);if(rejection)return rejection;
  if(['queued','received','sending'].includes(receipt.status))return '请求已排队，等待目标电脑回执。';
  if(receipt.status==='running'&&receiptPending(receipt))return '目标电脑已接收请求，等待执行结果。';
  if(receipt.status==='running')return action==='continue'?'目标电脑已确认 AI 开始执行。':action==='pause'?'目标电脑已接收暂停请求，正在确认会话状态。':'目标电脑已确认更改。';
  if(receipt.status==='paused')return '目标电脑已确认任务暂停。';
  if(receipt.status==='unknown')return `操作结果未知；请核对目标会话，勿重复提交。${receipt.error||''}`;
  if(receipt.status==='expired')return '请求已过期，没有执行。';
  if(receipt.status==='failed')return `请求执行失败。${receipt.error||''}`;
  return `目标电脑已回执：${receipt.status}。`;
}
function IconButton({label, children, onClick, disabled=false}: {label:string;children:ReactNode;onClick:()=>void;disabled?:boolean}) {return <button className="icon-button" type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>}
function Field({label, value, onChange, required=false, multiline=false, placeholder='', type='text',disabled=false}: {label:string;value:string;onChange:(value:string)=>void;required?:boolean;multiline?:boolean;placeholder?:string;type?:string;disabled?:boolean}) {
  const id = label.replace(/\s/g,'-');
  return <label className="field" htmlFor={id}><span>{label}</span>{multiline ? <textarea id={id} aria-label={label} value={value} onChange={e=>onChange(e.target.value)} required={required} placeholder={placeholder} rows={3} disabled={disabled}/> : <input id={id} aria-label={label} type={type} value={value} onChange={e=>onChange(e.target.value)} required={required} placeholder={placeholder} disabled={disabled}/>}</label>;
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(isDesktop());
  const [authChecked,setAuthChecked]=useState(isDesktop());
  const [registrationEnabled,setRegistrationEnabled]=useState(false);
  const [accountsAvailable,setAccountsAvailable]=useState(false);
  const [account,setAccount]=useState<AccountUser|null>(null);
  const [legacyTokenScope,setLegacyTokenScope]=useState('');
  const legacyTokenFor=useRef('');
  const [conversationTaskId,setConversationTaskId]=useState('');
  const [terminalTaskId,setTerminalTaskId]=useState('');
  const [state, setState] = useState<BoardState | null>(null);
  const [executionGateNow,setExecutionGateNow]=useState(()=>Date.now());
  const [desktopStartup,setDesktopStartup]=useState<DesktopStartupStatus|null>(()=>
    window.taskboard?.startupStatus&&window.taskboard?.subscribeStartup?{phase:'starting',revision:0}:null);
  const desktopStartupReady=useRef(!window.taskboard?.startupStatus||!window.taskboard?.subscribeStartup);
  const desktopStartupGate=useRef<ReturnType<typeof createDesktopStartupGate>|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNoticeValue] = useState('');
  const [noticeWarning, setNoticeWarning] = useState(false);
  const [reviewFeedback,setReviewFeedback]=useState<ReviewFeedback|null>(null);
  const reviewFeedbackRef=useRef<HTMLParagraphElement|null>(null);
  const shownReviewFeedbackKeys=useRef(new Set<string>());
  function setNotice(message:string){setNoticeValue(message);setNoticeWarning(false);}
  function setReceiptNotice(receipt:CommandReceipt,action:string){setNotice(commandText(receipt,action));setNoticeWarning(['failed','unknown','expired'].includes(receipt.status));}
  const [online, setOnline] = useState(()=>isDesktop()||navigator.onLine);
  const [connectionChecking,setConnectionChecking]=useState(false);
  const connectivityEpoch=useRef(0);const refreshSequence=useRef(0);const authGeneration=useRef(0);const logoutInProgress=useRef(false);const refreshInFlight=useRef<{epoch:number;authGeneration:number;identity:string;promise:Promise<void>}|null>(null);const onlineRef=useRef(isDesktop()||navigator.onLine);const checkingRef=useRef(false);const accountIdentityRef=useRef('');const lastResumeCheckAt=useRef(0);
  onlineRef.current=online;
  const [page, setPage] = useState<Page>('supervision');
  const [projectId, setProjectId] = useState('');
  const handoffProjectRef=useRef(projectId);handoffProjectRef.current=projectId;
  const handoffBoardRef=useRef<BoardState|null>(null);handoffBoardRef.current=state;
  const [taskId, setTaskId] = useState('');
  const pendingTaskScroll=useRef<{taskId:string;projectId:string}|null>(null);
  useLayoutEffect(()=>{const pending=pendingTaskScroll.current;if(!pending||page!=='tasks'||taskId!==pending.taskId||projectId!==pending.projectId)return;pendingTaskScroll.current=null;window.scrollTo(0,0);document.querySelector<HTMLElement>('.main')?.scrollTo(0,0);document.querySelector<HTMLElement>('.detail-scroll')?.scrollTo(0,0)},[page,taskId,projectId]);
  const [previewTaskId,setPreviewTaskId]=useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogTaskBinding,setDialogTaskBinding]=useState<DialogTaskBinding|null>(null);
  const [dialogCreateProjectId,setDialogCreateProjectId]=useState('');
  const dialogRef=useRef<HTMLDivElement|null>(null);
  const dialogOpenerRef=useRef<HTMLElement|null>(null);
  const lastClickedElementRef=useRef<HTMLElement|null>(null);
  const dialogWasOpen=useRef(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [mobileMoreOpen,setMobileMoreOpen]=useState(false);
  const mobileMoreButtonRef=useRef<HTMLButtonElement|null>(null);
  useEffect(()=>{if(!mobileMoreOpen)return;const close=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape'){setMobileMoreOpen(false);mobileMoreButtonRef.current?.focus();}};document.addEventListener('keydown',close);return()=>document.removeEventListener('keydown',close)},[mobileMoreOpen]);
  const [showDone, setShowDone] = useState(true);
  const [compact, setCompact] = useState(false);
  const [theme, setTheme] = useState<Theme>('system');
  const [resolvedTheme, setResolvedTheme] = useState<'light'|'dark'>('light');
  const [form, setForm] = useState<Record<string,string>>({});
  const [reviewDecision, setReviewDecision] = useState<'pass'|'fail'>('pass');
  const [formDraftStorage]=useState(()=>{try{return window.localStorage;}catch{return null;}});
  const formDraftRef=useRef<{key:string|null;draft:TaskFormDraft}|null>(null);
  const [formDraftNotice,setFormDraftNotice]=useState('');
  const [pluginForm, setPluginForm] = useState({pythonPath:'',codexPath:'',graceSeconds:'',pollSeconds:''});
  const [conversationFilter, setConversationFilter] = useState('all');
  const [verificationFilter, setVerificationFilter] = useState<VerificationState | 'all'>('all');
  const [pendingCommands, setPendingCommands] = useState<PendingTaskCommand[]>(()=>{
    try{const value=JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]');return Array.isArray(value)?value.filter(item=>typeof item?.id==='string'&&typeof item?.action==='string'&&typeof item?.accountId==='string'):[];}
    catch{return [];}
  });
  useLayoutEffect(()=>{
    if(!authenticated||!authChecked||floating){
      dialogOpenerRef.current=null;dialogWasOpen.current=false;
      if(dialog){setDialog(null);setDialogTaskBinding(null);setForm({});setError('');}
      return;
    }
    if(!dialog){
      if(dialogWasOpen.current){
        const opener=dialogOpenerRef.current;
        dialogOpenerRef.current=null;dialogWasOpen.current=false;
        if(opener?.isConnected&&!opener.hasAttribute('disabled')&&!opener.closest('[inert]'))opener.focus({preventScroll:true});
      }
      return;
    }
    const root=dialogRef.current;
    if(!root)return;
    dialogWasOpen.current=true;
    const shell=root.closest('.app-shell');
    const background=Array.from(shell?.children||[]).filter((child):child is HTMLElement=>child instanceof HTMLElement&&child!==root.parentElement).map(element=>({element,inert:element.inert}));
    for(const item of background)item.element.inert=true;
    root.querySelector<HTMLButtonElement>('.dialog-top button')?.focus({preventScroll:true});
    return()=>{for(const item of background)item.element.inert=item.inert;};
  },[dialog,authenticated,authChecked]);
  useEffect(()=>{
    let active=true;
    setLegacyTokenScope('');
    legacyTokenFor.current='';
    const token=getToken();
    if(isDesktop()||!authenticated||account||!token||!globalThis.crypto?.subtle)return()=>{active=false};
    void globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)).then(digest=>{
      if(!active||getToken()!==token)return;
      const fingerprint=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
      legacyTokenFor.current=token;
      setLegacyTokenScope(`legacy-token:${fingerprint}`);
    }).catch(()=>{});
    return()=>{active=false};
  },[account?.id,authenticated]);
  const [lastSyncAt,setLastSyncAt]=useState('');
  const [offlineQueue,setOfflineQueue]=useState(false);
  const [unknownSessionCommands,setUnknownSessionCommands]=useState<Record<string,string>>(()=>{
    try{return JSON.parse(localStorage.getItem('tuijin-unknown-session-commands')||'{}') as Record<string,string>;}catch{return {};}
  });

  const refresh = useCallback(():Promise<void> => {
    if(isDesktop()&&!desktopStartupReady.current)return Promise.resolve();
    const requestEpoch=connectivityEpoch.current;
    const requestAuthGeneration=authGeneration.current;
    const requestIdentity=accountIdentityRef.current;
    if(refreshInFlight.current?.epoch===requestEpoch&&refreshInFlight.current.authGeneration===requestAuthGeneration&&refreshInFlight.current.identity===requestIdentity)return refreshInFlight.current.promise;
    const requestSequence=++refreshSequence.current;
    const promise=(async()=>{
      try {
        const data = await getState();
        if(requestSequence!==refreshSequence.current||requestEpoch!==connectivityEpoch.current||requestAuthGeneration!==authGeneration.current||requestIdentity!==accountIdentityRef.current||logoutInProgress.current||(!isDesktop()&&(!navigator.onLine||data.connection.mode==='hub'&&document.visibilityState!=='visible')))return;
        checkingRef.current=false;setConnectionChecking(false);handoffBoardRef.current=data;setState(data); setError(''); setTheme(data.connection.mode==='hub'?(localStorage.getItem('tuijin-hub-theme') as Theme||'system'):data.settings.theme); onlineRef.current=true;setOnline(true);setLastSyncAt(new Date().toISOString());
        setProjectId(current => data.projects.some(project=>project.id===current) ? current : (data.projects[0]?.id || ''));
        setTaskId(current => data.tasks.some(task=>task.id===current) ? current : '');
        setUnknownSessionCommands(current=>Object.fromEntries(Object.entries(current).filter(([id])=>!data.tasks.some(task=>task.id===id&&task.conversationId))));
        setPluginForm({pythonPath:data.plugin.config?.pythonPath || '',codexPath:data.plugin.config?.codexPath || '',graceSeconds:String(data.plugin.config?.graceSeconds ?? ''),pollSeconds:String(data.plugin.config?.pollSeconds ?? '')});
        if(!isDesktop()&&!logoutInProgress.current)setAuthenticated(true);
      } catch (e) {if(requestSequence!==refreshSequence.current||requestEpoch!==connectivityEpoch.current||requestAuthGeneration!==authGeneration.current||requestIdentity!==accountIdentityRef.current||logoutInProgress.current)return;if(!isDesktop()&&e instanceof ApiError&&e.status===401){setAuthenticated(false);setState(null);clearToken();setAccount(null);}checkingRef.current=false;setConnectionChecking(false);setError(errorMessage(e));if(!isDesktop()){onlineRef.current=false;setOnline(false);}}
    })();
    refreshInFlight.current={epoch:requestEpoch,authGeneration:requestAuthGeneration,identity:requestIdentity,promise};
    void promise.then(()=>{if(refreshInFlight.current?.promise===promise)refreshInFlight.current=null;});
    return promise;
  }, []);
  useEffect(()=>{
    if(!window.taskboard)return;
    const gate=createDesktopStartupGate(window.taskboard,{
      onStatus:status=>{
        desktopStartupReady.current=status.phase==='ready';setDesktopStartup(status);
        if(status.phase!=='ready'){
          refreshSequence.current++;refreshInFlight.current=null;setState(null);
        }
      },
      onReady:()=>{void refresh();},
      onError:error=>{if(!desktopStartupReady.current)setDesktopStartup(current=>({phase:'failed',revision:current?.revision??0,
        message:error instanceof Error?error.message:'桌面服务状态暂不可读取'}));},
    });
    desktopStartupGate.current=gate;
    return()=>{desktopStartupGate.current=null;gate.dispose();};
  },[refresh]);
  const markClientOffline=useCallback(()=>{connectivityEpoch.current++;refreshSequence.current++;checkingRef.current=false;setConnectionChecking(false);onlineRef.current=false;setOnline(false);},[]);
  const getClientStatus=useCallback(()=>({online:onlineRef.current&&!checkingRef.current&&navigator.onLine,epoch:connectivityEpoch.current}),[]);
  useEffect(()=>{
    if(isDesktop())return;
    const invalidate=(force=false)=>{if(checkingRef.current&&!force)return;checkingRef.current=true;connectivityEpoch.current++;refreshSequence.current++;onlineRef.current=false;setOnline(false);setConnectionChecking(true);};
    const recheck=()=>{if(!authenticated||state?.connection.mode!=='hub'){if(authChecked)void refresh();return}if(!checkingRef.current&&Date.now()-lastResumeCheckAt.current<250)return;lastResumeCheckAt.current=Date.now();invalidate();if(navigator.onLine&&document.visibilityState==='visible')void refresh();};
    const disconnected=()=>{invalidate(true);setConnectionChecking(false);};
    const reconnected=()=>{if(!authenticated||state?.connection.mode!=='hub'){if(authChecked)void refresh();return}lastResumeCheckAt.current=Date.now();invalidate(true);if(navigator.onLine&&document.visibilityState==='visible')void refresh();};
    const visibility=()=>{if(!authenticated||state?.connection.mode!=='hub')return;if(document.visibilityState==='hidden')invalidate(true);else recheck();};
    const pageshow=()=>{if(document.visibilityState==='visible')recheck();};
    window.addEventListener('offline',disconnected);
    window.addEventListener('online',reconnected);
    window.addEventListener('pageshow',pageshow);window.addEventListener('focus',pageshow);document.addEventListener('visibilitychange',visibility);
    return()=>{window.removeEventListener('offline',disconnected);window.removeEventListener('online',reconnected);window.removeEventListener('pageshow',pageshow);window.removeEventListener('focus',pageshow);document.removeEventListener('visibilitychange',visibility);};
  },[refresh,authChecked,authenticated,state?.connection.mode]);

  useEffect(()=>{if(isDesktop())return;let active=true;const authEpoch=connectivityEpoch.current;const authSequence=++refreshSequence.current;const bootAuthGeneration=authGeneration.current;const bootIsCurrent=()=>active&&authSequence===refreshSequence.current&&authEpoch===connectivityEpoch.current&&bootAuthGeneration===authGeneration.current&&!logoutInProgress.current;(async()=>{
    try{const result=await request<{registrationEnabled:boolean}>('GET','/api/auth/status');if(bootIsCurrent()){setRegistrationEnabled(Boolean(result.registrationEnabled));setAccountsAvailable(true);}}catch{/* Legacy hubs may not expose account status. */}
    try{const result=await request<{user:AccountUser}>('GET','/api/auth/me');if(bootIsCurrent())setAccount(result.user);}catch{/* A valid legacy bearer may still access /api/state. */}
    try{const result=await getState();if(active&&authSequence===refreshSequence.current&&authEpoch===connectivityEpoch.current&&bootAuthGeneration===authGeneration.current&&!logoutInProgress.current&&navigator.onLine){setState(result);setAuthenticated(true);setProjectId(result.projects[0]?.id||'');onlineRef.current=true;setOnline(true);}}catch{if(active&&authSequence===refreshSequence.current&&authEpoch===connectivityEpoch.current&&bootAuthGeneration===authGeneration.current&&!logoutInProgress.current){setAuthenticated(false);onlineRef.current=false;setOnline(false);}}
    if(active){setAuthChecked(true);if(navigator.onLine&&!onlineRef.current)void refresh();}
  })();return()=>{active=false};},[refresh]);
  useEffect(() => {if (authenticated) void refresh();}, [authenticated, refresh]);
  useEffect(() => {
    if(!authenticated||!state)return;
    if(state.connection.mode==='hub'){
      const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh()},2000);
      return()=>window.clearInterval(timer);
    }
    return subscribe(()=>{void refresh()},connected=>setOnline(connected));
  },[authenticated,refresh,state?.connection.mode]);
  useEffect(()=>{
    if(!authenticated||state?.connection.mode==='hub'||(page!=='tasks'&&page!=='conversations'))return;
    const timer=window.setInterval(()=>{if(document.visibilityState==='visible'&&!busy)void refresh()},5000);
    return()=>window.clearInterval(timer);
  },[authenticated,state?.connection.mode,page,busy,refresh]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => setResolvedTheme(theme === 'system' ? (media.matches ? 'dark' : 'light') : theme);
    apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {document.documentElement.dataset.theme = resolvedTheme;}, [resolvedTheme]);
  useEffect(()=>{localStorage.setItem('tuijin-unknown-session-commands',JSON.stringify(unknownSessionCommands));},[unknownSessionCommands]);

  const project = state?.projects.find(p=>p.id===projectId);
  const dialogProject = dialog==='task'&&dialogCreateProjectId?state?.projects.find(item=>item.id===dialogCreateProjectId)||null:project;
  const tasks = useMemo(()=>state?.tasks.filter(t=>t.projectId===projectId && t.status!=='cancelled') || [],[state,projectId]);
  const codexTasks=tasks.filter(item=>!item.executionProvider||item.executionProvider==='codex-autocontinue');
  const conversationChoices=useMemo(()=>{
    const choices=new Map<string,string>();
    choices.set('all','全部会话');choices.set('unbound','未绑定执行会话');
    for(const item of tasks){
      if(item.sourceConversation?.conversationId){const source=item.sourceConversation;choices.set(JSON.stringify({kind:'source',provider:source.provider,id:source.conversationId}),`来源 · ${source.label||source.provider+' / '+source.conversationId}`);}
      if(item.conversationId)choices.set(JSON.stringify({kind:'bound',id:item.conversationId}),`执行 · ${item.conversationId}`);
    }
    return [...choices];
  },[tasks]);
  const visibleTasks=useMemo(()=>tasks.filter(item=>{
    if(verificationFilter!=='all' && verificationState(item)!==verificationFilter)return false;
    if(conversationFilter==='all')return true;
    if(conversationFilter==='unbound')return state?.connection.mode==='hub'?!item.hasExecutionBinding:!item.conversationId;
    try{const choice=JSON.parse(conversationFilter) as {kind:string;provider?:string;id:string};return choice.kind==='source'?item.sourceConversation?.provider===choice.provider&&item.sourceConversation?.conversationId===choice.id:item.conversationId===choice.id;}
    catch{return true;}
  }),[tasks,conversationFilter,verificationFilter]);
  const task=visibleTasks.find(t=>t.id===taskId)||null;
  const feedbackSource=task?.previewFeedback?state?.tasks.find(item=>item.id===task.previewFeedback?.sourceTaskId&&item.projectId===task.previewFeedback?.projectId)||null:null;
  const terminalTask=state?.tasks.find(item=>item.id===terminalTaskId&&item.projectId===projectId);
  useEffect(()=>{if(page!=='terminal'||!terminalTask)setTerminalTaskId('');},[page,terminalTask?.id,projectId]);
  const currentContinueGate=continueGate(task&&project?.id===task.projectId?task:null,executionGateNow);
  const selectedTaskRef=useRef(taskId);selectedTaskRef.current=taskId;
  useEffect(()=>{if(page!=='tasks')return;const timer=window.setInterval(()=>setExecutionGateNow(Date.now()),500);return()=>window.clearInterval(timer)},[page]);
  const activeAccountId=account?.id||(legacyTokenFor.current===getToken()?legacyTokenScope:'');
  accountIdentityRef.current=activeAccountId;
  useEffect(()=>{if(authenticated&&activeAccountId)void refresh()},[authenticated,activeAccountId,refresh]);
  const taskDialog=dialog==='edit'||dialog==='evidence'||dialog==='review';
  const hubCreatePending=dialog==='task'&&state?.connection.mode==='hub'&&Boolean(dialogProject&&pendingForProject(dialogProject.id).some(item=>item.action==='create_task'));
  const dialogStaleReason=taskDialog?(!dialogTaskBinding||dialogTaskBinding.dialog!==dialog?'任务草稿未绑定当前任务，请关闭后重新打开。':dialogTaskBinding.authGeneration!==authGeneration.current||dialogTaskBinding.accountId!==activeAccountId?'连接身份已变化，请关闭草稿后重新核对任务。':!task||task.id!==dialogTaskBinding.taskId||task.projectId!==dialogTaskBinding.projectId||projectId!==dialogTaskBinding.projectId?'当前任务已变化，请关闭草稿后重新核对任务。':task.revision!==dialogTaskBinding.revision||task.contentVersion!==dialogTaskBinding.contentVersion?'任务内容或记录已更新，请关闭草稿、核对当前版本后重新打开。':''):'';
  const issues = tasks.flatMap(t=>t.issues.filter(i=>i.open).map(i=>({task:t,issue:i})));
  const doneCount = visibleTasks.filter(isCompleted).length;
  const totalDoneCount = tasks.filter(isCompleted).length;
  const active = visibleTasks.filter(t=>groupOf(t)==='active');
  const todo = visibleTasks.filter(t=>groupOf(t)==='todo');
  const done = visibleTasks.filter(t=>groupOf(t)==='done');
  const clientOffline=!isDesktop()&&(!online||checkingRef.current||!navigator.onLine);
  const remoteWriteBlocked=clientOffline||(state?.connection.mode==='hub'&&(!activeAccountId||state.capabilities.role==='viewer'||state.connection.offline&&!offlineQueue));
  const canReconcileCommand=Boolean(state?.connection.mode==='hub'&&state.capabilities.remote&&activeAccountId&&!clientOffline&&!state.connection.offline&&!logoutInProgress.current&&state.capabilities.role!=='viewer');
  const recoveryAuthGeneration=authGeneration.current;
  function storedPendingCommands():PendingTaskCommand[]{try{const value=JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]');return Array.isArray(value)?value.filter(item=>typeof item?.id==='string'&&typeof item?.action==='string'&&typeof item?.accountId==='string'):[]}catch{return [];}}
  function rememberPendingCommand(command:PendingTaskCommand){const stored=storedPendingCommands();const previous=stored.find(item=>item.id===command.id);if(previous&&JSON.stringify({...previous,...command})===JSON.stringify(previous))return;const next=stored.some(item=>item.id===command.id)?stored.map(item=>item.id===command.id?{...item,...command}:item):[...stored,command];sessionStorage.setItem('tuijin-pending-commands',JSON.stringify(next));setPendingCommands(next);}
  function forgetPendingCommand(id:string){const next=storedPendingCommands().filter(item=>item.id!==id);sessionStorage.setItem('tuijin-pending-commands',JSON.stringify(next));setPendingCommands(next);}
  function pendingForTask(id:string){return storedPendingCommands().filter(item=>item.taskId===id&&item.accountId===activeAccountId);}
  function pendingForProject(id:string){return storedPendingCommands().filter(item=>item.projectId===id&&item.accountId===activeAccountId);}
  function hubTaskCreateBlockReason(target:Project|null|undefined=project):string{
    if(state?.connection.mode!=='hub')return '';
    if(!target)return '请先选择一个项目。';
    return taskCreateAvailabilityReason({role:state.capabilities.role,hasIdentity:Boolean(activeAccountId),remote:state.capabilities.remote,
      online:getClientStatus().online&&!state.connection.offline,available:target.taskCreationAvailable,
      pending:pendingForProject(target.id).some(item=>item.action==='create_task')});
  }
  function rememberConversationCommand(id:string,projectId:string,action:string,taskId?:string,status='sending'){rememberPendingCommand({id,projectId,taskId,action,accountId:activeAccountId,status});}
  function showReviewReceipt(receipt:CommandReceipt,scope:{accountId?:string;projectId?:string;taskId?:string},generation=authGeneration.current,confirmedRecovery?:'applied'|'not_applied'){
    if(receipt.action!=='review'||!receipt.commandId||!receipt.taskId||!receipt.projectId||receipt.taskId!==scope.taskId||receipt.projectId!==scope.projectId||scope.accountId!==activeAccountId||generation!==authGeneration.current)return;
    const rejection=reviewRejectionText(receipt);
    const status:ReviewFeedback['status']=confirmedRecovery==='not_applied'?'failed':confirmedRecovery==='applied'?'confirmed':receiptPending(receipt)?'pending':receipt.status==='unknown'?'unknown':receipt.status==='failed'||receipt.status==='expired'?'failed':'confirmed';
    const text=status==='pending'?'验收请求正在等待目标电脑确认；本次结论尚未确认。':status==='unknown'?'验收结果尚未确认。请先核实这次操作，暂勿重复提交。':status==='failed'?rejection||'本次验收没有确认成功。请核对任务状态和失败原因后再处理。':'目标电脑已回执验收请求，请核对同步后的任务状态。';
    setReviewFeedback(previous=>previous&&previous.commandId===receipt.commandId&&['failed','confirmed'].includes(previous.status)&&status==='pending'?previous:{accountId:scope.accountId!,authGeneration:generation,projectId:receipt.projectId!,taskId:receipt.taskId!,commandId:receipt.commandId!,status,text});
  }
  function isCommandRecoveryCurrent(identityKey:string,expectedAuthGeneration=authGeneration.current){return !logoutInProgress.current&&authGeneration.current===expectedAuthGeneration&&activeAccountId===identityKey&&getClientStatus().online&&(Boolean(account?.id)||legacyTokenFor.current===getToken());}
  function handleCommandRecovery(receipt:CommandReceipt,expectedAuthGeneration=recoveryAuthGeneration){
    const recovery=receipt.recovery;
    if(!receipt.commandId||!recovery||!['applied','not_applied'].includes(recovery.outcome)||!recovery.requestedAt||!recovery.checkedAt||!isCommandRecoveryCurrent(activeAccountId,expectedAuthGeneration))return;
    const requested=Date.parse(recovery.requestedAt),checked=Date.parse(recovery.checkedAt);
    if(!Number.isFinite(requested)||!Number.isFinite(checked)||checked<requested)return;
    const intent=storedPendingCommands().find(item=>item.id===receipt.commandId&&item.accountId===activeAccountId&&item.projectId===receipt.projectId&&(item.action==='new'?(!item.taskId||item.taskId===receipt.taskId)&&receipt.action==='create_conversation':item.taskId===receipt.taskId&&item.action===receipt.action));
    if(!intent)return;
    if(intent.action==='create_task'){
      if(receipt.status==='completed'||recovery.outcome==='applied'){
        handleHubTaskCreateReceipt(receipt,intent,expectedAuthGeneration);return;
      }
      if(receipt.status!=='completed'&&recovery.outcome==='not_applied'){
        forgetPendingCommand(intent.id);setNotice('电脑已确认原请求没有执行；草稿已保留，核对后可重新提交。');setNoticeWarning(false);return;
      }
      return;
    }
    forgetPendingCommand(intent.id);
    const rejection=reviewRejectionText(receipt);
    showReviewReceipt(receipt,intent,expectedAuthGeneration,recovery.outcome as 'applied'|'not_applied');
    setNotice(rejection||(recovery.outcome==='applied'?'电脑已确认这次操作已执行；请查看任务进展和输出。':'电脑已确认这次操作没有执行，可以重新提交。'));
    setNoticeWarning(Boolean(rejection));
    void refresh();
  }
  const activeTaskPending=task?pendingForTask(task.id):[];const taskHasUnresolvedWrite=activeTaskPending.length>0;const pausePending=activeTaskPending.some(item=>item.action==='pause');
  const taskReviewFeedback=task&&reviewFeedback?.accountId===activeAccountId&&reviewFeedback.authGeneration===authGeneration.current&&reviewFeedback.projectId===task.projectId&&reviewFeedback.taskId===task.id?reviewFeedback:null;
  const pendingReview=activeTaskPending.find(item=>item.action==='review');
  const pendingReviewDisplay=pendingReview?{status:pendingReview.status==='unknown'?'unknown':'pending',text:pendingReview.status==='unknown'?'验收结果尚未确认。请先核实这次操作，暂勿重复提交。':'验收请求正在等待目标电脑确认；本次结论尚未确认。'}:null;
  const taskReviewDisplay=pendingReview&&(pendingReview.id!==taskReviewFeedback?.commandId||pendingReview.status==='unknown')?pendingReviewDisplay:taskReviewFeedback||pendingReviewDisplay;
  useLayoutEffect(()=>{
    if(page!=='tasks'||dialog||!taskReviewDisplay||!window.matchMedia('(max-width:760px)').matches)return;
    const key=`${authGeneration.current}:${task?.id||''}:${pendingReview?.id||taskReviewFeedback?.commandId||''}:${taskReviewDisplay.status}`;
    if(shownReviewFeedbackKeys.current.has(key))return;
    shownReviewFeedbackKeys.current.add(key);
    const frame=window.requestAnimationFrame(()=>{
      const element=reviewFeedbackRef.current,nav=document.querySelector('.mobile-nav');
      if(!element||!nav)return;
      const message=element.getBoundingClientRect(),visibleBottom=nav.getBoundingClientRect().top-10;
      if(message.top<window.innerHeight&&message.bottom>visibleBottom)window.scrollBy(0,message.bottom-visibleBottom);
    });
    return()=>window.cancelAnimationFrame(frame);
  },[page,dialog,task?.id,taskReviewDisplay?.status,taskReviewDisplay?.text,pendingReview?.id,taskReviewFeedback?.commandId]);
  const inboxCount=state?.inbox?.items.filter(item=>item.projectId===projectId&&item.state==='open').length||0;
  function openInboxTask(nextTaskId:string,nextProjectId:string){pendingTaskScroll.current=nextTaskId?{taskId:nextTaskId,projectId:nextProjectId}:null;setProjectId(nextProjectId);setConversationFilter('all');setVerificationFilter('all');setTaskId(nextTaskId);setMobileDetail(Boolean(nextTaskId));setPage('tasks');}
  async function openFeedbackTask(nextTaskId:string,sourceProjectId:string){
    setError('');await refresh();
    const target=handoffBoardRef.current?.tasks.find(item=>item.id===nextTaskId&&item.projectId===sourceProjectId);
    if(!target){setError('关联任务尚未出现在当前项目中。请刷新任务列表后再试。');return;}
    setPreviewTaskId('');setNotice(`已打开修改任务「${target.title}」。`);openInboxTask(target.id,target.projectId);
  }
  function returnToFeedbackSource(feedbackTask:Task){
    const link=feedbackTask.previewFeedback;
    if(!link)return;
    const source=state?.tasks.find(item=>item.id===link.sourceTaskId&&item.projectId===link.projectId);
    if(!source){setError('来源任务当前不在已同步项目中，无法打开来源预览。');return;}
    setError('');setNotice(`已返回「${source.title}」的最新预览。此反馈来自内容版本 ${link.sourceContentVersion}；请按关联标准重新核对。`);
    openInboxTask(source.id,source.projectId);setPreviewTaskId(source.id);
  }
  function openTaskTerminal(nextTaskId:string,nextProjectId:string){
    if(!state?.tasks.some(item=>item.id===nextTaskId&&item.projectId===nextProjectId)){setError('任务已变化，请刷新后再打开项目终端。');return;}
    setProjectId(nextProjectId);setTerminalTaskId(nextTaskId);setMobileMoreOpen(false);setMobileDetail(false);setPage('terminal');
  }
  function openTaskStart(taskId:string,nextProjectId:string){setProjectId(nextProjectId);setConversationTaskId(taskId);setMobileDetail(false);setPage('conversations');}
  useNativeBack(()=>{
    if(!authenticated||!state)return false;
    if(dialog){if(!busy)closeDialog(true);return true;}
    if(mobileMoreOpen){setMobileMoreOpen(false);return true;}
    if(page==='tasks'&&task&&previewTaskId===task.id){setPreviewTaskId('');return true;}
    if(page==='terminal'&&terminalTask){openInboxTask(terminalTask.id,terminalTask.projectId);return true;}
    if(page==='tasks'&&mobileDetail){setMobileDetail(false);return true;}
    if(page!=='supervision'){setPage('supervision');setMobileDetail(false);return true;}
    return false;
  });
  function openInboxReview(nextTaskId:string,nextProjectId:string){const target=state?.tasks.find(item=>item.id===nextTaskId&&item.projectId===nextProjectId);if(!target){setError('任务已变化，请刷新后重新打开验收。');void refresh();return}openInboxTask(nextTaskId,nextProjectId);setReviewDecision('pass');openDialog('review',{},target);}
  const canControlTask=(item:Task)=>state?.connection.mode==='hub'?Boolean(item.hasExecutionBinding):Boolean(item.conversationId);

  async function taskRequest<T>(method:string,path:string,body?:unknown):Promise<T>{
    if(state?.connection.mode!=='hub'||!state.capabilities.remote)return request<T>(method,path,body);
    if(!activeAccountId)throw new Error('正在确认连接身份，请稍后重试。');
    if(!getClientStatus().online)throw new Error('连接状态待确认，请恢复连接并刷新状态后再操作。');
    const match=path.match(/^\/api\/tasks\/([^/]+)(?:\/(continue|pause|evidence|review))?$/);
    if(!match)return request<T>(method,path,body);
    if(state.capabilities.role==='viewer')throw Error('此连接只有查看权限。');
    const target=state.tasks.find(item=>item.id===decodeURIComponent(match[1]));
    if(!target)throw Error('任务已变化，请刷新后重试。');
    const action=match[2]||(method==='PATCH'?'update':'');
    if(!['continue','pause','update','evidence','review'].includes(action))throw Error('手机端不支持此操作。');
    const payload=(body||{}) as Record<string,unknown>;
    if(action==='update'&&payload.conversationId!==undefined)throw Error('手机端不能修改执行会话绑定，请在桌面端操作。');
    const commandId=typeof payload.commandId==='string'?payload.commandId:crypto.randomUUID();
    const unresolved=pendingForTask(target.id);
    if(action==='pause'){
      if(unresolved.some(item=>item.action==='pause'))throw Error('暂停请求已有未决回执，请先核对同一命令 ID。');
      if(unresolved.some(item=>!['continue','update'].includes(item.action)))throw Error('此任务已有未决写操作，请先核对回执后再暂停。');
    }else if(unresolved.length)throw Error('此任务已有未决写操作；请先核对回执，不能重新提交或继续编辑。');
    const commandBody=Object.fromEntries(Object.entries(payload).filter(([key])=>!['expectedRevision','commandId','conversationId'].includes(key)));
    const intent:PendingTaskCommand={id:commandId,projectId:target.projectId,taskId:target.id,action,accountId:activeAccountId,status:'sending'};
    rememberPendingCommand(intent);
    try{
      const result=await request<T>('POST','/api/commands',{commandId,projectId:target.projectId,taskId:target.id,action,expectedRevision:payload.expectedRevision,expiresAt:new Date(Date.now()+5*60*1000).toISOString(),queueOffline:state.connection.offline&&offlineQueue,body:commandBody});
      const receipt=result as T&CommandReceipt;
      if(!receipt||receipt.commandId!==commandId||receipt.projectId!==target.projectId||receipt.taskId!==target.id||receipt.action!==action||!['queued','received','sending','running','paused','unknown','expired','failed','completed'].includes(receipt.status)){rememberPendingCommand({...intent,status:'unknown'});throw new Error('验收或任务操作的回执无法确认；原命令结果待核实，请勿重复提交。');}
      if(receipt&&typeof receipt==='object'&&receipt.status==='unknown')rememberPendingCommand({...intent,status:'unknown'});
      else if(receipt&&typeof receipt==='object'&&receipt.status&&receiptPending(receipt))rememberPendingCommand({...intent,status:receipt.status});
      else if(receipt&&typeof receipt==='object'&&receipt.status)forgetPendingCommand(commandId);
      return result;
    }catch(error){
      if(error instanceof ApiError&&error.status>=400&&error.status<500&&![401,403,404].includes(error.status))forgetPendingCommand(commandId);
      throw error;
    }
  }
  function acknowledge(value:unknown,action:string):boolean{
    if(state?.connection.mode!=='hub'||!state.capabilities.remote||!value||typeof value!=='object')return false;
    const receipt=value as CommandReceipt;
    if(typeof receipt.status!=='string'||!receipt.commandId)return false;
    setReceiptNotice(receipt,action);
    if(action==='review'&&task)showReviewReceipt(receipt,{accountId:activeAccountId,projectId:task.projectId,taskId:task.id});
    if(receiptPending(receipt)||receipt.status==='unknown')rememberPendingCommand({id:receipt.commandId,action,accountId:activeAccountId,status:receipt.status});
    else forgetPendingCommand(receipt.commandId);
    return true;
  }
  useEffect(()=>{
    if(!pendingCommands.some(item=>item.accountId===activeAccountId&&item.action!=='start_task')||state?.connection.mode!=='hub'||!state.capabilities.remote)return;
    let active=true;let timer:number|undefined;const pollAccountId=activeAccountId,pollToken=getToken(),pollAuthGeneration=authGeneration.current,pollEpoch=connectivityEpoch.current;
    const isCurrent=()=>active&&!logoutInProgress.current&&activeAccountId===pollAccountId&&getToken()===pollToken&&authGeneration.current===pollAuthGeneration&&connectivityEpoch.current===pollEpoch&&getClientStatus().online&&(Boolean(account?.id)||legacyTokenFor.current===pollToken);
    const poll=async()=>{
      for(const pending of pendingCommands.filter(item=>item.accountId===activeAccountId)){
        if(!isCurrent())return;
        if(pending.action==='start_task')continue;
        try{
          const receipt=await request<CommandReceipt>('GET',`/api/commands/${encodeURIComponent(pending.id)}`);
          if(!isCurrent())return;
          const expectedAction=pending.action==='new'?'create_conversation':pending.action;
          if(receipt.commandId!==pending.id||receipt.action!==expectedAction||receipt.projectId!==pending.projectId||pending.taskId&&receipt.taskId!==pending.taskId)continue;
          if(!['queued','received','sending','running','paused','unknown','expired','failed','completed'].includes(receipt.status)){
            if(pending.status!=='unknown'){rememberPendingCommand({...pending,status:'unknown'});setError('回执状态无法确认；原命令结果待核实，请勿重复提交。');}
            continue;
          }
          const recovery=receipt.recovery;
          if(recovery&&['applied','not_applied'].includes(recovery.outcome)&&recovery.requestedAt&&recovery.checkedAt&&Date.parse(recovery.checkedAt)>=Date.parse(recovery.requestedAt)){handleCommandRecovery(receipt,pollAuthGeneration);continue;}
          if(receiptPending(receipt)||receipt.status==='unknown'){
            if(pending.status!==receipt.status){rememberPendingCommand({...pending,status:receipt.status});setReceiptNotice(receipt,receipt.action||pending.action);showReviewReceipt(receipt,pending,pollAuthGeneration);}
            continue;
          }
          if(pending.action==='create_task'){
            handleHubTaskCreateReceipt(receipt,pending,pollAuthGeneration);continue;
          }
          forgetPendingCommand(pending.id);
          showReviewReceipt(receipt,pending,pollAuthGeneration);
          setReceiptNotice(receipt,receipt.action||pending.action);await refresh();
        }catch(e){if(isCurrent())setError(errorMessage(e));}
      }
      if(isCurrent())timer=window.setTimeout(poll,3000);
    };
    timer=window.setTimeout(poll,1500);
    return()=>{active=false;if(timer)window.clearTimeout(timer);};
  },[pendingCommands,state?.connection.mode,state?.capabilities.remote,activeAccountId,online,recoveryAuthGeneration,connectivityEpoch.current,refresh]);

  async function mutate<T>(method:string,path:string,body?:unknown,success='已保存'): Promise<T | undefined> {
    if(state?.connection.mode==='hub'&&(remoteWriteBlocked||!getClientStatus().online)){setError(!getClientStatus().online?'连接状态待确认，请恢复连接并刷新状态后再操作。':'当前连接没有写入权限，或目标电脑离线且未允许本次排队。');return undefined;}
    const mutationAuthGeneration=authGeneration.current,mutationAccountId=activeAccountId;
    setBusy(true);setError('');setNotice('');
    try {const value = await taskRequest<T>(method,path,body);if(mutationAuthGeneration!==authGeneration.current||mutationAccountId!==accountIdentityRef.current)return undefined; setOfflineQueue(false); await refresh();if(mutationAuthGeneration!==authGeneration.current||mutationAccountId!==accountIdentityRef.current)return undefined; const action=path.endsWith('/evidence')?'evidence':path.endsWith('/review')?'review':method==='PATCH'&&path.startsWith('/api/tasks/')?'update':path.split('/').pop()||'';if(!acknowledge(value,action))setNotice(success); return value;}
    catch(e) {if(mutationAuthGeneration!==authGeneration.current||mutationAccountId!==accountIdentityRef.current)return undefined;if(!isDesktop()&&e instanceof TypeError)markClientOffline();const restartPolicy=path==='/api/plugin/policy'&&Boolean(body&&typeof body==='object'&&'restart' in body&&(body as {restart?:unknown}).restart===true);setError(restartPolicy?`本次重新开始尚未确认，请刷新核对任务与计划，不要连续重试。${errorMessage(e)}`:errorMessage(e)); return undefined;}
    finally {if(mutationAuthGeneration===authGeneration.current&&mutationAccountId===accountIdentityRef.current)setBusy(false);}
  }
  function toggleVerificationCheck(checkId:string,completed:boolean) {
    if(!task||state?.connection.mode==='hub'||state?.capabilities.role==='viewer'||(state?.capabilities.role&&state.capabilities.role!=='owner'))return;
    void mutate<Task>('POST',`/api/tasks/${encodeURIComponent(task.id)}/verification-checks/${encodeURIComponent(checkId)}`,{expectedRevision:task.revision,completed},completed?'验证待办已办结':'验证待办已重新打开');
  }
  function openDialog(next: Dialog, values: Record<string,string>={},targetTask?:Task,createProjectId?:string) {
    const active=document.activeElement;dialogOpenerRef.current=lastClickedElementRef.current?.isConnected?lastClickedElementRef.current:active instanceof HTMLElement?active:null;lastClickedElementRef.current=null;
    const target=targetTask||task;
    const binding=(next==='edit'||next==='evidence'||next==='review')&&target?{dialog:next,taskId:target.id,projectId:target.projectId,revision:target.revision,contentVersion:target.contentVersion,accountId:activeAccountId,authGeneration:authGeneration.current}:null;
    const createTarget=next==='task'?(state?.projects.find(item=>item.id===createProjectId)||project):null;
    const createScope=next==='task'&&state?.connection.mode==='hub'&&createTarget?{accountId:activeAccountId,projectId:createTarget.id}:null;
    const key=binding?taskFormDraftKey(isDesktop()?'local-owner':activeAccountId,binding.projectId,binding.taskId,binding.dialog):createScope?taskFormDraftKey(createScope.accountId,createScope.projectId,'__new_task__','create'):null;
    const restored=key&&formDraftStorage?readTaskFormDraft(formDraftStorage,key):null;
    const initialDraft:TaskFormDraft=binding?{revision:binding.revision,contentVersion:binding.contentVersion,values,reviewDecision:'pass'}:{revision:0,contentVersion:'new-task',values,reviewDecision:'pass'};
    formDraftRef.current=key?{key,draft:restored||initialDraft}:null;
    setDialogTaskBinding(binding&&restored?{...binding,revision:restored.revision,contentVersion:restored.contentVersion}:binding);
    setDialogCreateProjectId(createTarget?.id||'');
    setForm(restored?.values||values);setReviewDecision(restored?.reviewDecision||'pass');
    setFormDraftNotice(restored?'已恢复上次未提交的草稿；取消会丢弃草稿。':'');setError('');setDialog(next);
  }
  function closeDialog(preserveDraft=false) {
    const snapshot=formDraftRef.current;
    if(preserveDraft&&snapshot?.key&&(!formDraftStorage||!saveTaskFormDraft(formDraftStorage,snapshot.key,snapshot.draft))){setError('系统返回前未能保存草稿，窗口保持打开；请复制内容后重试。');setFormDraftNotice('草稿暂未保存，窗口保持打开，请先复制内容。');return;}
    const createStillPending=snapshot?.key&&storedPendingCommands().some(item=>item.action==='create_task'&&item.accountId===activeAccountId&&item.draftKey===snapshot.key);
    if(createStillPending){
      formDraftRef.current=null;setFormDraftNotice('');setDialog(null);setDialogTaskBinding(null);setDialogCreateProjectId('');setError('');
      setNotice('新建请求仍在核实中；草稿已收起并保留。关闭窗口不会撤回请求，请等待原命令回执。');setNoticeWarning(true);return;
    }
    if(!preserveDraft&&snapshot?.key&&formDraftStorage&&!discardTaskFormDraft(formDraftStorage,snapshot.key,snapshot.draft)){setError('未能清理此设备上的草稿，请稍后再试。');return;}
    formDraftRef.current=null;setFormDraftNotice('');setDialog(null);setDialogTaskBinding(null);setDialogCreateProjectId('');setError('');
  }
  function handleHubTaskCreateReceipt(receipt:CommandReceipt,pending:PendingTaskCommand,generation=authGeneration.current){
    const envelopeMatches=receipt.commandId===pending.id&&receipt.projectId===pending.projectId&&receipt.taskId===pending.taskId&&receipt.action==='create_task';
    if(!envelopeMatches){rememberPendingCommand({...pending,status:'unknown'});setError('新建任务回执无法与原请求对应；原命令待核实，请勿重复提交。');return;}
    if(receipt.status==='completed'){
      const createdTaskId=confirmedHubTaskId(receipt,pending.id,pending.projectId||'');
      if(!createdTaskId){rememberPendingCommand({...pending,status:'unknown'});setError('新建任务结果格式无法确认；原命令待核实，请勿重复提交。');return;}
      const alreadyHandled=pending.confirmedTaskId===createdTaskId;
      const storedDraft=pending.draftKey&&formDraftStorage?readTaskFormDraft(formDraftStorage,pending.draftKey):null;
      const draftCleared=!pending.draftKey||!formDraftStorage||!storedDraft||discardTaskFormDraft(formDraftStorage,pending.draftKey,storedDraft);
      if(draftCleared)forgetPendingCommand(pending.id);
      else{
        rememberPendingCommand({...pending,status:'completed',confirmedTaskId:createdTaskId});
        setFormDraftNotice('任务已创建，但本地草稿未能清理；请勿重复提交。');
        setNotice('任务已创建，但本地草稿未能清理。请先核对已创建任务，暂勿重新提交。');setNoticeWarning(true);
      }
      const currentDraft=formDraftRef.current;
      if(currentDraft?.key===pending.draftKey){formDraftRef.current=null;if(draftCleared)setFormDraftNotice('');setDialog(null);setDialogTaskBinding(null);setDialogCreateProjectId('');setForm({});}
      if(draftCleared){setNotice('任务已创建。');setNoticeWarning(false);}
      setError('');
      if(!alreadyHandled){
        const accountId=pending.accountId,projectId=pending.projectId,taskId=createdTaskId;
        void refresh().then(()=>{
          if(authGeneration.current!==generation||activeAccountId!==accountId||!handoffBoardRef.current?.projects.some(item=>item.id===projectId))return;
          setProjectId(projectId!);setTaskId(taskId);setPage('tasks');setMobileDetail(true);
        });
      }
      return;
    }
    if(receipt.status==='failed'||receipt.status==='expired'){
      forgetPendingCommand(pending.id);setError(commandText(receipt,'create_task'));setNotice(`${commandText(receipt,'create_task')} 草稿已保留，可核对后再试。`);setNoticeWarning(true);setFormDraftNotice('任务尚未创建，草稿已保留，可核对后再试。');return;
    }
    const status=['queued','received','sending','running','paused','unknown'].includes(receipt.status)?receipt.status:'unknown';
    rememberPendingCommand({...pending,status});
    setFormDraftNotice('新建请求尚未确认，草稿已保留；请等待原命令回执，不要再次提交。');
    if(status==='unknown')setError('新建任务结果待核实；请勿重复提交。');
    else setNotice(commandText(receipt,'create_task'));
  }
  function rememberFormDraft(values:Record<string,string>,decision=reviewDecision){
    const snapshot=formDraftRef.current;if(!snapshot)return;
    const next={key:snapshot.key,draft:{...snapshot.draft,values,reviewDecision:decision}};
    formDraftRef.current=next;
    setFormDraftNotice(formDraftStorage&&saveTaskFormDraft(formDraftStorage,next.key,next.draft)?'草稿保存在当前设备，不会自动提交；取消会丢弃草稿。':'草稿暂未保存到此设备，请先复制内容，避免刷新后丢失。');
  }
  function changeReviewDecision(decision:'pass'|'fail'){setReviewDecision(decision);rememberFormDraft(form,decision);}
  function finishTaskForm(value:unknown,snapshot:typeof formDraftRef.current){
    const receipt=value as CommandReceipt;
    const result=receipt?.result as {taskId?:unknown;status?:unknown}|undefined;
    const applied=receipt?.status==='running'&&['update','evidence','review'].includes(receipt.action||'')&&result?.taskId===receipt.taskId&&typeof result?.status==='string'&&result.status.length>0;
    if(receipt?.commandId&&(!applied||receipt.error||reviewRejectionText(receipt))){
      if(formDraftRef.current===snapshot)setFormDraftNotice(commandText(receipt,receipt.action||'update')+' 草稿已保留，请先核对本次结果。');
      return;
    }
    if(snapshot?.key&&formDraftStorage&&!discardTaskFormDraft(formDraftStorage,snapshot.key,snapshot.draft)){
      if(formDraftRef.current===snapshot)setFormDraftNotice('更改已确认，但本地草稿未能清理；请勿重复提交。');
      return;
    }
    if(formDraftRef.current===snapshot){formDraftRef.current=null;setFormDraftNotice('');setDialog(null);setDialogTaskBinding(null);setError('');}
  }
  function handleDialogKeyDown(event:KeyboardEvent<HTMLDivElement>){
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeDialog();return;}
    if(event.key!=='Tab')return;
    const root=dialogRef.current;if(!root)return;
    const focusable=Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],summary,[tabindex]:not([tabindex="-1"])')).filter(element=>element.getClientRects().length>0&&!element.closest('[inert]'));
    if(!focusable.length){event.preventDefault();root.focus({preventScroll:true});return;}
    const first=focusable[0],last=focusable[focusable.length-1],active=document.activeElement;
    if(!root.contains(active)){event.preventDefault();(event.shiftKey?last:first).focus();}
    else if(event.shiftKey&&active===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&active===last){event.preventDefault();first.focus();}
  }
  function setValue(key:string,value:string) {const next={...form,[key]:value};setForm(next);rememberFormDraft(next);}
  async function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog) return;
    if(dialogStaleReason)return;
    if(dialog==='task'&&state?.connection.mode==='hub'){
      const blocked=hubTaskCreateBlockReason(dialogProject);if(blocked){setError(blocked);return;}
    }
    if(remoteWriteBlocked||state?.connection.mode==='hub'&&!getClientStatus().online){setError('连接状态待确认，请恢复连接并刷新状态后再操作。');return;}
    const submittedFormDraft=formDraftRef.current;
    const criteria = (form.criteria || '').split('\n').map(x=>x.trim()).filter(Boolean);
    if (dialog==='project') {
      const created = await mutate<Project>('POST','/api/projects',{name:form.name?.trim()||directoryName(form.directory||''),goal:form.goal?.trim(),directory:form.directory?.trim() || undefined},'项目已创建');
      if (created) {setNotice(state?.projects.some(item=>item.id===created.id)?`已打开现有项目「${created.name}」，原任务和设置已保留。`:'项目已创建，接下来把说明交给 AI。');setProjectId(created.id);setPage('connection');closeDialog();}
    } else if (dialog==='import') {
      const imported = await mutate<Project>('POST','/api/projects/import',{path:form.path?.trim()},'项目已导入');
      if (imported) {setProjectId(imported.id);closeDialog();}
    } else if (dialog==='task' && dialogProject) {
      if (!criteria.length) {setError('请至少填写一条验收标准。');return;}
      if(state?.connection.mode==='hub'){
        const blocked=hubTaskCreateBlockReason(dialogProject);if(blocked){setError(blocked);return;}
        if(!form.title?.trim()||!form.goal?.trim()){setError('请填写任务名称和期望结果。');return;}
        const commandId=crypto.randomUUID(),accountId=activeAccountId,generation=authGeneration.current;
        const snapshot=formDraftRef.current;
        const pending:PendingTaskCommand={id:commandId,action:'create_task',taskId:commandId,projectId:dialogProject.id,accountId,status:'sending',draftKey:snapshot?.key||undefined};
        rememberPendingCommand(pending);setBusy(true);setError('');setNotice('');
        try{
          const receipt=await request<CommandReceipt>('POST','/api/commands',{
            commandId,projectId:dialogProject.id,taskId:commandId,action:'create_task',expectedRevision:0,
            expiresAt:new Date(Date.now()+5*60*1000).toISOString(),
            body:hubTaskCreateBody(form),
          });
          if(generation!==authGeneration.current||accountId!==accountIdentityRef.current)return;
          if(!receipt||receipt.commandId!==commandId||receipt.projectId!==dialogProject.id||receipt.taskId!==commandId||receipt.action!=='create_task'||!['queued','received','sending','running','paused','unknown','expired','failed','completed'].includes(receipt.status)){
            handleHubTaskCreateReceipt({commandId,projectId:dialogProject.id,taskId:commandId,action:'create_task',status:'unknown'},pending,generation);return;
          }
          handleHubTaskCreateReceipt(receipt,pending,generation);
        }catch(error){
          if(generation!==authGeneration.current||accountId!==accountIdentityRef.current)return;
          if(error instanceof ApiError&&error.status>=400&&error.status<500&&![401,403,404].includes(error.status)){
            forgetPendingCommand(commandId);setError(errorMessage(error));setFormDraftNotice('任务尚未创建，草稿已保留，可核对后再试。');
          }else{
            rememberPendingCommand({...pending,status:'unknown'});setError('新建任务请求结果未知；请恢复连接并核对原命令，不要重复提交。');setFormDraftNotice('草稿已保留；请先核实原命令结果。');
            if(!isDesktop()&&error instanceof TypeError)markClientOffline();
          }
        }finally{if(generation===authGeneration.current&&accountId===accountIdentityRef.current)setBusy(false);}
        return;
      }
      if(Boolean(form.sourceProvider?.trim())!==Boolean(form.sourceConversationId?.trim())){setError('来源工具和来源会话 ID 需要同时填写。');return;}
      const sourceConversation=form.sourceProvider?.trim()?{provider:form.sourceProvider.trim(),conversationId:form.sourceConversationId.trim(),label:form.sourceLabel?.trim()||undefined}:undefined;
      const created = await mutate<Task>('POST','/api/tasks',{projectId:dialogProject.id,title:form.title?.trim(),goal:form.goal?.trim(),example:form.example?.trim(),summary:form.summary?.trim(),approach:form.approach?.trim(),criteria,conversationId:form.conversationId?.trim() || undefined,executionProvider:form.executionProvider||'codex-autocontinue',sourceConversation},'任务已创建');
      if (created) {setTaskId(created.id);setMobileDetail(true);closeDialog();}
    } else if (dialog==='edit' && task) {
      if (!criteria.length) {setError('请至少保留一条验收标准。');return;}
      const patch: Record<string,unknown> = {expectedRevision:dialogTaskBinding!.revision,title:form.title?.trim(),goal:form.goal?.trim(),summary:form.summary?.trim(),approach:form.approach?.trim(),nextStep:form.nextStep?.trim(),status:form.status};
      if(state?.connection.mode!=='hub')Object.assign(patch,{example:form.example?.trim(),blockedReason:form.blockedReason?.trim(),conversationId:form.conversationId?.trim(),executionProvider:form.executionProvider||'codex-autocontinue'});
      if (criteria.join('\n') !== task.criteria.map(c=>c.text).join('\n')) patch.criteria = criteria;
      const saved = await mutate<Task>('PATCH',`/api/tasks/${encodeURIComponent(task.id)}`,patch,'任务已更新');
      if (saved) finishTaskForm(saved,submittedFormDraft);
    } else if (dialog==='evidence' && task) {
      const added = await mutate<unknown>('POST',`/api/tasks/${encodeURIComponent(task.id)}/evidence`,{expectedRevision:dialogTaskBinding!.revision,summary:form.summary?.trim(),reference:form.reference?.trim()},'证据已添加');
      if (added !== undefined) finishTaskForm(added,submittedFormDraft);
    } else if (dialog==='review' && task) {
      const reviewed = await mutate<unknown>('POST',`/api/tasks/${encodeURIComponent(task.id)}/review`,{expectedRevision:dialogTaskBinding!.revision,decision:reviewDecision,summary:form.summary?.trim()},reviewDecision==='pass'?'已通过验收':'未通过验收，问题已记录');
      if (reviewed !== undefined) finishTaskForm(reviewed,submittedFormDraft);
    }
  }
  function setProjectDirectory(directory:string) {
    setForm(previous=>({...previous,directory,name:!previous.name?.trim()||previous.name===directoryName(previous.directory||'')?directoryName(directory):previous.name}));
  }
  async function chooseDirectory(target:'directory'|'path') {
    if (!window.taskboard) return;
    try {const selected = await window.taskboard.chooseDirectory();if (selected) {if(target==='directory'&&dialog==='project')setProjectDirectory(selected);else setValue(target,selected);}}
    catch(e) {setError(errorMessage(e));}
  }
  async function changeTheme(next:Theme) {setTheme(next);if(state?.connection.mode==='hub'){localStorage.setItem('tuijin-hub-theme',next);setNotice('外观已更新。');return;}await mutate('PATCH','/api/settings',{theme:next},'外观已更新');}
  async function taskAction(action:'continue'|'pause') {
    if (!task||remoteWriteBlocked||state?.connection.mode==='hub'&&!getClientStatus().online) return;
    if(action==='continue'&&state?.connection.offline){setError('目标电脑离线，请恢复连接并刷新状态后再继续。');return;}
    const initialGate=action==='continue'?continueGate(task&&project?.id===task.projectId?task:null):null;
    if(action==='continue'&&!initialGate?.ready){setError(initialGate?.reason||'正在核对项目电脑状态，请刷新后再试。');return;}
    setBusy(true);setError('');setNotice('');
    try {
      if(action==='continue'&&state?.connection.mode==='hub'){
        const initialClient=getClientStatus(),initialAccount=activeAccountId,initialAuth=authGeneration.current;
        const fresh=await request<BoardState>('GET','/api/state'),currentClient=getClientStatus();
        if(selectedTaskRef.current!==task.id||handoffProjectRef.current!==task.projectId||accountIdentityRef.current!==initialAccount||authGeneration.current!==initialAuth)return;
        const currentTask=handoffBoardRef.current?.tasks.find(item=>item.id===task.id&&item.projectId===task.projectId);
        if(!currentTask||currentTask.revision!==task.revision||currentTask.contentVersion!==task.contentVersion){setError('任务版本已变化，请刷新后核对。');return;}
        if(!initialClient.online||!currentClient.online||initialClient.epoch!==currentClient.epoch||fresh.connection.mode!=='hub'||fresh.connection.offline||!fresh.capabilities.remote||!fresh.projects.some(item=>item.id===task.projectId)||fresh.capabilities.role==='viewer'){
          setError('连接或项目授权已变化，请刷新后核对。');return;
        }
        const freshGate=freshTaskGate(task,initialGate?.bootId||null,fresh,'continue');
        if(!freshGate.ready){setError(freshGate.reason);return;}
      }
      const result = await taskRequest<CommandReceipt>('POST',`/api/tasks/${encodeURIComponent(task.id)}/${action}`,action==='continue'?{expectedRevision:task.revision,commandId:crypto.randomUUID()}:{expectedRevision:task.revision});
      setOfflineQueue(false);
      await refresh();
      if (acknowledge(result,action))return;
      if (action==='continue') setNotice(result.status==='running'?'执行工具已确认开始此任务。':result.status==='waiting_quota'?'额度尚未恢复；此任务仍在等待。':result.status==='sending'?'请求已发送，等待执行工具确认；请勿重复提交。':result.status==='awaiting_approval'?'执行工具等待登录或授权，请在对应工具中处理。':result.status==='completed'||result.status==='turn_completed'?'本轮已结束，请检查结果并提交验收。':result.status==='failed'?`执行失败。${result.error||'请检查执行工具状态。'}`:`继续结果尚未确认。${result.error||'请检查任务状态后再决定是否重试。'}`);
      else setNotice(result.status==='paused'?'任务已暂停。':result.status==='completed'||result.status==='turn_completed'?'会话已结束，结果等待验收。':result.status==='failed'?'会话已失败，请查看任务状态。':`暂停结果尚未确认。${result.error||'请检查目标会话状态。'}`);
    } catch(e) {if(!isDesktop()&&e instanceof TypeError)markClientOffline();setError(errorMessage(e));}
    finally {setBusy(false);}
  }
  async function submitResult() {
    if (!task||remoteWriteBlocked||state?.connection.mode==='hub'&&!getClientStatus().online) return;
    await mutate('PATCH',`/api/tasks/${encodeURIComponent(task.id)}`,{expectedRevision:task.revision,status:'submitted'},'结果已提交，等待验收');
  }
  async function createSession(item:Task){
    if(remoteWriteBlocked||state?.connection.mode==='hub'&&!getClientStatus().online)return;
    if(unknownSessionCommands[item.id]){setNotice('创建结果仍待核查；请先检查对应执行会话，避免重复创建。');return;}
    const commandId=crypto.randomUUID();setBusy(true);setError('');setNotice('');
    try{
      const result=await request<{status:'created'|'unknown'|'awaiting_approval';threadId?:string;sessionId?:string}>('POST',`/api/tasks/${encodeURIComponent(item.id)}/session`,{expectedRevision:item.revision,commandId});
      if(result.status==='created'){
        await refresh();setNotice(`${executionName(item.executionProvider)} 会话已绑定。可以继续此任务。`);
      }else{
        setUnknownSessionCommands(current=>({...current,[item.id]:commandId}));
        setNotice(result.status==='awaiting_approval'?'执行工具等待登录或授权。请先在对应工具处理并核查会话，勿重新创建。':'创建结果待核查。请先在对应工具确认会话，勿重新创建。');
      }
    }catch(e){
      if(!isDesktop()&&e instanceof TypeError)markClientOffline();
      setUnknownSessionCommands(current=>({...current,[item.id]:commandId}));
      setError(`${errorMessage(e)} 创建结果可能未知，请先核查对应执行会话，勿重复创建。`);
    }finally{setBusy(false);}
  }
  async function pluginAction(action:'enable'|'disable'|'check') {await mutate<PluginState>('POST',`/api/plugin/${action}`,undefined,action==='check'?'检查已完成':action==='enable'?'插件已启用':'插件已停用');}
  async function savePlugin(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutate('PATCH','/api/plugin/config',{pythonPath:pluginForm.pythonPath.trim(),codexPath:pluginForm.codexPath.trim(),graceSeconds:Number(pluginForm.graceSeconds),pollSeconds:Number(pluginForm.pollSeconds)},'插件设置已保存');
  }
  async function setPolicy(change:PolicyChange) {
    await mutate('POST','/api/plugin/policy',change,change.restart?(state?.plugin.enabled?'已重新开始自动继续计划；请核对新的截止时间。':'计划已保存。插件仍停用；确认原执行已退出后，再启用插件才会执行。'):change.enabled?'已为此任务启用自动继续；既有计划不会因此延长。':'已停止后续自动继续；正在运行的 AI 不会因此暂停。');
  }
  async function reconcileTask(task:Task) {
    if(remoteWriteBlocked)return;
    setBusy(true);setError('');setNotice('');
    try {
      const result=await request<ReconcileResult>('POST','/api/plugin/reconcile',{taskId:task.id,expectedRevision:task.revision});
      await refresh();
      const unresolved=['unknown','awaiting_approval','blocked','running','still_running'].includes(result.status);
      setNotice(result.status==='stale_result'?'已确认原执行停止，但任务要求已经变化，旧结果没有提交为完成。请按当前要求继续；自动继续保持关闭。':unresolved?`会话状态仍未解除，自动继续保持关闭。${result.error||result.lastError||''}`:'会话已核实，自动继续保持关闭；如需恢复，请再次启用。');
    } catch(e) {if(!isDesktop()&&e instanceof TypeError)markClientOffline();setError(errorMessage(e));}
    finally {setBusy(false);}
  }
  async function logout() {setDialogTaskBinding(null);logoutInProgress.current=true;authGeneration.current++;connectivityEpoch.current++;refreshSequence.current++;try{if(state?.connection.mode==='hub')await request('POST','/api/auth/logout',{});}catch(e){if(!(e instanceof ApiError)||![401,404].includes(e.status)){logoutInProgress.current=false;setError('无法确认服务器已退出登录，请恢复连接后重试。');return;}}try{clearConversationDrafts(localStorage,activeAccountId);clearTaskFormDrafts(localStorage,activeAccountId);clearInboxDrafts(localStorage,activeAccountId);clearInboxSubmittedDrafts(sessionStorage,activeAccountId,location.origin);}catch{/* Storage is unavailable; account-scoped drafts cannot be read here. */}clearToken();handoffBoardRef.current=null;setAuthenticated(false);setState(null);setAccount(null);setReviewFeedback(null);shownReviewFeedbackKeys.current.clear();setBusy(false);setError('');}

  if (!authChecked) return <div className="login-screen"><div className="login-card"><h1>序程</h1><p>正在连接你的空间…</p></div></div>;
  if (!authenticated) return <LoginPanel accountsAvailable={accountsAvailable} registrationEnabled={registrationEnabled} onAuthenticated={user=>{logoutInProgress.current=false;authGeneration.current++;setAccount(user);setPage('supervision');setAuthenticated(true);setError('')}}/>;
  if(isDesktop()&&desktopStartup&&desktopStartup.phase!=='ready')return <div className="login-screen"><div className="login-card" role="status"><h1>序程</h1><p>{desktopStartup.phase==='starting'?'正在启动本机服务…':desktopStartup.phase==='stopping'?'本机服务正在停止，请稍候。':'本机服务未能启动，请核对后重试。'}</p>{desktopStartup.message&&<p>{desktopStartup.message}</p>}<button className="secondary" onClick={()=>void desktopStartupGate.current?.retry()}>重新检查启动状态</button></div></div>;

  if (floating) return <div className="floating-shell"><div className="floating-card"><header className="floating-header"><div className="brand-small"><Layers2 size={17}/><strong>{project?.name || '序程'}</strong></div><div className="toolbar"><IconButton label={compact?'展开悬浮窗':'收起悬浮窗'} onClick={()=>{setCompact(!compact);void window.taskboard?.setFloatingCompact(!compact).catch(e=>setError(errorMessage(e)))}}>{compact?<Menu size={16}/>:<Minus size={16}/>}</IconButton>{window.taskboard&&<IconButton label="打开主界面" onClick={()=>void window.taskboard?.showMain()}><ArrowRight size={16}/></IconButton>}</div></header>{!online&&state&&<p className="alert floating-offline">连接中断 · 上次同步 {dateText(lastSyncAt)}</p>}{!compact&&<><div className="floating-body"><span className="eyebrow">当前进展</span><strong>{active[0]?.title || (tasks.length?'暂无进行中的任务':'还没有任务')}</strong><p>{active[0]?.nextStep || active[0]?.summary || '打开主界面添加任务并设置验收标准。'}</p></div><div className="meter"><span style={{width:`${tasks.length?totalDoneCount/tasks.length*100:0}%`}}/></div><footer className="floating-footer"><span>{totalDoneCount} / {tasks.length} 项已验收</span><span className={issues.length?'risk-text':''}>{state?.capabilities.inbox ? `${inboxCount} 项需要我处理` : issues.length ? `${issues.length} 项待处理` : '暂无待处理偏差'}</span></footer><button className="secondary full" onClick={()=>void window.taskboard?.showMain()} disabled={!window.taskboard}>展开看板 <ArrowRight size={15}/></button></>}{error&&<p className="alert" role="alert">{error}</p>}</div></div>;

  const canConnectProject=Boolean(state&&state.connection.mode!=='hub'&&(!state.capabilities.role||state.capabilities.role==='owner'));
  const projectOfflineNotice=state?.connection.mode==='hub'&&state.connection.offline&&page!=='terminal';
  const headerHasNotice=Boolean((!online&&state)||error||notice||projectOfflineNotice);
  return <div className="app-shell" onClickCapture={event=>{const target=event.target;lastClickedElementRef.current=target instanceof Element?target.closest<HTMLElement>('button,[role="button"],summary'):null;}}>
    <aside className="sidebar"><div className="brand"><span className="brand-mark seqivo-brand"><img src="/brand-mark.svg" alt="" width="23" height="23"/></span><strong>序程</strong><span className="brand-sub">AI 任务看板</span></div><div className="sidebar-section"><span className="eyebrow">当前项目</span><label className="sr-only" htmlFor="project-select">选择项目</label><select id="project-select" value={projectId} onChange={e=>{handoffProjectRef.current=e.target.value;setProjectId(e.target.value);setTaskId('');setConversationFilter('all');setMobileDetail(false);}}>{!state?.projects.length&&<option value="">还没有项目</option>}{state?.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><div className="project-actions"><button onClick={()=>openDialog('project')} disabled={state?.connection.mode==='hub'}><Plus size={14}/> 新建</button><button onClick={()=>openDialog('import')} disabled={state?.connection.mode==='hub'}><FolderOpen size={14}/> 导入</button></div></div><nav aria-label="主要导航"><div className="sidebar-primary">{navItems.filter(item=>['supervision','tasks','conversations','terminal','inbox'].includes(item.id)).map(item=>{const Icon=item.icon;return <button key={item.id} className={page===item.id?'nav-active':''} aria-current={page===item.id?'page':undefined} onClick={()=>{setPage(item.id);setMobileDetail(false);}}><Icon size={17}/><span>{item.text}</span>{item.id==='inbox'&&inboxCount>0&&<small>{inboxCount}</small>}</button>})}</div><details className="sidebar-more"><summary><Menu size={16}/> 更多功能</summary><div className="sidebar-extra">{navItems.filter(item=>!['supervision','tasks','conversations','terminal','inbox'].includes(item.id)&&(state?.connection.mode!=='hub'||item.id!=='workflow')&&(state?.connection.mode==='hub'||item.id!=='account')&&(item.id!=='connection'||canConnectProject)).map(item=>{const Icon=item.icon;return <button key={item.id} className={page===item.id?'nav-active':''} aria-current={page===item.id?'page':undefined} onClick={()=>{setPage(item.id);setMobileDetail(false);}}><Icon size={17}/><span>{item.text}</span>{item.id==='issues'&&issues.length>0&&<small>{issues.length}</small>}</button>})}</div></details></nav><div className="sidebar-bottom"><span className="eyebrow">外观</span><div className="theme-switch" role="group" aria-label="外观模式">{(['light','system','dark'] as Theme[]).map(mode=><button key={mode} aria-label={mode==='light'?'浅色':mode==='dark'?'深色':'跟随系统'} aria-pressed={theme===mode} title={mode==='light'?'浅色':mode==='dark'?'深色':'跟随系统'} onClick={()=>void changeTheme(mode)}>{mode==='light'?<Sun size={15}/>:mode==='dark'?<Moon size={15}/>:<Settings2 size={15}/>}</button>)}</div>{window.taskboard&&<button className="quiet" onClick={()=>void window.taskboard?.openFloating()}><Layers2 size={15}/> 打开悬浮窗</button>}{!isDesktop()&&<button className="quiet" onClick={()=>void logout()}>退出当前连接</button>}<span className="sync-note">{online?'最近同步':'连接中断 · 上次同步'}：{dateText(state?.connection.mode==='hub'?state.connection.lastSeen:lastSyncAt)}</span></div></aside>
    <main className="main"><header className="mobile-top"><span className="brand-small"><Layers2 size={17}/> 序程</span><div className="mobile-controls"><select aria-label="选择项目" value={projectId} onChange={e=>{handoffProjectRef.current=e.target.value;setProjectId(e.target.value);setTaskId('');setConversationFilter('all');}}>{!state?.projects.length&&<option value="">还没有项目</option>}{state?.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><select aria-label="外观模式" value={theme} onChange={e=>void changeTheme(e.target.value as Theme)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div></header><div className={page==='terminal'?'main-header ssh-global-header':page==='supervision'?'main-header supervision-main-header':'main-header'}><div><span className="eyebrow">{page==='supervision'?'按任务与对话督办':page==='inbox'?'优先处理':page==='tasks'?'项目进展':page==='conversations'?'与 Codex 对话':page==='account'?'账号设置':page==='issues'?'验收与偏差':page==='connection'?'让进度自动进入看板':page==='handoff'?'继续已有工作':page==='workflow'?'安排协作任务':page==='records'?'历史与备份':page==='remote'?'远程连接':page==='terminal'?'交互式终端':'连接与自动化'}</span><h1>{page==='tasks'?(project?.name||'开始一个项目'):navItems.find(n=>n.id===page)?.text}</h1></div><div className="header-actions">{canConnectProject&&project&&['supervision','tasks'].includes(page)&&<button className="secondary" onClick={()=>setPage('connection')}><FolderOpen size={16}/> 接入 AI</button>}<IconButton label="刷新" onClick={()=>void refresh()}><RefreshCw size={17}/></IconButton>{page==='tasks'&&project&&<><button className="primary" onClick={()=>openDialog('task')} disabled={Boolean(hubTaskCreateBlockReason(project))} title={hubTaskCreateBlockReason(project)||undefined}><Plus size={16}/> 新建任务</button>{state?.connection.mode==='hub'&&Boolean(hubTaskCreateBlockReason(project))&&<span className="small-note" role="status">{hubTaskCreateBlockReason(project)}</span>}</>}</div><div className="header-status-slot" role="region" aria-label="连接与操作提示">{!headerHasNotice&&page!=='supervision'&&<p>{page==='inbox'?'先处理最影响进展的事项；每项都能回到任务核对。':page==='tasks'?(project?.goal||'导入现有项目，或新建一个项目开始。'):page==='conversations'?'从手机或电脑向项目中的 Codex 会话发送需求并查看输出。':page==='account'?'管理登录和当前空间。':page==='issues'?'对照原始要求，查看尚未解决的问题。':page==='connection'?'选择本地项目，把接入说明交给 AI，再查看汇报结果。':page==='handoff'?'把目标、进度和下一步交给新的对话。':page==='workflow'?'按角色和依赖安排已有任务，结果仍由人工验收。':page==='records'?'查看更改，保存或恢复看板记录。':page==='remote'?'让手机查看已授权项目和任务。':page==='terminal'?'连接服务器或电脑，打开 Shell 与 tmux 会话。':'按任务控制 Codex 自动继续。'}</p>}{!online&&state&&<div className="alert banner" role="status"><AlertCircle size={16}/>{connectionChecking?"正在确认手机与目标电脑的连接，确认前不能提交。":<>连接已中断，当前显示上次同步的内容（{dateText(lastSyncAt)}）。</>}<button onClick={()=>void refresh()}>重试</button></div>}{error&&<div className="alert banner" role="alert"><AlertCircle size={16}/>{error}<button onClick={()=>setError('')} aria-label="关闭错误提示"><X size={15}/></button></div>}{notice&&<div className={`${noticeWarning?'alert':'notice'} banner`} role={noticeWarning?'alert':'status'}>{noticeWarning?<AlertCircle size={16}/>:<Check size={16}/>}{notice}<button onClick={()=>setNotice('')} aria-label="关闭提示"><X size={15}/></button></div>}
    {projectOfflineNotice&&<div className="alert banner offline-queue" role="status"><AlertCircle size={16}/><span>目标电脑离线，当前内容来自上次同步。</span>{state.capabilities.role!=='viewer'&&<label><input type="checkbox" checked={offlineQueue} onChange={e=>setOfflineQueue(e.target.checked)}/>允许本次操作排队，5 分钟内有效</label>}</div>}</div></div>
    {!state?<div className="empty-state"><Activity size={28}/><h2>正在连接看板</h2><p>{error||'正在读取项目和任务。'}</p><div className="action-row"><button className="secondary" onClick={()=>void refresh()}>重试</button>{!isDesktop()&&<button className="secondary" onClick={()=>void logout()}>更换账号</button>}</div></div>:page==='supervision'?<SupervisionPanel board={state} projectId={projectId} taskCreateDisabledReason={nextProjectId=>hubTaskCreateBlockReason(state.projects.find(item=>item.id===nextProjectId)||null)} onOpenTask={openInboxTask} onOpenConversation={(nextTaskId,nextProjectId)=>{setProjectId(nextProjectId);setConversationTaskId(nextTaskId);setPage('conversations');setMobileDetail(false)}} onOpenInbox={nextProjectId=>{setProjectId(nextProjectId);setPage('inbox')}} onNewTask={nextProjectId=>{setProjectId(nextProjectId);openDialog('task',{},undefined,nextProjectId)}}/>:page==='connection'?(canConnectProject&&project?<ProjectConnection key={project.id} project={project} onBound={refresh} onOpenTask={id=>openInboxTask(id,project.id)}/>:<div className="empty-state"><FolderOpen size={30}/><h2>先选择本地项目</h2><p>请在项目所在电脑上新建项目，选择 AI 正在工作的文件夹。</p>{canConnectProject&&<button className="primary" onClick={()=>openDialog('project')}>新建项目</button>}</div>):page==='inbox'?state.connection.mode==='hub'&&!activeAccountId?<div className='empty-state'><h2>正在确认连接身份</h2><p>确认前暂不能处理手机事项。</p></div>:<InboxPanel key={activeAccountId||'local'} board={state} projectId={projectId} onOpenTask={openInboxTask} onOpenConnection={()=>setPage('remote')} onOpenPlugin={()=>setPage('plugins')} onReview={openInboxReview} onRefresh={refresh} clientOnline={online} connectionNoticeInHeader onClientOffline={markClientOffline} accountId={activeAccountId||'local'} isRecoveryCurrent={()=>isCommandRecoveryCurrent(activeAccountId,recoveryAuthGeneration)}/>:page==='tasks'&&previewTaskId&&task&&previewTaskId===task.id?<div className="preview-page"><PreviewLoadBoundary><Suspense fallback={<div className="empty-state">正在打开运行预览…</div>}><PreviewPanel key={`${state.connection.mode}:${state.connection.mode==='hub'?(account?.id||'unconfirmed'):'local-owner'}:${authGeneration.current}:${task.id}`} accountScope={state.connection.mode==='hub'?(account?.id||''):'local-owner'} connectionMode={state.connection.mode==='hub'?'hub':'local'} taskId={task.id} projectId={task.projectId} expectedRevision={task.revision} contentVersion={task.contentVersion} criteria={task.criteria.map(item=>({id:item.id,text:item.text}))} canRegister={state.connection.mode!=='hub'&&(state.capabilities.role===undefined||state.capabilities.role==='owner')} onTaskCreated={()=>{setNotice('修改任务已创建。点击“查看修改任务”继续处理。');void refresh();}} onOpenTask={id=>openFeedbackTask(id,task.projectId)} onClose={()=>setPreviewTaskId('')}/></Suspense></PreviewLoadBoundary></div>:page==='tasks'?<div className="tasks-page">{!project?<div className="empty-state"><FolderOpen size={30}/><h2>{state.connection.mode==='hub'?'暂无已授权项目':'从一个真实项目开始'}</h2><p>{state.connection.mode==='hub'?'请在手机连接页确认授权和电脑同步状态。':'选择项目目录导入已有记录，或建立新项目和验收标准。'}</p><div className="action-row"><button className="primary" disabled={state.connection.mode==='hub'} onClick={()=>openDialog('project')}><Plus size={16}/> 新建项目</button><button className="secondary" disabled={state.connection.mode==='hub'} onClick={()=>openDialog('import')}><FolderOpen size={16}/> 导入项目</button></div></div>:<><div className="overview"><div><strong>{doneCount} <span>/ {visibleTasks.length}</span></strong><p>项任务已验收</p></div><div className="overview-meter"><div className="meter" role="progressbar" aria-label="已验收任务" aria-valuemin={0} aria-valuemax={visibleTasks.length} aria-valuenow={doneCount}><span style={{width:`${visibleTasks.length?doneCount/visibleTasks.length*100:0}%`}}/></div><p>{issues.length ? `${issues.length} 项问题需要处理` : '按原定标准核对结果'}</p></div></div><div className="conversation-filter"><label htmlFor="conversation-filter">会话范围</label><select id="conversation-filter" value={conversationFilter} onChange={e=>{setConversationFilter(e.target.value);setTaskId('');setMobileDetail(false)}}>{conversationChoices.map(([key,label])=><option key={key} value={key}>{label} · {key==='all'?tasks.length:key==='unbound'?tasks.filter(t=>state.connection.mode==='hub'?!t.hasExecutionBinding:!t.conversationId).length:tasks.filter(t=>{try{const parsed=JSON.parse(key) as {kind:string;provider?:string;id:string};return parsed.kind==='source'?t.sourceConversation?.provider===parsed.provider&&t.sourceConversation?.conversationId===parsed.id:t.conversationId===parsed.id}catch{return false}}).length}</option>)}</select></div><div className="verification-filter"><label htmlFor="verification-filter">测试状态</label><select id="verification-filter" value={verificationFilter} onChange={e=>{setVerificationFilter(e.target.value as VerificationState | 'all');setTaskId('');setMobileDetail(false)}}><option value="all">全部验证状态</option>{Object.entries(verificationLabels).map(([value,label])=><option key={value} value={value}>{label} · {tasks.filter(item=>verificationState(item)===value).length}</option>)}</select></div><div className={`work-area ${mobileDetail?'show-detail':''}`}><section className="task-list" aria-label="任务列表"><div className="list-top"><span>任务清单</span><span>{visibleTasks.length} 项</span></div>{visibleTasks.length===0?<div className="list-empty"><p>{tasks.length?'当前筛选条件下暂无任务。':'还没有任务。先写清目标和验收标准。'}</p>{tasks.length?<button className="secondary" onClick={()=>{setConversationFilter('all');setVerificationFilter('all')}}>查看全部任务</button>:<button className="secondary" onClick={()=>openDialog('task')} disabled={state.connection.mode==='hub'}>新建第一项任务</button>}</div>:<>{renderGroup('正在完成',active)}{renderGroup('待完成',todo)}{done.length>0&&<><button className="group-heading group-toggle" onClick={()=>setShowDone(!showDone)} aria-expanded={showDone}>已完成 <span>{done.length} 项 · {showDone?'收起':'展开'}</span></button>{showDone&&done.map(renderTask)}</>}</>}</section><section className="detail-panel" aria-label="任务详情">{task?<><div className="detail-top"><button className="back-button" onClick={()=>setMobileDetail(false)}><ArrowLeft size={16}/> 返回清单</button><span>任务详情</span><IconButton label="收起任务详情" onClick={()=>{setTaskId('');setMobileDetail(false);}}><X size={16}/></IconButton></div><div className="detail-scroll"><div className="detail-heading"><h2>{task.title}</h2><span className={`pill ${isCompleted(task)?'good':task.issues.some(i=>i.open)?'risk':''}`}>{isCompleted(task)?'已验收':statusText[task.status]}</span></div>{task.previewFeedback&&<div className="detail-block"><span className="eyebrow">来源预览反馈</span><p>来自「{feedbackSource?.title||'原任务暂不可用'}」 · 内容版本 {task.previewFeedback.sourceContentVersion}</p>{task.previewFeedback.previewId&&<p>来源预览：{task.previewFeedback.previewId}</p>}<button className="secondary" type="button" disabled={!feedbackSource} title={!feedbackSource?'来源任务未同步到当前看板':undefined} onClick={()=>returnToFeedbackSource(task)}>返回来源预览</button>{!feedbackSource&&<p className="small-note" role="status">来源任务不在当前同步项目中，暂时无法打开预览。</p>}</div>}<div className="detail-block"><span className="eyebrow">原本要什么</span><p>{task.goal}</p>{task.example&&<p className="example">例：{task.example}</p>}</div><div className="detail-block"><span className="eyebrow">现在做到哪</span><p>{task.summary||'还没有进展说明。'}</p>{task.blockedReason&&<p className="warning-line">阻碍：{task.blockedReason}</p>}{task.nextStep&&<p className="next-line">下一步：{task.nextStep}</p>}</div><div className="detail-block"><span className="eyebrow">怎么实现</span><p>{task.approach||'尚未记录实现方案。'}</p></div>{task.issues.some(i=>i.open)&&<div className="issue-callout"><AlertCircle size={17}/><div><strong>有待解决的问题</strong>{task.issues.filter(i=>i.open).map(i=><p key={i.id}>{i.summary}</p>)}</div></div>}<VerificationDetails task={task} canToggleChecks={state.connection.mode!=='hub'&&state.capabilities.role!=='viewer'&&(!state.capabilities.role||state.capabilities.role==='owner')} saving={busy} onToggleCheck={toggleVerificationCheck}/><div className="detail-block"><span className="eyebrow">人工验收标准</span><ul className="criteria">{task.criteria.map(c=><li key={c.id}>{c.passed?<CheckCircle2 size={16}/>:<Circle size={16}/>}<span>{c.text}</span></li>)}</ul>{!task.criteria.length&&<p>还没有验收标准。</p>}</div><details className="detail-more"><summary>证据与来源 · {task.evidence.length}</summary>{task.evidence.length?<ul>{task.evidence.map(e=><li key={e.id}><strong>{e.summary}</strong><span>{e.source||'手动添加'} · {dateText(e.createdAt)}</span><code>{e.reference}</code></li>)}</ul>:<p>尚未添加证据。</p>}</details><details className="detail-more"><summary>会话与版本</summary><p>来源会话：{state.connection.mode==='hub'?(task.sourceConversationGroup===undefined?'来源信息未同步':task.sourceConversationGroup?'已关联（详情仅在桌面端可见）':'尚未记录'):task.sourceConversation?`${task.sourceConversation.label||task.sourceConversation.provider} · ${task.sourceConversation.conversationId}`:'尚未记录'}</p>{state.connection.mode!=='hub'&&<p>执行工具：{executionName(task.executionProvider)}</p>}<p>执行会话：{state.connection.mode==='hub'?(task.hasExecutionBinding?'已绑定（详情仅在桌面端可见）':'尚未绑定'):task.conversationId||'尚未绑定'}</p><p>内容版本：{String(task.contentVersion)} · 更新于 {dateText(task.updatedAt)}</p></details>{taskReviewDisplay&&<p ref={reviewFeedbackRef} className={`task-review-feedback status-${taskReviewDisplay.status} ${taskReviewDisplay.status==='confirmed'&&task.acceptance==='passed'?'verified':''}`} role={taskReviewDisplay.status==='failed'||taskReviewDisplay.status==='unknown'?'alert':'status'}>{taskReviewDisplay.text}{taskReviewDisplay.status==='confirmed'&&task.acceptance==='passed'?' 当前任务已通过验收。':taskReviewDisplay.status==='confirmed'&&task.acceptance==='failed'?' 当前任务记录为未通过验收。':''}</p>}<div className="detail-actions">{task.status==='planned'&&!task.hasExecutionBinding&&!task.conversationId&&(!task.executionProvider||task.executionProvider==='codex-autocontinue')&&(()=>{const gate=startTaskGate(task,state);return <button className="primary" type="button" disabled={busy||remoteWriteBlocked||taskHasUnresolvedWrite||!gate.ready} title={!gate.ready?gate.reason:undefined} onClick={()=>openTaskStart(task.id,task.projectId)}>让 AI 开始</button>})()}<button className="secondary" onClick={()=>openTaskTerminal(task.id,task.projectId)}>项目终端</button><button className="secondary" type="button" onClick={()=>setPreviewTaskId(task.id)}>试用运行预览</button><button className="secondary" disabled={remoteWriteBlocked||taskHasUnresolvedWrite} onClick={()=>openDialog('edit',{title:task.title,goal:task.goal,example:task.example||'',summary:task.summary||'',approach:task.approach||'',nextStep:task.nextStep||'',blockedReason:task.blockedReason||'',conversationId:task.conversationId||'',executionProvider:task.executionProvider||'codex-autocontinue',status:task.status,criteria:task.criteria.map(c=>c.text).join('\n')})}>编辑任务</button><button className="secondary" disabled={remoteWriteBlocked||taskHasUnresolvedWrite} onClick={()=>openDialog('evidence')}>添加证据</button>{canControlTask(task)&&<button className="secondary" onClick={()=>{setConversationTaskId(task.id);setPage('conversations');setMobileDetail(false)}}><MessageCircle size={15}/> 查看对话</button>}{task.status==='running'||activeTaskPending.some(item=>['continue','update'].includes(item.action))?<button className="secondary" onClick={()=>void taskAction('pause')} disabled={busy||pausePending||!canControlTask(task)||remoteWriteBlocked}><Pause size={15}/> 暂停</button>:!isCompleted(task)&&<button className="secondary" onClick={()=>void taskAction('continue')} disabled={busy||taskHasUnresolvedWrite||!canControlTask(task)||remoteWriteBlocked||!currentContinueGate.ready} title={!canControlTask(task)?'先绑定执行会话':!currentContinueGate.ready?currentContinueGate.reason:''}><Play size={15}/> 继续任务</button>}{canControlTask(task)&&!currentContinueGate.ready&&<span className="small-note" role="status">{currentContinueGate.reason} 请刷新状态后再试。</span>}{task.status!=='submitted'&&!isCompleted(task)&&<button className="secondary" disabled={busy||remoteWriteBlocked||taskHasUnresolvedWrite} onClick={()=>void submitResult()}>提交结果</button>}{task.status==='submitted'&&<button className="primary" disabled={remoteWriteBlocked||taskHasUnresolvedWrite} onClick={()=>{setReviewDecision('pass');openDialog('review')}}>人工验收</button>}</div>{activeTaskPending.filter(item=>item.status==='unknown').map(item=><CommandRecovery key={item.id} commandId={item.id} identityKey={activeAccountId} canReconcile={canReconcileCommand} isRecoveryCurrent={()=>isCommandRecoveryCurrent(activeAccountId,recoveryAuthGeneration)} onResolved={handleCommandRecovery}/>)}{!canControlTask(task)&&<p className="small-note">{task.status==='planned'&&!task.hasExecutionBinding&&!task.conversationId&&(!task.executionProvider||task.executionProvider==='codex-autocontinue')?'点击“让 AI 开始”，填写启动说明后可在此任务中开始。':'绑定执行会话后可继续任务。'}</p>}{!task.conversationId&&project?.directory&&state.connection.mode!=='hub'&&<button className="secondary" disabled={busy||remoteWriteBlocked||Boolean(unknownSessionCommands[task.id])} onClick={()=>void createSession(task)}>新建 {executionName(task.executionProvider)} 会话</button>}{unknownSessionCommands[task.id]&&<p className="small-note warning-line">创建结果待核查。请先确认对应执行会话，避免重复创建。</p>}</div></>:<div className="detail-placeholder"><ClipboardCheck size={27}/><p>选择一项任务，查看目标、进展和验收依据。</p></div>}</section></div></>}</div>:page==='conversations'?<ConversationPanel board={state} projectId={projectId} selectedTaskId={conversationTaskId} onSelectTask={setConversationTaskId} onOpenTask={openInboxTask} onOpenTerminal={openTaskTerminal} onRefresh={refresh} clientOnline={online} onClientOffline={markClientOffline} getClientStatus={getClientStatus} accountScopeReady={Boolean(activeAccountId)} pendingTaskCommands={pendingCommands.filter(item=>item.accountId===activeAccountId)} getPendingTaskCommands={pendingForTask} getPendingProjectCommands={pendingForProject} onRememberTaskCommand={rememberConversationCommand} onForgetTaskCommand={forgetPendingCommand} identityKey={activeAccountId} canReconcile={canReconcileCommand} isRecoveryCurrent={()=>isCommandRecoveryCurrent(activeAccountId,recoveryAuthGeneration)} onRecoveryResolved={handleCommandRecovery}/>:page==='account'?<AccountSettings user={account} legacyOwner={!isDesktop()&&state.capabilities.role==='owner'&&Boolean(getToken())} onSignedIn={user=>{authGeneration.current++;refreshSequence.current++;refreshInFlight.current=null;setAccount(user);void refresh()}} onLogout={()=>void logout()}/>:page==='issues'?<div className="content-page">{issues.length?<div className="issue-list">{issues.map(({task:t,issue})=><article className="issue-card" key={`${t.id}-${issue.id}`}><div className="issue-card-top"><span className="pill risk">{issue.kind||'待处理偏差'}</span><span>{t.title}</span></div><h2>{issue.summary}</h2><p>此项仍需解决并重新提交验收。</p><div className="action-row"><button className="secondary" onClick={()=>{setTaskId(t.id);setPage('tasks');setMobileDetail(true)}}>查看任务 <ArrowRight size={15}/></button><button className="secondary" disabled={busy||state.connection.mode==='hub'} onClick={()=>void mutate('POST',`/api/tasks/${encodeURIComponent(t.id)}/issues/${encodeURIComponent(issue.id)}/resolve`,{expectedRevision:t.revision},'问题已标记解决；请重新提交验收')}>标记已解决</button></div></article>)}</div>:<div className="empty-state"><CheckCircle2 size={30}/><h2>暂无待处理偏差</h2><p>新问题会在任务更新后出现在这里。</p></div>}</div>:page==='handoff'?<ProjectHandoff key={`${state.connection.mode}:${activeAccountId}:${authGeneration.current}:${projectId}`} board={state} projectId={projectId} accountId={activeAccountId} online={online} checking={connectionChecking} isCurrent={()=>!logoutInProgress.current&&authGeneration.current===recoveryAuthGeneration&&accountIdentityRef.current===activeAccountId&&handoffProjectRef.current===projectId&&handoffBoardRef.current?.projects.some(item=>item.id===projectId)===true&&getClientStatus().online}/>:page==='workflow'?(state.connection.mode==='hub'?<div className="empty-state"><h2>协作计划请在桌面端管理</h2></div>:<WorkflowPanel project={project} tasks={tasks}/>):page==='records'?(state.connection.mode==='hub'?<div className="empty-state"><h2>记录与备份请在桌面端管理</h2><p>手机端显示最近同步的任务快照。</p></div>:<DataPanel project={project} tasks={tasks} onRestored={refresh}/>):page==='remote'?<RemotePanel board={state} projects={state.projects}/>:page==='terminal'?<TerminalLoadBoundary><Suspense fallback={<div className="empty-state">正在打开终端…</div>}><TerminalPanel board={state} projectId={projectId} contextTask={terminalTask} onOpenTask={openInboxTask}/></Suspense></TerminalLoadBoundary>:state.connection.mode==='hub'?<div className="empty-state"><h2>插件请在桌面端管理</h2><p>手机上仍可查看已授权任务。</p></div>:<div className="content-page plugin-page"><div className="section-header"><div><h2>Codex 自动继续</h2><p>按选定任务和会话恢复 Codex 工作。</p></div><span className={`pill ${state.plugin.enabled?'good':''}`}>{state.plugin.enabled?'已启用':state.plugin.available?'已停用':'不可用'}</span></div>{state.plugin.lastError&&<p className="alert">{state.plugin.lastError}</p>}<div className="plugin-grid"><section className="setting-card"><div className="card-heading"><Plug size={18}/><h3>连接状态</h3></div><p>{state.plugin.name} · {state.plugin.version}</p><p>最近额度检查：{dateText(state.plugin.quota?.checkedAt)}</p>{state.plugin.quota?.windows.map(w=><p key={w.name}>{w.name}：已使用 {w.usedPercent}% · {dateText(w.resetsAt)} 恢复</p>)}<div className="action-row"><button className="secondary" onClick={()=>void pluginAction('check')} disabled={busy}>检查连接</button><button className="primary" onClick={()=>void pluginAction(state.plugin.enabled?'disable':'enable')} disabled={busy||(!state.plugin.available&&!state.plugin.enabled)}>{state.plugin.enabled?'停用插件':'启用插件'}</button></div></section><section className="setting-card"><div className="card-heading"><Settings2 size={18}/><h3>运行设置</h3></div><form onSubmit={savePlugin}><Field label="Python 路径" value={pluginForm.pythonPath} onChange={v=>setPluginForm(f=>({...f,pythonPath:v}))} required/><Field label="Codex 路径" value={pluginForm.codexPath} onChange={v=>setPluginForm(f=>({...f,codexPath:v}))} required/><div className="field-row"><Field label="等待秒数" type="number" value={pluginForm.graceSeconds} onChange={v=>setPluginForm(f=>({...f,graceSeconds:v}))} required/><Field label="检查间隔秒数" type="number" value={pluginForm.pollSeconds} onChange={v=>setPluginForm(f=>({...f,pollSeconds:v}))} required/></div><button className="secondary" disabled={busy} type="submit">保存设置</button></form></section></div><AutoContinuePolicies tasks={codexTasks} policies={state.plugin.policies||[]} pluginEnabled={state.plugin.enabled} busy={busy} onSetPolicy={setPolicy} onReconcile={reconcileTask}/><PluginCatalog onChanged={refresh} liveCodex={state.plugin}/></div>}
    {mobileMoreOpen&&<div className="mobile-more-panel" role="menu" aria-label="更多页面">{navItems.filter(item=>!['supervision','tasks','conversations','terminal'].includes(item.id)&&(state?.connection.mode!=='hub'||item.id!=='workflow')&&(state?.connection.mode==='hub'||item.id!=='account')&&(item.id!=='connection'||canConnectProject)).map(item=>{const Icon=item.icon;return <button type="button" role="menuitem" key={item.id} aria-current={page===item.id?'page':undefined} onClick={()=>{setPage(item.id);setMobileDetail(false);setMobileMoreOpen(false)}}><Icon size={17}/>{item.text}{item.id==='inbox'&&inboxCount>0&&<small>{inboxCount}</small>}</button>})}</div>}<nav className="mobile-nav" aria-label="移动导航">{navItems.filter(item=>['supervision','tasks','conversations','terminal'].includes(item.id)).map(item=>{const Icon=item.icon;return <button key={item.id} aria-current={page===item.id?'page':undefined} onClick={()=>{setPage(item.id);setMobileDetail(false);setMobileMoreOpen(false);}}><Icon size={18}/><span>{item.text}</span></button>})}<button type="button" ref={mobileMoreButtonRef} aria-expanded={mobileMoreOpen} aria-label={inboxCount>0?`更多页面，${inboxCount} 项待处理`:'更多页面'} onClick={()=>setMobileMoreOpen(open=>!open)}><Menu size={18}/><span>更多{inboxCount>0?` · ${inboxCount}`:''}</span></button></nav></main>
    {dialog&&<div className="dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)closeDialog()}}><div className="dialog" ref={dialogRef} tabIndex={-1} onKeyDown={handleDialogKeyDown} role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div className="dialog-top"><h2 id="dialog-title">{dialog==='project'?'新建项目':dialog==='import'?'导入项目':dialog==='task'?'新建任务':dialog==='edit'?'编辑任务':dialog==='evidence'?'添加证据':'人工验收'}</h2><IconButton label={hubCreatePending?'收起并保留草稿':'关闭'} onClick={()=>closeDialog()}><X size={18}/></IconButton></div><form onSubmit={submitDialog}>{dialog==='project'&&<><p className="form-help">选择 AI 正在工作的文件夹，就能接收进度。已经接入的目录会打开原项目。</p><Field label="项目文件夹" value={form.directory||''} onChange={setProjectDirectory} placeholder="已有代码所在的文件夹，可稍后选择"/>{window.taskboard&&<button className="secondary" type="button" onClick={()=>void chooseDirectory('directory')}>选择文件夹</button>}<Field label="项目名称" value={form.name||''} onChange={v=>setValue('name',v)} required={!form.directory?.trim()} placeholder="选择文件夹后自动填写"/><Field label="项目目标（选填）" value={form.goal||''} onChange={v=>setValue('goal',v)} multiline placeholder="例如：让客户可以在手机上下单，也可以稍后补充"/>{form.directory&&state?.projects.some(item=>item.directory===form.directory.trim().replace(/[\\/]+$/,''))&&<p className="notice" role="status">这个文件夹已经接入，继续后打开原项目，原任务和设置会保留。</p>}</>}{dialog==='import'&&<><p className="form-help">选择包含 .taskboard/project.json 的项目目录。</p><Field label="项目路径" value={form.path||''} onChange={v=>setValue('path',v)} required placeholder="项目目录的绝对路径"/>{window.taskboard&&<button className="secondary" type="button" onClick={()=>void chooseDirectory('path')}>选择目录</button>}</>}{(dialog==='task'||dialog==='edit')&&<><Field label="任务名称" value={form.title||''} onChange={v=>setValue('title',v)} required disabled={hubCreatePending}/><Field label="期望结果" value={form.goal||''} onChange={v=>setValue('goal',v)} multiline required disabled={hubCreatePending}/>{state?.connection.mode!=='hub'&&<Field label="使用例子" value={form.example||''} onChange={v=>setValue('example',v)} multiline disabled={hubCreatePending}/>}<Field label="当前进展" value={form.summary||''} onChange={v=>setValue('summary',v)} multiline disabled={hubCreatePending}/><Field label="实现思路" value={form.approach||''} onChange={v=>setValue('approach',v)} multiline disabled={hubCreatePending}/><Field label="验收标准（每行一条）" value={form.criteria||''} onChange={v=>setValue('criteria',v)} multiline required disabled={hubCreatePending}/>{dialog==='edit'&&<><Field label="下一步" value={form.nextStep||''} onChange={v=>setValue('nextStep',v)} multiline/>{state?.connection.mode!=='hub'&&<Field label="阻碍原因" value={form.blockedReason||''} onChange={v=>setValue('blockedReason',v)} multiline/>}<label className="field" htmlFor="task-status"><span>任务状态</span><select id="task-status" value={form.status||'planned'} onChange={e=>setValue('status',e.target.value)}>{(['planned','running','paused','blocked','submitted','failed'] as Task['status'][]).map(s=><option key={s} value={s}>{statusText[s]}</option>)}</select></label></>}{dialog==='task'&&state?.connection.mode!=='hub'&&<details className="detail-more"><summary>来源会话（可选）</summary><p>仅用于记录任务来源，不授予继续执行权限。</p><Field label="来源工具" value={form.sourceProvider||''} onChange={v=>setValue('sourceProvider',v)} placeholder="如 Codex"/><Field label="来源会话 ID" value={form.sourceConversationId||''} onChange={v=>setValue('sourceConversationId',v)}/><Field label="来源会话名称" value={form.sourceLabel||''} onChange={v=>setValue('sourceLabel',v)}/></details>}{state?.connection.mode!=='hub'&&<><label className="field" htmlFor="execution-provider"><span>执行工具</span><select id="execution-provider" aria-label="执行工具" value={form.executionProvider||'codex-autocontinue'} disabled={dialog==='edit'&&Boolean(task?.conversationId||task?.status==='running')} onChange={e=>setValue('executionProvider',e.target.value)}>{executionTools.map(tool=><option key={tool.id} value={tool.id}>{tool.name}</option>)}</select></label><p className="form-help">使用前请在接入与插件中启用所选工具，并绑定项目目录。</p><Field label={`${executionName(form.executionProvider)} 会话 ID`} value={form.conversationId||''} onChange={v=>setValue('conversationId',v)} placeholder="可稍后绑定；用于继续执行"/></>}</>}{dialog==='evidence'&&<><Field label="证据说明" value={form.summary||''} onChange={v=>setValue('summary',v)} required multiline/><Field label="证据引用" value={form.reference||''} onChange={v=>setValue('reference',v)} required placeholder="文件路径、命令或报告链接"/></>}{dialog==='review'&&<><div className="decision" role="group" aria-label="验收结论"><button type="button" aria-pressed={reviewDecision==='pass'} onClick={()=>changeReviewDecision('pass')}><CheckCircle2 size={17}/> 通过</button><button type="button" aria-pressed={reviewDecision==='fail'} onClick={()=>changeReviewDecision('fail')}><AlertCircle size={17}/> 未通过</button></div><Field label="验收说明" value={form.summary||''} onChange={v=>setValue('summary',v)} multiline required/><p className="form-help">通过验收需要当前版本证据、验收标准和无待解决问题。</p></>}{formDraftNotice&&<p className="small-note" role="status">{formDraftNotice}</p>}{dialogStaleReason&&<p className="alert" role="alert">{dialogStaleReason}</p>}{state?.connection.mode==='hub'&&connectionChecking&&<p className="alert" role="status">正在确认连接；确认前不能提交，草稿会保留。</p>}{error&&<p className="alert" role="alert">{error}</p>}<div className="dialog-actions"><button className="secondary" type="button" onClick={()=>closeDialog()}>{hubCreatePending?'收起':'取消'}</button><button className="primary" type="submit" disabled={busy||remoteWriteBlocked||Boolean(dialogStaleReason)||hubCreatePending||Boolean(task&&pendingForTask(task.id).length&&['edit','evidence','review'].includes(dialog||''))}>{busy?'正在保存…':dialog==='review'?'提交结论':dialog==='project'?'继续接入':'保存'}</button></div></form></div></div>}
  </div>;

  function renderGroup(label:string, items:Task[]) {return items.length?<div className="task-group" key={label}><div className="group-heading">{label}<span>{items.length}</span></div>{items.map(renderTask)}</div>:null;}
  function renderTask(item:Task) {const selected=taskId===item.id;return <button key={item.id} className={`task-row ${selected?'selected':''}`} aria-pressed={selected} onClick={()=>{setTaskId(item.id);setMobileDetail(true)}}><span className={`task-icon ${isCompleted(item)?'complete':''}`}>{isCompleted(item)?<CheckCircle2 size={18}/>:item.status==='planned'?<Circle size={18}/>:<Activity size={18}/>}</span><span className="task-copy"><strong>{item.title}</strong><span>{item.summary||item.goal}</span><small>{item.issues.some(i=>i.open)?'有待处理偏差 · ':''}{isCompleted(item)?'已验收':statusText[item.status]}<VerificationBadge task={item}/></small></span><ArrowRight className="row-arrow" size={15}/></button>}
}
