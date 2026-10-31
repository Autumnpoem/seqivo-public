import {ApiError,request} from './api';
import type {ControlPhase,ControlState,ControlTarget,ReturnReview,SessionRef,TerminalCallbacks,TerminalSession,TerminalTicket,UnknownExecution} from './terminal-types';

function bytesFromBase64(value:string):Uint8Array {const raw=atob(value);return Uint8Array.from(raw,char=>char.charCodeAt(0));}
function base64FromBytes(value:Uint8Array):string {let result='';for(const byte of value)result+=String.fromCharCode(byte);return btoa(result);}
function sameRef(a:SessionRef|null,b:SessionRef|null){return JSON.stringify(a)===JSON.stringify(b);}
function validRef(value:unknown):value is SessionRef {return !!value&&typeof value==='object'&&['serverName','instanceId','sessionId'].every(key=>typeof (value as Record<string,unknown>)[key]==='string');}
function validSessionRefs(refs:SessionRef[]){return Array.isArray(refs)&&refs.length>=1&&refs.length<=16&&refs.every(ref=>validRef(ref)&&ref.serverName===refs[0].serverName)&&new Set(refs.map(ref=>JSON.stringify(ref))).size===refs.length;}
function validUnknownExecutions(value:unknown):value is UnknownExecution[]{
  if(!Array.isArray(value)||value.length<1||value.length>16)return false;
  const seen=new Set<string>();
  for(const item of value){
    if(!item||typeof item!=='object')return false;
    const row=item as Record<string,unknown>;
    if(Object.keys(row).some(key=>key!=='taskId'&&key!=='commandId')||typeof row.taskId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(row.taskId)||
      typeof row.commandId!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/.test(row.commandId))return false;
    const key=JSON.stringify([row.taskId,row.commandId]);if(seen.has(key))return false;seen.add(key);
  }
  return true;
}
function normalizeUnknownExecutions(value:unknown):UnknownExecution[]{
  if(!Array.isArray(value)||value.length>16)return [];
  const rows:UnknownExecution[]=[];
  for(const item of value){
    if(!item||typeof item!=='object')return [];
    const row=item as Record<string,unknown>;
    if(typeof row.taskId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(row.taskId)||
      typeof row.commandId!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/.test(row.commandId))return [];
    rows.push({taskId:row.taskId,commandId:row.commandId});
  }
  return new Set(rows.map(row=>JSON.stringify(row))).size===rows.length?rows:[];
}
const reviewPath=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=240&&
  (value==='.'||!value.startsWith('/')&&!value.includes('\\')&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'))&&!/[\x00-\x1f\x7f]/.test(value);
function checkedReturnReview(value:unknown,generation:number|null):ReturnReview|null{
  if(!value||typeof value!=='object')return null;
  const review=value as Record<string,unknown>,directories=review.workspaceRelativeDirectories,changes=review.changes;
  if(!/^[a-f0-9]{64}$/.test(String(review.reviewId))||!Number.isSafeInteger(review.expiresAt)||Number(review.expiresAt)<=0||
    !Number.isSafeInteger(review.generation)||review.generation!==generation||!Array.isArray(directories)||directories.length>16||
    !directories.every(item=>item&&typeof item==='object'&&validRef(item.sessionRef)&&
      /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(item.sessionRef.serverName)&&/^[a-f0-9]{64}$/.test(item.sessionRef.instanceId)&&/^\$(0|[1-9]\d*)$/.test(item.sessionRef.sessionId)&&reviewPath(item.path))||
    new Set(directories.map(item=>JSON.stringify(item.sessionRef))).size!==directories.length||
    !Array.isArray(changes)||changes.length>80||!changes.every(item=>item&&typeof item==='object'&&reviewPath(item.path)&&['added','modified','deleted'].includes(item.kind))||
    !['git-tracked-and-nonignored-untracked','directory-tree-excluding-git-metadata'].includes(String(review.snapshotScope))||
    !Number.isSafeInteger(review.totalChanges)||Number(review.totalChanges)<changes.length||Number(review.totalChanges)>40000||
    !Number.isSafeInteger(review.omittedChanges)||Number(review.omittedChanges)!==Number(review.totalChanges)-changes.length||
    !Number.isSafeInteger(review.parkedManagedSessions)||Number(review.parkedManagedSessions)<0||Number(review.parkedManagedSessions)>16||
    review.unownedWorkspaceWriters!==0||typeof review.notes!=='string'||review.notes.length>2000)return null;
  return review as unknown as ReturnReview;
}
function urlForTicket(ticket:TerminalTicket){const url=new URL(ticket.wsUrl||'/api/terminal/ws',window.location.href);if(url.protocol==='https:')url.protocol='wss:';else if(url.protocol==='http:')url.protocol='ws:';if(!['ws:','wss:'].includes(url.protocol))throw new Error('终端连接地址无效。');return url.href;}
const MAX_RESUME_ATTEMPTS=7;
const MAX_FRESH_RECOVERY_ATTEMPTS=3;
const MAX_INPUT_IN_FLIGHT=8;
const MAX_PENDING_INPUT_BYTES=64*1024;
const MAX_INPUT_FRAME_BYTES=16*1024;
// These errors invalidate the current writable attachment or its process
// evidence. A list/default conflict does not have that meaning.
const INPUT_AUTHORITY_ERRORS=new Set(['PROCESS_PROOF_UNAVAILABLE','MANAGED_PANE_UNKNOWN','TERMINAL_PLUGIN_UNKNOWN',
  'EXECUTION_BINDING_CHANGED','EXECUTION_BUSY','GRANT_REQUIRED','PROFILE_DISABLED']);
function transportFailure(error:unknown){return error instanceof TypeError&&/^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed)$/i.test(error.message);}

