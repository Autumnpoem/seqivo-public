import {useCallback,useEffect,useMemo,useRef,useState,type FormEvent} from 'react';
import {AlertCircle,ArrowLeft,Check,ExternalLink,RefreshCw,Smartphone,Monitor,ShieldAlert} from 'lucide-react';
import {ApiError,errorMessage,request} from './api';
import {previewFeedbackRecords,previewFeedbackStorageEvent,savePreviewFeedbackRecord,type PreviewFeedbackRecord} from './preview-feedback-recovery';
import {previewRecordAttempts,persistPreviewRecordAttempt,settlePreviewRecordAttempt,type PreviewRecordAttempt} from './preview-records-client';
import {desktopPreviewOrigin,previewSiteCapability,previewSiteUrl} from './preview-transport';
import PreviewRetestSection from './PreviewRetestSection';
import './preview.css';

export interface PreviewManifest {
  previewId:string;projectId:string;taskId:string;contentVersion:number|string;sourceCommit:string;dirtyDigest?:string|null;
  sourceTaskRevision?:number;
  dirty?:boolean;artifactDigest:string;environment:string;dataMode:'real'|'simulated';capability:'static-interactive'|'records-v1';
  backendApi:'unsupported'|'records-v1';apiTarget?:'records-v1';dataStoreId?:string;createdAt:string;
  provenance?:{kind:'managed-vite-vanilla-v1';sourceDigest:string;inputDigest:string;buildReceiptDigest:string;toolDigest:string;profileDigest:string};
}
interface Feedback {id:string;status:'draft'|'confirming'|'confirmed'|'not_applied'|'created_unavailable';taskId?:string;summary?:string;pagePath?:string;previewId?:string;projectId?:string;sourceTaskId?:string;contentVersion?:number|string;criterionIds?:string[]}
interface FeedbackVerification {feedback:Feedback;verification:{state:'not_requested'|'unknown'|'confirmed'|'not_applied';checkedAt?:number}}
interface UncertainFeedback {previewId:string;contentVersion:string;kind:'draft'|'confirm';idempotencyKey?:string;feedbackId?:string}
interface AccessIntent {id:string;previewId:string;projectId:string;taskId:string;state:'registered'|'issued'|'closed'|'expired'|'invalidated';expiresAt:number}
interface PreviewDetail {preview:PreviewManifest;launchUrl:string;dataCapability?:string;expiresAt?:number|string;intent?:AccessIntent}
interface DisplayedPreviewDetail extends PreviewDetail {trustedSiteUrl:string}
type ControlledBuildState='prepared'|'snapshot_ready'|'building'|'output_ready'|'registered_local'|'ready'|'failed_no_publish'|'unknown';
interface ControlledBuildIntent {scope:string;projectId:string;taskId:string;requestId:string;expectedRevision:number;contentVersion:number|string;worktreeId:null|string;profile:'vite-vanilla-v1';apiTarget:'static'|'records-v1';dataMode:'simulated'|'real';createdAt:number}
interface ControlledBuildResult {id:string;requestId:string;projectId:string;taskId:string;expectedRevision:number;contentVersion:number|string;worktreeId:null|string;profile:'vite-vanilla-v1';apiTarget:'static'|'records-v1';dataMode:'simulated'|'real';state:ControlledBuildState;previewId?:string;sourceDigest?:string;artifactDigest?:string;errorCode?:string}
const BUILD_PREFIX='seqivo-controlled-build-v1:';
const buildKey=(scope:string,projectId:string,taskId:string,requestId:string)=>`${BUILD_PREFIX}${encodeURIComponent(scope)}:${encodeURIComponent(projectId)}:${encodeURIComponent(taskId)}:${requestId}`;
const buildPrefix=(scope:string,projectId:string,taskId:string)=>`${BUILD_PREFIX}${encodeURIComponent(scope)}:${encodeURIComponent(projectId)}:${encodeURIComponent(taskId)}:`;
const buildTerminal=(state:string)=>state==='ready'||state==='failed_no_publish';
const buildStates:ControlledBuildState[]=['prepared','snapshot_ready','building','output_ready','registered_local','ready','failed_no_publish','unknown'];
const buildStateText:Record<ControlledBuildState,string>={prepared:'已登记，等待快照',snapshot_ready:'源码快照已就绪',building:'正在构建',output_ready:'产物已就绪，等待登记',registered_local:'已在本机登记，等待同步',ready:'可试用',failed_no_publish:'已确认未发布',unknown:'结果待核对'};
const buildErrorText:Record<string,string>={BUILD_INVALID:'构建请求无效',BUILD_UNSUPPORTED:'当前环境不支持受控构建',BUILD_WORKTREE_UNSUPPORTED:'此任务的工作树尚不能受控构建',BUILD_BUSY:'工作区正在使用，请稍后核对',BUILD_BINDING_CHANGED:'任务或执行位置已变化',BUILD_SOURCE_INVALID:'源码不符合首版范围',BUILD_PROFILE_UNSUPPORTED:'构建范围不受支持',BUILD_EXECUTOR_UNKNOWN:'构建进程状态无法确认',BUILD_REQUEST_CONFLICT:'原请求编号已用于其他构建',BUILD_PUBLISH_UNKNOWN:'发布结果无法确认'};
function readControlledBuilds(scope:string,projectId:string,taskId:string):ControlledBuildIntent[]{
  const prefix=buildPrefix(scope,projectId,taskId),items:ControlledBuildIntent[]=[];
  for(let i=0;i<localStorage.length;i++){
    const key=localStorage.key(i);if(!key?.startsWith(prefix))continue;
    let item:ControlledBuildIntent;
    try{item=JSON.parse(localStorage.getItem(key)||'') as ControlledBuildIntent;}catch{throw new Error('原构建记录无法读取；为避免重复构建，当前任务保持锁定。');}
    if(!item||item.scope!==scope||item.projectId!==projectId||item.taskId!==taskId||key!==buildKey(scope,projectId,taskId,item.requestId)||
      !/^[0-9a-f-]{36}$/.test(item.requestId)||!Number.isSafeInteger(item.expectedRevision)||
      !['number','string'].includes(typeof item.contentVersion)||item.worktreeId!==null&&typeof item.worktreeId!=='string'||
      item.profile!=='vite-vanilla-v1'||!['static','records-v1'].includes(item.apiTarget)||!['simulated','real'].includes(item.dataMode)||
      !Number.isSafeInteger(item.createdAt))throw new Error('原构建记录身份不匹配；当前任务保持锁定。');
    items.push(item);
  }
  return items.sort((a,b)=>b.createdAt-a.createdAt);
}
function persistControlledBuild(item:ControlledBuildIntent){
  const key=buildKey(item.scope,item.projectId,item.taskId,item.requestId),raw=JSON.stringify(item);
  if(localStorage.getItem(key)!==null)throw new Error('此构建编号已存在，未发送新请求。');
  localStorage.setItem(key,raw);
  if(localStorage.getItem(key)!==raw)throw new Error('无法确认原构建编号已保存，未发送构建请求。');
}
function checkedControlledBuild(value:ControlledBuildResult|undefined,intent:ControlledBuildIntent):ControlledBuildResult{
  if(!value||value.id!==intent.requestId||value.requestId!==intent.requestId||value.projectId!==intent.projectId||
    value.taskId!==intent.taskId||value.expectedRevision!==intent.expectedRevision||value.contentVersion!==intent.contentVersion||
    value.worktreeId!==intent.worktreeId||value.profile!==intent.profile||value.apiTarget!==intent.apiTarget||
    value.dataMode!==intent.dataMode||!buildStates.includes(value.state)||
    value.previewId!==undefined&&typeof value.previewId!=='string'||
    value.sourceDigest!==undefined&&!/^[a-f0-9]{64}$/.test(value.sourceDigest)||
    value.artifactDigest!==undefined&&!/^[a-f0-9]{64}$/.test(value.artifactDigest)||
    value.state==='ready'&&(!value.previewId||!value.sourceDigest||!value.artifactDigest))
    throw new Error('原构建回执与任务、版本或构建编号不匹配；保持锁定。');
  return value;
}
function matchesBuiltPreview(manifest:PreviewManifest|undefined,receipt:ControlledBuildResult):boolean{
  return Boolean(manifest&&manifest.previewId===receipt.previewId&&manifest.projectId===receipt.projectId&&
    manifest.taskId===receipt.taskId&&manifest.contentVersion===receipt.contentVersion&&
    Number.isSafeInteger(manifest.sourceTaskRevision)&&manifest.sourceTaskRevision===receipt.expectedRevision&&
    manifest.artifactDigest===receipt.artifactDigest&&manifest.provenance?.kind==='managed-vite-vanilla-v1'&&
    manifest.provenance.sourceDigest===receipt.sourceDigest);
}
type PreviewProps={taskId:string;projectId:string;accountScope?:string;connectionMode?:'local'|'hub';contentVersion?:number|string;expectedRevision:number;canRegister?:boolean;criteria?:{id:string;text:string}[];onTaskCreated?:(taskId:string)=>void;onOpenTask?:(taskId:string)=>void|Promise<void>;onClose?:()=>void};

