import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pendingChecks} from './verification.mjs';

const tables={projects:['id','directory','data'],tasks:['id','project_id','data'],events:['seq','id','project_id','type','data','created_at'],receipts:['id','hash','data'],settings:['key','data'],metadata:['key','value']};
const keys={projects:'id',tasks:'id',events:'seq',receipts:'id',settings:'key',metadata:'key'};
const schema=`CREATE TABLE projects(id TEXT PRIMARY KEY,directory TEXT UNIQUE,data TEXT NOT NULL);
CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
CREATE TABLE events(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,project_id TEXT,type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE receipts(id TEXT PRIMARY KEY,hash TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Row images are captured in the same SQLite transaction as the projection.
// Replaying these records never invokes file, plugin or provider operations.
export class Journal {
 constructor(store,ErrorType){
  this.store=store;this.db=store.db;this.Error=ErrorType;this.enabled=true;
  this.db.exec(`CREATE TABLE IF NOT EXISTS journal_entries(seq INTEGER PRIMARY KEY AUTOINCREMENT,tx TEXT NOT NULL,entity TEXT NOT NULL,operation TEXT NOT NULL,row_key TEXT NOT NULL,data TEXT NOT NULL);`);
  this.db.function('journal_enabled',()=>this.enabled?1:0);
  this.db.function('journal_tx',()=>store.txId||randomUUID());
  for(const [table,columns] of Object.entries(tables))for(const [action,ref] of [['INSERT','NEW'],['UPDATE','NEW'],['DELETE','OLD']]){
   const json=columns.map(c=>`'${c}',${ref}.${c}`).join(',');
   this.db.exec(`CREATE TRIGGER IF NOT EXISTS journal_${table}_${action} AFTER ${action} ON ${table} WHEN journal_enabled()=1 BEGIN INSERT INTO journal_entries(tx,entity,operation,row_key,data) VALUES(journal_tx(),'${table}','${action==='DELETE'?'delete':'put'}',CAST(${ref}.${keys[table]} AS TEXT),json_object(${json})); END;`);
  }
  if(!this.db.prepare('SELECT 1 FROM journal_entries LIMIT 1').get())store.transaction(()=>this.checkpoint());
 }
 checkpoint(){
  const insert=this.db.prepare('INSERT INTO journal_entries(tx,entity,operation,row_key,data) VALUES(?,?,?,?,?)');
  for(const table of Object.keys(tables))for(const row of this.db.prepare(`SELECT * FROM ${table}`).all())insert.run(this.store.txId||randomUUID(),table,'put',String(row[keys[table]]),JSON.stringify(row));
 }
 rows(){return this.db.prepare('SELECT * FROM journal_entries ORDER BY seq').all().map(r=>({...r}));}
 export(){
  // A portable checkpoint carries current row images and the audit/receipt
  // history, without every overwritten copy of a potentially large task.
  const latest=this.db.prepare(`SELECT * FROM (SELECT *, ROW_NUMBER() OVER(PARTITION BY entity,row_key ORDER BY seq DESC) AS rank FROM journal_entries) WHERE rank=1 AND operation='put'`).all();
  const order=Object.keys(tables),tx=randomUUID();latest.sort((a,b)=>order.indexOf(a.entity)-order.indexOf(b.entity)||a.seq-b.seq);
  const journal=latest.map(({entity,operation,row_key,data},i)=>({seq:i+1,tx,entity,operation,row_key,data}));
  const payload={format:'tuijin-archive',version:1,createdAt:new Date().toISOString(),journal};const archive={...payload,digest:digest(payload)};
  if(journal.length>100000||Buffer.byteLength(JSON.stringify(archive))>16_000_000)throw new this.Error('备份超过当前单文件上限（16 MB / 100000 条），未生成不完整备份');
  return archive;
 }
 validate(archive,{internal=false}={}){
  const fail=message=>{throw new this.Error(message);};
  if(!archive||archive.format!=='tuijin-archive'||archive.version!==1||!Array.isArray(archive.journal)||(!internal&&(archive.journal.length>100000||Buffer.byteLength(JSON.stringify(archive))>16_000_000)))fail('备份格式或大小不符合要求');
  const {digest:checksum,...payload}=archive;if(checksum!==digest(payload))fail('备份校验失败，文件可能不完整');
  const tmp=new DatabaseSync(':memory:');tmp.exec('PRAGMA foreign_keys=ON;'+schema);
  try{
   let previous=0;
   for(const entry of archive.journal){
    if(!Number.isSafeInteger(entry.seq)||entry.seq<=previous||!Object.hasOwn(tables,entry.entity)||!['put','delete'].includes(entry.operation)||typeof entry.data!=='string'||typeof entry.tx!=='string')fail('备份记录不合法');previous=entry.seq;
    const row=JSON.parse(entry.data),cols=tables[entry.entity];
    if(!row||Object.keys(row).length!==cols.length||cols.some(c=>!Object.hasOwn(row,c))||String(row[keys[entry.entity]])!==entry.row_key)fail('备份实体不合法');
    for(const c of cols)if(!(typeof row[c]==='string'||(c==='seq'&&Number.isSafeInteger(row[c]))||(['directory','project_id'].includes(c)&&row[c]===null)))fail('备份字段不合法');
    if(entry.operation==='delete')tmp.prepare(`DELETE FROM ${entry.entity} WHERE ${keys[entry.entity]}=?`).run(row[keys[entry.entity]]);
    else tmp.prepare(`INSERT INTO ${entry.entity}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')}) ON CONFLICT(${keys[entry.entity]}) DO UPDATE SET ${cols.filter(c=>c!==keys[entry.entity]).map(c=>`${c}=excluded.${c}`).join(',')}`).run(...cols.map(c=>row[c]));
   }
   const snapshot=Object.fromEntries(Object.keys(tables).map(table=>[table,tmp.prepare(`SELECT * FROM ${table}`).all()]));
   for(const row of snapshot.projects){const p=JSON.parse(row.data);if(p.id!==row.id||p.directory!==row.directory||typeof p.name!=='string'||typeof p.goal!=='string'||!Array.isArray(p.constraints))fail('项目内容不合法');}
   for(const row of snapshot.tasks){const t=JSON.parse(row.data);if(t.id!==row.id||t.projectId!==row.project_id||!['planned','running','paused','blocked','submitted','failed','cancelled'].includes(t.status)||!['unverified','passed','failed','stale'].includes(t.acceptance)||!Number.isSafeInteger(t.revision)||t.revision<1||!Number.isSafeInteger(t.contentVersion)||t.contentVersion<1||['title','goal','summary','approach','example','nextStep','conversationId'].some(k=>typeof t[k]!=='string')||!Array.isArray(t.criteria)||!Array.isArray(t.evidence)||!Array.isArray(t.issues))fail('任务内容不合法');const v=t.verification;if(v!=null){if(!v||typeof v!=='object'||Array.isArray(v)||!['unverified','passed','partial','failed'].includes(v.status)||v.source!=='test'||typeof v.summary!=='string'||!v.summary.trim()||typeof v.reference!=='string'||!v.reference.trim()||!Number.isSafeInteger(v.contentVersion)||v.contentVersion<1||v.contentVersion>t.contentVersion||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt))||!Array.isArray(v.criterionIds)||v.criterionIds.length>100||v.criterionIds.some(id=>typeof id!=='string'||!id)||new Set(v.criterionIds).size!==v.criterionIds.length)fail('测试验证记录不合法');const checks=pendingChecks(v.pendingChecks,v.contentVersion===t.contentVersion?t.criteria.map(c=>c.id):null,this.Error);if(v.status==='passed'&&checks.length||v.status==='unverified'&&v.criterionIds.length)fail('测试验证状态与清单冲突');}}
   for(const row of snapshot.settings)if(row.key!=='theme'||!['light','dark','system'].includes(JSON.parse(row.data)))fail('设置内容不合法');
   for(const row of snapshot.receipts)JSON.parse(row.data);
   for(const row of snapshot.events){const event=JSON.parse(row.data);if(!event||typeof event!=='object'||Array.isArray(event))fail('事件内容不合法');}
   return snapshot;
  }catch(e){if(e instanceof this.Error)throw e;fail('备份记录损坏：'+e.message);}finally{tmp.close();}
 }
 replace(snapshot){
  this.enabled=false;
  try{
   for(const table of ['tasks','projects','events','receipts','settings','metadata'])this.db.exec(`DELETE FROM ${table}`);
   for(const [table,cols] of Object.entries(tables)){const insert=this.db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`);for(const row of snapshot[table])insert.run(...cols.map(c=>row[c]));}
  }finally{this.enabled=true;}
 }
 replay(){const payload={format:'tuijin-archive',version:1,createdAt:new Date().toISOString(),journal:this.rows()};const snapshot=this.validate({...payload,digest:digest(payload)},{internal:true});return this.store.transaction(()=>{this.store.beforeMetadataReplace?.(snapshot.metadata);this.replace(snapshot);return {status:'rebuilt',tasks:snapshot.tasks.length,projects:snapshot.projects.length};});}
 restore(archive){
  const snapshot=this.validate(archive);
  // An archive carries task history, never permission to write another directory
  // or to resume an old provider conversation on this device.
  for(const row of snapshot.projects){const p=JSON.parse(row.data);p.directory=null;row.directory=null;row.data=JSON.stringify(p);}
  for(const row of snapshot.tasks){const t=JSON.parse(row.data);t.conversationId='';if(t.status==='running'){t.status='blocked';t.blockedReason='从备份恢复，请重新绑定会话并确认执行状态';}if(t.acceptance==='passed'){t.acceptance='stale';t.criteria=t.criteria.map(c=>({...c,passed:false}));}t.revision++;t.contentVersion++;row.data=JSON.stringify(t);}
  for(const row of snapshot.metadata)if(row.key==='workflow.v1'){
    const value=JSON.parse(row.value);if(!Array.isArray(value.plans))throw new this.Error('工作流备份格式不正确');
    for(const plan of value.plans){plan.status='restored';for(const member of plan.members||[]){member.status='blocked';member.lease=null;member.workspace='';member.lastError='从备份恢复，需重新建立执行计划';}}
    row.value=JSON.stringify(value);
  }
  snapshot.metadata=snapshot.metadata.filter(row=>row.key!=='execution.leases.v1');
  return this.store.transaction(()=>{this.store.beforeMetadataReplace?.(snapshot.metadata);this.replace(snapshot);this.db.exec('DELETE FROM journal_entries');this.checkpoint();this.store.event(null,'archive.restored',{projects:snapshot.projects.length,tasks:snapshot.tasks.length});return {status:'restored',projects:snapshot.projects.length,tasks:snapshot.tasks.length,rebindRequired:true};});
 }
}
