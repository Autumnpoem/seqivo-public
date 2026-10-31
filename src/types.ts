export type Theme = 'system' | 'light' | 'dark';
export type TaskStatus = 'planned' | 'running' | 'paused' | 'blocked' | 'submitted' | 'failed' | 'cancelled';
export type Acceptance = 'unverified' | 'passed' | 'failed' | 'stale';
export type ExecutionWriteState = 'ready'|'blocked'|'unknown';
export type ExecutionWriteReason = 'ACTIVE_EXECUTION'|'HUMAN_CONTROL'|'WORKSPACE_BUSY'|'SOURCE_CHANGED'|'BINDING_UNAVAILABLE'|'CORE_UNAVAILABLE';
export interface ExecutionWriteAction {state:ExecutionWriteState;reasonCode:ExecutionWriteReason|null}
export interface ConversationStartGate {v:1;bootId:string;observedAt:string;state:ExecutionWriteState;reasonCode:ExecutionWriteReason|null}
export interface TaskExecutionWriteGate {v:1;bootId:string;observedAt:string;taskRevision:number;contentVersion:number;message:ExecutionWriteAction;continue:ExecutionWriteAction;start?:ExecutionWriteAction}
export interface Project { id: string; name: string; goal: string; directory: string | null; createdAt: string; inboxAvailable?:boolean; taskCreationAvailable?:boolean; conversationStart?:ConversationStartGate }
export interface Criterion { id: string; text: string; passed: boolean }
export interface Evidence { id: string; summary: string; reference: string; source: string; contentVersion: number | string; createdAt: string }
export interface Issue { id: string; summary: string; open: boolean; kind: string }
export interface SourceConversation { provider: string; conversationId: string; label?: string }
export interface Verification {
  status: 'passed' | 'partial' | 'failed' | 'unverified'; summary: string; reference: string;
  criterionIds: string[]; source: 'test'; contentVersion: number | string; createdAt: string;
  pendingChecks?: {id: string; kind: 'test'|'implementation'|'decision'; title: string; criterionIds: string[]; steps: string[]; expectedResult: string; blockedReason: string; completed?: boolean; shareWithRemote?: boolean}[];
}
export interface Task {
  id: string; projectId: string; title: string; goal: string; example: string; summary: string; approach: string;
  nextStep: string; status: TaskStatus; acceptance: Acceptance; criteria: Criterion[]; evidence: Evidence[];
  issues: Issue[]; revision: number; contentVersion: number | string; conversationId: string;
  blockedReason: string; updatedAt: string; sourceConversation?: SourceConversation | null; sourceConversationGroup?: string | null; hasExecutionBinding?: boolean; executionProvider?: string;
  previewFeedback?: {projectId:string;previewId:string;sourceTaskId:string;sourceContentVersion:number|string}|null;
  executionWrite?:TaskExecutionWriteGate;
  verification?: Verification | null;
}
export interface Policy { taskId: string; enabled: boolean; status: string; lastError: string|null; wakeAt: string | null; attempts: number; maxAttempts: number; budgetMinutes?:number|null; startedAt?:string|null; deadlineAt?:string|null; remainingSeconds?:number|null; stopReason?:string|null; planIntent?:{version:1;goal:string;nextStep:string}|null; recoveryFailureCount?:number }
export interface ReconcileResult { status: string; error?: string; lastError?: string }
export interface PluginState {
  id: string; name: string; version: string; enabled: boolean; available: boolean; status: string; lastError: string;
  upstream: {url: string; commit: string};
  quota: null | {windows: {name: string; usedPercent: number; resetsAt: string; windowDurationMins: number}[]; blocked: boolean; checkedAt: string};
  config?: {pythonPath: string; codexPath: string; graceSeconds: number; pollSeconds: number};
  policies?: Policy[]; capabilities: string[];
}
export interface InboxItem {
  id:string; projectId:string; taskId:string; kind:'decision'|'acceptance'|'blocked'|'unknown';
  state:'open'|'acknowledged'|'resolved'|'superseded'; itemRevision:number; sourceRevision:number;
  contentVersion:number; source:{type:string;id:string}; dedupKey:string; priority:number;
  title:string; summary:string; impact:string; recommendedAction:string;
  createdAt:string; updatedAt:string; resolvedAt:string|null; resolution:Record<string,unknown>|null;
  options?:{id:string;label:string;consequence:string}[]; shareWithRemote:boolean;
  readOnly?:boolean;
}
export interface InboxState {items:InboxItem[];updatedAt:string;omitted?:{projectId:string;open:number;history:number}[]}
export interface BoardState {
  projects: Project[]; tasks: Task[]; settings: {theme: Theme}; plugin: PluginState;
  events: unknown[]; capabilities: {desktop: boolean; remote: boolean; inbox?:boolean; taskStart?:boolean; role?: 'viewer'|'controller'|'owner'};
  connection: {mode: string; updatedAt: string; lastSeen?: string; offline?: boolean};
  inbox?:InboxState;
  // Older hubs intentionally omit this capability and continue to show the task list.
}
export interface HistoryEntry { seq?: number; id?: string; type?: string; createdAt?: string; projectId?: string; taskId?: string; [key: string]: unknown }
export interface HistoryResponse { events: HistoryEntry[]; cursor?: number | string | null }
export interface RemoteState { status: 'disconnected'|'connecting'|'connected'|'offline'|'revoked'|'error'; url?: string; nodeId?: string; lastSyncAt?: string; lastError?: string; projectIds?: string[] }
export interface CommandRecovery { outcome: 'applied'|'not_applied'|'unknown'; requestedAt?: string; checkedAt?: string; basis?: string }
export interface CommandReceipt { commandId?: string; projectId?: string; taskId?: string; action?: string; status: 'queued'|'received'|'sending'|'running'|'paused'|'unknown'|'expired'|'failed'|string; error?: string | null; result?: unknown; recovery?: CommandRecovery }
export interface AccountUser { id:string; username:string; role?:string }
export interface ConversationMessage {id:string;role:'user'|'assistant'|'tool'|'system';text:string;createdAt?:string;status?:string}
export interface Conversation {taskId:string;status:string;messages:ConversationMessage[];updatedAt?:string;truncated?:boolean}
export interface DesktopStartupStatus {phase:'starting'|'ready'|'failed'|'stopping';message?:string|null;revision:number}
declare global {
  interface Window { taskboard?: {
    request: (method: string, path: string, body?: unknown) => Promise<unknown>;
    subscribe: (callback: () => void) => () => void;
    openFloating: () => Promise<void>;
    setFloatingCompact: (compact: boolean) => Promise<void>;
    showMain: () => Promise<void>;
    chooseDirectory: () => Promise<string | null>;
    startupStatus?: () => Promise<DesktopStartupStatus>;
    subscribeStartup?: (callback:(status:DesktopStartupStatus)=>void) => Promise<()=>void>;
  } }
}