/** Accept only the origin-local, preview-specific static site subtree. */
export function safePreviewUrl(value:string,previewId:string):string|null {
  return previewSiteUrl(value,previewId,window.location.origin);
}
export function previewCapability(value:string,previewId:string):string|null {
  return previewSiteCapability(value,previewId);
}
function formatDate(value:string|number){const time=new Date(typeof value==='number'?value:String(value));return Number.isNaN(time.getTime())?String(value):time.toLocaleString('zh-CN');}
function previewError(error:unknown){
  if(error instanceof ApiError){
    if(error.status===401)return '登录已失效。请重新登录后刷新预览；反馈不会自动补交。';
    if([403,404,410].includes(error.status))return '无权访问或预览已过期。请刷新列表后重新选择。';
  }
  return errorMessage(error);
}
function checkedCapability(detail:PreviewDetail,previewId:string,taskId:string,projectId:string):string {
  if(detail?.preview?.previewId!==previewId||detail.preview.taskId!==taskId||detail.preview.projectId!==projectId)throw new Error('预览版本无法核对。');
  if(detail.preview.apiTarget==='records-v1'&&(!detail.preview.dataStoreId||
    !/^[A-Za-z0-9_-]{1,100}$/.test(detail.preview.dataStoreId)||
    !/^[A-Za-z0-9_-]{43}$/.test(detail.dataCapability||'')))throw new Error('动态预览数据身份无法核对。');
  const capability=previewCapability(detail.launchUrl,previewId);
  if(!capability)throw new Error('预览地址不安全，已阻止打开。');
  return capability;
}
function checkedIntent(value:AccessIntent|undefined,previewId:string,taskId:string,projectId:string):AccessIntent {
  if(!value||!/^[A-Za-z0-9_-]{43}$/.test(value.id)||value.previewId!==previewId||value.taskId!==taskId||value.projectId!==projectId||!['registered','issued','closed','expired','invalidated'].includes(value.state)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=0||value.expiresAt>8_640_000_000_000_000)throw new Error('本次预览访问身份无法核对。');
  return value;
}
function boundedAccess<T>(promise:Promise<T>):Promise<T>{
  let timer:number|undefined;
  const deadline=new Promise<T>((_,reject)=>{timer=window.setTimeout(()=>reject(new Error('请求仍未返回，结果需要核实。')),8000);});
  return Promise.race([promise,deadline]).finally(()=>{if(timer!==undefined)window.clearTimeout(timer);});
}