/** Input is buffered only inside one live attachment and is never replayed after a boundary change. */
export class TerminalClient {
  private ws:WebSocket|null=null;
  private state:'idle'|'connecting'|'authenticating'|'opening'|'ready'|'selecting'|'redrawing'|'output_gap'|'control_wait'='idle';
  private epoch=0;
  private nextOffset:number|null=null;
  private seq=0;
  private unacked=new Set<number>();
  private pendingInput:Array<{bytes:Uint8Array;context:string}>=[];
  private pendingInputBytes=0;
  private inputFlowRevision=0;
  private connectionId:string|null=null;
  private current:SessionRef|null=null;
  private generation=0;
  private intentional=false;
  private reconnectTimer:number|undefined;
  private reconnectCount=0;
  private resumeTransportFailures=0;
  private reachableWakeEligible=false;
  private reachableWakeUsed=false;
  private recoveryCycleId=0;
  private freshRecoveryCount=0;
  private freshRecoveryAttempted=false;
  private freshRecoveryRef:SessionRef|null=null;
  private controlPhase:ControlPhase;
  private controlOwned:boolean;
  private controlManaged=false;
  private pendingOpenAfterTakeover=false;
  private controlMode:'managed'|'existing'|null=null;
  private controlGeneration:number|null=null;
  private transferFence=false;
  private pendingTargetsRequest:string|null=null;
  private pendingTransferRequest:string|null=null;
  private pendingTransferAction:{type:'transfer-control'|'accept-control'|'cancel-transfer';requestId:string;transferId?:string}|null=null;
  private activeTransferId:string|null=null;
  private offerTransferId:string|null=null;
  private acceptedTransferId:string|null=null;
  private offerBaseGeneration:number|null=null;
  private requiresTransferSelection=false;
  private pendingTransferRecoveryGeneration:number|null=null;
  private pendingReconcile:{requestId:string;action:'acquire'|'release';sessionRef:SessionRef|null}|null=null;
  private pendingReturn:{stage:'preparing'|'review'|'confirming'|'canceling';connectionId:string;socketGeneration:number;controlGeneration:number;review:ReturnReview|null}|null=null;
  private returnFence=false;
  private returnFenceGeneration:number|null=null;
  private suppressOldDefaultError=false;
  private authorizedSessionRefs:SessionRef[]=[];
  private unresolvedExecutions:UnknownExecution[]=[];
  private pendingSessionRef:SessionRef|null=null;
  private pendingDetach:{requestId:string;resolve:(confirmed:boolean)=>void;timer:number;promise:Promise<boolean>}|null=null;
  private pendingDefault:{requestId:string;sessionRef:SessionRef;expectedRevision:number;timer:number}|null=null;
  private defaultRevision=0;
  private readonly encoder=new TextEncoder();
  constructor(private readonly target:{nodeId?:string;profileId:string;mode:'tmux'|'shell';readOnly:boolean;ticketControl:boolean;inputAllowed:boolean;takeoverAllowed:boolean;projectId?:string|null},private readonly cb:TerminalCallbacks,private readonly size:()=>{cols:number;rows:number}){this.controlPhase=target.projectId===null?'unmanaged':'unknown';this.controlOwned=target.projectId===null;}
  get isReady(){return !this.pendingDetach&&this.state==='ready'}
  get recoveryCycle(){return this.recoveryCycleId}
  get canInput(){return !this.pendingDetach&&!this.pendingReconcile&&!this.pendingReturn&&!this.returnFence&&!this.transferFence&&!this.requiresTransferSelection&&this.state==='ready'&&!this.target.readOnly&&this.target.inputAllowed&&this.controlOwned&&['human','unmanaged'].includes(this.controlPhase)&&(this.controlPhase==='unmanaged'||this.controlMode==='managed'||this.controlMode==='existing'&&!!this.current&&this.authorizedSessionRefs.some(ref=>sameRef(ref,this.current)))&&this.ws?.readyState===WebSocket.OPEN}
  get canConfirmReturn(){const pending=this.pendingReturn;return !!pending&&pending.stage==='review'&&!!pending.review&&pending.review.expiresAt>Date.now()&&
    pending.connectionId===this.connectionId&&pending.socketGeneration===this.generation&&pending.controlGeneration===this.controlGeneration&&
    this.controlPhase==='return_review'&&!this.target.readOnly&&this.target.inputAllowed&&this.target.takeoverAllowed&&this.ws?.readyState===WebSocket.OPEN}
  get canCancelReturn(){const pending=this.pendingReturn;return !!pending&&pending.stage==='review'&&!!pending.review&&
    pending.connectionId===this.connectionId&&pending.socketGeneration===this.generation&&pending.controlGeneration===this.controlGeneration&&
    this.controlPhase==='return_review'&&this.ws?.readyState===WebSocket.OPEN}
  get canTransfer(){return !this.pendingDetach&&!this.returnFence&&!this.transferFence&&this.state==='ready'&&this.target.mode==='tmux'&&!this.target.readOnly&&this.target.inputAllowed&&this.target.takeoverAllowed&&this.controlPhase==='human'&&this.controlOwned&&this.controlGeneration!==null&&this.ws?.readyState===WebSocket.OPEN}
  get isTransferLocked(){return this.transferFence}
  get currentRef(){return this.current}
  get inputContext(){return this.canInput?{connectionId:this.connectionId,epoch:this.epoch,sessionRef:this.current,generation:this.generation,
    controlGeneration:this.controlGeneration,inputFlowRevision:this.inputFlowRevision}:null}
  matchesInputContext(context:NonNullable<TerminalClient['inputContext']>){const current=this.inputContext;return !!current&&current.connectionId===context.connectionId&&current.epoch===context.epoch&&current.generation===context.generation&&
    current.controlGeneration===context.controlGeneration&&current.inputFlowRevision===context.inputFlowRevision&&sameRef(current.sessionRef,context.sessionRef)}
  private emit(state:Parameters<TerminalCallbacks['onState']>[0],message?:string){this.cb.onState(state,message)}
  private send(frame:Record<string,unknown>){if(this.ws?.readyState!==WebSocket.OPEN||this.pendingDetach&&frame.type!=='detach')return false;this.ws.send(JSON.stringify({v:1,...frame}));return true;}
  private inputFlowContext(){return JSON.stringify([this.generation,this.connectionId,this.epoch,this.controlGeneration,
    this.controlPhase,this.controlOwned,this.controlMode,this.transferFence,this.returnFence,this.inputFlowRevision,this.current,this.authorizedSessionRefs]);}
  private discardInputFlow(reason:string,clearSent=true){
    const unsent=this.pendingInputBytes>0,unconfirmed=clearSent&&this.unacked.size>0;
    this.pendingInput=[];this.pendingInputBytes=0;this.inputFlowRevision++;
    if(clearSent)this.unacked.clear();
    if(unsent||unconfirmed)this.cb.onNotice(`${reason}${unsent?' 未发送的输入已丢弃。':''}${unconfirmed?' 已发送但未确认的输入不会重发，请核对终端内容。':''}`);
  }
  private flushInput(){
    while(this.pendingInput.length&&this.unacked.size<MAX_INPUT_IN_FLIGHT){
      const next=this.pendingInput[0];
      if(!this.canInput||next.context!==this.inputFlowContext()){
        this.discardInputFlow('终端控制权或连接已变化。');return;
      }
      const seq=this.seq+1;
      if(!this.send({type:'input',epoch:this.epoch,seq,data:base64FromBytes(next.bytes)})){
        this.discardInputFlow('终端连接已中断。',false);return;
      }
      this.seq=seq;this.unacked.add(seq);
      this.pendingInput.shift();this.pendingInputBytes-=next.bytes.length;
    }
  }
  private lock(){this.state='idle';}
  private clearPendingDefault(){if(this.pendingDefault)window.clearTimeout(this.pendingDefault.timer);this.pendingDefault=null;}
  private retryAfterTransportFailure(recoverSessionRef:SessionRef|null=null){
    if(this.intentional||this.pendingDetach||this.transferFence||this.pendingReconcile||this.pendingTransferAction||
      (recoverSessionRef?this.freshRecoveryCount>=MAX_FRESH_RECOVERY_ATTEMPTS:this.reconnectCount>=MAX_RESUME_ATTEMPTS))return false;
    this.lock();
    const attempts=recoverSessionRef?this.freshRecoveryCount:this.reconnectCount;
    const delay=Math.min(10000,1500*2**attempts);
    this.reconnectTimer=window.setTimeout(()=>void this.connect(!recoverSessionRef,recoverSessionRef),delay);
    this.emit('disconnected','网络暂时不可用，恢复后会继续核对当前会话；输入不会重发。');
    return true;
  }
  private clearReachableWake(){this.resumeTransportFailures=0;this.reachableWakeEligible=false;}
  invalidateReachableWake(cycle:number){if(cycle!==this.recoveryCycleId)return;this.clearReachableWake();this.reachableWakeUsed=true;}
  /** A successful status request from a new foreground/online wake may spend one
   * extra old-connection check after seven proven ticket transport failures. */
  resumeAfterReachable(cycle:number){
    const safeControl=this.target.readOnly||this.controlPhase==='human'&&this.controlOwned||this.controlPhase==='unmanaged';
    if(cycle!==this.recoveryCycleId||!this.reachableWakeEligible||this.reachableWakeUsed||this.intentional||this.pendingDetach||
      this.state!=='idle'||!this.connectionId||this.target.mode!=='tmux'||!validRef(this.current)||
      !safeControl||this.transferFence||this.pendingReconcile||this.pendingTransferAction||
      this.requiresTransferSelection||this.pendingSessionRef||this.freshRecoveryAttempted||this.freshRecoveryRef)return false;
    // Consume before the first await in connect(). Parallel wake events cannot
    // grant another ticket, even if this request fails immediately.
    this.reachableWakeEligible=false;this.reachableWakeUsed=true;
    void this.connect(true,null,true);
    return true;
  }
  private recoverExpiredResume(){
    const ref=this.current;
    const safeControl=this.target.readOnly||this.controlPhase==='human'&&this.controlOwned||this.controlPhase==='unmanaged';
    if(this.freshRecoveryAttempted||this.target.mode!=='tmux'||!validRef(ref)||!safeControl||this.transferFence||this.pendingReconcile||this.pendingTransferAction||this.pendingDetach)return false;
    this.clearReachableWake();this.freshRecoveryAttempted=true;this.freshRecoveryCount=0;this.freshRecoveryRef=ref;this.connectionId=null;this.current=null;this.pendingSessionRef=ref;
    this.discardInputFlow('原连接恢复窗口已过。');this.epoch=0;this.seq=0;this.nextOffset=null;this.controlOwned=false;
    this.cb.onReady(null,0);this.emit('disconnected','原连接已过恢复窗口；正在用新连接核对原会话，不会切到默认会话或重发输入。');
    void this.connect(false,ref);return true;
  }
  private failExpiredResume(){
    this.connectionId=null;this.controlOwned=false;this.cb.onReady(null,0);this.lock();
    this.emit('error',this.target.mode==='shell'?'原普通 Shell 连接已过恢复窗口，进程状态待核对。请手动重新连接；不会自动启动新 Shell 或重发输入。':'原连接已过恢复窗口，无法自动核对原会话。请手动连接并明确选择存活会话；不会改默认或重发输入。');
  }
  async connect(resume=false,recoverSessionRef:SessionRef|null=null,reachableWake=false){
    if(this.pendingDetach)await this.pendingDetach.promise;
    if(recoverSessionRef){
      if(!this.freshRecoveryAttempted||!sameRef(this.freshRecoveryRef,recoverSessionRef)||this.freshRecoveryCount>=MAX_FRESH_RECOVERY_ATTEMPTS)return;
      this.freshRecoveryCount++;
    }else if(resume){
      if(this.reconnectCount>=MAX_RESUME_ATTEMPTS+(reachableWake&&this.reachableWakeUsed?1:0))return;
      this.reconnectCount++;
    }
    this.stopSocket(false);
    const generation=++this.generation;
    this.intentional=false;
    this.state='connecting';this.emit('connecting');
    this.cb.onControl({phase:this.controlPhase,owned:false});
    try {
      const body=this.target.nodeId?{nodeId:this.target.nodeId,profileId:this.target.profileId,scope:this.target.ticketControl?'control':'view',...(resume&&this.connectionId?{resumeConnectionId:this.connectionId}:{})}:{profileId:this.target.profileId,mode:this.target.mode,...(resume&&this.connectionId?{resumeConnectionId:this.connectionId}:{})};
      const ticket=await request<TerminalTicket>('POST','/api/terminal/tickets',body);
      if(generation!==this.generation)return;
      if(resume)this.clearReachableWake();
      if(!resume)this.connectionId=null;
      const ws=new WebSocket(urlForTicket(ticket));this.ws=ws;this.connectionId=ticket.connectionId;
      ws.onopen=()=>{if(generation!==this.generation)return;this.state='authenticating';this.emit('authenticating');this.send({type:'auth',ticket:ticket.ticket});};
      ws.onmessage=event=>{if(generation===this.generation)this.receive(event.data,resume,recoverSessionRef);};
      ws.onerror=()=>{if(generation===this.generation&&!this.pendingDetach&&!this.intentional){this.stopSocket(false);this.lost(1006,recoverSessionRef);}};
      ws.onclose=event=>{if(generation===this.generation){if(this.pendingDetach)this.finishDisconnect(false);else this.lost(event.code,recoverSessionRef);}};
    }catch(error){
      if(generation!==this.generation)return;
      if(resume&&error instanceof ApiError&&error.code==='RESUME_UNAVAILABLE'){
        if(this.recoverExpiredResume())return;
        this.failExpiredResume();return;
      }
      if(recoverSessionRef){
        if(transportFailure(error)&&sameRef(this.freshRecoveryRef,recoverSessionRef)&&this.retryAfterTransportFailure(recoverSessionRef))return;
        this.freshRecoveryRef=null;
        this.connectionId=null;this.pendingSessionRef=null;this.controlOwned=false;this.cb.onReady(null,0);
        this.lock();this.emit('error',transportFailure(error)?'网络恢复仍未完成。请手动连接并明确选择存活会话；不会自动重试或重发输入。':error instanceof ApiError&&error.code==='RESUME_UNAVAILABLE'?'新连接仍无法核对原会话。请手动连接并明确选择存活会话；不会自动重试或重发输入。':error instanceof Error?error.message:'原会话恢复失败，请手动核对。');return;
      }
      this.lock();
      if(resume&&transportFailure(error)){
        this.resumeTransportFailures++;
        if(this.retryAfterTransportFailure())return;
        if(!this.reachableWakeUsed&&this.reconnectCount===MAX_RESUME_ATTEMPTS&&
          this.resumeTransportFailures===MAX_RESUME_ATTEMPTS)this.reachableWakeEligible=true;
      }else this.clearReachableWake();
      this.lock();
      this.emit('error',transportFailure(error)?'网络恢复仍未完成。请手动连接并明确选择存活会话；不会自动重试或重发输入。':error instanceof Error?error.message:'无法连接终端。');
    }
  }
  private receive(raw:unknown,resume=false,recoverSessionRef:SessionRef|null=null){
    // stopSocket(true) retires the attachment; callbacks from its old socket
    // must never restore ready/input after a proof failure.
    if(this.intentional&&this.ws===null)return;
    if(typeof raw!=='string'||raw.length>65536)return;
    let frame:Record<string,unknown>;
    try{frame=JSON.parse(raw) as Record<string,unknown>}catch{return;}
    if(frame.v!==1||typeof frame.type!=='string')return;
    // A detach is terminal for this attachment. Ignore every late frame until
    // the exact request's acknowledgement arrives on this socket.
    if(this.pendingDetach){
      if(frame.type==='exit'&&frame.reason==='detached'&&frame.requestId===this.pendingDetach.requestId)this.finishDisconnect(true);
      return;
    }
    if(frame.type==='control'){
      if(!['ai_ready','stopping','human','return_check','return_review','transfer_pending','unknown'].includes(String(frame.phase)))return;
      const phase=frame.phase as ControlPhase;
      const completedReconcile=this.pendingReconcile&&frame.requestId===this.pendingReconcile.requestId?this.pendingReconcile:null;
      // The manager may send an uncorrelated progress snapshot, and a previous
      // open may finish late. Neither is proof that this recovery succeeded.
      if(this.pendingReconcile&&!completedReconcile&&!(this.pendingReturn&&phase==='unknown'))return;
      const controlGeneration=Number.isSafeInteger(frame.generation)&&Number(frame.generation)>=0?Number(frame.generation):null;
      if(this.controlGeneration!==null&&controlGeneration!==null&&controlGeneration<this.controlGeneration)return;
      let returnReview:ReturnReview|null=null;
      const pendingReturn=this.pendingReturn;
      let confirmedReturn=false;
      if(pendingReturn){
        if(pendingReturn.connectionId!==this.connectionId||pendingReturn.socketGeneration!==this.generation||controlGeneration===null||controlGeneration<pendingReturn.controlGeneration)return;
        if(phase==='return_review'){
          const ownerRecovery=completedReconcile?.action==='release'&&controlGeneration===pendingReturn.controlGeneration+1;
          if(pendingReturn.stage!=='preparing'||controlGeneration!==pendingReturn.controlGeneration&&!ownerRecovery||frame.managed!==true||frame.owned!==true)return;
          returnReview=checkedReturnReview(frame.returnReview,controlGeneration);
          if(!returnReview){this.pendingReturn=null;this.controlPhase='unknown';this.controlOwned=false;
            this.cb.onControl({phase:'unknown',owned:false,returnReview:null,reason:'交还核对内容无法确认。请重新核对现场。'});
            this.emit('control_wait','交还核对内容无效，不能确认交还。');return;}
          pendingReturn.stage='review';pendingReturn.review=returnReview;pendingReturn.controlGeneration=controlGeneration;
          this.returnFenceGeneration=controlGeneration;
        }else if(phase==='unknown'){this.pendingReturn=null;if(this.pendingReconcile?.action==='release')this.pendingReconcile=null;}
        else if(pendingReturn.stage==='preparing'&&phase==='return_check'||pendingReturn.stage==='confirming'&&phase==='return_check'){}
        else if(pendingReturn.stage==='confirming'&&phase==='ai_ready'&&frame.managed===true&&frame.owned===false&&controlGeneration===pendingReturn.controlGeneration){this.pendingReturn=null;confirmedReturn=true;}
        else return; // Old human/review frames cannot restore input or replace a pending confirmation.
      }else if(phase==='return_review'){
        this.controlPhase='unknown';this.controlOwned=false;
        this.cb.onControl({phase:'unknown',owned:false,returnReview:null,reason:'交还审查连接已变化，请正式核对现场。'});return;
      }
      const mode=frame.mode==='existing'||frame.mode==='managed'?frame.mode:null;
      const authorizedSessionRefs=Array.isArray(frame.authorizedSessionRefs)?frame.authorizedSessionRefs.filter(validRef).slice(0,16):[];
      const unresolvedExecutions=normalizeUnknownExecutions(frame.unresolvedExecutions);
      const control:ControlState={phase:frame.managed===false?'unmanaged':phase,managed:frame.managed!==false,owned:frame.owned===true,generation:controlGeneration,mode,authorizedSessionRefs,
        requiresSessionSelection:frame.requiresSessionSelection===false?false:true,
        canReconcileAcquire:frame.managed!==false&&['unknown','human'].includes(phase)&&frame.canReconcileAcquire===true,returnReview,unresolvedExecutions};
      if(this.transferFence&&phase==='human'&&control.owned&&!this.acceptedTransferId&&this.pendingTransferRecoveryGeneration===null)return;
      // This is an authoritative snapshot, including an absent/cleared reason.
      // Locally synthesized partial callbacks intentionally omit this field.
      control.reason=typeof frame.reason==='string'?frame.reason:'';
      if(['git-tracked-and-nonignored-untracked','directory-tree-excluding-git-metadata','legacy-unspecified'].includes(String(frame.snapshotScope)))control.snapshotScope=frame.snapshotScope as ControlState['snapshotScope'];
      if(Array.isArray(frame.changes))control.changes=frame.changes.filter((item):item is {path:string;kind:string}=>!!item&&typeof item==='object'&&typeof item.path==='string'&&typeof item.kind==='string').slice(0,100);
      const previousInputContext=this.inputFlowContext();
      if(confirmedReturn){this.returnFence=false;this.returnFenceGeneration=null;}
      if(this.returnFence&&phase==='human'&&control.owned&&controlGeneration!==null&&
        (this.returnFenceGeneration===null||controlGeneration>this.returnFenceGeneration)&&
        (completedReconcile?.action==='acquire'||this.pendingOpenAfterTakeover)){
        this.returnFence=false;this.returnFenceGeneration=null;
      }
      this.controlGeneration=controlGeneration;this.controlPhase=control.phase;this.controlOwned=control.owned===true;this.controlManaged=control.managed===true;this.controlMode=mode;this.authorizedSessionRefs=authorizedSessionRefs;this.unresolvedExecutions=unresolvedExecutions;
      if(previousInputContext!==this.inputFlowContext())this.discardInputFlow('终端控制权已变化。');
      if(this.freshRecoveryRef&&control.managed&&!this.target.readOnly&&(control.phase!=='human'||!control.owned||mode==='existing'&&!authorizedSessionRefs.some(ref=>sameRef(ref,this.freshRecoveryRef)))){
        this.cb.onControl(control);this.stopSocket(true);this.connectionId=null;this.current=null;this.pendingSessionRef=null;this.cb.onReady(null,0);
        this.emit('control_wait','原会话的控制权已变化。请重新核对授权；不会自动接入默认会话。');return;
      }
      // A transferred writer is never restored by an old ready/control frame.
      if(this.acceptedTransferId&&control.phase==='human'&&control.owned&&controlGeneration!==null&&(this.offerBaseGeneration===null||controlGeneration>this.offerBaseGeneration)){
        this.acceptedTransferId=null;this.offerBaseGeneration=null;this.transferFence=false;this.requiresTransferSelection=true;this.current=null;this.state='selecting';this.cb.onReady(null,0);this.emit('selecting','执行权已转到此设备。请明确选择要接续的 tmux 会话。');this.list();
      }
      if(completedReconcile&&this.pendingTransferRecoveryGeneration!==null&&control.phase==='human'&&control.owned&&controlGeneration!==null&&controlGeneration>this.pendingTransferRecoveryGeneration){this.pendingTransferRecoveryGeneration=null;this.transferFence=false;}
      this.cb.onControl(control);
      if(completedReconcile){
        this.pendingReconcile=null;
        if(completedReconcile.action==='acquire'&&control.phase==='human'&&control.owned){
          if(completedReconcile.sessionRef){this.suppressOldDefaultError=true;this.select(completedReconcile.sessionRef);return;}
          if(this.target.mode==='shell'){
            this.pendingOpenAfterTakeover=false;
            this.emit('control_wait','执行权已核对，但普通 Shell 原进程不能凭新连接安全恢复。请核对现场；不会自动启动新 Shell。');
            return;
          }
          if(control.mode==='managed'&&control.requiresSessionSelection===false){
            this.pendingOpenAfterTakeover=false;
            this.cb.onNotice('执行权已核对；尚未建立受管会话。请明确选择或新建会话，终端不会自动打开。');
          }else{
            this.pendingOpenAfterTakeover=false;this.current=null;this.pendingSessionRef=null;
            this.state='selecting';this.cb.onReady(null,0);
            this.emit('selecting','执行权已核对。请从原授权会话中明确选择；默认会话不会自动打开。');
            this.list();
          }
        }
      }
      if(phase==='unknown'||phase==='ai_ready'||phase==='unmanaged')this.pendingOpenAfterTakeover=false;
      if(phase==='human'&&this.controlOwned&&this.pendingOpenAfterTakeover){this.pendingOpenAfterTakeover=false;this.openAfterControl();}
      return;
    }
    if(frame.type==='controlTargets'){
      if(!this.pendingTargetsRequest||frame.requestId!==this.pendingTargetsRequest)return;
      this.pendingTargetsRequest=null;
      const items:Array<ControlTarget>=Array.isArray(frame.items)?frame.items.filter((item):item is ControlTarget=>!!item&&typeof item==='object'&&typeof item.connectionId==='string'&&item.connectionId.length>0&&(item.deviceId===null||typeof item.deviceId==='string')&&typeof item.local==='boolean').map(item=>({connectionId:item.connectionId,deviceId:item.deviceId,local:item.local})):[];
      this.cb.onTransfer({type:'targets',items});return;
    }
    if(frame.type==='controlOffer'){
      if(this.target.mode!=='tmux'||this.target.readOnly||!this.target.inputAllowed||!this.target.takeoverAllowed||typeof frame.transferId!=='string'||!Number.isFinite(frame.expiresAt)||typeof frame.projectId!=='string'||typeof frame.profileId!=='string'||frame.profileId!==this.target.profileId||frame.fromDeviceId!==null&&typeof frame.fromDeviceId!=='string')return;
      this.discardInputFlow('终端控制权转移中。');this.offerTransferId=frame.transferId;this.offerBaseGeneration=this.controlGeneration;this.transferFence=true;this.pendingOpenAfterTakeover=false;this.cb.onTransfer({type:'offer',transferId:frame.transferId,expiresAt:Number(frame.expiresAt),projectId:frame.projectId,profileId:frame.profileId,fromDeviceId:frame.fromDeviceId as string|null});return;
    }
    if(frame.type==='transferPending'){
      if(!this.pendingTransferRequest||frame.requestId!==this.pendingTransferRequest||typeof frame.transferId!=='string'||typeof frame.targetConnectionId!=='string'||!Number.isFinite(frame.expiresAt)||!Number.isSafeInteger(frame.generation))return;
      this.discardInputFlow('终端控制权转移中。');this.pendingTransferRequest=null;this.pendingTransferAction=null;this.activeTransferId=frame.transferId;this.transferFence=true;this.pendingOpenAfterTakeover=false;
      this.cb.onTransfer({type:'pending',transferId:frame.transferId,expiresAt:Number(frame.expiresAt),targetConnectionId:frame.targetConnectionId,generation:Number(frame.generation)});return;
    }
    if(frame.type==='transferAccepted'){
      if(typeof frame.transferId!=='string'||this.offerTransferId!==frame.transferId||this.pendingTransferAction?.type!=='accept-control'||this.pendingTransferAction.transferId!==frame.transferId||this.pendingTransferAction.requestId!==frame.requestId)return;
      this.discardInputFlow('终端控制权转移中。');this.pendingTransferAction=null;this.acceptedTransferId=frame.transferId;this.offerTransferId=null;this.transferFence=true;
      this.cb.onTransfer({type:'accepted',transferId:frame.transferId});return;
    }
    if(frame.type==='transferCompleted'){
      if(typeof frame.transferId!=='string'||this.activeTransferId!==frame.transferId)return;
      this.activeTransferId=null;this.transferFence=true;this.cb.onTransfer({type:'completed',transferId:frame.transferId});return;
    }
    if(frame.type==='transferEnded'){
      const endedBeforePending=this.pendingTransferAction?.type==='transfer-control'&&!this.activeTransferId;
      if(frame.status!=='unknown'||typeof frame.transferId!=='string'||!endedBeforePending&&![this.activeTransferId,this.offerTransferId,this.acceptedTransferId].includes(frame.transferId))return;
      this.discardInputFlow('终端控制权转移结果未确认。');this.activeTransferId=null;this.offerTransferId=null;this.acceptedTransferId=null;this.offerBaseGeneration=null;this.pendingTransferRequest=null;this.pendingTransferAction=null;this.transferFence=true;this.controlPhase='unknown';this.controlOwned=false;
      const reason=typeof frame.reason==='string'?frame.reason:'转移结果未确认。';this.cb.onControl({phase:'unknown',owned:false,reason});this.cb.onTransfer({type:'ended',transferId:frame.transferId,reason});return;
    }
    if(frame.type==='authenticated'){
      if(frame.connectionId!==this.connectionId)return;
      this.state='opening';this.emit('opening');
      const {cols,rows}=this.size();
      this.send({type:'open',connectionId:this.connectionId,profileId:this.target.profileId,mode:this.target.mode,readOnly:this.target.readOnly,cols,rows,...(recoverSessionRef?{recoverSessionRef}:{}),...(this.reconnectCount>0&&this.nextOffset!==null?{resumeOffset:this.nextOffset}:{})});
      this.list();return;
    }
    if(frame.type==='sessions'){
      const items=Array.isArray(frame.items)?frame.items.filter((item):item is TerminalSession=>!!item&&typeof item==='object'&&validRef(item.sessionRef)&&typeof item.name==='string').map(item=>({sessionRef:item.sessionRef,name:item.name,attached:Boolean(item.attached),authorized:item.authorized===true})):[];
      if(Number.isSafeInteger(frame.defaultRevision)&&Number(frame.defaultRevision)>=0)this.defaultRevision=Number(frame.defaultRevision);
      const saved=this.pendingDefault;
      if(saved&&frame.requestId===saved.requestId){
        this.clearPendingDefault();
        this.cb.onNotice(validRef(frame.defaultRef)&&sameRef(frame.defaultRef,saved.sessionRef)&&this.defaultRevision>saved.expectedRevision?'默认会话已保存。':'默认会话保存结果未确认，请刷新列表核对。');
      }
      this.cb.onSessions(items,validRef(frame.defaultRef)?frame.defaultRef:null,frame.available!==false,this.defaultRevision,typeof frame.requestId==='string'?frame.requestId:undefined);return;
    }
    if(frame.type==='ready'){
      if(this.pendingReturn||this.returnFence&&this.controlPhase==='return_review')return;
      if(frame.connectionId!==this.connectionId||!Number.isSafeInteger(frame.epoch)||Number(frame.epoch)<1)return;
      if(frame.readOnly!==undefined&&frame.readOnly!==this.target.readOnly){this.intentional=true;this.lock();this.emit('error','终端只读状态与连接请求不一致。');this.ws?.close(4003,'Read-only mismatch');return;}
      const nextEpoch=Number(frame.epoch);
      if(this.pendingSessionRef&&!sameRef(this.pendingSessionRef,validRef(frame.sessionRef)?frame.sessionRef:null))return;
      if(nextEpoch<this.epoch||nextEpoch===this.epoch&&this.state!=='opening')return;
      const wasResume=this.reconnectCount>0&&nextEpoch===this.epoch&&sameRef(this.current,validRef(frame.sessionRef)?frame.sessionRef:null);
      if(nextEpoch!==this.epoch)this.seq=0;
      if(Number.isSafeInteger(frame.lastInputSeq)&&Number(frame.lastInputSeq)>=0)this.seq=Math.max(this.seq,Number(frame.lastInputSeq));
      this.discardInputFlow('终端附件已重新确认。');this.epoch=nextEpoch;this.current=validRef(frame.sessionRef)?frame.sessionRef:null;
      if(this.requiresTransferSelection&&this.pendingSessionRef&&sameRef(this.pendingSessionRef,validRef(frame.sessionRef)?frame.sessionRef:null))this.requiresTransferSelection=false;
      if(this.pendingSessionRef&&sameRef(this.pendingSessionRef,validRef(frame.sessionRef)?frame.sessionRef:null))this.suppressOldDefaultError=false;
      this.pendingSessionRef=null;
      if(!wasResume)this.cb.onClear();
      this.nextOffset=wasResume&&this.nextOffset!==null?this.nextOffset:Number.isSafeInteger(frame.offset)?Number(frame.offset):0;
      this.state=this.requiresTransferSelection?'selecting':'ready';this.recoveryCycleId++;this.reconnectCount=0;this.clearReachableWake();this.reachableWakeUsed=false;this.freshRecoveryCount=0;this.freshRecoveryAttempted=false;this.freshRecoveryRef=null;this.emit(this.state);this.cb.onReady(this.requiresTransferSelection?null:this.current,this.epoch);this.list();this.resize();return;
    }
    if(frame.type==='output'){
      if(this.state!=='ready'||frame.epoch!==this.epoch||!Number.isSafeInteger(frame.offset)||typeof frame.data!=='string')return;
      let bytes:Uint8Array;try{bytes=bytesFromBase64(frame.data)}catch{return;}
      if(bytes.length>32768)return;
      const offset=Number(frame.offset);
      if(this.nextOffset!==null&&offset!==this.nextOffset){
        if(offset<this.nextOffset&&offset+bytes.length<=this.nextOffset)return;
        this.handleGap();return;
      }
      this.nextOffset=offset+bytes.length;this.cb.onOutput(bytes);return;
    }
    if(frame.type==='gap'){
      if(frame.epoch!==this.epoch)return;
      this.handleGap();return;
    }
    if(frame.type==='inputAck'){
      if(frame.epoch===this.epoch&&frame.status==='written'&&Number.isSafeInteger(frame.seq)&&this.unacked.has(Number(frame.seq))){
        this.unacked.delete(Number(frame.seq));this.flushInput();
      }
      return;
    }
    if(frame.type==='exit'){
      if(frame.epoch!==this.epoch)return;
      this.discardInputFlow('终端附件已退出。');
      this.lock();this.cb.onReady(null,0);this.emit('disconnected',typeof frame.reason==='string'?frame.reason:'终端已结束。');return;
    }
    if(frame.type==='error'){
      const code=typeof frame.code==='string'?frame.code:'ERROR';
      const message=typeof frame.message==='string'?frame.message:code;
      this.discardInputFlow('终端请求返回错误。');
      if(this.pendingReturn){
        this.pendingReturn=null;this.pendingReconcile=null;this.controlPhase='unknown';this.controlOwned=false;
        this.cb.onControl({phase:'unknown',owned:false,returnReview:null,reason:message});this.emit('control_wait',message);return;
      }
      if(recoverSessionRef&&code!=='DEFAULT_UNAVAILABLE'&&code!=='DEFAULT_STALE')this.freshRecoveryRef=null;
      if(['UNAUTHORIZED','FORBIDDEN','GRANT_CHANGED','DEVICE_REQUIRED','DEVICE_REVOKED','NODE_CHANGED','NODE_REVOKED','CONNECTION_CHANGED'].includes(code)||code.startsWith('CONTROL_'))this.clearReachableWake();
      if(code==='RESUME_UNAVAILABLE'&&this.state==='authenticating'){
        if(resume&&this.recoverExpiredResume())return;
        this.stopSocket(true);this.connectionId=null;this.pendingSessionRef=null;this.controlOwned=false;this.cb.onReady(null,0);
        this.emit('error',recoverSessionRef?'新连接仍无法核对原会话。请手动连接并明确选择存活会话；不会自动重试或重发输入。':this.target.mode==='shell'?'原普通 Shell 连接已过恢复窗口，进程状态待核对。请手动重新连接；不会自动启动新 Shell 或重发输入。':'原连接已过恢复窗口，无法自动核对原会话。请手动连接并明确选择存活会话；不会改默认或重发输入。');return;
      }
      if(this.pendingReconcile&&frame.requestId===this.pendingReconcile.requestId){
        this.pendingReconcile=null;this.pendingOpenAfterTakeover=false;this.pendingTransferRecoveryGeneration=null;
        this.controlPhase='unknown';this.controlOwned=false;this.cb.onControl({phase:'unknown',owned:false,reason:message});this.emit('control_wait',message);return;
      }
      if((this.pendingReconcile||this.suppressOldDefaultError)&&['DEFAULT_UNAVAILABLE','DEFAULT_STALE'].includes(code))return;
      if(this.pendingTransferAction){this.failTransferAction(message);return;}
      if(code==='DEFAULT_CONFLICT'||code==='DEFAULT_REVISION_REQUIRED'){
        this.clearPendingDefault();
        this.cb.onNotice('默认会话已在其他设备变化。已刷新列表，请重新选择。');this.cb.onDefaultConflict();this.list();return;
      }
      if(INPUT_AUTHORITY_ERRORS.has(code)){
        if(this.pendingDefault){this.clearPendingDefault();this.cb.onNotice('默认会话保存结果未确认，请重新连接后核对列表。');}
        this.stopSocket(true);this.connectionId=null;this.current=null;this.controlPhase='unknown';this.controlOwned=false;
        this.cb.onReady(null,0);this.cb.onControl({phase:'unknown',owned:false,reason:message});
        this.emit('error',`${message} 当前终端输入已冻结；请重新连接并核对终端内容，已发送的输入不会重发。`);return;
      }
      if(code==='SESSION_NOT_AUTHORIZED'){
        const blocked=validRef(frame.sessionRef)?frame.sessionRef:this.pendingSessionRef;
        this.state='selecting';this.cb.onSessionUnauthorized(blocked);this.emit('selecting','此会话尚未获可写授权。请明确选择后扩展，复核通过再点击会话切换。');this.list();return;
      }
      if(code==='CONTROL_REQUIRED'){
        this.pendingOpenAfterTakeover=false;this.state='control_wait';
        this.cb.onControlRequired();this.emit('control_wait',message);return;
      }
      if(code.startsWith('CONTROL_')){
        this.pendingOpenAfterTakeover=false;
        this.controlPhase='unknown';this.controlOwned=false;this.cb.onControl({phase:'unknown',owned:false,reason:message});this.emit('control_wait',message);return;
      }
      if(this.controlPhase==='stopping'||this.controlPhase==='return_check'){
        this.pendingOpenAfterTakeover=false;
        this.controlPhase='unknown';this.controlOwned=false;this.cb.onControl({phase:'unknown',owned:false,reason:message});this.emit('control_wait',message);return;
      }
      if(['UNAUTHORIZED','FORBIDDEN','GRANT_CHANGED','DEVICE_REQUIRED','DEVICE_REVOKED','NODE_CHANGED','NODE_REVOKED','CONNECTION_CHANGED','INPUT_STALE'].includes(code)){
        if(this.pendingDefault){this.clearPendingDefault();this.cb.onNotice('');}
        this.intentional=true;this.lock();this.emit('error',message);this.ws?.close(4003,'Terminal denied');return;
      }
      if(code==='NEEDS_SELECTION'||code==='DEFAULT_UNAVAILABLE'||code==='DEFAULT_STALE'||code==='SESSION_NOT_FOUND'||code==='TMUX_UNAVAILABLE'){
        this.state='selecting';this.emit('selecting',message);
        this.cb.onNotice(code==='SESSION_NOT_FOUND'&&recoverSessionRef?'原会话已结束或身份已变化；请选择存活的原授权会话。不会自动进入默认或同名新会话。':code==='DEFAULT_UNAVAILABLE'||code==='DEFAULT_STALE'?'默认会话已结束或身份已变化。请选择存活会话或明确新建，再单独设为默认；不会自动接入同名新会话。':'请选择一个真实的 tmux 会话。');
        this.list();return;
      }
      if(code==='OUTPUT_GAP'){
        this.state='output_gap';this.emit('output_gap','普通 Shell 的部分输出已丢失。确认后可继续当前进程，缺失内容无法恢复。');return;
      }
      if(this.state==='redrawing'){
        this.state='output_gap';this.emit('output_gap',message);return;
      }
      if(this.state==='selecting'){
        this.emit('selecting',message);this.list();return;
      }
      if(this.state==='ready'){
        this.cb.onNotice(message);return;
      }
      this.emit('error',message);return;
    }
  }
  private handleGap(){
    if(this.state==='redrawing'||this.state==='output_gap')return;
    this.discardInputFlow('终端输出恢复中。');
    if(this.target.mode==='shell'){
      this.state='output_gap';this.emit('output_gap','普通 Shell 的部分输出已丢失。确认后可继续当前进程，缺失内容无法恢复。');return;
    }
    this.state='redrawing';this.emit('redrawing','输出有缺口，正在重新附着当前 tmux 会话。');
    const {cols,rows}=this.size();
    if(!this.send({type:'open',connectionId:this.connectionId,profileId:this.target.profileId,mode:'tmux',readOnly:this.target.readOnly,cols,rows,redraw:true})){
      this.state='output_gap';this.emit('output_gap','输出有缺口，重新附着未送达。请手动重新连接。');
    }
  }
  acceptShellGap(){
    if(this.pendingDetach||this.state!=='output_gap'||this.target.mode!=='shell'||this.ws?.readyState!==WebSocket.OPEN)return false;
    this.state='redrawing';this.emit('redrawing','正在确认继续当前 Shell。');
    const {cols,rows}=this.size();
    if(!this.send({type:'open',connectionId:this.connectionId,profileId:this.target.profileId,mode:'shell',cols,rows,acceptGap:true})){
      this.state='output_gap';this.emit('output_gap','请求未送达，终端仍保持只读。');return false;
    }
    return true;
  }
  openAfterControl(){
    if(this.pendingDetach||this.returnFence||this.transferFence||this.controlPhase!=='human'||!this.controlOwned||this.ws?.readyState!==WebSocket.OPEN)return false;
    this.discardInputFlow('终端正在重新附着。');
    this.state='opening';this.emit('opening');
    const {cols,rows}=this.size();
    return this.send({type:'open',connectionId:this.connectionId,profileId:this.target.profileId,mode:this.target.mode,readOnly:this.target.readOnly,cols,rows});
  }
  requestTakeover(endUnknownCommands?:UnknownExecution[]){
    if(this.pendingDetach||this.returnFence||this.transferFence||this.target.readOnly||!this.target.takeoverAllowed||!this.target.inputAllowed||this.ws?.readyState!==WebSocket.OPEN)return false;
    if(endUnknownCommands!==undefined&&(!validUnknownExecutions(endUnknownCommands)||this.target.mode!=='tmux'||!this.controlManaged||this.controlPhase!=='ai_ready'||
      JSON.stringify(endUnknownCommands)!==JSON.stringify(this.unresolvedExecutions)))return false;
    this.discardInputFlow('终端接管正在核验。');
    this.pendingOpenAfterTakeover=true;this.controlPhase='stopping';this.controlOwned=false;this.cb.onControl({phase:'stopping',owned:false});
    if(this.send({type:'takeover',...(endUnknownCommands!==undefined?{endUnknownCommands:endUnknownCommands.map(({taskId,commandId})=>({taskId,commandId}))}:{})}))return true;
    this.pendingOpenAfterTakeover=false;this.controlPhase='unknown';this.cb.onControl({phase:'unknown',owned:false,reason:'接管请求是否到达电脑无法确认。'});return false;
  }
  requestExistingTakeover(sessionRefs:SessionRef[]){
    if(this.pendingDetach||this.returnFence||this.transferFence||this.target.readOnly||this.target.mode!=='tmux'||!this.target.takeoverAllowed||!this.target.inputAllowed||!validSessionRefs(sessionRefs)||this.ws?.readyState!==WebSocket.OPEN)return false;
    this.discardInputFlow('终端接管正在核验。');
    this.pendingOpenAfterTakeover=true;this.controlPhase='stopping';this.controlOwned=false;this.cb.onControl({phase:'stopping',owned:false});
    if(this.send({type:'takeover-existing',sessionRefs}))return true;
    this.pendingOpenAfterTakeover=false;this.controlPhase='unknown';this.cb.onControl({phase:'unknown',owned:false,reason:'已有会话接入请求是否到达电脑无法确认。'});return false;
  }
  extendExisting(sessionRefs:SessionRef[]){
    if(this.pendingDetach||this.returnFence||this.transferFence||this.target.readOnly||this.controlMode!=='existing'||this.controlPhase!=='human'||!this.controlOwned||!this.target.takeoverAllowed||!validSessionRefs(sessionRefs)||this.ws?.readyState!==WebSocket.OPEN)return false;
    this.discardInputFlow('终端授权范围正在核验。');
    this.controlPhase='stopping';this.controlOwned=false;this.cb.onControl({phase:'stopping',owned:false});
    if(this.send({type:'extend-existing',sessionRefs}))return true;
    this.controlPhase='unknown';this.cb.onControl({phase:'unknown',owned:false,reason:'会话扩展请求是否到达电脑无法确认。'});return false;
  }
  returnControl(notes:string){
    if(this.pendingDetach||this.pendingReconcile||this.pendingReturn||this.transferFence||!this.canInput||!this.target.takeoverAllowed||
      this.controlPhase!=='human'||!this.controlOwned||this.controlGeneration===null||!this.connectionId||this.ws?.readyState!==WebSocket.OPEN)return false;
    this.discardInputFlow('终端正在准备交还核对。');this.returnFence=true;this.returnFenceGeneration=this.controlGeneration;
    this.pendingReturn={stage:'preparing',connectionId:this.connectionId,socketGeneration:this.generation,controlGeneration:this.controlGeneration,review:null};
    this.controlPhase='return_check';this.controlOwned=false;this.cb.onControl({phase:'return_check',owned:false,returnReview:null});
    if(this.send({type:'return-prepare',notes:notes.slice(0,2000)}))return true;
    this.pendingReturn=null;this.controlPhase='unknown';this.cb.onControl({phase:'unknown',owned:false,returnReview:null,reason:'交还准备是否到达电脑无法确认。'});return false;
  }
  confirmReturn(){
    if(!this.canConfirmReturn)return false;
    const pending=this.pendingReturn!,review=pending.review!;
    pending.stage='confirming';this.discardInputFlow('正在确认交还。');
    this.controlPhase='return_check';this.controlOwned=false;this.cb.onControl({phase:'return_check',owned:false,returnReview:null});
    if(this.send({type:'return-confirm',reviewId:review.reviewId,expectedGeneration:review.generation}))return true;
    this.pendingReturn=null;this.controlPhase='unknown';this.cb.onControl({phase:'unknown',owned:false,returnReview:null,reason:'交还确认是否到达电脑无法确认。'});return false;
  }
  cancelReturn(){
    const pending=this.pendingReturn;
    if(!pending||pending.stage!=='review'||!pending.review||pending.connectionId!==this.connectionId||pending.socketGeneration!==this.generation||
      pending.controlGeneration!==this.controlGeneration||this.ws?.readyState!==WebSocket.OPEN)return false;
    pending.stage='canceling';this.discardInputFlow('正在取消交还核对。');
    this.controlPhase='return_check';this.controlOwned=false;this.cb.onControl({phase:'return_check',owned:false,returnReview:null});
    if(this.send({type:'return-cancel',reviewId:pending.review.reviewId,expectedGeneration:pending.review.generation}))return true;
    this.pendingReturn=null;this.controlPhase='unknown';this.cb.onControl({phase:'unknown',owned:false,returnReview:null,reason:'取消交还是否到达电脑无法确认。'});return false;
  }
  reconcileControl(action:'acquire'|'release',sessionRef?:SessionRef){
    if(this.pendingDetach||this.pendingReconcile||this.pendingReturn||this.target.readOnly||action==='release'&&this.transferFence||sessionRef!==undefined&&(action!=='acquire'||!validRef(sessionRef))||this.ws?.readyState!==WebSocket.OPEN)return false;
    if(action==='release'&&(!this.target.inputAllowed||!this.target.takeoverAllowed||this.controlPhase!=='unknown'||!this.controlOwned||this.controlGeneration===null||!this.connectionId))return false;
    this.discardInputFlow('终端控制权正在重新核验。');
    const requestId=crypto.randomUUID();this.pendingReconcile={requestId,action,sessionRef:sessionRef||null};this.pendingOpenAfterTakeover=false;
    if(action==='release'){
      this.returnFence=true;this.returnFenceGeneration=this.controlGeneration;
      this.pendingReturn={stage:'preparing',connectionId:this.connectionId!,socketGeneration:this.generation,controlGeneration:this.controlGeneration!,review:null};
      this.controlPhase='return_check';this.controlOwned=false;this.cb.onControl({phase:'return_check',owned:false,returnReview:null});
    }
    if(action==='acquire'&&this.transferFence)this.pendingTransferRecoveryGeneration=this.controlGeneration;
    if(this.send({type:'reconcile-control',action,requestId,...(sessionRef?{sessionRef}:{})}))return true;
    this.pendingReconcile=null;this.pendingReturn=null;this.pendingTransferRecoveryGeneration=null;return false;
  }
  listControlTargets(){
    if(!this.canTransfer)return false;
    const requestId=crypto.randomUUID();this.pendingTargetsRequest=requestId;
    if(this.send({type:'list-control-targets',requestId}))return true;
    this.pendingTargetsRequest=null;return false;
  }
  transferControl(targetConnectionId:string){
    if(!this.canTransfer||this.pendingTransferAction||!targetConnectionId)return false;
    this.discardInputFlow('终端控制权正在转移。');
    const requestId=crypto.randomUUID();this.pendingTransferRequest=requestId;this.pendingTargetsRequest=null;
    this.pendingTransferAction={type:'transfer-control',requestId};
    this.transferFence=true;this.pendingOpenAfterTakeover=false;this.cb.onControl({phase:'transfer_pending',owned:false,generation:this.controlGeneration});
    if(this.send({type:'transfer-control',targetConnectionId,expectedGeneration:this.controlGeneration,requestId}))return true;
    this.failTransferAction('转移请求是否送达尚未确认。');return false;
  }
  acceptControl(transferId:string){
    if(this.pendingDetach||this.pendingTransferAction||!transferId||this.offerTransferId!==transferId||this.target.mode!=='tmux'||this.target.readOnly||!this.target.inputAllowed||!this.target.takeoverAllowed||this.ws?.readyState!==WebSocket.OPEN)return false;
    this.discardInputFlow('终端控制权正在转移。');
    const requestId=crypto.randomUUID();this.pendingTransferAction={type:'accept-control',requestId,transferId};
    this.transferFence=true;if(this.send({type:'accept-control',transferId,requestId}))return true;
    this.failTransferAction('接受转移请求是否送达尚未确认。');return false;
  }
  cancelTransfer(transferId:string){
    if(this.pendingDetach||this.pendingTransferAction||!transferId||![this.activeTransferId,this.offerTransferId].includes(transferId)||this.ws?.readyState!==WebSocket.OPEN)return false;
    this.discardInputFlow('终端控制权正在转移。');
    const requestId=crypto.randomUUID();this.pendingTransferAction={type:'cancel-transfer',requestId,transferId};
    this.transferFence=true;if(this.send({type:'cancel-transfer',transferId,requestId}))return true;
    this.failTransferAction('取消转移请求是否送达尚未确认。');return false;
  }
  private failTransferAction(reason:string){
    this.clearPendingDefault();this.stopSocket(true);this.connectionId=null;this.current=null;this.cb.onReady(null,0);
    this.controlPhase='unknown';this.controlOwned=false;this.cb.onControl({phase:'unknown',owned:false,reason});
    this.cb.onTransfer({type:'failed',reason});this.emit('error','转移未完成，请重新连接；原 tmux 会话保留。');
  }
  pauseForOffline(){
    if(this.pendingDetach||this.intentional||this.state==='idle'&&this.reconnectTimer===undefined&&!this.freshRecoveryRef)return;
    if(this.pendingReturn){this.pendingReturn=null;this.pendingReconcile=null;this.controlPhase='unknown';this.controlOwned=false;
      this.cb.onControl({phase:'unknown',owned:false,returnReview:null,reason:'交还核对连接已中断，结果未确认。'});
      this.cb.onNotice('交还结果未确认；请重新连接并正式核对现场，不会自动确认。');
      this.stopSocket(true);this.connectionId=null;this.current=null;this.cb.onReady(null,0);
      this.emit('control_wait','交还结果未确认，输入保持关闭。');return;}
    if(this.pendingReconcile){this.pendingReconcile=null;this.pendingOpenAfterTakeover=false;this.controlPhase='unknown';this.controlOwned=false;this.cb.onControl({phase:'unknown',owned:false,reason:'控制权核对结果未确认。'});this.cb.onNotice('恢复核对结果未确认；重新连接后请检查现场，不会自动重试。');}
    if(this.pendingTransferAction||this.activeTransferId||this.offerTransferId||this.acceptedTransferId){this.failTransferAction('转移期间连接中断，结果尚未确认。');return;}
    const defaultUnknown=Boolean(this.pendingDefault);
    if(defaultUnknown)this.clearPendingDefault();
    this.pendingOpenAfterTakeover=false;
    this.clearTransferOnLoss();
    const uncertain=this.unacked.size>0;
    if(defaultUnknown||uncertain)this.cb.onNotice([defaultUnknown?'默认会话保存状态未确认；联网后请核对列表，不会自动重试。':'',uncertain?'有输入尚未确认是否写入；请检查终端内容，输入不会自动重发。':''].filter(Boolean).join(' '));
    this.stopSocket(false);this.unacked.clear();this.generation++;
    this.cb.onReady(null,0);
    this.emit('disconnected',uncertain?'网络中断，有输入尚未确认是否写入。恢复后请核对终端；输入不会重发。':'网络中断，恢复后会尝试接回当前会话。');
  }
  resume(){if(this.intentional||this.state!=='idle'||this.pendingDetach)return;if(this.freshRecoveryRef){if(this.freshRecoveryCount<MAX_FRESH_RECOVERY_ATTEMPTS)void this.connect(false,this.freshRecoveryRef);return;}if(this.connectionId&&this.reconnectCount<MAX_RESUME_ATTEMPTS)void this.connect(true);}
  private lost(closeCode:number,recoverSessionRef:SessionRef|null=null){
    if(this.intentional){this.ws=null;return;}
    if(this.pendingReturn){this.pendingReturn=null;this.pendingReconcile=null;this.controlPhase='unknown';this.controlOwned=false;
      this.cb.onControl({phase:'unknown',owned:false,returnReview:null,reason:'交还核对连接已中断，结果未确认。'});
      this.cb.onNotice('交还结果未确认；请重新连接并正式核对现场，不会自动确认。');
      this.stopSocket(true);this.connectionId=null;this.current=null;this.cb.onReady(null,0);
      this.emit('control_wait','交还结果未确认，输入保持关闭。');return;}
    // A socket established during exact-session recovery outlives that phase.
    // Once ready reset the phase, its next loss resumes the new connection.
    if(!this.freshRecoveryAttempted)recoverSessionRef=null;
    if(this.pendingReconcile){this.pendingReconcile=null;this.pendingOpenAfterTakeover=false;this.controlPhase='unknown';this.controlOwned=false;this.cb.onControl({phase:'unknown',owned:false,reason:'控制权核对结果未确认。'});this.cb.onNotice('恢复核对结果未确认；重新连接后请检查现场，不会自动重试。');}
    const defaultUnknown=Boolean(this.pendingDefault);
    if(defaultUnknown)this.clearPendingDefault();
    this.pendingOpenAfterTakeover=false;
    const transferUnresolved=this.clearTransferOnLoss();
    const uncertain=this.unacked.size>0;
    if(defaultUnknown||uncertain)this.cb.onNotice([defaultUnknown?'默认会话保存状态未确认；重连后请核对列表，不会自动重试。':'',uncertain?'有输入尚未确认是否写入；请检查终端内容，输入不会自动重发。':''].filter(Boolean).join(' '));
    this.discardInputFlow('终端连接已中断。',false);this.unacked.clear();
    this.lock();this.ws=null;this.cb.onReady(null,0);
    this.emit('disconnected',transferUnresolved?'转移未完成，请重新连接；原 tmux 会话保留。':uncertain?'连接中断，有输入尚未确认是否写入。请检查终端内容，输入不会自动重发。':'终端连接已中断，正在尝试恢复。');
    if(transferUnresolved||[4001,4003].includes(closeCode)){this.clearReachableWake();this.connectionId=null;this.freshRecoveryRef=null;this.emit('error',transferUnresolved?'转移未完成，请重新连接；原 tmux 会话保留。':'终端授权或连接身份已变化。请刷新状态后重新连接。');return;}
    const exactRef=recoverSessionRef&&sameRef(this.freshRecoveryRef,recoverSessionRef)?recoverSessionRef:null;
    if(recoverSessionRef&&!exactRef){this.clearReachableWake();this.connectionId=null;this.pendingSessionRef=null;this.controlOwned=false;this.emit('error','原会话恢复状态已变化，请手动核对；不会自动接入默认会话。');return;}
    if(!this.retryAfterTransportFailure(exactRef)){
      if(exactRef){
        // Exhaustion ends the whole recovery cycle. A fresh ticket has its own
        // connectionId; retaining it would let a foreground wake fall back to
        // the old-connection resume phase and evade the fresh attempt limit.
        this.freshRecoveryRef=null;this.connectionId=null;this.current=null;this.pendingSessionRef=null;
        this.controlOwned=false;this.nextOffset=null;this.unacked.clear();
        this.cb.onControl({phase:this.controlPhase,owned:false});
      }
      this.emit('error','自动恢复失败，请手动连接并明确选择存活会话。');
    }
  }
  private stopSocket(intentional:boolean){
    this.discardInputFlow('终端连接已关闭。',false);
    if(this.reconnectTimer!==undefined)window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer=undefined;
    if(intentional){this.intentional=true;this.generation++;this.pendingOpenAfterTakeover=false;this.pendingReconcile=null;this.pendingReturn=null;this.suppressOldDefaultError=false;this.freshRecoveryRef=null;this.clearReachableWake();this.clearTransferOnLoss();}
    const ws=this.ws;this.ws=null;
    if(ws){ws.onclose=null;ws.onmessage=null;ws.onerror=null;ws.close();}
    this.lock();
  }
  private finishDisconnect(confirmed:boolean){
    const pending=this.pendingDetach;if(!pending)return;
    this.clearPendingDefault();
    this.pendingDetach=null;window.clearTimeout(pending.timer);
    this.stopSocket(true);this.connectionId=null;this.current=null;this.nextOffset=null;this.epoch=0;this.seq=0;
    this.unacked.clear();this.reconnectCount=0;this.cb.onReady(null,0);
    this.emit('disconnected',confirmed?'已断开终端，tmux 会话仍在电脑上运行。':'断开确认未收到；重新连接时将复核旧终端客户端是否仍在运行。');
    pending.resolve(confirmed);
  }
  disconnect():Promise<boolean>{
    if(this.pendingDetach)return this.pendingDetach.promise;
    if(this.pendingReturn){this.pendingReturn=null;this.pendingReconcile=null;this.controlPhase='unknown';this.controlOwned=false;this.cb.onControl({phase:'unknown',owned:false,returnReview:null,reason:'交还核对尚未完成；断开后请正式核对现场。'});}
    this.discardInputFlow('终端正在断开。');
    this.clearPendingDefault();
    if(this.ws?.readyState!==WebSocket.OPEN){this.stopSocket(true);this.connectionId=null;this.current=null;this.cb.onReady(null,0);this.emit('disconnected','连接已关闭；旧终端客户端退役尚未确认。');return Promise.resolve(false);}
    this.state='control_wait';this.pendingOpenAfterTakeover=false;this.cb.onReady(null,0);
    let resolve!:(confirmed:boolean)=>void;
    const promise=new Promise<boolean>(done=>{resolve=done;});
    const timer=window.setTimeout(()=>this.finishDisconnect(false),8000);
    const requestId=crypto.randomUUID();
    this.pendingDetach={requestId,resolve,timer,promise};
    if(!this.send({type:'detach',epoch:this.epoch,requestId}))this.finishDisconnect(false);
    return promise;
  }
  dispose(){this.clearPendingDefault();this.discardInputFlow('终端界面已关闭。');if(this.pendingDetach)this.finishDisconnect(false);else this.stopSocket(true);}
  private clearTransferOnLoss(){
    const unresolved=Boolean(this.pendingTransferRequest||this.pendingTransferAction||this.activeTransferId||this.offerTransferId||this.acceptedTransferId);
    this.pendingTargetsRequest=null;this.pendingTransferRequest=null;this.pendingTransferAction=null;this.activeTransferId=null;this.offerTransferId=null;this.acceptedTransferId=null;this.offerBaseGeneration=null;
    if(unresolved)this.transferFence=true;
    this.cb.onTransfer({type:'cleared'});
    return unresolved;
  }
  list(){const requestId=crypto.randomUUID();return this.send({type:'list',requestId})?requestId:null;}
  select(ref:SessionRef){if(this.pendingDetach||this.returnFence||this.transferFence||!this.ws||this.state==='idle')return;this.discardInputFlow('正在切换终端会话。');this.pendingSessionRef=ref;this.state='selecting';this.emit('selecting');this.send({type:'select',requestId:crypto.randomUUID(),sessionRef:ref,epoch:this.epoch});}
  create(name:string){if(this.pendingDetach||this.returnFence||this.transferFence||this.requiresTransferSelection||this.target.readOnly||!this.ws||this.state==='idle')return;this.discardInputFlow('正在新建终端会话。');this.state='selecting';this.emit('selecting');const {cols,rows}=this.size();this.send({type:'create',requestId:crypto.randomUUID(),name,epoch:this.epoch,cols,rows});}
  setDefault(ref:SessionRef){
    if(this.pendingDefault||this.pendingDetach||this.returnFence||this.transferFence||this.ws?.readyState!==WebSocket.OPEN||!validRef(ref))return false;
    const requestId=crypto.randomUUID(),expectedRevision=this.defaultRevision;
    if(!this.send({type:'default',requestId,sessionRef:ref,expectedRevision}))return false;
    const timer=window.setTimeout(()=>{if(this.pendingDefault?.requestId!==requestId)return;this.clearPendingDefault();this.cb.onNotice('默认会话保存结果未确认，请刷新列表核对；不会自动重试。');},8000);
    this.pendingDefault={requestId,sessionRef:ref,expectedRevision,timer};
    return true;
  }
  resize(){if(this.state!=='ready'||this.transferFence)return;const {cols,rows}=this.size();this.send({type:'resize',epoch:this.epoch,cols,rows});}
  input(value:string){
    if(!this.canInput)return false;
    if(!value.length)return true;
    // Admit the whole xterm callback atomically. A too-large paste must never
    // send its first chunk and then silently discard the rest.
    if(value.length>MAX_PENDING_INPUT_BYTES){this.cb.onNotice('本次输入超过缓冲上限，整段未发送。');return false;}
    const bytes=this.encoder.encode(value);
    if(bytes.length>MAX_PENDING_INPUT_BYTES||this.pendingInputBytes+bytes.length>MAX_PENDING_INPUT_BYTES){
      this.cb.onNotice('终端输入积压，本次按键或粘贴整段未发送。请等待确认后重试。');return false;
    }
    const parts:Uint8Array[]=[];
    let part='',size=0;
    for(const scalar of value){
      const scalarSize=this.encoder.encode(scalar).length;
      if(size+scalarSize>MAX_INPUT_FRAME_BYTES){parts.push(this.encoder.encode(part));part='';size=0;}
      part+=scalar;size+=scalarSize;
    }
    if(part)parts.push(this.encoder.encode(part));
    const context=this.inputFlowContext();
    for(const item of parts)this.pendingInput.push({bytes:item,context});
    this.pendingInputBytes+=bytes.length;
    this.flushInput();
    return true;
  }
}
