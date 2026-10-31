export type SessionRef = {serverName:string;instanceId:string;sessionId:string};
export type TerminalScope = 'view'|'input'|'create'|'default'|'takeover';
export interface TerminalSession {sessionRef:SessionRef;name:string;attached:boolean;authorized?:boolean}
export interface TerminalProfile {id:string;label:string;cwd?:string;shell?:string;tmuxAvailable?:boolean;tmuxReason?:string;enabled?:boolean;projectId?:string|null;runtime?:'native'|'wsl';wsl?:{distro:string;user:string;uid:number;cwd:string};serverName?:string;allowSharedServer?:boolean;tmuxExecutable?:string}
export interface TerminalGrant {nodeId?:string;deviceId?:string;profileId:string;scopes:TerminalScope[];revision?:number}
export interface TerminalNode {nodeId:string;profiles:TerminalProfile[]}
export interface HubTerminalStatus {device:{deviceId:string;label:string;status:'pending'|'approved'}|null;nodes:TerminalNode[];grants:TerminalGrant[]}
export interface LocalTerminalStatus {mode:'local';platform:string;enabled:boolean;profiles:TerminalProfile[];grants:TerminalGrant[];pendingDevices:{deviceId:string;label:string;confirmationCode?:string;expiresAt?:number}[];connections?:{id:string;profileId:string;mode:string;ready:boolean}[];link?:{status:string};plugin?:{enabled:boolean;status:'ready'|'disabled'|'disabling'|'disabled_unknown';lastError?:string|null;contract:string}}
export interface WslAvailability {supported:boolean;available:boolean;distributions:string[];reason?:string}
export type TerminalStatus = HubTerminalStatus|LocalTerminalStatus;
export interface TerminalTicket {ticket:string;connectionId:string;wsUrl?:string;expiresAt:number}
export type ControlPhase='ai_ready'|'stopping'|'human'|'return_check'|'return_review'|'transfer_pending'|'unknown'|'unmanaged';
export type SnapshotScope='git-tracked-and-nonignored-untracked'|'directory-tree-excluding-git-metadata'|'legacy-unspecified'|null;
export interface ReturnReview {reviewId:string;expiresAt:number;generation:number;workspaceRelativeDirectories:{sessionRef:SessionRef;path:string}[];
  changes:{path:string;kind:'added'|'modified'|'deleted'}[];snapshotScope:Exclude<SnapshotScope,'legacy-unspecified'|null>;
  totalChanges:number;omittedChanges:number;parkedManagedSessions:number;unownedWorkspaceWriters:0;notes:string}
export interface UnknownExecution {taskId:string;commandId:string}
export interface ControlState {phase:ControlPhase;managed?:boolean;owned?:boolean;generation?:number|null;mode?:'managed'|'existing'|null;authorizedSessionRefs?:SessionRef[];requiresSessionSelection?:boolean;canReconcileAcquire?:boolean;reason?:string;changes?:{path:string;kind:string}[];snapshotScope?:SnapshotScope;returnReview?:ReturnReview|null;unresolvedExecutions?:UnknownExecution[]}
export interface ControlTarget {connectionId:string;deviceId:string|null;local:boolean}
export type TransferEvent =
  | {type:'targets';items:ControlTarget[]}
  | {type:'offer';transferId:string;expiresAt:number;projectId:string;profileId:string;fromDeviceId:string|null}
  | {type:'pending';transferId:string;expiresAt:number;targetConnectionId:string;generation:number}
  | {type:'accepted';transferId:string}
  | {type:'completed';transferId:string}
  | {type:'ended';transferId:string;reason:string}
  | {type:'failed';reason:string}
  | {type:'cleared'};
export interface TerminalCallbacks {
  onState:(state:'connecting'|'authenticating'|'opening'|'ready'|'selecting'|'redrawing'|'output_gap'|'control_wait'|'disconnected'|'error',message?:string)=>void;
  onSessions:(items:TerminalSession[],defaultRef:SessionRef|null,available:boolean,defaultRevision:number,requestId?:string)=>void;
  onReady:(sessionRef:SessionRef|null,epoch:number)=>void;
  onOutput:(data:Uint8Array)=>void;
  onClear:()=>void;
  onNotice:(message:string)=>void;
  onControl:(control:ControlState)=>void;
  onTransfer:(event:TransferEvent)=>void;
  onControlRequired:()=>void;
  onDefaultConflict:()=>void;
  onSessionUnauthorized:(sessionRef:SessionRef|null)=>void;
}