export default function PreviewPanel({taskId,projectId,accountScope='',connectionMode='hub',contentVersion,expectedRevision,canRegister=false,criteria=[],onTaskCreated,onOpenTask,onClose}:PreviewProps){
  const [previews,setPreviews]=useState<PreviewManifest[]>([]);
  const [selectedId,setSelectedId]=useState('');
  const [detail,setDetail]=useState<DisplayedPreviewDetail|null>(null);
  const [width,setWidth]=useState<'desktop'|'phone'>('desktop');
  const [pagePath,setPagePath]=useState('index.html');
  const [summary,setSummary]=useState('');
  const [criterionIds,setCriterionIds]=useState<string[]>([]);
  const [draft,setDraft]=useState<Feedback|null>(null);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [uncertain,setUncertain]=useState(false);
  const [uncertainFeedback,setUncertainFeedback]=useState<UncertainFeedback|null>(null);
  const [recoveryRecords,setRecoveryRecords]=useState<PreviewFeedbackRecord[]>([]);
  const [recoveryError,setRecoveryError]=useState('');
  const [recoveryBusy,setRecoveryBusy]=useState('');
  const [verifiedDraftIds,setVerifiedDraftIds]=useState<string[]>([]);
  const [allowNewAfterFence,setAllowNewAfterFence]=useState(false);
  const [online,setOnline]=useState(navigator.onLine);
  const [distDir,setDistDir]=useState('');
  const [environment,setEnvironment]=useState('本机静态构建');
  const [dataMode,setDataMode]=useState<'real'|'simulated'>('simulated');
  const [apiTarget,setApiTarget]=useState<'static'|'records-v1'>('static');
  const [buildApiTarget,setBuildApiTarget]=useState<'static'|'records-v1'>('static');
  const [buildDataMode,setBuildDataMode]=useState<'simulated'|'real'>('simulated');
  const [buildIntents,setBuildIntents]=useState<ControlledBuildIntent[]>([]);
  const [buildResults,setBuildResults]=useState<Record<string,ControlledBuildResult|{state:'checking'|'not_found'|'error'}>>({});
  const [buildBusy,setBuildBusy]=useState('');
  const [buildError,setBuildError]=useState('');
  const [buildStorageError,setBuildStorageError]=useState('');
  const [launchNonce,setLaunchNonce]=useState('');
  const [recordAttempts,setRecordAttempts]=useState<PreviewRecordAttempt[]>([]);
  const [recordError,setRecordError]=useState('');
  const [recordBusy,setRecordBusy]=useState('');
  const frameRef=useRef<HTMLIFrameElement|null>(null);
  const [registering,setRegistering]=useState(false);
  const [detailVersion,setDetailVersion]=useState(0);
  const [accessBusy,setAccessBusy]=useState(false);
  const [accessClosed,setAccessClosed]=useState(false);
  const [accessPhase,setAccessPhase]=useState<'idle'|'transport'|'transport_unavailable'|'registering'|'issuing'|'ready'|'unknown'>('idle');
  const [accessIntent,setAccessIntent]=useState<AccessIntent|null>(null);
  const accessBusyRef=useRef(false);
  const detailRequestRevision=useRef(0);
  const detailRef=useRef<DisplayedPreviewDetail|null>(null);
  const intentRef=useRef<AccessIntent|null>(null);
  const uncertainFeedbackRef=useRef<UncertainFeedback|null>(null);
  const selectedIdRef=useRef(selectedId);
  const identityRef=useRef('');
  const identity=`${connectionMode}:${accountScope}:${projectId}:${taskId}`;
  const buildIdentity=`${identity}:${expectedRevision}:${String(contentVersion)}`;
  const buildIdentityRef=useRef(buildIdentity);
  const expectedBuiltReceiptRef=useRef<ControlledBuildResult|null>(null);
  identityRef.current=identity;
  buildIdentityRef.current=buildIdentity;
  useEffect(()=>{identityRef.current=identity;return()=>{identityRef.current='';};},[identity]);
  useEffect(()=>{buildIdentityRef.current=buildIdentity;return()=>{buildIdentityRef.current='';};},[buildIdentity]);
  detailRef.current=detail;
  selectedIdRef.current=selectedId;
  const selected=previews.find(item=>item.previewId===selectedId)||null;
  const previousPreview=selected?previews.find(item=>item.previewId!==selected.previewId&&Date.parse(item.createdAt)<Date.parse(selected.createdAt)):null;
  const visibleBuildIntents=buildIntents.filter(item=>item.scope===accountScope&&item.projectId===projectId&&item.taskId===taskId);
  const buildLocked=Boolean(buildStorageError)||visibleBuildIntents.some(item=>!buildTerminal(buildResults[item.requestId]?.state||''));
  const launchUrl=useMemo(()=>detail&&selected&&detail.preview.previewId===selected.previewId&&previewCapability(detail.launchUrl,selected.previewId)?detail.trustedSiteUrl:null,[detail,selected]);
  const refreshRecordAttempts=useCallback(()=>{
    try{setRecordAttempts(previewRecordAttempts(accountScope,projectId,taskId));setRecordError('');}
    catch(cause){setRecordError(previewError(cause));}
  },[accountScope,projectId,taskId]);
  useEffect(()=>{refreshRecordAttempts();const changed=(event:StorageEvent)=>{
    if(event.key===null||event.key.startsWith('seqivo-preview-record-v1:'))refreshRecordAttempts();};
    window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);
  },[refreshRecordAttempts]);
  const unresolvedRecords=recoveryRecords.filter(item=>!item.result||item.conflict);
  const feedbackLocked=uncertain||unresolvedRecords.length>0||Boolean(recoveryError)||!accountScope||recoveryBusy!==''||recoveryRecords.some(item=>item.result==='created_unavailable')||recoveryRecords.some(item=>item.result==='not_applied')&&!allowNewAfterFence;
  function reloadRecovery(){
    try{setRecoveryRecords(previewFeedbackRecords(accountScope,projectId,taskId));setRecoveryError('');}
    catch(cause){setRecoveryError(previewError(cause));}
  }
  useEffect(()=>{
    if(!accountScope){setRecoveryRecords([]);setRecoveryError('尚未确认当前账号身份。反馈暂不可提交或核实。');return;}
    reloadRecovery();
    try{const saved=previewFeedbackRecords(accountScope,projectId,taskId);void(async()=>{for(const record of saved)if(!record.result&&!record.conflict)await verifyRecovery(record);})();}
    catch{/* reloadRecovery already shows the storage error and blocks submissions. */}
    const change=(event:StorageEvent)=>{if(previewFeedbackStorageEvent(event))reloadRecovery();};
    window.addEventListener('storage',change);
    return()=>window.removeEventListener('storage',change);
  },[identity]);
  async function verifiedScope():Promise<void>{
    if(!accountScope)throw new Error('尚未确认当前账号身份，未发送请求。');
    if(connectionMode==='hub'){
      const result=await boundedAccess(request<{user?:{id?:string}}>('GET','/api/auth/me'));
      if(result.user?.id!==accountScope||identityRef.current!==identity)throw new Error('登录账号已变化，未发送请求。');
    }
  }
  const recordPath=(item:PreviewRecordAttempt)=>`/api/previews/${encodeURIComponent(item.previewId)}/data/stores/${encodeURIComponent(item.dataStoreId)}/operations/by-key/${encodeURIComponent(item.clientMutationId)}`;
  async function verifyRecordAttempt(item:PreviewRecordAttempt,reconcile=false){
    if(recordBusy||item.result||!online)return;
    const captured=identity;setRecordBusy(item.intentId);setRecordError('');
    try{
      await verifiedScope();
      const result=await boundedAccess(request<{operation:{id?:string;clientMutationId:string;state:'confirmed'|'not_applied'|'unknown';recordId?:string}}>(
        reconcile?'POST':'GET',`${recordPath(item)}${reconcile?'/reconcile':''}`,reconcile?{}:undefined,
        connectionMode==='hub'?{expectedPreviewActorId:accountScope}:undefined));
      if(identityRef.current!==captured)return;
      if(result.operation.clientMutationId!==item.clientMutationId||
        !['confirmed','not_applied','unknown'].includes(result.operation.state)||
        result.operation.state==='confirmed'&&!result.operation.recordId)
        throw new Error('原保存回执无法匹配，保持锁定。');
      if(result.operation.state!=='unknown')settlePreviewRecordAttempt(item,result.operation.state);
      refreshRecordAttempts();
      setNotice(result.operation.state==='unknown'?'原保存结果仍待核实，不会重发写入。':
        result.operation.state==='confirmed'?'已核实原记录保存成功。':'已核实原操作未写入，原编号不能重用。');
    }catch(cause){if(identityRef.current===captured)setRecordError(cause instanceof ApiError&&cause.status===404?
      'Hub 尚无原操作行，不能证明未执行；保持原编号并停止重发。':previewError(cause));}
    finally{if(identityRef.current===captured)setRecordBusy('');}
  }
  useEffect(()=>{
    if(!detail||!selected||selected.apiTarget!=='records-v1'||!launchNonce)return;
    const currentDetail=detail,capturedIdentity=identity,capturedNonce=launchNonce;
    const message=(event:MessageEvent)=>{
      if(event.origin!=='null'||event.source!==frameRef.current?.contentWindow||
        detailRef.current!==currentDetail||identityRef.current!==capturedIdentity||
        selectedIdRef.current!==selected.previewId||accessPhase!=='ready'||accessClosed||
        accessBusyRef.current||intentRef.current?.id!==currentDetail.intent?.id)return;
      const data=event.data;
      if(!data||typeof data!=='object'||data.v!==1||data.nonce!==capturedNonce||
        data.previewId!==selected.previewId||data.dataStoreId!==selected.dataStoreId||
        data.projectId!==projectId)return;
      if(data.type==='seqivo-records-ready'){
        if(!currentDetail.dataCapability||!/^[A-Za-z0-9_-]{43}$/.test(currentDetail.dataCapability))return;
        frameRef.current?.contentWindow?.postMessage({v:1,type:'seqivo-records-init',nonce:capturedNonce,
          previewId:selected.previewId,dataStoreId:selected.dataStoreId,projectId,
          dataCapability:currentDetail.dataCapability},'*');return;
      }
      if(data.type!=='seqivo-records-save-intent'||typeof data.intentId!=='string'||
        !/^[A-Za-z0-9_-]{1,100}$/.test(data.intentId)||typeof data.title!=='string')return;
      const title=data.title.trim();
      if(!title||!title.isWellFormed()||Array.from(title).length>120||new TextEncoder().encode(title).length>480||
        /[\p{Cc}\p{Cf}]/u.test(title))return;
      void(async()=>{
        try{
          await verifiedScope();
          const encoded=new TextEncoder().encode(JSON.stringify({title}));
          const digest=await crypto.subtle.digest('SHA-256',encoded);
          const payloadHash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
          if(detailRef.current!==currentDetail||identityRef.current!==capturedIdentity||
            selectedIdRef.current!==selected.previewId||accessPhase!=='ready'||accessBusyRef.current||
            intentRef.current?.id!==currentDetail.intent?.id||frameRef.current?.contentWindow!==event.source)return;
          const saved=persistPreviewRecordAttempt({v:1,account:accountScope,projectId,taskId,
            previewId:selected.previewId,dataStoreId:selected.dataStoreId!,contentVersion:String(selected.contentVersion),
            intentId:data.intentId,clientMutationId:crypto.randomUUID(),payloadHash,createdAt:Date.now()});
          refreshRecordAttempts();
          frameRef.current?.contentWindow?.postMessage({v:1,type:'seqivo-records-save-ack',nonce:capturedNonce,
            previewId:selected.previewId,dataStoreId:selected.dataStoreId,projectId,
            intentId:data.intentId,clientMutationId:saved.clientMutationId,payloadHash},'*');
        }catch(cause){setRecordError(previewError(cause));}
      })();
    };
    window.addEventListener('message',message);return()=>window.removeEventListener('message',message);
  },[detail,selected,launchNonce,identity,accessPhase,accessClosed,projectId,taskId,accountScope]);
  const feedbackActor=connectionMode==='hub'?{expectedPreviewActorId:accountScope}:undefined;
  function saveRecovery(record:PreviewFeedbackRecord){savePreviewFeedbackRecord(record);reloadRecovery();}
  function recoveryPath(record:PreviewFeedbackRecord){return `/api/previews/${encodeURIComponent(record.previewId)}/feedback/${record.feedbackId?encodeURIComponent(record.feedbackId):`by-key/${encodeURIComponent(record.idempotencyKey)}`}`;}
  function checkedFeedbackVerification(value:FeedbackVerification,record:PreviewFeedbackRecord):FeedbackVerification{
    const feedback=value?.feedback,verification=value?.verification;
    if(!feedback||feedback.previewId!==record.previewId||feedback.projectId!==record.projectId||feedback.sourceTaskId!==record.taskId||String(feedback.contentVersion)!==record.contentVersion||
      !['draft','confirming','confirmed','not_applied','created_unavailable'].includes(feedback.status)||!verification||!['not_requested','unknown','confirmed','not_applied'].includes(verification.state)||
      (record.feedbackId&&feedback.id!==record.feedbackId)||feedback.id!==undefined&&typeof feedback.id!=='string'||
      feedback.status==='draft'&&!['not_requested','unknown'].includes(verification.state)||
      feedback.status==='confirming'&&verification.state!=='unknown'||
      feedback.status==='confirmed'&&(!feedback.taskId||!['confirmed','unknown'].includes(verification.state))||
      feedback.status==='not_applied'&&verification.state!=='not_applied'||feedback.status==='created_unavailable'&&verification.state!=='confirmed')throw new Error('反馈核实结果与原任务或版本不匹配。');
    return value;
  }
  async function verifyRecovery(record:PreviewFeedbackRecord,reconcile=false){
    if(recoveryBusy||!online)return;
    const captured=identity;
    setVerifiedDraftIds(ids=>ids.filter(id=>id!==record.id));
    setRecoveryBusy(record.id);setRecoveryError('');
    try{
      const before=previewFeedbackRecords(accountScope,projectId,taskId).find(item=>item.id===record.id);
      if(!before||before.result||before.conflict){reloadRecovery();return;}
      await verifiedScope();
      const result=checkedFeedbackVerification(await boundedAccess(request<FeedbackVerification>(reconcile?'POST':'GET',`${recoveryPath(record)}${reconcile?'/reconcile':''}`,reconcile?{}:undefined,feedbackActor)),record);
      if(identityRef.current!==captured)return;
      const feedback=result.feedback;
      const latest=previewFeedbackRecords(accountScope,projectId,taskId).find(item=>item.id===record.id);
      if(!latest||latest.result||latest.conflict){reloadRecovery();return;}
      const confirmed=feedback.status==='confirmed'&&result.verification.state==='confirmed';
      const next:PreviewFeedbackRecord={...latest,...(feedback.id?{feedbackId:feedback.id}:{}),...(confirmed?{result:'confirmed' as const,taskCreatedId:feedback.taskId}:feedback.status==='not_applied'?{result:'not_applied' as const}:feedback.status==='created_unavailable'?{result:'created_unavailable' as const}:{})};
      saveRecovery(next);
      const merged=previewFeedbackRecords(accountScope,projectId,taskId).find(item=>item.id===record.id);
      if(!merged||merged.conflict||merged.result&&merged.result!==next.result){setRecoveryError('原反馈的持久回执互相矛盾，保持锁定。请停止提交并核对任务记录。');return;}
      if(feedback.status==='draft'&&result.verification.state==='not_requested'&&feedback.id&&merged.kind==='draft'){setVerifiedDraftIds(ids=>ids.includes(record.id)?ids:[...ids,record.id]);if(record.previewId===selectedIdRef.current)setDraft(feedback);}
      if(confirmed){
        setNotice('已核实修改任务已创建，可直接打开查看。');
        if(record.previewId===selectedIdRef.current&&(draft?.id===feedback.id||uncertainFeedbackRef.current?.feedbackId===feedback.id)){
          setDraft(feedback);uncertainFeedbackRef.current=null;setUncertainFeedback(null);setUncertain(false);setError('');
        }
      }
      else if(feedback.status==='confirmed')setNotice('服务端记录曾确认，但当前核实结果不一致；原反馈仍锁定，不会创建第二个任务。');
      else if(feedback.status==='not_applied')setNotice('已核实原请求未执行；原编号仍不会再次使用。需要反馈时请明确填写新草稿。');
      else if(feedback.status==='created_unavailable')setNotice('原反馈曾创建任务，但任务现已不可见；不会再创建一次。');
      else setNotice('原反馈仍未确认完成。请稍后手动核实；页面不会重复提交。');
    }catch(cause){if(identityRef.current===captured)setRecoveryError(cause instanceof ApiError&&cause.status===404?'目前未查到原反馈，不代表它未执行。请明确核实原请求；原编号继续保留。':previewError(cause));}
    finally{if(identityRef.current===captured)setRecoveryBusy('');}
  }
  async function confirmRecoveredDraft(record:PreviewFeedbackRecord){
    if(!record.feedbackId||record.conflict||!verifiedDraftIds.includes(record.id)||recoveryBusy||!online)return;
    const captured=identity;
    setRecoveryBusy(record.id);setRecoveryError('');
    try{
      await verifiedScope();
      const latest=previewFeedbackRecords(accountScope,projectId,taskId).find(item=>item.id===record.id);
      if(identityRef.current!==captured||!latest||latest.kind!=='draft'||latest.feedbackId!==record.feedbackId||latest.result||latest.conflict)throw new Error('原草稿状态已变化，请重新核实。');
      const confirming:PreviewFeedbackRecord={...latest,kind:'confirm'};
      saveRecovery(confirming);
      const result=await boundedAccess(request<{feedback:Feedback}>('POST',`/api/previews/${encodeURIComponent(record.previewId)}/feedback/${encodeURIComponent(record.feedbackId)}/confirm`,{},feedbackActor));
      if(identityRef.current!==captured)return;
      if(result.feedback?.status!=='confirmed'||!result.feedback.taskId)throw new Error('确认回执未能核实。请核实这次反馈，不会再次确认。');
      saveRecovery({...confirming,result:'confirmed',taskCreatedId:result.feedback.taskId});
      setNotice('已核实修改任务已创建，可直接打开查看。');onTaskCreated?.(result.feedback.taskId);
    }catch(cause){if(identityRef.current===captured)setRecoveryError(previewError(cause));}
    finally{if(identityRef.current===captured)setRecoveryBusy('');}
  }
  useEffect(()=>{const change=()=>setOnline(navigator.onLine);window.addEventListener('online',change);window.addEventListener('offline',change);return()=>{window.removeEventListener('online',change);window.removeEventListener('offline',change);};},[]);
  const reloadBuildIntents=useCallback(()=>{
    if(!accountScope){setBuildIntents([]);setBuildStorageError('账号身份尚未确认，不能发起或核对构建。');return;}
    try{setBuildIntents(readControlledBuilds(accountScope,projectId,taskId));setBuildStorageError('');}
    catch(cause){setBuildIntents([]);setBuildStorageError(previewError(cause));}
  },[accountScope,projectId,taskId]);
  useEffect(()=>{
    setBuildResults({});setBuildError('');reloadBuildIntents();
    const onStorage=(event:StorageEvent)=>{if(event.key===null||event.key.startsWith(buildPrefix(accountScope,projectId,taskId)))reloadBuildIntents();};
    window.addEventListener('storage',onStorage);return()=>window.removeEventListener('storage',onStorage);
  },[buildIdentity,reloadBuildIntents]);
  async function inspectBuild(item:ControlledBuildIntent,reconcile=false){
    if(buildBusy||!online)return;
    const captured=buildIdentity;setBuildBusy(item.requestId);setBuildError('');
    setBuildResults(current=>({...current,[item.requestId]:{state:'checking'}}));
    try{
      await verifiedScope();
      if(buildIdentityRef.current!==captured)return;
      const result=await boundedAccess(request<{build:ControlledBuildResult}>(reconcile?'POST':'GET',
        `/api/preview/controlled-builds/${encodeURIComponent(item.requestId)}${reconcile?'/reconcile':''}`,reconcile?{}:undefined));
      if(buildIdentityRef.current!==captured)return;
      const checked=checkedControlledBuild(result.build,item);
      setBuildResults(current=>({...current,[item.requestId]:checked}));
    }catch(cause){if(buildIdentityRef.current===captured){
      setBuildResults(current=>({...current,[item.requestId]:{state:cause instanceof ApiError&&cause.status===404?'not_found':'error'}}));
      setBuildError(cause instanceof ApiError&&cause.status===404?'暂未找到原请求记录，不能确认是否执行过。请继续核对原编号，不会自动重发。':previewError(cause));
    }}finally{if(buildIdentityRef.current===captured)setBuildBusy('');}
  }
  useEffect(()=>{
    if(!online||!accountScope)return;
    const pending=visibleBuildIntents.filter(item=>!buildResults[item.requestId]);
    if(pending.length&&!buildBusy)void inspectBuild(pending[0]);
  },[visibleBuildIntents.map(item=>item.requestId).join(','),Object.keys(buildResults).join(','),online,buildBusy,buildIdentity]);
  async function startControlledBuild(){
    if(!canRegister||connectionMode!=='local'||!online||buildBusy||buildLocked||!accountScope||
      !Number.isSafeInteger(expectedRevision)||expectedRevision<0||contentVersion===undefined||
      buildApiTarget==='static'&&buildDataMode==='real')return;
    const captured=buildIdentity;
    const item:ControlledBuildIntent={scope:accountScope,projectId,taskId,requestId:crypto.randomUUID(),
      expectedRevision,contentVersion,worktreeId:null,profile:'vite-vanilla-v1',apiTarget:buildApiTarget,dataMode:buildDataMode,createdAt:Date.now()};
    try{
      await verifiedScope();
      if(buildIdentityRef.current!==captured)return;
      if(readControlledBuilds(accountScope,projectId,taskId).some(saved=>!buildTerminal(buildResults[saved.requestId]?.state||'')))
        throw new Error('已有原构建请求待核对，未发送新请求。');
      persistControlledBuild(item);reloadBuildIntents();setBuildBusy(item.requestId);setBuildError('');
      const {scope:_scope,createdAt:_createdAt,...body}=item;
      const response=await boundedAccess(request<{build:ControlledBuildResult}>('POST','/api/preview/controlled-builds',body));
      if(buildIdentityRef.current!==captured)return;
      const checked=checkedControlledBuild(response.build,item);
      setBuildResults(current=>({...current,[item.requestId]:checked}));
    }catch(cause){if(buildIdentityRef.current===captured){setBuildError(`${previewError(cause)} 原请求如已发送，不会自动重发；请核对同一编号。`);reloadBuildIntents();}}
    finally{if(buildIdentityRef.current===captured)setBuildBusy('');}
  }
  async function openBuiltPreview(item:ControlledBuildResult){
    if(item.state!=='ready'||!item.previewId||!await revokeCurrentAccess())return;
    const captured=buildIdentity;
    const found=await loadList(item.previewId,true,item);
    if(buildIdentityRef.current!==captured)return;
    if(!found){setBuildError('原构建版本或摘要当前无法匹配，未打开其他预览。请核对原请求和预览列表。');return;}
    expectedBuiltReceiptRef.current=item;
    setAccessClosed(false);setDetailVersion(value=>value+1);
  }
  const loadList=useCallback(async(preferredId?:string,requirePreferred=false,expectedBuild?:ControlledBuildResult):Promise<boolean>=>{
    detailRequestRevision.current++;
    setLoading(true);setError('');setNotice('');setDetail(null);
    if(!uncertainFeedbackRef.current){setUncertain(false);setDraft(null);}
    try{
      const result=await request<{previews:PreviewManifest[]}>('GET',`/api/previews?taskId=${encodeURIComponent(taskId)}`);
      const items=(Array.isArray(result.previews)?result.previews:[]).filter(item=>item?.taskId===taskId&&item.projectId===projectId&&typeof item.previewId==='string').sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
      const found=Boolean(preferredId&&items.some(item=>item.previewId===preferredId&&(!expectedBuild||matchesBuiltPreview(item,expectedBuild))));
      setPreviews(items);if(!requirePreferred||found)setSelectedId(current=>found?preferredId!:items.some(item=>item.previewId===current)?current:items[0]?.previewId||'');
      return requirePreferred?found:true;
    }catch(cause){if(!requirePreferred){setPreviews([]);setSelectedId('');}setError(previewError(cause));return false;}
    finally{setLoading(false);}
  },[taskId,projectId]);
  useEffect(()=>{void loadList();},[loadList]);
  useEffect(()=>{
    const revision=++detailRequestRevision.current;
    if(!selectedId||accessClosed)return;
    let current=true;
    const nativeBridge=Boolean(window.taskboard);
    let transportPending=nativeBridge;
    intentRef.current=null;setAccessIntent(null);setAccessPhase(nativeBridge?'transport':'registering');
    setDetail(null);setError('');setNotice('');
    if(!uncertainFeedbackRef.current){setDraft(null);setUncertain(false);setPagePath('index.html');setSummary('');setCriterionIds([]);}
    void(async()=>{
      try{
        let trustedOrigin=window.location.origin;
        if(nativeBridge){
          const transport=await boundedAccess(request<unknown>('GET','/api/preview/transport'));
          if(!current||revision!==detailRequestRevision.current||selectedIdRef.current!==selectedId)return;
          const checked=desktopPreviewOrigin(transport);
          if(!checked)throw new Error('桌面预览连接地址无法核对。');
          trustedOrigin=checked;
          transportPending=false;
          setAccessPhase('registering');
        }
        const registration=await boundedAccess(request<{intent:AccessIntent}>('POST',`/api/previews/${encodeURIComponent(selectedId)}/access-intents`,{}));
        if(!current||revision!==detailRequestRevision.current||selectedIdRef.current!==selectedId)return;
        const registered=checkedIntent(registration.intent,selectedId,taskId,projectId);
        if(registered.state!=='registered')throw new Error('本次预览访问登记结果无法核对。');
        intentRef.current=registered;setAccessIntent(registered);setAccessPhase('issuing');
        const result=await boundedAccess(request<PreviewDetail>('POST',`/api/previews/${encodeURIComponent(selectedId)}/access-intents/${encodeURIComponent(registered.id)}/issue`,{}));
        if(!current||revision!==detailRequestRevision.current||selectedIdRef.current!==selectedId)return;
        const issued=checkedIntent(result.intent,selectedId,taskId,projectId);
        if(issued.id!==registered.id||issued.state!=='issued')throw new Error('签发结果与本次访问不匹配。');
        const manifest=previews.find(item=>item.previewId===selectedId);
        if(!manifest||String(result.preview?.contentVersion)!==String(manifest.contentVersion)||result.preview.artifactDigest!==manifest.artifactDigest)throw new Error('预览版本与列表不匹配。');
        const builtReceipt=expectedBuiltReceiptRef.current;
        if(builtReceipt?.previewId===selectedId&&(!matchesBuiltPreview(manifest,builtReceipt)||!matchesBuiltPreview(result.preview,builtReceipt)))
          throw new Error('预览版本与原构建回执的源码或产物摘要不匹配，已阻止打开。');
        checkedCapability(result,selectedId,taskId,projectId);
        const trustedSiteUrl=previewSiteUrl(result.launchUrl,selectedId,trustedOrigin);
        if(!trustedSiteUrl)throw new Error('预览地址与已核对的连接不匹配，已阻止打开。');
        const displayed={...result,trustedSiteUrl};
        intentRef.current=issued;setAccessIntent(issued);setAccessPhase('ready');
        detailRef.current=displayed;
        setLaunchNonce(crypto.randomUUID());
        setDetail(displayed);
      }catch(cause){if(current&&revision===detailRequestRevision.current){
        if(transportPending){
          setAccessPhase('transport_unavailable');
          setError(`桌面预览连接暂不可用，尚未申请预览链接。请检查本机服务后点“重新连接预览”。${previewError(cause)}`);
          return;
        }
        setAccessPhase('unknown');
        setError(intentRef.current?`链接获取结果未确认；请核实或关闭本次访问，不会重复申请链接。${previewError(cause)}`:`访问登记未确认，但尚未申请链接。可以返回或重新选择版本。${previewError(cause)}`);
      }}
    })();
    return()=>{current=false;};
  },[selectedId,taskId,projectId,detailVersion,accessClosed]);
  async function revokeCurrentAccess():Promise<boolean>{
    if(accessBusyRef.current)return false;
    const active=intentRef.current;
    // Register has no capability. Invalidate its generation so a late response cannot issue.
    detailRequestRevision.current++;
    if(!active){setAccessClosed(true);setAccessPhase('idle');return true;}
    accessBusyRef.current=true;setAccessBusy(true);setError('');
    try{
      const result=await boundedAccess(request<{intent:AccessIntent;inactive:boolean}>('POST',`/api/previews/${encodeURIComponent(active.previewId)}/access-intents/${encodeURIComponent(active.id)}/close`,{}));
      const closed=checkedIntent(result.intent,active.previewId,taskId,projectId);
      if(closed.id!==active.id||result.inactive!==true||!['closed','expired','invalidated'].includes(closed.state))throw new Error('关闭回执无法确认。');
      intentRef.current=null;setAccessIntent(null);
      detailRef.current=null;setDetail(null);setAccessClosed(true);
      setAccessPhase('idle');
      setNotice('本次预览访问已关闭。此前已下载的页面内容无法收回。');
      return true;
    }catch(cause){
      setAccessPhase('unknown');setError(`关闭结果未确认。请核实本次访问或手动重试关闭；不会再申请链接。${previewError(cause)}`);
      return false;
    }
    finally{accessBusyRef.current=false;setAccessBusy(false);}
  }
  async function verifyCurrentAccess(){
    const active=intentRef.current;if(!active||accessBusyRef.current)return;
    // A verification of an already issued link must not let a late issue reply open it.
    detailRequestRevision.current++;
    accessBusyRef.current=true;setAccessBusy(true);setError('');
    try{
      const result=await boundedAccess(request<{intent:AccessIntent}>('GET',`/api/previews/${encodeURIComponent(active.previewId)}/access-intents/${encodeURIComponent(active.id)}`));
      const checked=checkedIntent(result.intent,active.previewId,taskId,projectId);
      if(checked.id!==active.id)throw new Error('核实结果与本次访问不匹配。');
      if(['closed','expired','invalidated'].includes(checked.state)){
        intentRef.current=null;setAccessIntent(null);detailRequestRevision.current++;detailRef.current=null;setDetail(null);setAccessClosed(true);setAccessPhase('idle');setNotice('已核实本次链接失效。此前已下载的页面内容无法收回。');
      }else{intentRef.current=checked;setAccessIntent(checked);setAccessPhase('unknown');setError(checked.state==='issued'?'链接仍有效且已签发，请关闭本次访问；不会重复申请链接。':'链接尚未签发，请关闭本次访问后再离开。');}
    }catch(cause){setError(`本次访问尚未核实；请恢复连接后手动重试核实或关闭。${previewError(cause)}`);}
    finally{accessBusyRef.current=false;setAccessBusy(false);}
  }
  async function replaceAccess(nextId?:string){
    if(accessBusyRef.current||busy)return;
    if(!await revokeCurrentAccess())return;
    if(nextId&&nextId!==selectedIdRef.current)expectedBuiltReceiptRef.current=null;
    setAccessClosed(false);
    if(nextId&&nextId!==selectedIdRef.current){selectedIdRef.current=nextId;setSelectedId(nextId);return;}
    setDetailVersion(value=>value+1);
  }
  async function refreshList(){if(accessBusyRef.current||!await revokeCurrentAccess())return;await loadList();setAccessClosed(false);setDetailVersion(value=>value+1);}
  async function closePanel(onClosed:()=>void|Promise<void>=()=>onClose?.()){
    if(accessBusyRef.current)return;
    const captured=identity;
    if(!await revokeCurrentAccess()||identityRef.current!==captured)return;
    detailRequestRevision.current++;
    setAccessClosed(true);
    await onClosed();
  }
  async function createDraft(event:FormEvent){
    event.preventDefault();if(!selectedId||!detail||!online||busy||accessBusy||feedbackLocked||!summary.trim())return;
    setBusy(true);setError('');setNotice('');
    const idempotencyKey=crypto.randomUUID();
    const captured=identity;
    const record:PreviewFeedbackRecord={v:1,id:idempotencyKey,scope:accountScope,projectId,taskId,previewId:selectedId,contentVersion:String(selected?.contentVersion??''),kind:'draft',idempotencyKey,createdAt:Date.now()};
    let sent=false;
    try{
      await verifiedScope();
      if(identityRef.current!==captured||previewFeedbackRecords(accountScope,projectId,taskId).some(item=>!item.result))throw new Error('已有反馈待核实，请先处理原请求。');
      saveRecovery(record);
      sent=true;
      const result=await boundedAccess(request<{feedback:Feedback}>('POST',`/api/previews/${encodeURIComponent(selectedId)}/feedback`,{pagePath:pagePath.trim()||'index.html',summary:summary.trim(),...(criterionIds.length?{criterionIds}:{}),idempotencyKey},feedbackActor));
      if(identityRef.current!==captured)return;
      if(result.feedback?.status!=='draft'||!result.feedback.id)throw new Error('反馈草稿结果无法确认，请刷新后核对。');
      saveRecovery({...record,feedbackId:result.feedback.id});
      uncertainFeedbackRef.current=null;setUncertainFeedback(null);setUncertain(false);
      setDraft(result.feedback);setNotice('反馈已保存为草稿。请核对内容后明确确认，才会生成关联任务。');
    }catch(cause){if(identityRef.current===captured){if(sent){const unknown={previewId:selectedId,contentVersion:record.contentVersion,kind:'draft' as const,idempotencyKey};uncertainFeedbackRef.current=unknown;setUncertainFeedback(unknown);setUncertain(true);}setError(previewError(cause));}}
    finally{setBusy(false);}
  }
  async function confirmDraft(){
    if(!selectedId||!draft?.id||draft.status!=='draft'||!online||busy||accessBusy||uncertain||recoveryBusy)return;
    setBusy(true);setError('');setNotice('');
    const captured=identity;
    let sent=false;
    try{
      await verifiedScope();
      const existing=previewFeedbackRecords(accountScope,projectId,taskId).find(item=>item.feedbackId===draft.id&&item.previewId===selectedId&&!item.result);
      if(identityRef.current!==captured||!existing||existing.kind==='confirm'||existing.result||existing.conflict)throw new Error('原草稿身份无法核对，未发送确认。');
      const confirming:PreviewFeedbackRecord={...existing,kind:'confirm'};
      saveRecovery(confirming);
      sent=true;
      const result=await boundedAccess(request<{feedback:Feedback;retest?:unknown}>('POST',`/api/previews/${encodeURIComponent(selectedId)}/feedback/${encodeURIComponent(draft.id)}/confirm`,{},feedbackActor));
      if(identityRef.current!==captured)return;
      if(result.feedback?.status!=='confirmed'||!result.feedback.taskId)throw new Error('反馈确认结果待核实，请刷新后检查任务列表。');
      saveRecovery({...confirming,result:'confirmed',taskCreatedId:result.feedback.taskId});
      uncertainFeedbackRef.current=null;setUncertainFeedback(null);setUncertain(false);
      setDraft(result.feedback);
      setNotice('修改任务已创建。处理后，可从任务返回来源预览检查新版。');onTaskCreated?.(result.feedback.taskId);
    }catch(cause){if(identityRef.current===captured){if(sent){const unknown={previewId:selectedId,contentVersion:String(selected?.contentVersion??'未知'),kind:'confirm' as const,feedbackId:draft.id};uncertainFeedbackRef.current=unknown;setUncertainFeedback(unknown);setUncertain(true);}setError(previewError(cause));}}
    finally{setBusy(false);}
  }
  async function registerBuild(event:FormEvent){
    event.preventDefault();if(!canRegister||!distDir.trim()||!environment.trim()||contentVersion===undefined||registering||accessBusy)return;
    setRegistering(true);setError('');setNotice('');
    try{
      const result=await request<{preview:PreviewManifest}>('POST','/api/preview/builds',{projectId,taskId,contentVersion,distDir:distDir.trim(),environment:environment.trim(),dataMode,apiTarget});
      setDistDir('');if(!await revokeCurrentAccess()){setNotice('构建已登记，但当前预览访问关闭未确认。请核对后手动刷新列表；登记不会自动重复。');return;}await loadList(result.preview?.previewId);setAccessClosed(false);setDetailVersion(value=>value+1);setNotice('构建已登记。Hub 同步完成后会出现在预览列表；源代码与产物的构建对应关系尚未核验。');
    }catch(cause){setError(previewError(cause));}
    finally{setRegistering(false);}
  }
  return <section className="preview-panel" aria-label="运行预览">
    <div className="preview-header"><div><span className="preview-eyebrow">任务运行预览</span><h2>在提交验收前亲自试用</h2><p>此处展示静态构建中的客户端交互。预览不能证明后端服务、短信或支付已接通。</p></div>{onClose&&<button className="secondary" type="button" disabled={accessBusy} onClick={()=>void closePanel()}><ArrowLeft size={16}/> {accessBusy?'正在关闭…':'返回任务'}</button>}</div>
    {error&&<div className="preview-alert" role="alert"><AlertCircle size={17}/><span>{error}</span><button type="button" disabled={accessBusy} onClick={()=>void refreshList()}>刷新列表</button></div>}
    {!online&&<div className="preview-offline" role="status">当前离线。可以查看已加载的内容，反馈不会自动提交；恢复网络后请先刷新核对。</div>}
    {notice&&<p className="preview-notice" role="status">{notice}</p>}
    <section className="preview-controlled-build" aria-label="受控预览构建">
      <div className="preview-controlled-build-heading"><div><h3>从当前代码构建</h3><p>把当前任务的网页代码构建成可打开的预览。构建后仍需亲自试用和验收。</p></div><span>{canRegister&&connectionMode==='local'?'本机可发起':'当前设备只可查看'}</span></div>
      <details className="preview-provenance-note"><summary>首版支持范围</summary><p>支持简单 HTML、JavaScript/TypeScript、普通 CSS 和副作用式相对静态导入。暂不支持外部依赖、CSS 中的导入或资源引用、内联脚本或样式、框架、项目配置及构建脚本；不会安装依赖。</p></details>
      <p className="preview-build-scope">任务内容版本 {contentVersion===undefined?'未知':String(contentVersion)} · 修订 {Number.isSafeInteger(expectedRevision)?expectedRevision:'未知'}。{buildApiTarget==='records-v1'?'隔离记录 API 只提供保存与读回，其他业务后端未接入。':'仅静态交互，不接入业务后端。'}</p>
      {canRegister&&connectionMode==='local'&&<div className="preview-build-controls"><label>试用数据<select value={buildApiTarget} onChange={event=>{const next=event.target.value as 'static'|'records-v1';setBuildApiTarget(next);if(next==='static')setBuildDataMode('simulated');}}><option value="static">仅静态交互</option><option value="records-v1">隔离记录保存与读回</option></select></label><label>数据来源<select value={buildDataMode} onChange={event=>setBuildDataMode(event.target.value as 'simulated'|'real')}><option value="simulated">模拟数据</option>{buildApiTarget==='records-v1'&&<option value="real">隔离记录真实保存</option>}</select></label><button className="primary" type="button" disabled={!online||Boolean(buildBusy)||buildLocked||Boolean(accessBusy)||!accountScope||contentVersion===undefined||!Number.isSafeInteger(expectedRevision)} onClick={()=>void startControlledBuild()}>{buildBusy?'正在处理原请求…':'从当前代码构建'}</button></div>}
      {buildStorageError&&<p className="preview-uncertain" role="alert">{buildStorageError}</p>}
      {buildError&&<p className="preview-uncertain" role="alert">{buildError}</p>}
      {visibleBuildIntents.map(item=>{const result=buildResults[item.requestId],state=result?.state;const receipt=result&&'id'in result?result:null;return <article className="preview-build-attempt" key={item.requestId}><strong>版本 {item.contentVersion} · {state&&state in buildStateText?buildStateText[state as ControlledBuildState]:state==='checking'?'正在核对原请求':state==='not_found'?'尚未找到原请求，结果未明':'原请求结果待核对'}</strong><p>构建时任务修订 {item.expectedRevision} · 内容版本 {item.contentVersion}。{state==='ready'?(item.expectedRevision!==expectedRevision||item.contentVersion!==contentVersion?'这是原请求保存的历史版本；当前任务已变化，请重新核对，不能当作当前任务已完成或验收。':'这是原请求保存的构建版本，仍需亲自试用和验收。'):state==='failed_no_publish'?'已确认本次未发布。可检查原因后重新预览、明确发起新请求。':'不会自动重新发起构建。'}</p>{receipt?.errorCode&&<p>{buildErrorText[receipt.errorCode]||'构建失败，请核对原请求。'}</p>}{receipt?.state==='ready'&&<p>源码快照 {receipt.sourceDigest?.slice(0,12)} · 产物 {receipt.artifactDigest?.slice(0,12)}</p>}<div className="preview-access-actions"><button className="secondary" type="button" disabled={!online||Boolean(buildBusy)} onClick={()=>void inspectBuild(item)}>读取原结果</button>{!buildTerminal(state||'')&&<button className="secondary" type="button" disabled={!online||Boolean(buildBusy)||!(canRegister&&connectionMode==='local')} onClick={()=>void inspectBuild(item,true)}>核对原请求</button>}{receipt?.state==='ready'&&<button className="secondary" type="button" disabled={!online||Boolean(accessBusy)} onClick={()=>void openBuiltPreview(receipt)}>打开这个预览</button>}</div></article>;})}
    </section>
    {(recoveryRecords.length>0||recoveryError)&&<section className="preview-recovery" aria-label="反馈恢复"><h3>原反馈记录 {recoveryRecords.length>1?`（${recoveryRecords.length} 项）`:''}</h3><p>这里只保存原请求编号和来源，不保存反馈正文。核实会读取原状态；页面不会自动重新提交。</p>{recoveryError&&<p className="preview-uncertain" role="alert">{recoveryError}</p>}{recoveryRecords.map(record=><article key={record.id} className="preview-recovery-item"><strong>预览版本 {record.contentVersion} · {record.kind==='confirm'?'任务确认':'反馈草稿'}</strong>{record.conflict?<p>原反馈的持久回执互相矛盾，已锁定。请停止提交并核对任务记录。</p>:record.result==='confirmed'?<><p>修改任务已创建。处理后可返回来源预览核对新版。</p>{onOpenTask&&record.taskCreatedId&&!(draft?.status==='confirmed'&&draft.id===record.feedbackId)&&<button type="button" className="secondary" disabled={accessBusy||busy||Boolean(recoveryBusy)||!online} onClick={()=>void closePanel(()=>onOpenTask(record.taskCreatedId!))}><ExternalLink size={15}/> 查看修改任务</button>}</>:record.result==='created_unavailable'?<p>曾创建关联任务，但任务现在不可见；不能再创建一次。</p>:record.result==='not_applied'?<p>已核实原请求未执行，原编号不会再使用。</p>:<p>原请求结果待核实。暂时查不到也不能当作未执行。</p>}<div className="preview-access-actions">{!record.result&&!record.conflict&&<><button type="button" className="secondary" disabled={!online||Boolean(recoveryBusy)} onClick={()=>void verifyRecovery(record)}>核实这次反馈</button><button type="button" className="secondary" disabled={!online||Boolean(recoveryBusy)} onClick={()=>void verifyRecovery(record,true)}>正式核对结果</button>{record.kind==='draft'&&record.feedbackId&&verifiedDraftIds.includes(record.id)&&<button type="button" className="primary" disabled={!online||Boolean(recoveryBusy)} onClick={()=>void confirmRecoveredDraft(record)}>确认这份原草稿</button>}</>}{record.result==='not_applied'&&<button type="button" className="secondary" onClick={()=>{setAllowNewAfterFence(true);setDraft(null);setUncertain(false);setUncertainFeedback(null);uncertainFeedbackRef.current=null;}}>重新填写新反馈</button>}</div></article>)}</section>}
    {canRegister&&<details className="preview-register"><summary>登记本机构建（owner）</summary><p>登记已生成的 Vite 产物，不执行构建脚本。动态 records-v1 仅支持本项目隔离记录的保存与读回；不代理任意后端。</p><form onSubmit={registerBuild}><label>静态构建目录<input value={distDir} onChange={event=>setDistDir(event.target.value)} placeholder="项目中的 dist 目录绝对路径" required/></label><label>运行环境<input value={environment} onChange={event=>setEnvironment(event.target.value)} maxLength={80} required/></label><label>数据说明<select value={dataMode} onChange={event=>setDataMode(event.target.value as 'real'|'simulated')}><option value="simulated">模拟数据</option><option value="real">真实数据（由登记者声明）</option></select></label><label>后端能力<select value={apiTarget} onChange={event=>setApiTarget(event.target.value as 'static'|'records-v1')}><option value="static">仅静态交互</option><option value="records-v1">项目隔离记录 API（保存/读回）</option></select></label><p>当前任务内容版本：{contentVersion===undefined?'未知':String(contentVersion)}。不具备版本时不能登记。</p><button className="secondary" disabled={registering||accessBusy||contentVersion===undefined||!distDir.trim()||!environment.trim()}>{registering?'正在登记…':'登记静态构建'}</button></form></details>}
    {loading?<div className="preview-empty">正在读取预览版本…</div>:!previews.length?<div className="preview-empty"><h3>还没有可试用的版本</h3><p>开发者发布静态构建后，这里会列出对应任务的预览。</p><button className="secondary" type="button" disabled={accessBusy} onClick={()=>void refreshList()}><RefreshCw size={15}/> 刷新</button></div>:<>
      <div className="preview-toolbar"><label>预览版本<select value={selectedId} disabled={busy||accessBusy} onChange={event=>void replaceAccess(event.target.value)}>{previews.map(item=><option key={item.previewId} value={item.previewId}>版本 {item.contentVersion} · {formatDate(item.createdAt)}</option>)}</select></label><div className="preview-width" role="group" aria-label="预览宽度"><button type="button" aria-pressed={width==='desktop'} onClick={()=>setWidth('desktop')}><Monitor size={16}/> 宽屏</button><button type="button" aria-pressed={width==='phone'} onClick={()=>setWidth('phone')}><Smartphone size={16}/> 手机</button></div><button className="secondary" type="button" disabled={accessBusy||busy} onClick={()=>void replaceAccess()}><RefreshCw size={15}/> {accessPhase==='transport_unavailable'?'重新连接预览':'重新获取预览链接'}</button></div>
      <div className="preview-access"><p>{accessPhase==='transport'?'正在核对本机预览连接，确认前不会申请链接。':accessPhase==='transport_unavailable'?'本机预览连接尚未确认；没有申请链接，可在连接恢复后重试。':accessPhase==='registering'?'正在登记访问；返回或切换版本会取消后续链接申请。':accessPhase==='issuing'?'正在获取链接；现在仍可关闭本次访问。':accessPhase==='unknown'?'访问结果待核实；不会自动重复申请链接。':'关闭本次访问会让当前链接失效，已下载的页面内容无法收回。'}</p><div className="preview-access-actions">{accessIntent&&<button className="secondary" type="button" disabled={accessBusy||!online} onClick={()=>void verifyCurrentAccess()}>核对本次访问</button>}<button className="secondary" type="button" disabled={accessBusy||(!accessIntent&&accessPhase!=='registering')||!online} onClick={()=>void revokeCurrentAccess()}>{accessBusy?'正在关闭访问…':'关闭本次预览访问'}</button></div></div>
      {detail?.expiresAt&&<p className="preview-provenance-note">本次预览链接有效至 {formatDate(detail.expiresAt)}。页面打不开或链接过期时，请手动重新获取。</p>}
      {selected&&<><div className="preview-provenance"><span><strong>{selected.provenance?'构建时内容版本':'内容版本'}</strong>{selected.contentVersion}</span>{selected.provenance&&<span><strong>构建时任务修订</strong>{selected.sourceTaskRevision??'未提供'}</span>}<span><strong>运行环境</strong>{selected.environment}</span><span><strong>数据声明</strong>{selected.dataMode==='simulated'?'模拟数据':'真实数据（未独立核验）'}</span><span><strong>运行产物哈希</strong>{selected.artifactDigest?.slice(0,12)||'未提供'}</span><span><strong>{selected.provenance?'源码快照基准提交':'登记时源码'}</strong>{selected.sourceCommit?.slice(0,12)||'未提供'}{!selected.provenance&&selected.dirty?' · 含未提交改动':''}</span></div>{selected.provenance?<details className="preview-provenance-note"><summary>查看构建来源与版本记录</summary><p>源码快照 {selected.provenance.sourceDigest.slice(0,12)} · 输入 {selected.provenance.inputDigest.slice(0,12)} · 构建 {selected.provenance.buildReceiptDigest.slice(0,12)} · 工具 {selected.provenance.toolDigest.slice(0,12)} · 配置 {selected.provenance.profileDigest.slice(0,12)}。这里不单独推断未提交改动范围；业务后端仍须另验。</p></details>:<p className="preview-provenance-note">运行产物哈希标识当前提供的文件；构建来源与登记时源码是否一致，尚未核验。</p>}</>}
      {selected?.provenance&&(selected.sourceTaskRevision!==expectedRevision||selected.contentVersion!==contentVersion)&&<p className="preview-provenance-note">这是历史任务修订的预览。请重新核对当前任务内容；此版本不能代表当前任务已完成或已验收。</p>}
      {selected?.dataMode==='simulated'&&<div className="preview-warning"><ShieldAlert size={17}/> 当前是模拟数据。按钮和表单可用于体验界面，但不能据此认定真实业务数据已更新。</div>}
      <div className="preview-warning"><ShieldAlert size={17}/> {selected?.apiTarget==='records-v1'?'此版本仅接入隔离 records-v1 保存与读回；短信、支付、登录和其他后端仍未接通。':'此预览未接入后端服务。短信、支付、登录及真实数据写入需要另行验证。'}</div>
      {detail&&launchUrl?<div className={`preview-stage preview-stage-${width}`}><iframe ref={frameRef} key={`${selectedId}:${launchNonce}`} title={`任务预览 · 版本 ${selected?.contentVersion}`} src={selected?.apiTarget==='records-v1'&&launchNonce?`${launchUrl}#seqivo=${encodeURIComponent(launchNonce)}&previewId=${encodeURIComponent(selected.previewId)}&dataStoreId=${encodeURIComponent(selected.dataStoreId||'')}&projectId=${encodeURIComponent(projectId)}`:launchUrl} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" loading="lazy"/></div>:<div className="preview-empty">{accessPhase==='transport'?'正在核对本机预览连接…':accessPhase==='transport_unavailable'?'本机预览连接暂不可用。请检查连接后重试；尚未申请预览链接。':accessPhase==='registering'?'正在登记本次访问…':accessPhase==='issuing'?'正在获取预览链接…':accessPhase==='unknown'?'本次链接尚未确认，请核实或关闭后重新获取。':'本次预览访问已关闭。可明确重新获取链接。'}</div>}
      {selected&&<PreviewRetestSection currentPreviewId={selected.previewId} previousPreviewId={previousPreview?.previewId||null}
        projectId={projectId} taskId={taskId} contentVersion={selected.contentVersion}
        currentSourceDigest={selected.provenance?.sourceDigest||null} criteria={criteria} accountScope={accountScope}
        mode={connectionMode} canEdit={canRegister&&connectionMode==='local'&&Boolean(selected.provenance)} online={online}/>}
      {recordAttempts.length>0&&<section className="preview-recovery" aria-label="动态记录恢复"><h3>动态保存记录</h3><p>原保存编号在看板中持久保留；结果未知时不会重新发送写入。</p>{recordAttempts.map(item=><article key={item.intentId} className="preview-recovery-item"><strong>版本 {item.contentVersion} · 保存 {item.result==='confirmed'?'已确认':item.result==='not_applied'?'已证实未执行':'结果待核实'}</strong>{!item.result&&<div className="preview-access-actions"><button type="button" className="secondary" disabled={Boolean(recordBusy)||!online} onClick={()=>void verifyRecordAttempt(item)}>读取原结果</button><button type="button" className="secondary" disabled={Boolean(recordBusy)||!online} onClick={()=>void verifyRecordAttempt(item,true)}>明确核实原结果</button></div>}</article>)}</section>}
      {recordError&&<p className="preview-uncertain" role="alert">{recordError}</p>}
      <section className="preview-feedback"><h3>记录试用反馈</h3><p>先保存草稿，再明确确认生成关联任务。页面路径由你填写；预览不会读取页面内容或自动发送反馈。</p>
        {!draft?<form onSubmit={createDraft}><label>当前页面路径<input value={pagePath} onChange={event=>setPagePath(event.target.value)} maxLength={400} placeholder="index.html"/></label><label>遇到的问题或改进建议<textarea value={summary} onChange={event=>setSummary(event.target.value)} maxLength={4000} rows={4} required/></label>{criteria.length>0&&<fieldset><legend>关联验收项（可选）</legend>{criteria.map(item=><label key={item.id}><input type="checkbox" checked={criterionIds.includes(item.id)} onChange={()=>setCriterionIds(current=>current.includes(item.id)?current.filter(id=>id!==item.id):[...current,item.id])}/>{item.text}</label>)}</fieldset>}<button className="primary" disabled={!online||busy||accessBusy||feedbackLocked||!detail||!summary.trim()}>保存反馈草稿</button></form>:<div className="preview-draft"><strong>{draft.status==='confirmed'?'已确认并创建任务':'反馈草稿待确认'}</strong><p>页面：{draft.pagePath||pagePath}</p><p>{draft.summary||summary}</p>{draft.status==='draft'?<button className="primary" type="button" disabled={!online||busy||accessBusy||uncertain||Boolean(recoveryError)||!accountScope||Boolean(recoveryBusy)} onClick={()=>void confirmDraft()}><Check size={16}/> 确认并创建关联任务</button>:draft.taskId?<div className="preview-linked">{onOpenTask?<button className="primary" type="button" disabled={accessBusy||busy||Boolean(recoveryBusy)||!online} onClick={()=>void closePanel(()=>onOpenTask(draft.taskId!))}><ExternalLink size={15}/> 查看修改任务</button>:<span>关联任务：{draft.taskId}</span>}</div>:null}</div>}
        {uncertain&&<p className="preview-uncertain">本次提交结果无法确认（预览版本 {uncertainFeedback?.contentVersion??'未知'}，{uncertainFeedback?.kind==='confirm'?'确认关联任务':'保存草稿'}）。请到任务列表核对是否已生成关联任务；刷新预览不会解除本次锁定，页面不会自动补交。</p>}
      </section>
    </>}
  </section>;
}
