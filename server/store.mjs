import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { EventEmitter } from 'node:events';
import { Journal } from './journal.mjs';
import { pendingChecks } from './verification.mjs';
import { isReviewRejectionCode } from './review-rejection.mjs';
import { previewPagePath } from './preview/registry.mjs';

export class BoardError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}
const confirmedReviewRollbacks = new WeakSet();
const reviewRejectionTasks = new WeakMap();
const reviewProofTransaction = Symbol('review rollback proof');
class ReviewRejection extends BoardError {
  constructor(message, code, taskId) { super(message,409,code);reviewRejectionTasks.set(this,taskId); }
}
export function confirmedReviewRejectionCode(error, taskId) {
  return error instanceof ReviewRejection && confirmedReviewRollbacks.has(error) && reviewRejectionTasks.get(error)===taskId && isReviewRejectionCode(error.code) ? error.code : null;
}
const states = new Set(['planned','running','paused','blocked','submitted','failed','cancelled']);
const stamp = () => new Date().toISOString();
const id = () => randomUUID();
export function text(value, field, max=10000, required=false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new BoardError(`${field}格式不正确`);
  return value.trim();
}
function criteria(value) {
  if (!Array.isArray(value) || value.length > 100) throw new BoardError('验收条件需为列表，最多 100 项');
  return value.map(v=>({id:id(),text:text(typeof v==='string'?v:v?.text,'验收条件',2000,true),passed:false}));
}
function sourceConversation(value){
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['provider','conversationId','label'].includes(k)))throw new BoardError('来源会话格式不正确');
  return {provider:text(value.provider,'来源工具',100,true),conversationId:text(value.conversationId,'来源会话',300,true),label:text(value.label,'会话名称',240)};
}
const remoteTaskKey = ({tenantId,nodeId,subjectId,commandId}) =>
  'remote.task.create.v1.'+createHash('sha256').update(JSON.stringify([tenantId,nodeId,subjectId,commandId])).digest('hex');
