/** Metadata only. Feedback text, preview links, credentials and tokens never enter storage. */
export interface PreviewFeedbackRecord {
  v:1;
  id:string;
  scope:string;
  projectId:string;
  taskId:string;
  previewId:string;
  contentVersion:string;
  kind:'draft'|'confirm';
  idempotencyKey:string;
  feedbackId?:string;
  result?:'confirmed'|'not_applied'|'created_unavailable';
  taskCreatedId?:string;
  /** Derived on read if two durable observations contradict each other. */
  conflict?:boolean;
  createdAt:number;
}

const prefix='seqivo-preview-feedback-v1:';
const safeId=/^[A-Za-z0-9_-]{1,160}$/;
const keyFor=(record:PreviewFeedbackRecord)=>`${prefix}${encodeURIComponent(record.scope)}:${encodeURIComponent(record.projectId)}:${encodeURIComponent(record.taskId)}:${record.id}`;

export function validPreviewFeedbackRecord(value:unknown):value is PreviewFeedbackRecord {
  if(!value||typeof value!=='object')return false;
  const r=value as Partial<PreviewFeedbackRecord>;
  return r.v===1&&typeof r.id==='string'&&safeId.test(r.id)&&typeof r.scope==='string'&&r.scope.length>0&&r.scope.length<200&&
    typeof r.projectId==='string'&&safeId.test(r.projectId)&&typeof r.taskId==='string'&&safeId.test(r.taskId)&&
    typeof r.previewId==='string'&&safeId.test(r.previewId)&&typeof r.contentVersion==='string'&&r.contentVersion.length<=160&&
    (r.kind==='draft'||r.kind==='confirm')&&typeof r.idempotencyKey==='string'&&safeId.test(r.idempotencyKey)&&
    (r.feedbackId===undefined||typeof r.feedbackId==='string'&&safeId.test(r.feedbackId))&&
    (r.result===undefined||['confirmed','not_applied','created_unavailable'].includes(r.result))&&
    (r.taskCreatedId===undefined||typeof r.taskCreatedId==='string'&&safeId.test(r.taskCreatedId))&&
    (r.result!=='confirmed'||typeof r.taskCreatedId==='string'&&safeId.test(r.taskCreatedId))&&
    (r.conflict===undefined||typeof r.conflict==='boolean')&&
    Number.isSafeInteger(r.createdAt)&&Number(r.createdAt)>0;
}

export function savePreviewFeedbackRecord(record:PreviewFeedbackRecord):void {
  if(!validPreviewFeedbackRecord(record))throw new Error('反馈恢复记录身份无效，未发送请求。');
  if(record.conflict)throw new Error('反馈恢复记录存在冲突，未发送请求。');
  const previous=previewFeedbackRecords(record.scope,record.projectId,record.taskId).find(item=>item.id===record.id);
  if(previous?.conflict)throw new Error('反馈恢复记录存在冲突，未发送请求。');
  if(previous?.result&&!record.result)throw new Error('原反馈已有终态回执，旧响应不得覆盖。');
  if(previous?.kind==='confirm'&&record.kind==='draft')throw new Error('原反馈已进入确认阶段，旧草稿响应不得覆盖。');
  const sameIdentity=previous&&previous.scope===record.scope&&previous.projectId===record.projectId&&previous.taskId===record.taskId&&
    previous.previewId===record.previewId&&previous.contentVersion===record.contentVersion&&previous.idempotencyKey===record.idempotencyKey&&previous.createdAt===record.createdAt&&
    previous.feedbackId===record.feedbackId&&previous.kind===record.kind;
  // An unavailable task remains the safer display after a later confirmed
  // observation. Once its task ID is known, repeated GETs add no new fact.
  if(sameIdentity&&previous.result==='created_unavailable'&&record.result==='confirmed'&&previous.taskCreatedId===record.taskCreatedId)return;
  if(previous&&previous.kind===record.kind&&previous.feedbackId===record.feedbackId&&previous.result===record.result&&previous.taskCreatedId===record.taskCreatedId&&
    previous.scope===record.scope&&previous.projectId===record.projectId&&previous.taskId===record.taskId&&previous.previewId===record.previewId&&
    previous.contentVersion===record.contentVersion&&previous.idempotencyKey===record.idempotencyKey&&previous.createdAt===record.createdAt)return;
  // Each observation is immutable. A late tab cannot replace a terminal receipt.
  const key=`${keyFor(record)}:event:${crypto.randomUUID()}`,serialized=JSON.stringify(record);
  try{
    if(localStorage.getItem(key)!==null)throw new Error('反馈恢复记录编号已存在');
    localStorage.setItem(key,serialized);
    if(localStorage.getItem(key)!==serialized)throw new Error('反馈恢复记录未写入');
  }catch{throw new Error('无法保存反馈恢复记录，未发送请求。请检查浏览器存储后重试。');}
}

