import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {BoardError} from '../store.mjs';
import {previewPagePath,previewPath} from './registry.mjs';
import {INTENT_ID,INTENT_TTL,INTENT_RETENTION,MAX_ACTIVE_INTENTS,MAX_TERMINAL_INTENTS,
  newIntentId,emptyIntentBody,intentState,publicIntent,sqliteTransaction} from './access-intents.mjs';

const ID=/^[A-Za-z0-9_-]{1,100}$/;
const MAX_ACTIVE_CAPS=100,MAX_REVOKED_CAPS=200;
const fail=(message,status=400,code='PREVIEW_INVALID')=>{throw new BoardError(message,status,code);};
const publicManifest=({files,v,...manifest})=>manifest;
const hash=value=>createHash('sha256').update(value).digest('hex');
const types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json; charset=utf-8',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',ico:'image/x-icon',woff:'font/woff',woff2:'font/woff2',txt:'text/plain; charset=utf-8'};

/** Same-origin desktop adapter; no Hub account credentials are held or forwarded. */
export function createLocalPreview({store,registry,records,now=Date.now,desktop=false}) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS preview_local_builds(preview_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,criteria_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS preview_local_feedback(id TEXT PRIMARY KEY,preview_id TEXT NOT NULL,idem_key TEXT NOT NULL,
      page_path TEXT NOT NULL,summary TEXT NOT NULL,criterion_ids_json TEXT NOT NULL,status TEXT NOT NULL,task_id TEXT,
      UNIQUE(preview_id,idem_key));
    CREATE TABLE IF NOT EXISTS preview_local_feedback_fences(preview_id TEXT NOT NULL,idem_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,PRIMARY KEY(preview_id,idem_key));
    CREATE TABLE IF NOT EXISTS preview_local_access_intents(id TEXT PRIMARY KEY,preview_id TEXT NOT NULL,
      project_id TEXT NOT NULL,task_id TEXT NOT NULL,artifact_digest TEXT NOT NULL,role TEXT NOT NULL,boot_id TEXT NOT NULL,
      state TEXT NOT NULL,cap_hash TEXT,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS preview_local_record_operations(operation_id TEXT PRIMARY KEY,preview_id TEXT NOT NULL,
      data_store_id TEXT NOT NULL,client_mutation_id TEXT NOT NULL,payload_hash TEXT NOT NULL,title TEXT NOT NULL,
      original_boot_id TEXT NOT NULL,admission_sequence INTEGER NOT NULL,status TEXT NOT NULL,
      record_json TEXT,created_at INTEGER NOT NULL,UNIQUE(preview_id,data_store_id,client_mutation_id));`);
  if(!store.db.prepare('PRAGMA table_info(preview_local_builds)').all().some(row=>row.name==='manifest_json'))
    store.db.exec('ALTER TABLE preview_local_builds ADD COLUMN manifest_json TEXT');
  if(!store.db.prepare('PRAGMA table_info(preview_local_builds)').all().some(row=>row.name==='project_dir'))
    store.db.exec('ALTER TABLE preview_local_builds ADD COLUMN project_dir TEXT');
  if(!store.db.prepare('PRAGMA table_info(preview_local_feedback)').all().some(row=>row.name==='protocol_version'))
    store.db.exec('ALTER TABLE preview_local_feedback ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1');
  const bootId=randomBytes(32).toString('base64url');
  const caps=new Map(),dataCaps=new Map(),confirming=new Map();
  let retestComparator=null;
  function pruneRevokedCaps(){let revoked=0;
    for(const [key,item] of [...caps].reverse())if(item.revokedAt!==null&&++revoked>MAX_REVOKED_CAPS)caps.delete(key);
    revoked=0;for(const [key,item] of [...dataCaps].reverse())
      if(item.revokedAt!==null&&++revoked>MAX_REVOKED_CAPS)dataCaps.delete(key);}
  function record(manifest,criteria,projectDir=null) {
    store.db.prepare('INSERT OR IGNORE INTO preview_local_builds(preview_id,project_id,task_id,criteria_json,manifest_json,project_dir) VALUES(?,?,?,?,?,?)')
      .run(manifest.previewId,manifest.projectId,manifest.taskId,JSON.stringify(criteria),JSON.stringify(manifest),projectDir);
  }
  function assertDirectory(previewId,directory){
    const row=store.db.prepare('SELECT project_dir FROM preview_local_builds WHERE preview_id=?').get(previewId);
    if(!row||!row.project_dir||row.project_dir!==directory)
      fail('Preview project directory changed',409,'PREVIEW_VERSION');
  }
  async function historical(previewId) {
    if(!ID.test(previewId))fail('Preview unavailable',404,'PREVIEW_NOT_FOUND');
    const row=store.db.prepare('SELECT * FROM preview_local_builds WHERE preview_id=?').get(previewId);
    if(!row)fail('Preview unavailable',404,'PREVIEW_NOT_FOUND');
    const manifest=row.manifest_json?JSON.parse(row.manifest_json):await registry.get(previewId);
    if(!manifest)fail('Preview history unavailable',409,'PREVIEW_FEEDBACK_UNKNOWN');
    if(manifest.previewId!==previewId||manifest.projectId!==row.project_id||manifest.taskId!==row.task_id)
      fail('Preview history changed',409,'PREVIEW_VERSION');
    if(!row.manifest_json)store.db.prepare('UPDATE preview_local_builds SET manifest_json=? WHERE preview_id=? AND manifest_json IS NULL')
      .run(JSON.stringify(manifest),previewId);
    store.getProject(row.project_id);
    return {row,manifest};
  }
  const feedbackInput=(item,current)=>{
    const m=current.manifest,criterionIds=JSON.parse(item.criterion_ids_json),criteria=JSON.parse(current.row.criteria_json);
    return {idempotencyKey:item.id,projectId:m.projectId,sourcePreview:publicManifest(m),pagePath:item.page_path,
      summary:item.summary,criterionIds,criterionItems:criterionIds.map(id=>criteria.find(c=>c.id===id)),reporterUserId:'local_owner'};
  };
  const feedbackResult=(item,current,status=item.status,taskId=item.task_id)=>({feedback:{id:item.id,previewId:current.manifest.previewId,
    projectId:current.manifest.projectId,sourceTaskId:current.manifest.taskId,contentVersion:current.manifest.contentVersion,
    status,taskId:taskId||undefined,pagePath:item.page_path,summary:item.summary,criterionIds:JSON.parse(item.criterion_ids_json)},
    verification:{state:status==='confirmed'||status==='created_unavailable'?'confirmed':status==='not_applied'?'not_applied':status==='confirming'?'unknown':'not_requested'}});
  async function build(previewId) {
    if(!ID.test(previewId))fail('Preview unavailable',404,'PREVIEW_NOT_FOUND');
    const row=store.db.prepare('SELECT * FROM preview_local_builds WHERE preview_id=?').get(previewId);
    const manifest=row&&await registry.get(previewId);
    if(!row||!manifest||!await registry.isRegistered(previewId)||manifest.projectId!==row.project_id||manifest.taskId!==row.task_id)
      fail('Preview unavailable',404,'PREVIEW_NOT_FOUND');
    const source=store.getTask(manifest.taskId);
    if(source.projectId!==manifest.projectId)fail('Preview source changed',409,'PREVIEW_VERSION');
    return {row,manifest};
  }
  function bindRetestComparator(callback){
    if(retestComparator||typeof callback!=='function')fail('Retest comparator already bound',500,'PREVIEW_RETEST_BINDING');
    retestComparator=callback;
  }
  function retest(current,previous){
    if(current.manifest.taskId!==previous.manifest.taskId||current.manifest.projectId!==previous.manifest.projectId)
      fail('Preview versions are unrelated',400,'PREVIEW_VERSION');
    if(retestComparator)return retestComparator(current,previous);
    return {previousPreviewId:previous.manifest.previewId,previewId:current.manifest.previewId,
      sourceState:'unknown',reasonCode:'source_unknown',reason:'未能核实两版源码来源',
      currentTaskMatchesPreview:false,changedFiles:[],comparisonDigest:null,
      binding:{projectId:current.manifest.projectId,taskId:current.manifest.taskId,
        contentVersion:current.manifest.contentVersion,criteriaDigest:null,sourceDigest:null},
      items:JSON.parse(current.row.criteria_json).map(item=>({criterionId:item.id,text:item.text,
        status:'unknown',reasonCode:'source_unknown',reason:'未能核实两版源码来源',
        changedPaths:[],checkSteps:[]}))};
  }
  function intentFor(manifest,id,role) {
    if(!INTENT_ID.test(id||''))fail('Preview intent unavailable',404,'PREVIEW_ACCESS_NOT_FOUND');
    const intent=store.db.prepare('SELECT * FROM preview_local_access_intents WHERE id=?').get(id);
    if(!intent||intent.preview_id!==manifest.previewId)fail('Preview intent unavailable',404,'PREVIEW_ACCESS_NOT_FOUND');
    if(intent.role!==role)fail('Preview intent belongs to another role',403,'PREVIEW_FORBIDDEN');
    if(intent.project_id!==manifest.projectId||intent.task_id!==manifest.taskId||
      intent.artifact_digest!==manifest.artifactDigest)fail('Preview build changed',409,'PREVIEW_VERSION');
    return intent;
  }
  function pruneIntents() {
    const time=now();
    store.db.prepare(`UPDATE preview_local_access_intents SET state='expired',updated_at=?
      WHERE state IN ('registered','issued') AND expires_at<=?`).run(time,time);
    store.db.prepare(`UPDATE preview_local_access_intents SET state='invalidated',updated_at=?
      WHERE state IN ('registered','issued') AND boot_id<>?`).run(time,bootId);
    store.db.prepare(`DELETE FROM preview_local_access_intents WHERE state IN ('closed','expired','invalidated')
      AND expires_at+?<=?`).run(INTENT_RETENTION,time);
    store.db.prepare(`DELETE FROM preview_local_access_intents WHERE id IN (
      SELECT id FROM preview_local_access_intents WHERE state IN ('closed','expired','invalidated')
      ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET ${MAX_TERMINAL_INTENTS})`).run();
  }
  async function request(method,path,input,role) {
    if(!['owner','viewer'].includes(role))fail('Preview access denied',403,'PREVIEW_FORBIDDEN');
    const url=new URL(path,'http://local'),pathname=url.pathname;
    if(method==='GET'&&pathname==='/api/previews') {
      if([...url.searchParams.keys()].length!==1||!ID.test(url.searchParams.get('taskId')))fail('Task ID required',400,'PREVIEW_TASK');
      const task=store.getTask(url.searchParams.get('taskId'));
      const manifests=await registry.listRegistered(task.id);
      const previews=manifests.filter(item=>item.projectId===task.projectId&&store.db.prepare('SELECT 1 FROM preview_local_builds WHERE preview_id=?').get(item.previewId))
        .map(publicManifest);
      return {previews};
    }
    if(url.search&&!(method==='GET'&&/^\/api\/previews\/[^/]+\/retest$/.test(pathname)&&[...url.searchParams.keys()].length===1&&url.searchParams.has('previous')))
      fail('Query not allowed',400,'PREVIEW_QUERY');
    const recordRecovery=/^\/api\/previews\/([^/]+)\/data\/stores\/([^/]+)\/operations\/by-key\/([^/]+)(?:\/(reconcile))?$/.exec(pathname);
    if(recordRecovery){
      if(role!=='owner'||url.search||!ID.test(recordRecovery[2])||!ID.test(recordRecovery[3]))
        fail('Preview record recovery denied',403,'PREVIEW_FORBIDDEN');
      if(method==='POST'&&(!recordRecovery[4]||!emptyIntentBody(input))||method==='GET'&&recordRecovery[4]||
        !['GET','POST'].includes(method))fail('Invalid record recovery request',400,'PREVIEW_RECORD_INPUT');
      const current=await historical(recordRecovery[1]),m=current.manifest;
      if(m.apiTarget!=='records-v1'||m.dataStoreId!==recordRecovery[2])fail('Preview data store changed',409,'PREVIEW_VERSION');
      const item=store.db.prepare(`SELECT * FROM preview_local_record_operations WHERE preview_id=?
        AND data_store_id=? AND client_mutation_id=?`).get(m.previewId,m.dataStoreId,recordRecovery[3]);
      if(!item)fail('Original operation is not known',404,'PREVIEW_RECORD_UNKNOWN');
      const op={operationId:item.operation_id,tenantId:'local',actorUserId:'local_owner',
        clientMutationId:item.client_mutation_id,payloadHash:item.payload_hash,
        admission:{nodeId:item.original_boot_id,nodeEpoch:1,connectionGeneration:1,
          admissionSequence:item.admission_sequence}};
      const scope={previewId:m.previewId,projectId:m.projectId,taskId:m.taskId,
        contentVersion:m.contentVersion,artifactDigest:m.artifactDigest,dataStoreId:m.dataStoreId};
      let result=records.readOperation(scope,op);
      if(method==='POST'&&result.operation.status==='unknown'&&item.original_boot_id===bootId)
        result=records.reconcileOperation(scope,op);
      if(result.operation.status==='confirmed'&&item.status!=='confirmed')
        store.db.prepare("UPDATE preview_local_record_operations SET status='confirmed',record_json=? WHERE operation_id=?")
          .run(JSON.stringify(result.operation.record),item.operation_id);
      if(result.operation.status==='not_applied'&&item.status!=='not_applied')
        store.db.prepare("UPDATE preview_local_record_operations SET status='not_applied' WHERE operation_id=?")
          .run(item.operation_id);
      return {operation:{id:item.operation_id,clientMutationId:item.client_mutation_id,
        state:result.operation.status,
        ...(result.operation.record?{recordId:result.operation.record.id}:{})}};
    }
    const match=/^\/api\/previews\/([^/]+)(?:\/(retest|feedback|revoke)(?:\/([^/]+)\/confirm)?)?$/.exec(pathname);
    const access=/^\/api\/previews\/([^/]+)\/access-intents(?:\/([^/]+)(?:\/(issue|close))?)?$/.exec(pathname);
    const recovery=/^\/api\/previews\/([^/]+)\/feedback\/(?:by-key\/([^/]+)|([^/]+))(?:\/(reconcile))?$/.exec(pathname);
    if(!match&&!access&&!recovery)fail('Preview route unavailable',404,'NOT_FOUND');
    if(recovery){
      if(role!=='owner')fail('Only owner can read feedback',403,'PREVIEW_FORBIDDEN');
      if(!['GET','POST'].includes(method)||method==='POST'&&(!recovery[4]||!emptyIntentBody(input))||
        method==='GET'&&recovery[4])fail('Invalid feedback recovery request',400,'PREVIEW_FEEDBACK');
      const current=await historical(recovery[1]),key=recovery[2],feedbackId=recovery[3];
      if(!ID.test(key||feedbackId))fail('Feedback unavailable',404,'PREVIEW_FEEDBACK');
      const lookup=()=>key?store.db.prepare('SELECT * FROM preview_local_feedback WHERE preview_id=? AND idem_key=?').get(recovery[1],key):
        store.db.prepare('SELECT * FROM preview_local_feedback WHERE preview_id=? AND id=?').get(recovery[1],feedbackId);
      let item=lookup();
      if(!item){
        if(!key||method==='GET')fail('Feedback unavailable',404,'PREVIEW_FEEDBACK');
        return sqliteTransaction(store.db,()=>{
          item=lookup();if(item)return feedbackResult(item,current);
          const fence=store.db.prepare('SELECT 1 FROM preview_local_feedback_fences WHERE preview_id=? AND idem_key=?').get(recovery[1],key);
          if(!fence){
            const used=store.db.prepare(`SELECT (SELECT count(*) FROM preview_local_feedback WHERE preview_id=?) +
              (SELECT count(*) FROM preview_local_feedback_fences WHERE preview_id=?) AS n`).get(recovery[1],recovery[1]).n;
            if(used>=200)fail('Too many preview reports',429,'PREVIEW_LIMIT');
            store.db.prepare('INSERT INTO preview_local_feedback_fences VALUES(?,?,?)').run(recovery[1],key,now());
          }
          return {feedback:{previewId:current.manifest.previewId,projectId:current.manifest.projectId,
            sourceTaskId:current.manifest.taskId,contentVersion:current.manifest.contentVersion,status:'not_applied'},
            verification:{state:'not_applied',checkedAt:now()}};
        });
      }
      if(method==='GET')return feedbackResult(item,current,item.status==='draft'&&item.protocol_version===1?'confirming':item.status);
      if(item.status==='draft'&&item.protocol_version===0)return feedbackResult(item,current);
      const verified=store.reconcilePreviewFeedbackTask(feedbackInput(item,current),
        {allowFence:item.status==='confirming'&&item.protocol_version===2});
      const contradiction=['confirmed','created_unavailable'].includes(item.status)&&verified.status==='not_applied';
      if(!contradiction&&['confirmed','created_unavailable','not_applied'].includes(verified.status))
        store.db.prepare('UPDATE preview_local_feedback SET status=?,task_id=? WHERE id=? AND status IN (\'draft\',\'confirming\',\'confirmed\')')
          .run(verified.status,verified.taskId||null,item.id);
      item=lookup();
      const effective=contradiction?item.status:verified.status==='unknown'?'confirming':verified.status;
      return {...feedbackResult(item,current,effective,verified.taskId||item.task_id),
        verification:{state:contradiction||verified.status==='unknown'?'unknown':verified.status==='not_applied'?'not_applied':'confirmed',checkedAt:now()}};
    }
    if(method==='POST'&&match?.[2]==='feedback'&&typeof match[3]==='string'&&ID.test(match[3])){
      if(role!=='owner')fail('Only owner can submit feedback',403,'PREVIEW_FORBIDDEN');
      const historicalCurrent=await historical(match[1]);
      const item=store.db.prepare('SELECT * FROM preview_local_feedback WHERE id=? AND preview_id=?')
        .get(match[3],historicalCurrent.manifest.previewId);
      if(!item)fail('Feedback unavailable',404,'PREVIEW_FEEDBACK');
      if(item.status==='confirmed')return {...feedbackResult(item,historicalCurrent),
        retest:{items:[],reason:'awaiting_new_preview'}};
      if(['not_applied','created_unavailable'].includes(item.status))fail('Feedback cannot be confirmed',409,'PREVIEW_FEEDBACK_CLOSED');
      if(!confirming.has(item.id)){
        if(item.status!=='draft'||item.protocol_version!==0)
          fail('Feedback confirmation must be verified',409,'PREVIEW_FEEDBACK_UNKNOWN');
        const current=await build(match[1]);
        const changed=store.db.prepare(`UPDATE preview_local_feedback SET status='confirming',protocol_version=2
          WHERE id=? AND status='draft' AND protocol_version=0`).run(item.id);
        if(changed.changes!==1)fail('Feedback confirmation must be verified',409,'PREVIEW_FEEDBACK_UNKNOWN');
        const operation=Promise.resolve().then(()=>{
          const task=store.createPreviewFeedbackTask(feedbackInput(item,current));
          store.db.prepare("UPDATE preview_local_feedback SET status='confirmed',task_id=? WHERE id=? AND status='confirming'")
            .run(task.id,item.id);
          return task.id;
        }).finally(()=>confirming.delete(item.id));
        confirming.set(item.id,operation);
      }
      const taskId=await confirming.get(item.id);
      const durable=store.db.prepare('SELECT * FROM preview_local_feedback WHERE id=?').get(item.id);
      if(durable?.status==='not_applied'||durable?.status==='created_unavailable')
        fail('Feedback outcome changed',409,'PREVIEW_FEEDBACK_CLOSED');
      if(durable?.status!=='confirmed'||durable.task_id!==taskId)
        fail('Feedback confirmation is uncertain',503,'PREVIEW_FEEDBACK_UNKNOWN');
      return {...feedbackResult(durable,historicalCurrent),retest:{items:[],reason:'awaiting_new_preview'}};
    }
    const current=await build((access||match)[1]),m=current.manifest;
    if(access) {
      if(method==='POST'&&!emptyIntentBody(input))fail('Invalid preview intent request',400,'PREVIEW_ACCESS_BODY');
      if(method==='POST'&&!access[2]) {
        const intent=sqliteTransaction(store.db,()=>{
          pruneIntents();
          if(store.db.prepare(`SELECT count(*) AS n FROM preview_local_access_intents
            WHERE state IN ('registered','issued') AND expires_at>?`).get(now()).n>=MAX_ACTIVE_INTENTS)
            fail('Too many active preview intents',429,'PREVIEW_LIMIT');
          const time=now(),id=newIntentId(),expiresAt=time+INTENT_TTL;
          store.db.prepare('INSERT INTO preview_local_access_intents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(id,m.previewId,m.projectId,m.taskId,m.artifactDigest,role,bootId,'registered',null,expiresAt,time,time);
          return {id,preview_id:m.previewId,project_id:m.projectId,task_id:m.taskId,expires_at:expiresAt};
        });
        return {intent:publicIntent(intent,'registered')};
      }
      const intent=intentFor(m,access[2],role),state=intentState(intent,now(),bootId);
      if(method==='GET'&&!access[3])return {intent:publicIntent(intent,state)};
      if(method==='POST'&&access[3]==='issue') {
        if(state!=='registered')fail('Preview intent cannot be issued',409,'PREVIEW_ACCESS_ALREADY_ISSUED');
        const token=randomBytes(32).toString('base64url'),key=hash(token);
        const dataToken=m.apiTarget==='records-v1'?randomBytes(32).toString('base64url'):null;
        try {
          sqliteTransaction(store.db,()=>{
            const fresh=intentFor(m,intent.id,role);
            if(intentState(fresh,now(),bootId)!=='registered')
              fail('Preview intent cannot be issued',409,'PREVIEW_ACCESS_ALREADY_ISSUED');
            for(const [capKey,cap] of caps)if(cap.expiresAt<=now())caps.delete(capKey);
            if([...caps.values()].filter(cap=>cap.revokedAt===null).length>=MAX_ACTIVE_CAPS)
              fail('Too many active preview links',429,'PREVIEW_LIMIT');
            caps.set(key,{previewId:m.previewId,expiresAt:fresh.expires_at,role,revokedAt:null,intentId:fresh.id});
            if(dataToken)dataCaps.set(hash(dataToken),{previewId:m.previewId,expiresAt:fresh.expires_at,
              role,revokedAt:null,intentId:fresh.id,bootId});
            const updated=store.db.prepare(`UPDATE preview_local_access_intents SET state='issued',cap_hash=?,updated_at=?
              WHERE id=? AND state='registered'`).run(key,now(),fresh.id);
            if(updated.changes!==1)fail('Preview intent changed',409,'PREVIEW_ACCESS_ALREADY_ISSUED');
          });
        } catch(error) {caps.delete(key);if(dataToken)dataCaps.delete(hash(dataToken));throw error;}
        return {preview:publicManifest(m),launchUrl:`/api/previews/${m.previewId}/site/${token}/index.html`,
          expiresAt:intent.expires_at,intent:publicIntent(intent,'issued'),
          ...(dataToken?{dataCapability:dataToken}:{})};
      }
      if(method==='POST'&&access[3]==='close') {
        let cap,previousRevoked,dataCap,previousDataRevoked;
        try {
          const closed=sqliteTransaction(store.db,()=>{
            const fresh=intentFor(m,intent.id,role),effective=intentState(fresh,now(),bootId);
            if(['closed','expired','invalidated'].includes(effective)) {
              if(fresh.state!==effective)store.db.prepare('UPDATE preview_local_access_intents SET state=?,updated_at=? WHERE id=?')
                .run(effective,now(),fresh.id);
              pruneIntents();
              return publicIntent(fresh,effective);
            }
            if(effective==='issued') {
              cap=fresh.cap_hash&&caps.get(fresh.cap_hash);
              if(!cap||cap.intentId!==fresh.id||cap.previewId!==m.previewId||cap.role!==role||
                cap.expiresAt!==fresh.expires_at)fail('Preview intent state cannot be verified',503,'PREVIEW_ACCESS_UNKNOWN');
              previousRevoked=cap.revokedAt;cap.revokedAt=now();
              if(m.apiTarget==='records-v1'){
                dataCap=[...dataCaps.values()].find(item=>item.intentId===fresh.id);
                if(!dataCap||dataCap.previewId!==m.previewId||dataCap.role!==role||dataCap.bootId!==bootId)
                  fail('Preview data access cannot be verified',503,'PREVIEW_ACCESS_UNKNOWN');
                previousDataRevoked=dataCap.revokedAt;dataCap.revokedAt=now();
              }
            }
            store.db.prepare("UPDATE preview_local_access_intents SET state='closed',updated_at=? WHERE id=?")
              .run(now(),fresh.id);
            pruneIntents();
            return publicIntent(fresh,'closed');
          });
          pruneRevokedCaps();
          const unsettled=m.apiTarget==='records-v1'&&store.db.prepare(`SELECT 1 FROM preview_local_record_operations
            WHERE preview_id=? AND status NOT IN ('confirmed','not_applied') LIMIT 1`).get(m.previewId);
          return {intent:closed,inactive:true,...(m.apiTarget==='records-v1'?{dataWrites:unsettled?'unknown':'settled'}:{})};
        } catch(error) {if(cap)cap.revokedAt=previousRevoked;if(dataCap)dataCap.revokedAt=previousDataRevoked;throw error;}
      }
      fail('Preview intent route unavailable',404,'NOT_FOUND');
    }
    if(method==='GET'&&!match[2]) {
      if(m.apiTarget==='records-v1')fail('Dynamic preview requires a registered access intent',409,'PREVIEW_ACCESS_REQUIRED');
      for(const [key,cap] of caps)if(cap.expiresAt<=now())caps.delete(key);
      if([...caps.values()].filter(cap=>cap.revokedAt===null).length>=MAX_ACTIVE_CAPS)fail('Too many active preview links',429,'PREVIEW_LIMIT');
      const token=randomBytes(32).toString('base64url'),expiresAt=now()+600_000;
      caps.set(hash(token),{previewId:m.previewId,expiresAt,role,revokedAt:null});
      return {preview:publicManifest(m),launchUrl:`/api/previews/${m.previewId}/site/${token}/index.html`,expiresAt};
    }
    if(method==='POST'&&match[2]==='revoke'&&!match[3]) {
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||
        !Object.hasOwn(input,'capability')||typeof input.capability!=='string'||
        !/^[A-Za-z0-9_-]{32,100}$/.test(input.capability))fail('Invalid preview revocation',400,'PREVIEW_CAPABILITY');
      const cap=caps.get(hash(input.capability));
      if(!cap||cap.previewId!==m.previewId||cap.expiresAt<=now()||cap.role!==role)
        fail('Preview link expired',403,'PREVIEW_CAPABILITY');
      if(cap.revokedAt===null)cap.revokedAt=now();
      if(cap.intentId){const data=[...dataCaps.values()].find(item=>item.intentId===cap.intentId);
        if(data)data.revokedAt=now();}
      pruneRevokedCaps();
      return {revoked:true};
    }
    if(method==='GET'&&match[2]==='retest'&&!match[3])return retest(current,await build(url.searchParams.get('previous')));
    if(role!=='owner')fail('Only owner can submit feedback',403,'PREVIEW_FORBIDDEN');
    if(method==='POST'&&match[2]==='feedback'&&!match[3]) {
      const {pagePath,summary,criterionIds=[],idempotencyKey}=input;
      try{previewPagePath(pagePath);}catch{fail('Invalid page path',400,'PREVIEW_FEEDBACK');}
      const criteria=JSON.parse(current.row.criteria_json);
      if(typeof summary!=='string'||!summary.trim()||summary.length>4000||!ID.test(idempotencyKey)||
        !Array.isArray(criterionIds)||criterionIds.length>100||criterionIds.some(id=>!ID.test(id)||!criteria.some(item=>item.id===id))||
        new Set(criterionIds).size!==criterionIds.length)fail('Invalid feedback',400,'PREVIEW_FEEDBACK');
      const item=sqliteTransaction(store.db,()=>{
        const prior=store.db.prepare('SELECT * FROM preview_local_feedback WHERE preview_id=? AND idem_key=?').get(m.previewId,idempotencyKey);
        if(prior&&(prior.page_path!==pagePath||prior.summary!==summary.trim()||prior.criterion_ids_json!==JSON.stringify(criterionIds)))
          fail('Feedback key reused',409,'PREVIEW_FEEDBACK_CONFLICT');
        if(!prior){
          if(store.db.prepare('SELECT 1 FROM preview_local_feedback_fences WHERE preview_id=? AND idem_key=?').get(m.previewId,idempotencyKey))
            fail('Feedback key was closed',409,'PREVIEW_FEEDBACK_NOT_APPLIED');
          const used=store.db.prepare(`SELECT (SELECT count(*) FROM preview_local_feedback WHERE preview_id=?) +
            (SELECT count(*) FROM preview_local_feedback_fences WHERE preview_id=?) AS n`).get(m.previewId,m.previewId).n;
          if(used>=200)fail('Too many preview reports',429,'PREVIEW_LIMIT');
          store.db.prepare(`INSERT INTO preview_local_feedback(id,preview_id,idem_key,page_path,summary,criterion_ids_json,status,task_id,protocol_version)
            VALUES(?,?,?,?,?,?,?,?,0)`).run(randomUUID(),m.previewId,idempotencyKey,pagePath,summary.trim(),JSON.stringify(criterionIds),'draft',null);
        }
        return prior||store.db.prepare('SELECT * FROM preview_local_feedback WHERE preview_id=? AND idem_key=?').get(m.previewId,idempotencyKey);
      });
      return feedbackResult(item,current);
    }
    fail('Preview route unavailable',404,'NOT_FOUND');
  }
  async function handleSite(req,res,path) {
    const match=/^\/api\/previews\/([^/]+)\/site\/([^/]+)\/(.+)$/.exec(path);
    if(!match)return false;
    if(req.method!=='GET')fail('Method not allowed',405,'METHOD');
    if(!/^[A-Za-z0-9_-]{32,100}$/.test(match[2])||new URL(req.url,'http://local').search)
      fail('Preview link invalid',403,'PREVIEW_CAPABILITY');
    const current=await build(match[1]),key=hash(match[2]),cap=caps.get(key);
    if(!cap||cap.previewId!==current.manifest.previewId||cap.expiresAt<=now()||cap.revokedAt!==null)
      fail('Preview link expired',403,'PREVIEW_CAPABILITY');
    let assetPath;try{assetPath=previewPath(decodeURIComponent(match[3]));}catch{fail('Invalid preview path',400,'PREVIEW_PATH');}
    const {bytes}=await registry.read(current.manifest.previewId,assetPath);
    await build(current.manifest.previewId);
    if(caps.get(key)!==cap||cap.expiresAt<=now()||cap.revokedAt!==null)
      fail('Preview link expired',403,'PREVIEW_CAPABILITY');
    const source=`http://${req.headers.host}`,ext=assetPath.split('.').pop().toLowerCase(),contentType=types[ext]||'application/octet-stream';
    const isHtml=contentType.startsWith('text/html');
    const headers={'Content-Type':contentType,'Cache-Control':'private, no-store',
      'Cross-Origin-Resource-Policy':'cross-origin','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
    if(req.headers.origin==='null'&&!isHtml)headers['Access-Control-Allow-Origin']='null';
    headers['Content-Security-Policy']=isHtml
      ? `sandbox allow-scripts allow-forms; default-src 'none'; script-src ${source}; style-src ${source} 'unsafe-inline'; img-src ${source} data:; font-src ${source} data:; connect-src ${current.manifest.apiTarget==='records-v1'?`${source}/api/previews/${current.manifest.previewId}/data/records`:"'none'"}; frame-ancestors ${source}${desktop?' tauri://localhost http://tauri.localhost https://tauri.localhost':''}; base-uri 'none'; form-action 'none'`
      : "sandbox; default-src 'none'; script-src 'none'; connect-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    if(contentType==='application/octet-stream')headers['Content-Disposition']='attachment';
    if(isHtml)res.removeHeader('X-Frame-Options');
    res.writeHead(200,headers);res.end(bytes);return true;
  }
  async function handleData(req,res,path){
    const match=/^\/api\/previews\/([^/]+)\/data\/records$/.exec(path);
    if(!match)return false;
    const url=new URL(req.url,'http://local');
    if(url.search||req.headers.origin!=='null'||req.headers.cookie!==undefined||
      req.headers.authorization!==undefined)fail('Preview data access denied',403,'PREVIEW_DATA_AUTH');
    const current=await build(match[1]),m=current.manifest;
    if(m.apiTarget!=='records-v1'||!records)fail('Preview data target unavailable',404,'PREVIEW_NOT_FOUND');
    const cors={'Access-Control-Allow-Origin':'null','Vary':'Origin','Cache-Control':'no-store'};
    if(req.method==='OPTIONS'){
      if(!['GET','POST'].includes(req.headers['access-control-request-method'])||
        !/^(?:content-type,\s*x-seqivo-preview-data|x-seqivo-preview-data,\s*content-type|x-seqivo-preview-data)$/i
          .test(req.headers['access-control-request-headers']||''))fail('Invalid preview data preflight',403,'ORIGIN');
      res.writeHead(204,{...cors,'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers':'Content-Type, X-Seqivo-Preview-Data'});res.end();return true;
    }
    if(!['GET','POST'].includes(req.method))fail('Preview data method denied',405,'METHOD');
    const token=req.headers['x-seqivo-preview-data'];
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))fail('Preview data capability required',403,'PREVIEW_DATA_AUTH');
    const cap=dataCaps.get(hash(token));
    const verify=()=>{
      const intent=store.db.prepare('SELECT state FROM preview_local_access_intents WHERE id=? AND preview_id=?')
        .get(cap?.intentId,m.previewId);
      if(!cap||cap.previewId!==m.previewId||cap.bootId!==bootId||cap.revokedAt!==null||
        cap.expiresAt<=now()||intent?.state!=='issued'||dataCaps.get(hash(token))!==cap)
        fail('Preview data capability expired',403,'PREVIEW_DATA_AUTH');
    };
    verify();
    const scope={previewId:m.previewId,projectId:m.projectId,taskId:m.taskId,
      contentVersion:m.contentVersion,artifactDigest:m.artifactDigest,dataStoreId:m.dataStoreId};
    let result;
    if(req.method==='GET')result=records.list(scope);
    else{
      if(cap.role!=='owner'||!req.headers['content-type']?.startsWith('application/json'))
        fail('Preview data write denied',403,'PREVIEW_FORBIDDEN');
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>4096)fail('Preview data too large',413,'PREVIEW_LIMIT');}
      let body;try{body=JSON.parse(raw);}catch{fail('Invalid preview data',400,'PREVIEW_RECORD_INPUT');}
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==2||
        !ID.test(body.clientMutationId)||typeof body.title!=='string')fail('Invalid preview data',400,'PREVIEW_RECORD_INPUT');
      const title=body.title.trim();
      if(!title||!title.isWellFormed()||Array.from(title).length>120||Buffer.byteLength(title)>480||
        /[\p{Cc}\p{Cf}]/u.test(title))fail('Invalid preview title',400,'PREVIEW_RECORD_INPUT');
      await build(m.previewId);verify();
      const payloadHash=hash(JSON.stringify({title}));
      const old=store.db.prepare(`SELECT * FROM preview_local_record_operations WHERE preview_id=?
        AND data_store_id=? AND client_mutation_id=?`).get(m.previewId,m.dataStoreId,body.clientMutationId);
      if(old&&old.payload_hash!==payloadHash)fail('Preview mutation changed',409,'PREVIEW_RECORD_CONFLICT');
      if(old?.status==='confirmed'){result={operationId:old.operation_id,record:JSON.parse(old.record_json)};}
      else if(old)fail('Original write requires verification',503,'PREVIEW_RECORD_UNKNOWN');
      else{
        if(store.db.prepare(`SELECT 1 FROM preview_local_record_operations WHERE preview_id=?
          AND status NOT IN ('confirmed','not_applied') LIMIT 1`).get(m.previewId))
          fail('Earlier preview write needs verification',409,'PREVIEW_RECORD_UNKNOWN');
        const operationId=randomUUID(),sequence=store.db.prepare('SELECT COALESCE(MAX(admission_sequence),0)+1 AS n FROM preview_local_record_operations').get().n;
        store.db.prepare('INSERT INTO preview_local_record_operations VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(operationId,m.previewId,m.dataStoreId,body.clientMutationId,payloadHash,title,bootId,sequence,'admitted',null,now());
        const operation={operationId,tenantId:'local',actorUserId:'local_owner',clientMutationId:body.clientMutationId,
          payloadHash,admission:{nodeId:bootId,nodeEpoch:1,connectionGeneration:1,admissionSequence:sequence},title};
        const saved=records.createOperation(scope,operation);
        store.db.prepare("UPDATE preview_local_record_operations SET status='confirmed',record_json=? WHERE operation_id=?")
          .run(JSON.stringify(saved.operation.record),operationId);
        result={operationId,record:saved.operation.record};
      }
    }
    await build(m.previewId);verify();
    res.writeHead(200,{...cors,'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify(result));return true;
  }
  return {record,build,bindRetestComparator,assertDirectory,request,handleSite,handleData};
}