function previewFeedbackPayload(input) {
  const preview=input?.sourcePreview;
  let pagePathValid=true;try{previewPagePath(input?.pagePath);}catch{pagePathValid=false;}
  if(!input||typeof input!=='object'||!preview||
    ![input.idempotencyKey,input.projectId,preview.previewId,preview.taskId].every(value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value))||
    !Number.isSafeInteger(preview.contentVersion)||preview.contentVersion<1||
    typeof preview.artifactDigest!=='string'||!/^[a-f0-9]{64}$/.test(preview.artifactDigest)||!pagePathValid||
    !Array.isArray(input.criterionIds)||input.criterionIds.length>100||
    input.criterionIds.some(value=>typeof value!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value))||
    !Array.isArray(input.criterionItems)||input.criterionItems.length!==input.criterionIds.length||
    input.criterionItems.some((item,index)=>item?.id!==input.criterionIds[index]||typeof item.text!=='string'||!item.text.trim()||item.text.length>2000)||
    typeof preview.environment!=='string'||preview.environment.length>80||!['real','simulated'].includes(preview.dataMode)||
    typeof input.reporterUserId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(input.reporterUserId))
    throw new BoardError('预览反馈关联无效',400,'PREVIEW_FEEDBACK_INVALID');
  const summary=text(input.summary,'反馈说明',4000,true);
  const canonical={feedbackId:input.idempotencyKey,projectId:input.projectId,previewId:preview.previewId,
    sourceTaskId:preview.taskId,sourceContentVersion:preview.contentVersion,artifactDigest:preview.artifactDigest,
    environment:preview.environment,dataMode:preview.dataMode,pagePath:input.pagePath,summary,
    criterionIds:input.criterionIds,criterionItems:input.criterionItems,reporterUserId:input.reporterUserId};
  return {canonical,payloadHash:createHash('sha256').update(JSON.stringify(canonical)).digest('hex')};
}
export class Store extends EventEmitter {
  constructor(path) {
    super(); mkdirSync(dirname(path),{recursive:true});
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, directory TEXT UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,project_id TEXT,type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,hash TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preview_feedback_receipts(feedback_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS preview_feedback_outcomes(feedback_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,
        project_id TEXT NOT NULL,preview_id TEXT NOT NULL,source_task_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('created','not_applied')),task_id TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preview_feedback_store_identity(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    if(this.db.prepare('PRAGMA foreign_key_list(preview_feedback_receipts)').all().some(row=>row.on_delete!=='CASCADE')){
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.exec(`CREATE TABLE preview_feedback_receipts_migrated(feedback_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE);
          INSERT INTO preview_feedback_receipts_migrated SELECT * FROM preview_feedback_receipts;
          DROP TABLE preview_feedback_receipts;
          ALTER TABLE preview_feedback_receipts_migrated RENAME TO preview_feedback_receipts;`);
        this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    this.depth=0;this.txId=null;this.journal=new Journal(this,BoardError);
    if(!this.db.prepare('SELECT id FROM preview_feedback_store_identity').get())
      this.db.prepare('INSERT INTO preview_feedback_store_identity(id) VALUES(?)').run(id());
    this.backfillReviewHistory();
    this.rebuildPreviewFeedbackReceipts();
  }
  previewFeedbackStoreId(){return this.db.prepare('SELECT id FROM preview_feedback_store_identity').get().id;}
  transaction(fn, proofMode=null) {
    if(this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;this.txId=id();
    let result,callbackCompleted=false;
    try { result=fn();callbackCompleted=true;this.db.exec('COMMIT'); }
    catch(e) {
      this.db.exec('ROLLBACK');
      if(proofMode===reviewProofTransaction && !callbackCompleted && e instanceof ReviewRejection && isReviewRejectionCode(e.code)) confirmedReviewRollbacks.add(e);
      throw e;
    }
    finally{this.depth--;this.txId=null;}
    this.emit('change');return result;
  }
  backfillReviewHistory(){
    const legacy=this.db.prepare('SELECT id,data FROM tasks').all().filter(row=>{const task=JSON.parse(row.data);return task.review&&!Array.isArray(task.reviewHistory);});
    if(legacy.length)this.transaction(()=>{const update=this.db.prepare('UPDATE tasks SET data=? WHERE id=?');for(const row of legacy){const task=JSON.parse(row.data);task.reviewHistory=[task.review];update.run(JSON.stringify(task),row.id);}});
  }
  event(projectId,type,payload) {
    this.db.prepare('INSERT INTO events(id,project_id,type,data,created_at) VALUES(?,?,?,?,?)').run(id(),projectId||null,type,JSON.stringify(payload),stamp());
  }
  projects() {return this.db.prepare('SELECT data FROM projects ORDER BY rowid').all().map(r=>JSON.parse(r.data));}
  tasks(projectId) {return (projectId?this.db.prepare('SELECT data FROM tasks WHERE project_id=?').all(projectId):this.db.prepare('SELECT data FROM tasks').all()).map(r=>JSON.parse(r.data));}
  getProject(projectId) {const r=this.db.prepare('SELECT data FROM projects WHERE id=?').get(projectId);if(!r)throw new BoardError('项目不存在',404);return JSON.parse(r.data);}
  getTask(taskId) {const r=this.db.prepare('SELECT data FROM tasks WHERE id=?').get(taskId);if(!r)throw new BoardError('任务不存在',404);return JSON.parse(r.data);}
  lastFileReport(projectId,directory) {
    const row=this.db.prepare(`SELECT receipts.data FROM receipts JOIN tasks
      ON tasks.id=json_extract(receipts.data,'$.taskId')
      WHERE tasks.project_id=? AND json_extract(receipts.data,'$.fileDirectory')=?
        AND json_extract(receipts.data,'$.fileReceivedAt') IS NOT NULL
      ORDER BY json_extract(receipts.data,'$.fileReceivedAt') DESC, receipts.rowid DESC LIMIT 1`).get(projectId,directory);
    if(!row)return null;
    const receipt=JSON.parse(row.data);
    return {eventId:receipt.eventId,taskId:receipt.taskId,receivedAt:receipt.fileReceivedAt};
  }
  project(input) {
    let directory=null;
    if(input.directory){if(!isAbsolute(input.directory))throw new BoardError('请选择绝对项目路径');try{directory=realpathSync(input.directory);if(!statSync(directory).isDirectory())throw Error();}catch{throw new BoardError('项目目录不存在或不可访问');}}
    const existing=directory&&this.projects().find(p=>p.directory===directory);if(existing)return existing;
    const p={id:id(),name:text(input.name,'项目名',160,true),goal:text(input.goal,'项目目标'),constraints:criteria(input.constraints||[]).map(c=>c.text),directory,createdAt:stamp()};
    return this.transaction(()=>{this.db.prepare('INSERT INTO projects VALUES(?,?,?)').run(p.id,directory,JSON.stringify(p));this.event(p.id,'project.created',{id:p.id,name:p.name});return p;});
  }
  createTask(input) {
    this.getProject(input.projectId);
    const t={id:id(),projectId:input.projectId,title:text(input.title,'任务名',240,true),goal:text(input.goal,'任务目标'),summary:text(input.summary,'进度'),example:text(input.example,'例子'),approach:text(input.approach,'方案'),nextStep:'',sourceConversation:sourceConversation(input.sourceConversation),executionProvider:text(input.executionProvider||'codex-autocontinue','执行工具',100,true),status:'planned',acceptance:'unverified',criteria:criteria(input.criteria||[]),evidence:[],issues:[],verification:null,revision:1,contentVersion:1,conversationId:text(input.conversationId,'会话 ID',300),blockedReason:'',updatedAt:stamp(),createdAt:stamp()};
    return this.transaction(()=>{this.db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(t.id,t.projectId,JSON.stringify(t));this.event(t.projectId,'task.created',{taskId:t.id,title:t.title});return t;});
  }
  remoteTaskCreation(input) {
    const row=this.db.prepare('SELECT value FROM metadata WHERE key=?').get(remoteTaskKey(input));
    if(!row)return null;
    const saved=JSON.parse(row.value);
    const task=this.db.prepare('SELECT project_id FROM tasks WHERE id=?').get(saved.taskId);
    if(saved.projectId!==input.projectId||!task||task.project_id!==input.projectId)return null;
    return saved;
  }
  createRemoteTask(input) {
    const payloadHash=createHash('sha256').update(JSON.stringify([input.projectId,input.body])).digest('hex');
    return this.transaction(()=>{
      const prior=this.remoteTaskCreation(input);
      if(prior){
        if(prior.payloadHash!==payloadHash)throw new BoardError('远程命令已用于其他任务内容',409,'COMMAND_CONFLICT');
        return {taskId:prior.taskId,status:'planned',revision:1};
      }
      if(this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get(remoteTaskKey(input)))
        throw new BoardError('原远程任务记录缺失，不能重复创建',409,'TASK_CREATE_UNKNOWN');
      const task=this.createTask({projectId:input.projectId,...input.body});
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(remoteTaskKey(input),
        JSON.stringify({projectId:input.projectId,taskId:task.id,payloadHash}));
      return {taskId:task.id,status:'planned',revision:1};
    });
  }
  createPreviewFeedbackTask(input) {
    const preview=input?.sourcePreview;
    const {canonical,payloadHash}=previewFeedbackPayload(input);
    const result=this.transaction(()=>{
      const outcome=this.db.prepare('SELECT * FROM preview_feedback_outcomes WHERE feedback_id=?').get(input.idempotencyKey);
      if(outcome){
        if(outcome.payload_hash!==payloadHash||outcome.project_id!==input.projectId||outcome.preview_id!==preview.previewId)
          throw new BoardError('反馈标识已关联其他内容',409,'PREVIEW_FEEDBACK_CONFLICT');
        if(outcome.status==='not_applied')throw new BoardError('反馈创建已确认未执行',409,'PREVIEW_FEEDBACK_NOT_APPLIED');
        return this.previewTaskMatchingOutcome(outcome);
      }
      const receipt=this.db.prepare('SELECT payload_hash,task_id FROM preview_feedback_receipts WHERE feedback_id=?').get(input.idempotencyKey);
      if(receipt){
        if(receipt.payload_hash!==payloadHash)throw new BoardError('反馈标识已关联其他内容',409,'PREVIEW_FEEDBACK_CONFLICT');
        this.db.prepare('INSERT INTO preview_feedback_outcomes VALUES(?,?,?,?,?,?,?,?)')
          .run(input.idempotencyKey,payloadHash,input.projectId,preview.previewId,preview.taskId,'created',receipt.task_id,stamp());
        return this.previewTaskMatchingOutcome({feedback_id:input.idempotencyKey,payload_hash:payloadHash,
          project_id:input.projectId,task_id:receipt.task_id});
      }
      const source=this.getTask(preview.taskId);
      if(source.projectId!==input.projectId)throw new BoardError('反馈源任务已更换项目',409,'PREVIEW_SOURCE_CHANGED');
      const selected=input.criterionItems.map(item=>`在新版预览中重验：${item.text}`);
      const task=this.createTask({projectId:input.projectId,title:`预览反馈：${canonical.summary.slice(0,100)}`,
        goal:`修复预览 ${preview.previewId} 页面 ${input.pagePath} 的反馈：${canonical.summary}`,
        summary:'已从预览反馈确认创建，待修复并在新版预览重验。',
        criteria:selected.length?selected:['在新版实际运行预览中复核该反馈'],
        example:`来源预览 ${preview.previewId}；构建 ${preview.artifactDigest}；页面 ${input.pagePath}`});
      task.previewFeedback=canonical;
      this.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(task),task.id);
      this.db.prepare('INSERT INTO preview_feedback_receipts VALUES(?,?,?)').run(input.idempotencyKey,payloadHash,task.id);
      this.db.prepare('INSERT INTO preview_feedback_outcomes VALUES(?,?,?,?,?,?,?,?)')
        .run(input.idempotencyKey,payloadHash,input.projectId,preview.previewId,preview.taskId,'created',task.id,stamp());
      return task;
    });
    if(!result)throw new BoardError('反馈任务曾创建但现已不可用',409,'PREVIEW_FEEDBACK_CREATED_UNAVAILABLE');
    return result;
  }
  previewTaskMatchingOutcome(outcome){
    if(!outcome?.task_id)return null;
    const row=this.db.prepare('SELECT data FROM tasks WHERE id=?').get(outcome.task_id);
    if(!row)return null;
    try{
      const task=JSON.parse(row.data),receipt=this.previewReceiptForTask(task);
      return task.projectId===outcome.project_id&&receipt?.feedbackId===outcome.feedback_id&&
        receipt.payloadHash===outcome.payload_hash&&receipt.taskId===outcome.task_id?task:null;
    }catch{return null;}
  }
  reconcilePreviewFeedbackTask(input,{allowFence=false}={}) {
    const {canonical,payloadHash}=previewFeedbackPayload(input);
    return this.transaction(()=>{
      let outcome=this.db.prepare('SELECT * FROM preview_feedback_outcomes WHERE feedback_id=?').get(canonical.feedbackId);
      if(!outcome){
        const receipt=this.db.prepare('SELECT payload_hash,task_id FROM preview_feedback_receipts WHERE feedback_id=?').get(canonical.feedbackId);
        if(receipt){
          if(receipt.payload_hash!==payloadHash)throw new BoardError('反馈标识已关联其他内容',409,'PREVIEW_FEEDBACK_CONFLICT');
          this.db.prepare('INSERT INTO preview_feedback_outcomes VALUES(?,?,?,?,?,?,?,?)')
            .run(canonical.feedbackId,payloadHash,canonical.projectId,canonical.previewId,canonical.sourceTaskId,'created',receipt.task_id,stamp());
          outcome=this.db.prepare('SELECT * FROM preview_feedback_outcomes WHERE feedback_id=?').get(canonical.feedbackId);
        } else if(allowFence){
          this.db.prepare('INSERT INTO preview_feedback_outcomes VALUES(?,?,?,?,?,?,?,?)')
            .run(canonical.feedbackId,payloadHash,canonical.projectId,canonical.previewId,canonical.sourceTaskId,'not_applied',null,stamp());
          outcome=this.db.prepare('SELECT * FROM preview_feedback_outcomes WHERE feedback_id=?').get(canonical.feedbackId);
        } else return {status:'unknown'};
      }
      if(outcome.payload_hash!==payloadHash||outcome.project_id!==canonical.projectId||outcome.preview_id!==canonical.previewId||
        outcome.source_task_id!==canonical.sourceTaskId)throw new BoardError('反馈标识已关联其他内容',409,'PREVIEW_FEEDBACK_CONFLICT');
      if(outcome.status==='not_applied')return {status:'not_applied'};
      return {status:this.previewTaskMatchingOutcome(outcome)?'confirmed':'created_unavailable',taskId:outcome.task_id};
    });
  }
  previewReceiptForTask(task) {
    const value=task.previewFeedback;
    if(value==null)return null;
    if(!value||typeof value!=='object'||Array.isArray(value)||
      ![value.feedbackId,value.projectId,value.previewId,value.sourceTaskId].every(item=>typeof item==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(item))||
      value.projectId!==task.projectId||!Number.isSafeInteger(value.sourceContentVersion)||value.sourceContentVersion<1||
      typeof value.artifactDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.artifactDigest))
      throw new BoardError('预览反馈关联损坏',400,'PREVIEW_FEEDBACK_INVALID');
    return {feedbackId:value.feedbackId,payloadHash:createHash('sha256').update(JSON.stringify(value)).digest('hex'),taskId:task.id};
  }
  rebuildPreviewFeedbackReceipts() {
    for(const row of this.db.prepare('SELECT id,data FROM tasks').all()){
      const receipt=this.previewReceiptForTask(JSON.parse(row.data));if(!receipt)continue;
      const prior=this.db.prepare('SELECT payload_hash,task_id FROM preview_feedback_receipts WHERE feedback_id=?').get(receipt.feedbackId);
      if(prior&&(prior.payload_hash!==receipt.payloadHash||prior.task_id!==receipt.taskId))
        throw new BoardError('预览反馈收据冲突',409,'PREVIEW_FEEDBACK_CONFLICT');
      if(!prior)this.db.prepare('INSERT INTO preview_feedback_receipts VALUES(?,?,?)').run(receipt.feedbackId,receipt.payloadHash,receipt.taskId);
      const outcome=this.db.prepare('SELECT * FROM preview_feedback_outcomes WHERE feedback_id=?').get(receipt.feedbackId);
      if(outcome&&(outcome.payload_hash!==receipt.payloadHash||outcome.task_id!==receipt.taskId||outcome.status!=='created'))
        throw new BoardError('预览反馈结果冲突',409,'PREVIEW_FEEDBACK_CONFLICT');
      if(!outcome)this.db.prepare('INSERT INTO preview_feedback_outcomes VALUES(?,?,?,?,?,?,?,?)')
        .run(receipt.feedbackId,receipt.payloadHash,JSON.parse(row.data).projectId,JSON.parse(row.data).previewFeedback.previewId,
          JSON.parse(row.data).previewFeedback.sourceTaskId,'created',receipt.taskId,stamp());
    }
  }
  bindDirectory(projectId,input){
    if(typeof input.directory!=='string'||!isAbsolute(input.directory))throw new BoardError('请选择项目绝对路径');
    let directory;try{directory=realpathSync(input.directory);if(!statSync(directory).isDirectory())throw Error();}catch{throw new BoardError('项目目录不可访问');}
    return this.transaction(()=>{const p=this.getProject(projectId);if(this.tasks(projectId).some(t=>t.status==='running'||t.conversationId))throw new BoardError('请先停止任务并解除会话绑定，再更换目录',409);if(this.projects().some(v=>v.id!==projectId&&v.directory===directory))throw new BoardError('该目录已关联其他项目',409);p.directory=directory;this.db.prepare('UPDATE projects SET directory=?,data=? WHERE id=?').run(directory,JSON.stringify(p),p.id);this.event(p.id,'project.directory_bound',{id:p.id});return p;});
  }
  checkRevision(task,expected) {if(!Number.isInteger(expected)||task.revision!==expected)throw new BoardError('任务已更新，请刷新后重试',409,'REVISION_CONFLICT');}
  saveTask(t,type,meta={}) {t.revision++;t.updatedAt=stamp();this.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(t),t.id);this.event(t.projectId,type,{taskId:t.id,title:t.title,revision:t.revision,...meta});return t;}
  updateTask(taskId,patch,expectedRevision) {
    return this.transaction(()=>{
      const t=this.getTask(taskId);this.checkRevision(t,expectedRevision);
      const allowed=new Set(['title','goal','example','summary','approach','nextStep','status','criteria','conversationId','executionProvider','blockedReason','implementationRef','sourceConversation','expectedRevision']);
      for(const key of Object.keys(patch))if(!allowed.has(key))throw new BoardError(`不允许直接修改 ${key}`);
      let contentChanged=false;
      for(const field of ['title','goal','example','summary','approach','nextStep','conversationId','blockedReason','implementationRef']) {
        if(!(field in patch))continue;
        const value=text(patch[field],field,field==='title'?240:10000,field==='title');
        if(value!==t[field]&&(!['nextStep','blockedReason'].includes(field)||t.acceptance==='passed'||(t.verification?.status==='passed'&&t.verification.contentVersion===t.contentVersion)))contentChanged=true;
        if(field==='conversationId'&&t.status==='running'&&value!==t[field])throw new BoardError('运行中不能更换关联会话');
        t[field]=value;
      }
      if('sourceConversation' in patch)t.sourceConversation=sourceConversation(patch.sourceConversation);
      if('executionProvider' in patch){const provider=text(patch.executionProvider,'执行工具',100,true);if(provider!==t.executionProvider){if(t.status==='running'||t.conversationId)throw new BoardError('请先停止任务并解除会话绑定，再更换执行工具',409);t.executionProvider=provider;contentChanged=true;}}
      if('criteria' in patch){t.criteria=criteria(patch.criteria);contentChanged=true;}
      if('status' in patch){if(!states.has(patch.status))throw new BoardError('未知任务状态');if(patch.status!==t.status&&(patch.status==='running'||t.acceptance==='passed'||(t.verification?.status==='passed'&&t.verification.contentVersion===t.contentVersion)))contentChanged=true;if(patch.status==='blocked'&&t.status!=='blocked')t.blockedOccurrence=id();t.status=patch.status;}
      if(contentChanged){t.contentVersion++;t.acceptance=t.evidence.length?'stale':'unverified';t.criteria=t.criteria.map(c=>({...c,passed:false}));}
      return this.saveTask(t,'task.updated',{contentChanged});
    });
  }
  addEvidence(taskId,input,source='user') {
    return this.transaction(()=>{const t=this.getTask(taskId);this.checkRevision(t,input.expectedRevision);t.evidence.push({id:id(),summary:text(input.summary,'证据说明',5000,true),reference:text(input.reference,'证据位置',4000,true),source,contentVersion:t.contentVersion,createdAt:stamp()});return this.saveTask(t,'evidence.added');});
  }
  verify(taskId,input) {
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['expectedRevision','status','summary','reference','criterionIds','pendingChecks'].includes(key)))throw new BoardError('测试验证请求格式不正确');
    return this.transaction(()=>{
      const t=this.getTask(taskId);this.checkRevision(t,input.expectedRevision);
      if(!['unverified','passed','partial','failed'].includes(input.status))throw new BoardError('未知测试验证状态');
      const summary=text(input.summary,'测试说明',5000,true),reference=text(input.reference,'测试依据',4000,true);
      if(!Array.isArray(input.criterionIds)||input.criterionIds.length>100||input.criterionIds.some(value=>typeof value!=='string'||!value))throw new BoardError('测试覆盖条件格式不正确');
      const criterionIds=new Set(input.criterionIds),available=new Set(t.criteria.map(item=>item.id));
      if(criterionIds.size!==input.criterionIds.length||[...criterionIds].some(value=>!available.has(value)))throw new BoardError('测试覆盖条件重复或不属于当前任务');
      const previous=t.verification?.pendingChecks||[];
      if(input.pendingChecks===undefined&&previous.length&&t.verification.contentVersion!==t.contentVersion)
        throw new BoardError('请重新确认当前版本的待办清单');
      const checks=pendingChecks(input.pendingChecks===undefined?previous:input.pendingChecks,available,BoardError);
      if(input.status==='unverified'&&criterionIds.size)throw new BoardError('未执行的验证计划不能标记已覆盖验收条件');
      if(input.status==='passed'){
        if(checks.length)throw new BoardError('仍有待验证事项，不能记录整项测试通过');
        if(!available.size||criterionIds.size!==available.size)throw new BoardError('通过测试必须覆盖全部验收条件');
        if(t.status!=='submitted')throw new BoardError('请先提交结果，再记录整项测试通过');
        if(t.issues.some(issue=>issue.open))throw new BoardError('仍有未解决偏差，不能记录整项测试通过');
      }
      t.verification={status:input.status,summary,reference,criterionIds:[...criterionIds],pendingChecks:checks,source:'test',contentVersion:t.contentVersion,createdAt:stamp()};
      return this.saveTask(t,'task.verified',{status:input.status,criterionIds:t.verification.criterionIds});
    });
  }
  setVerificationCheck(taskId,checkId,input) {
    if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.completed!=='boolean'||Object.keys(input).some(key=>!['expectedRevision','completed'].includes(key)))throw new BoardError('待办状态请求格式不正确');
    return this.transaction(()=>{
      const t=this.getTask(taskId);this.checkRevision(t,input.expectedRevision);
      const v=t.verification;
      if(!v||v.contentVersion!==t.contentVersion)throw new BoardError('验证计划已过期，请先确认当前版本的计划',409,'VERIFICATION_STALE');
      const check=v.pendingChecks?.find(item=>item.id===checkId);
      if(!check)throw new BoardError('验证待办不存在',404);
      if((check.completed??false)===input.completed)return t;
      check.completed=input.completed;
      // Manual checklist completion is independent of test evidence and human acceptance.
      return this.saveTask(t,'verification.check.updated',{checkId,completed:input.completed,source:'human'});
    });
  }
  review(taskId,input,actor=null) {
    return this.transaction(()=>{
      const t=this.getTask(taskId);this.checkRevision(t,input.expectedRevision);const summary=text(input.summary,'验收说明',5000,true);
      if(input.decision==='pass'){
        if(t.status!=='submitted')throw new ReviewRejection('请先提交结果，再进行验收','REVIEW_NOT_SUBMITTED',taskId);
        if(!t.criteria.length)throw new ReviewRejection('请先定义验收条件','REVIEW_CRITERIA_REQUIRED',taskId);
        if(!t.evidence.some(e=>e.contentVersion===t.contentVersion))throw new ReviewRejection('缺少当前版本的验收证据','REVIEW_CURRENT_EVIDENCE_REQUIRED',taskId);
        if(t.issues.some(i=>i.open))throw new ReviewRejection('请先处理未解决的交付偏差','REVIEW_OPEN_ISSUES',taskId);
        t.acceptance='passed';t.criteria=t.criteria.map(c=>({...c,passed:true}));
      }else if(input.decision==='fail'){
        t.acceptance='failed';t.issues.push({id:id(),summary,open:true,kind:'confirmed',createdAt:stamp()});
      }else throw new BoardError('未知验收结论');
      if(t.review&&!Array.isArray(t.reviewHistory))t.reviewHistory=[t.review];
      t.review={decision:input.decision,summary,source:'human',...(actor?{actor}:{}),contentVersion:t.contentVersion,createdAt:stamp()};
      t.reviewHistory=[...(t.reviewHistory||[]),t.review];
      return this.saveTask(t,'task.reviewed',{decision:input.decision,summary});
    },reviewProofTransaction);
  }
  resolveIssue(taskId,issueId,expectedRevision) {
    return this.transaction(()=>{const t=this.getTask(taskId);this.checkRevision(t,expectedRevision);const issue=t.issues.find(i=>i.id===issueId);if(!issue)throw new BoardError('偏差记录不存在',404);issue.open=false;issue.resolvedAt=stamp();t.acceptance='unverified';t.contentVersion++;t.criteria=t.criteria.map(c=>({...c,passed:false}));if(t.status==='submitted')t.status='planned';return this.saveTask(t,'issue.resolved');});
  }
  settings() {return {theme:'system',...Object.fromEntries(this.db.prepare('SELECT * FROM settings').all().map(x=>[x.key,JSON.parse(x.data)]))};}
  setSettings(input) {
    if(!['system','light','dark'].includes(input.theme)||Object.keys(input).some(k=>k!=='theme'))throw new BoardError('未知外观设置');
    return this.transaction(()=>{this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('theme',JSON.stringify(input.theme));return this.settings();});
  }
  events() {return this.db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT 80').all().map(e=>({seq:e.seq,id:e.id,type:e.type,projectId:e.project_id,...JSON.parse(e.data),createdAt:e.created_at}));}
  history({projectId,taskId,afterSeq=0,limit=100}={}) {
    const cursor=Number(afterSeq),count=Number(limit);
    if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isInteger(count)||count<1||count>500)throw new BoardError('历史分页参数不正确');
    const conditions=['seq>?'],args=[cursor];
    if(projectId){this.getProject(projectId);conditions.push('project_id=?');args.push(projectId);}
    if(taskId){const task=this.getTask(taskId);if(projectId&&task.projectId!==projectId)throw new BoardError('任务不属于该项目');conditions.push("json_extract(data,'$.taskId')=?");args.push(taskId);}
    const events=this.db.prepare(`SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args,count).map(e=>({seq:e.seq,id:e.id,type:e.type,projectId:e.project_id,...JSON.parse(e.data),createdAt:e.created_at}));
    return {events,cursor:events.at(-1)?.seq??cursor};
  }
  exportArchive(){return this.journal.export();}
  restoreArchive(archive){
    for(const row of this.journal.validate(archive).tasks)this.previewReceiptForTask(JSON.parse(row.data));
    return this.transaction(()=>{const result=this.journal.restore(archive);this.rebuildPreviewFeedbackReceipts();this.backfillReviewHistory();return result;});
  }
  replay(){return this.transaction(()=>{const result=this.journal.replay();this.rebuildPreviewFeedbackReceipts();this.backfillReviewHistory();return result;});}
  importProject(directory) {
    if(typeof directory!=='string'||!isAbsolute(directory))throw new BoardError('请选择项目绝对路径');
    let real,source;
    try{real=realpathSync(directory);const path=join(real,'.taskboard','project.json');if(statSync(path).size>2_000_000)throw new BoardError('项目文件过大');source=JSON.parse(readFileSync(path,'utf8'));}catch(e){if(e instanceof BoardError)throw e;throw new BoardError('无法读取该目录的 .taskboard/project.json');}
    const old=this.projects().find(p=>p.directory===real);if(old)return old;
    if(!Array.isArray(source.tasks)||source.tasks.length>10000)throw new BoardError('任务清单格式不正确');
    let referenceCount=0;
    for(const raw of source.tasks){
      if(!raw||typeof raw!=='object')throw new BoardError('任务格式不正确');
      for(const field of ['artifactRefs','dependsOn','acceptanceCriteria'])if(raw[field]!==undefined&&(!Array.isArray(raw[field])||raw[field].length>100))throw new BoardError(`${field} 每个任务最多 100 项`);
      referenceCount+=(raw.artifactRefs||[]).length;if(referenceCount>5000)throw new BoardError('单次导入最多 5000 个证据引用');
    }
    return this.transaction(()=>{
      const p=this.project({name:source.name||'未命名项目',goal:source.goal||'',constraints:source.constraints||[],directory:real});
      for(const raw of source.tasks){
        const t=this.createTask({projectId:p.id,title:raw.title,goal:raw.goal||(raw.acceptanceCriteria||[]).join('；'),summary:raw.summary||(raw.executionStatus==='submitted'?'产物已提交，等待验收。':'尚未开始。'),example:raw.example||'',criteria:raw.acceptanceCriteria||[],approach:raw.approach||'',conversationId:raw.conversationId||''});
        t.sourceId=String(raw.id||'');t.phase=raw.phase||'';t.status=states.has(raw.executionStatus)?raw.executionStatus:'planned';t.dependsOn=Array.isArray(raw.dependsOn)?raw.dependsOn:[];
        for(const ref of raw.artifactRefs||[])t.evidence.push({id:id(),summary:'导入的产物引用（尚未核验）',reference:text(ref,'产物引用',4000,true),source:'import',contentVersion:t.contentVersion,createdAt:stamp()});
        this.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(t),t.id);
      }
      return p;
    });
  }
  applyEvent(input,source='file',fileDirectory=null) {
    if(!input||typeof input!=='object')throw new BoardError('事件格式不正确');
    const eventId=text(input.eventId||input.id,'事件 ID',200,true);const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.transaction(()=>{
      const existing=this.db.prepare('SELECT * FROM receipts WHERE id=?').get(eventId);
      if(existing){if(existing.hash!==hash)throw new BoardError('事件 ID 已用于另一条更新',409);return JSON.parse(existing.data);}
      const payload=input.payload||{};let task;
      if(input.type==='task.create'){
        if(payload.conversationId||payload.executionProvider)throw new BoardError('请由用户在看板中绑定可控制的会话',403);
        task=this.createTask({...payload,projectId:input.projectId});
      }
      else if(input.type==='task.update'){
        const allowed=new Set(['summary','approach','nextStep','status','implementationRef','blockedReason','sourceConversation']);
        for(const field of Object.keys(payload))if(!allowed.has(field))throw new BoardError(`汇报不能修改 ${field}，请由用户确认原始要求`,403);
        const current=this.getTask(input.taskId);
        if(payload.status&&(['paused','cancelled'].includes(payload.status)||(current.status==='paused'&&payload.status!=='paused')||current.status==='cancelled'))throw new BoardError('汇报不能覆盖用户的暂停或取消决定',403);
        task=this.updateTask(input.taskId,payload,input.expectedRevision);
      }
      else if(input.type==='evidence.add')task=this.addEvidence(input.taskId,{...payload,expectedRevision:input.expectedRevision},source);
      else if(input.type==='decision.request'){
        if(typeof this.requestDecision!=='function')throw new BoardError('决策收件箱尚未就绪',503);
        const item=this.requestDecision(input.taskId,{...payload,expectedRevision:input.expectedRevision},source);
        task=this.getTask(input.taskId);
        const result={eventId,status:'accepted',taskId:task.id,revision:task.revision,itemId:item.id,
          ...(source==='file'&&fileDirectory?{fileReceivedAt:stamp(),fileDirectory}: {})};
        this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(eventId,hash,JSON.stringify(result));return result;
      }
      else throw new BoardError('该入口仅允许新增、汇报和附加证据，不能验收或控制执行',403);
      const result={eventId,status:'accepted',taskId:task.id,revision:task.revision,
        ...(source==='file'&&fileDirectory?{fileReceivedAt:stamp(),fileDirectory}: {})};this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(eventId,hash,JSON.stringify(result));return result;
    });
  }
  context(projectId) {
    const p=this.getProject(projectId),tasks=this.tasks(projectId);
    const lines=[`# ${p.name}`,'',p.goal,'','## 规则','','完成以当前版本验收为准；AI 只能汇报进度和证据，不能自行通过人工验收。不要将离线演示替代真实集成。',...(p.constraints||[]).map(c=>`- ${c}`),'','## 当前任务',''];
    const handoff=this.handoffContext?.(projectId);
    if(handoff)lines.push(handoff,'');
    for(const t of tasks){if(t.status==='cancelled')continue;const v=t.verification;const versionCurrent=v?.contentVersion===t.contentVersion;const covered=v&&t.criteria.length>0&&t.criteria.every(c=>v.criterionIds.includes(c.id));const conditionsCurrent=v?.status!=='passed'||(t.status==='submitted'&&!t.issues.some(i=>i.open)&&covered);const validity=!versionCurrent?'旧版，已过期':conditionsCurrent?'当前内容':'当前条件已失效';lines.push(`### ${t.sourceId||t.id} · ${t.title}`,`- 状态：${t.status}；人工验收：${t.acceptance}；修订：${t.revision}`,`- 测试验证：${v?`${v.status==='unverified'?'unverified（验证计划，未执行）':v.status}（${validity}）；覆盖 ${v.criterionIds.length}/${t.criteria.length} 项；依据：${v.reference}`:'尚无记录'}。测试验证不等于人工验收。`,`- 目标：${t.goal}`,`- 进度：${t.summary}`,`- 方案：${t.approach||'尚未记录'}`,`- 下一步：${t.nextStep||'依照验收条件继续'}`,`- 验收：${t.criteria.map(c=>c.text).join('；')||'尚未定义'}`,...(v?.pendingChecks||[]).flatMap((check,index)=>[`- ${check.completed?'已办结（人工标记）':'未验证'} ${index+1}（${check.kind}；记录版本 ${v.contentVersion}${versionCurrent?'，当前版本':'，已过期'}）：${check.title}`,`  - 关联验收条件：${check.criterionIds.map(id=>t.criteria.find(c=>c.id===id)?.text||id).join('；')}`,`  - 操作步骤：${check.steps.join('；')}`,`  - 通过标准：${check.expectedResult}`,...(check.blockedReason?[`  - 阻塞原因：${check.blockedReason}`]:[])]),...t.issues.filter(i=>i.open).map(i=>`- 未解决偏差：${i.summary}`),...t.evidence.slice(-3).map(e=>`- 证据（${e.source}）：${e.reference}`),'');}
    const pendingDecisions=(this.inbox?.state().items||[]).filter(item=>item.projectId===projectId&&item.kind==='decision'&&['open','acknowledged'].includes(item.state));
    for(const task of tasks){
      const known=Array.isArray(task.decisions)?task.decisions.filter(item=>item?.source==='human'&&typeof item.answer==='string'):[];
      const supplements=Array.isArray(task.supplementHistory)?task.supplementHistory.filter(item=>item?.source==='human'&&typeof item.answer==='string'):[];
      const pending=pendingDecisions.filter(item=>item.taskId===task.id);
      if(!known.length&&!pending.length&&!supplements.length)continue;
      lines.push(`### ${task.sourceId||task.id} · 人工决策与补充`);
      for(const item of known)lines.push(`- 已答复（内容版本 ${item.contentVersion}）：${item.answer}${item.optionId?`；选项 ${item.optionId}`:''}`);
      for(const item of pending)lines.push(`- 待答复（内容版本 ${item.contentVersion}）：${item.title}；${item.summary}；影响：${item.impact}`,
        ...((item.options||[]).map(option=>`  - ${option.id}：${option.label}；后果：${option.consequence}`)));
      for(const item of supplements)lines.push(`- 人工补充（内容版本 ${item.contentVersion}）：${item.answer}`);
      lines.push('');
    }
    return lines.join('\n');
  }
  close(){if(this.db.isOpen)this.db.close();}
}