export function previewFeedbackRecords(scope:string,projectId:string,taskId:string):PreviewFeedbackRecord[] {
  if(!scope)return [];
  try{
    const groups=new Map<string,PreviewFeedbackRecord>();
    const namespace=`${prefix}${encodeURIComponent(scope)}:${encodeURIComponent(projectId)}:${encodeURIComponent(taskId)}:`;
    for(let index=0;index<localStorage.length;index++){
      const key=localStorage.key(index);
      if(!key?.startsWith(namespace))continue;
      const raw=localStorage.getItem(key);
      if(!raw)throw new Error('当前反馈记录无法读取');
      let value:unknown;
      try{value=JSON.parse(raw);}catch{throw new Error('当前反馈记录格式无效');}
      if(!validPreviewFeedbackRecord(value)||value.scope!==scope||value.projectId!==projectId||value.taskId!==taskId)throw new Error('当前反馈记录身份无效');
      const base=keyFor(value);
      if(key!==base&&!new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}:event:[A-Za-z0-9_-]{36}$`).test(key))throw new Error('当前反馈记录键无效');
      const previous=groups.get(value.id);
      if(!previous){groups.set(value.id,{...value});continue;}
      const sameIdentity=previous.scope===value.scope&&previous.projectId===value.projectId&&previous.taskId===value.taskId&&
        previous.previewId===value.previewId&&previous.contentVersion===value.contentVersion&&previous.idempotencyKey===value.idempotencyKey&&previous.createdAt===value.createdAt;
      const conflictingFeedback=Boolean(previous.feedbackId&&value.feedbackId&&previous.feedbackId!==value.feedbackId);
      const bothCreated=previous.result&&value.result&&['confirmed','created_unavailable'].includes(previous.result)&&['confirmed','created_unavailable'].includes(value.result);
      const conflictingResult=Boolean(previous.result&&value.result&&previous.result!==value.result&&!bothCreated);
      const conflictingTask=Boolean(previous.taskCreatedId&&value.taskCreatedId&&previous.taskCreatedId!==value.taskCreatedId);
      if(!sameIdentity||conflictingFeedback||conflictingResult||conflictingTask||previous.conflict||value.conflict){
        groups.set(value.id,{...previous,result:undefined,conflict:true});continue;
      }
      groups.set(value.id,{...previous,kind:previous.kind==='confirm'||value.kind==='confirm'?'confirm':'draft',
        feedbackId:previous.feedbackId||value.feedbackId,
        result:previous.result==='created_unavailable'||value.result==='created_unavailable'?'created_unavailable':previous.result||value.result,
        taskCreatedId:previous.taskCreatedId||value.taskCreatedId});
    }
    return [...groups.values()].sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
  }catch{throw new Error('无法读取反馈恢复记录。请检查浏览器存储；此前反馈结果需要核实。');}
}

export function previewFeedbackStorageEvent(event:StorageEvent):boolean {
  return event.key===null||event.key.startsWith(prefix);
}
