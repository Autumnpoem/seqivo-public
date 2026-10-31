import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { HubError } from './store.mjs';
import { previewEnvironment, previewPagePath, previewPath } from '../preview/registry.mjs';
import { INTENT_ID, INTENT_TTL, INTENT_RETENTION, MAX_ACTIVE_INTENTS, MAX_TERMINAL_INTENTS,
  newIntentId, emptyIntentBody, intentState, publicIntent, sqliteTransaction } from '../preview/access-intents.mjs';
import {previewRetestScope,unknownRetestResult,sanitizeRetestResult} from '../preview/retest-contract.mjs';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_FILE = 4 * 1024 * 1024;
const MAX_ACTIVE_CAPS = 20;
const MAX_REVOKED_CAPS = 200;
const MAX_RECORD_OPERATIONS_PER_PREVIEW = 1000;
const MAX_RECORD_OPERATIONS_TOTAL = 100000;
const hash = value => createHash('sha256').update(value).digest('hex');
const deny = (message, status = 403, code = 'PREVIEW_FORBIDDEN') => { throw new HubError(message, status, code); };
const cookieName = secure => secure ? '__Host-hub_session' : 'hub_session';
const publicManifest = row => {
  const m = typeof row.manifest_json === 'string' ? JSON.parse(row.manifest_json) : row;
  const { previewId, projectId, taskId, contentVersion, sourceTaskRevision, sourceCommit, dirtyDigest, dirty, provenance,
    artifactDigest, environment, dataMode, capability, backendApi, apiTarget, dataStoreId, createdAt } = m;
  return { previewId, projectId, taskId, contentVersion, ...(provenance?{sourceTaskRevision}:{}),sourceCommit,
    ...(provenance ? { provenance } : { dirtyDigest, dirty }),
    artifactDigest, environment, dataMode, capability, backendApi,
    ...(apiTarget?{apiTarget,dataStoreId}:{}),createdAt };
};
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8' };
const mime = path => types[path.split('.').pop().toLowerCase()] || 'application/octet-stream';

function session(accounts, req, secure) {
  if (req.headers.authorization !== undefined) deny('Account login required', 403, 'ACCOUNT_LOGIN_REQUIRED');
  const name = cookieName(secure), parts = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (parts.length !== 1) deny('Account login required', 401, 'UNAUTHORIZED');
  const token = parts[0].slice(name.length + 1);
  const login=accounts.authenticateSession(token);
  if(req.headers['x-preview-actor-id']!==undefined&&req.headers['x-preview-actor-id']!==login.user.id)
    deny('Preview account changed',409,'PREVIEW_ACTOR_CHANGED');
  return { ...login, tokenHash: hash(token) };
}

function validateManifest(m) {
  let environmentValid=true;try{previewEnvironment(m?.environment);}catch{environmentValid=false;}
  const managed = m?.provenance !== undefined;
  const provenanceKeys=['kind','sourceDigest','inputDigest','buildReceiptDigest','toolDigest','profileDigest'];
  const sourceValid = managed ? m.provenance?.kind === 'managed-vite-vanilla-v1' &&
    m.provenance && typeof m.provenance==='object' && !Array.isArray(m.provenance) &&
    Object.keys(m.provenance).sort().join('|')===provenanceKeys.sort().join('|') &&
    ['sourceDigest','inputDigest','buildReceiptDigest','toolDigest','profileDigest']
      .every(key => SHA.test(m.provenance[key])) &&
    m.dirty === undefined && m.dirtyDigest === undefined &&
    Number.isSafeInteger(m.sourceTaskRevision) && m.sourceTaskRevision >= 1 :
    SHA.test(m?.dirtyDigest) && typeof m?.dirty === 'boolean' && m.sourceTaskRevision === undefined;
  if (!m || Buffer.byteLength(JSON.stringify(m)) > 262144 || ![1,2].includes(m.v) || !ID.test(m.previewId) || !ID.test(m.projectId) || !ID.test(m.taskId) ||
    !Number.isSafeInteger(m.contentVersion) || m.contentVersion < 1 || !/^[a-f0-9]{40,64}$/.test(m.sourceCommit) ||
    !sourceValid || !SHA.test(m.artifactDigest) ||
    !environmentValid ||
    !['real', 'simulated'].includes(m.dataMode) ||
    (m.v===1 ? m.capability!=='static-interactive'||m.backendApi!=='unsupported'||m.apiTarget!==undefined||m.dataStoreId!==undefined :
      m.capability!=='records-v1'||m.backendApi!=='records-v1'||m.apiTarget!=='records-v1'||!ID.test(m.dataStoreId)) ||
    !Array.isArray(m.files) || !m.files.length || m.files.length > 1000) deny('Invalid preview manifest', 400, 'PREVIEW_MANIFEST');
  const total = m.files.reduce((sum, item) => {
    try { previewPath(item.path); } catch { deny('Invalid preview manifest path', 400, 'PREVIEW_MANIFEST'); }
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE || !SHA.test(item.sha256))
      deny('Invalid preview asset', 400, 'PREVIEW_MANIFEST');
    return sum + item.size;
  }, 0);
  if (total > 32 * 1024 * 1024 || new Set(m.files.map(item => item.path)).size !== m.files.length ||
    !m.files.some(item => item.path === 'index.html')) deny('Invalid preview manifest files', 400, 'PREVIEW_MANIFEST');
  const check = createHash('sha256');
  for (const item of [...m.files].sort((a, b) => a.path.localeCompare(b.path))) check.update(item.path).update('\0').update(item.sha256).update('\0');
  if (check.digest('hex') !== m.artifactDigest) deny('Preview digest mismatch', 400, 'PREVIEW_MANIFEST');
}

/** Same-origin Hub endpoint; the browser document runs with an opaque origin. */
export function createPreviewHub({ store, accounts, secure = false, publicOrigin, now = Date.now, createTask } = {}) {
  if (!store?.db || !accounts?.authenticateSession) throw new TypeError('Preview Hub requires store and accounts');
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS preview_builds(preview_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,node_id TEXT NOT NULL,
      node_epoch INTEGER NOT NULL,project_id TEXT NOT NULL,task_id TEXT NOT NULL,content_version INTEGER NOT NULL,
      artifact_digest TEXT NOT NULL,manifest_json TEXT NOT NULL,criteria_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS preview_builds_task ON preview_builds(tenant_id,task_id,created_at);
    CREATE TABLE IF NOT EXISTS preview_caps(token_hash TEXT PRIMARY KEY,preview_id TEXT NOT NULL,user_id TEXT NOT NULL,
      session_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS preview_data_caps(token_hash TEXT PRIMARY KEY,preview_id TEXT NOT NULL,intent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,session_hash TEXT NOT NULL,write_enabled INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS preview_record_operations(operation_id TEXT PRIMARY KEY,preview_id TEXT NOT NULL,
      data_store_id TEXT NOT NULL,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,session_hash TEXT NOT NULL,
      client_mutation_id TEXT NOT NULL,payload_hash TEXT NOT NULL,title TEXT NOT NULL,
      node_id TEXT NOT NULL,node_epoch INTEGER NOT NULL,connection_generation INTEGER NOT NULL,
      admission_sequence INTEGER NOT NULL,status TEXT NOT NULL,record_json TEXT,created_at INTEGER NOT NULL,
      UNIQUE(preview_id,data_store_id,tenant_id,user_id,client_mutation_id));
    CREATE TABLE IF NOT EXISTS preview_access_intents(id TEXT PRIMARY KEY,preview_id TEXT NOT NULL,project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,artifact_digest TEXT NOT NULL,user_id TEXT NOT NULL,session_hash TEXT NOT NULL,
      state TEXT NOT NULL,cap_hash TEXT,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS preview_access_intents_owner ON preview_access_intents(user_id,state,expires_at);
    CREATE TABLE IF NOT EXISTS preview_feedback(id TEXT PRIMARY KEY,preview_id TEXT NOT NULL,tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,idem_key TEXT NOT NULL,page_path TEXT NOT NULL,summary TEXT NOT NULL,
      criterion_ids_json TEXT NOT NULL,status TEXT NOT NULL,task_id TEXT,created_at INTEGER NOT NULL,confirmed_at INTEGER,
      UNIQUE(preview_id,user_id,idem_key));
    CREATE TABLE IF NOT EXISTS preview_feedback_fences(preview_id TEXT NOT NULL,user_id TEXT NOT NULL,
      idem_key TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(preview_id,user_id,idem_key));
  `);
  if(!store.db.prepare('PRAGMA table_info(preview_feedback)').all().some(row=>row.name==='protocol_version'))
    store.db.exec('ALTER TABLE preview_feedback ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1');
  if(!store.db.prepare('PRAGMA table_info(preview_feedback)').all().some(row=>row.name==='recovery_store_id'))
    store.db.exec('ALTER TABLE preview_feedback ADD COLUMN recovery_store_id TEXT');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 262144, perMessageDeflate: false, clientTracking: false });
  const sockets = new Set(), nodes = new Map(), requests = new Map(), feedbackRequests = new Map(), recordRequests=new Map(), retestRequests=new Map(), confirming = new Map();
  let nodeConnectionGeneration=0;
  let closed = false, serverListener = null, server = null;
  const rowFor = previewId => {
    if (!ID.test(previewId)) deny('Preview unavailable', 404, 'PREVIEW_NOT_FOUND');
    const row = store.db.prepare('SELECT * FROM preview_builds WHERE preview_id=?').get(previewId);
    if (!row) deny('Preview unavailable', 404, 'PREVIEW_NOT_FOUND');
    return row;
  };
  const authorize = (req, row, write = false) => {
    const login = session(accounts, req, secure);
    if (login.subject.tenant_id !== row.tenant_id || !store.canAccess(login.subject, row.project_id) ||
      write && login.subject.role !== 'owner') deny();
    return login;
  };
  const capabilityFor = (row, token, { allowRevoked = false } = {}) => {
    const cap = typeof token === 'string' && /^[A-Za-z0-9_-]{32,100}$/.test(token) &&
      store.db.prepare('SELECT * FROM preview_caps WHERE token_hash=?').get(hash(token));
    if (!cap || cap.preview_id !== row.preview_id || cap.expires_at <= now() ||
      !allowRevoked && cap.revoked_at !== null)
      deny('Preview link expired', 403, 'PREVIEW_CAPABILITY');
    return cap;
  };
  const accessFor = (row, cap) => {
    const activeSession = store.db.prepare('SELECT user_id FROM account_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?')
      .get(cap.session_hash, now());
    const ownerSubject = store.db.prepare(`SELECT s.* FROM account_users u JOIN subjects s ON s.id=u.owner_subject_id
      WHERE u.id=? AND s.revoked_at IS NULL AND s.tenant_id=?`).get(cap.user_id, row.tenant_id);
    if (!activeSession || activeSession.user_id !== cap.user_id || !ownerSubject || !store.canAccess(ownerSubject, row.project_id))
      deny('Preview access changed', 403, 'PREVIEW_FORBIDDEN');
  };
  const dataCapabilityFor=(row,req)=>{
    if(req.headers.cookie!==undefined||req.headers.authorization!==undefined)
      deny('Preview data credentials are not accepted',403,'PREVIEW_DATA_AUTH');
    const token=req.headers['x-seqivo-preview-data'];
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))
      deny('Preview data capability required',403,'PREVIEW_DATA_AUTH');
    const cap=store.db.prepare('SELECT * FROM preview_data_caps WHERE token_hash=?').get(hash(token));
    if(!cap||cap.preview_id!==row.preview_id||cap.revoked_at!==null||cap.expires_at<=now())
      deny('Preview data capability expired',403,'PREVIEW_DATA_AUTH');
    accessFor(row,cap);
    const intent=store.db.prepare('SELECT state FROM preview_access_intents WHERE id=? AND preview_id=?')
      .get(cap.intent_id,row.preview_id);
    if(intent?.state!=='issued')deny('Preview data access closed',403,'PREVIEW_DATA_AUTH');
    return cap;
  };
  const origin = req => publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  const sameOrigin = req => { if (req.headers.origin !== origin(req)) deny('Origin denied', 403, 'ORIGIN'); };
  const intentFor = (row, id, login) => {
    if (!INTENT_ID.test(id || '')) deny('Preview intent unavailable', 404, 'PREVIEW_ACCESS_NOT_FOUND');
    const intent = store.db.prepare('SELECT * FROM preview_access_intents WHERE id=?').get(id);
    if (!intent || intent.preview_id !== row.preview_id) deny('Preview intent unavailable', 404, 'PREVIEW_ACCESS_NOT_FOUND');
    if (intent.user_id !== login.user.id || intent.session_hash !== login.tokenHash)
      deny('Preview intent belongs to another session', 403, 'PREVIEW_FORBIDDEN');
    if (intent.project_id !== row.project_id || intent.task_id !== row.task_id ||
      intent.artifact_digest !== row.artifact_digest) deny('Preview build changed', 409, 'PREVIEW_VERSION');
    return intent;
  };
  const pruneIntents = userId => {
    const time = now();
    store.db.prepare(`UPDATE preview_access_intents SET state='expired',updated_at=?
      WHERE user_id=? AND state IN ('registered','issued') AND expires_at<=?`).run(time, userId, time);
    store.db.prepare(`DELETE FROM preview_access_intents WHERE user_id=? AND state IN ('closed','expired','invalidated')
      AND expires_at+?<=?`).run(userId, INTENT_RETENTION, time);
    store.db.prepare(`DELETE FROM preview_access_intents WHERE id IN (
      SELECT id FROM preview_access_intents WHERE user_id=? AND state IN ('closed','expired','invalidated')
      ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ${MAX_TERMINAL_INTENTS})`).run(userId);
  };
  const pruneRevokedCaps = userId => store.db.prepare(`DELETE FROM preview_caps WHERE token_hash IN (
    SELECT token_hash FROM preview_caps WHERE user_id=? AND revoked_at IS NOT NULL
    ORDER BY revoked_at DESC, rowid DESC LIMIT -1 OFFSET ${MAX_REVOKED_CAPS})`).run(userId);
  const pruneRevokedDataCaps=userId=>store.db.prepare(`DELETE FROM preview_data_caps WHERE token_hash IN (
    SELECT token_hash FROM preview_data_caps WHERE user_id=? AND revoked_at IS NOT NULL
    ORDER BY revoked_at DESC,rowid DESC LIMIT -1 OFFSET ${MAX_REVOKED_CAPS})`).run(userId);
  const snapshotTask = row => {
    const snapshot = store.db.prepare('SELECT data_json,received_at FROM snapshots WHERE node_id=? AND tenant_id=? AND epoch=?')
      .get(row.node_id, row.tenant_id, row.node_epoch);
    return snapshot && now() - snapshot.received_at <= 60_000 &&
      JSON.parse(snapshot.data_json).tasks?.find(item => item.id === row.task_id && item.projectId === row.project_id);
  };
  const criteriaFor = row => JSON.parse(row.criteria_json);
  const feedbackInput=(row,feedback)=>{
    const criterionIds=JSON.parse(feedback.criterion_ids_json);
    return {idempotencyKey:feedback.id,projectId:row.project_id,sourcePreview:publicManifest(row),
      pagePath:feedback.page_path,summary:feedback.summary,criterionIds,
      criterionItems:criterionIds.map(id=>criteriaFor(row).find(item=>item.id===id)),reporterUserId:feedback.user_id};
  };
  const feedbackResult=(row,feedback,status=feedback.status,taskId=feedback.task_id,verified=false)=>({
    feedback:{id:feedback.id,previewId:row.preview_id,projectId:row.project_id,sourceTaskId:row.task_id,
      contentVersion:row.content_version,status,taskId:taskId||undefined,pagePath:feedback.page_path,
      summary:feedback.summary,criterionIds:JSON.parse(feedback.criterion_ids_json)},
    verification:{state:verified?(status==='not_applied'?'not_applied':status==='confirmed'||status==='created_unavailable'?'confirmed':'unknown'):
      status==='confirmed'||status==='created_unavailable'?'confirmed':status==='not_applied'?'not_applied':
      status==='confirming'?'unknown':'not_requested',...(verified?{checkedAt:now()}:{})}});
  const retestPair=(current,previous)=>{
    if(current.task_id!==previous.task_id||current.project_id!==previous.project_id||
      current.tenant_id!==previous.tenant_id||current.node_id!==previous.node_id||
      current.node_epoch!==previous.node_epoch)
      deny('Preview versions are unrelated',400,'PREVIEW_VERSION');
    const first=previewRetestScope(JSON.parse(current.manifest_json));
    const second=previewRetestScope(JSON.parse(previous.manifest_json));
    if(first.previewId!==current.preview_id||first.projectId!==current.project_id||
      first.taskId!==current.task_id||first.contentVersion!==current.content_version||
      first.artifactDigest!==current.artifact_digest||
      second.previewId!==previous.preview_id||second.projectId!==previous.project_id||
      second.taskId!==previous.task_id||second.contentVersion!==previous.content_version||
      second.artifactDigest!==previous.artifact_digest)
      deny('Preview registration changed',409,'PREVIEW_VERSION');
    return {current:first,previous:second,criteria:criteriaFor(current)};
  };
  function activeNode(row) {
    const node = nodes.get(row.node_id);
    const subject = store.db.prepare('SELECT epoch FROM subjects WHERE id=? AND tenant_id=? AND role=? AND revoked_at IS NULL')
      .get(row.node_id, row.tenant_id, 'node');
    if (!node || !subject || node.epoch !== subject.epoch || row.node_epoch !== node.epoch || node.ws.readyState !== WebSocket.OPEN)
      deny('Preview node offline', 503, 'NODE_OFFLINE');
    const owner = store.db.prepare('SELECT node_id,epoch FROM project_owners WHERE tenant_id=? AND project_id=?')
      .get(row.tenant_id, row.project_id);
    if (!owner || owner.node_id !== node.nodeId || owner.epoch !== node.epoch) deny('Preview project ownership changed', 409, 'PREVIEW_OWNER_CHANGED');
    return node;
  }
  function originalRetestOwner(row){
    const subject=store.db.prepare('SELECT * FROM subjects WHERE id=? AND tenant_id=? AND role=? AND revoked_at IS NULL')
      .get(row.node_id,row.tenant_id,'node');
    const owner=store.db.prepare('SELECT node_id,epoch FROM project_owners WHERE tenant_id=? AND project_id=?')
      .get(row.tenant_id,row.project_id);
    if(!subject||subject.epoch!==row.node_epoch||!owner||owner.node_id!==row.node_id||
      owner.epoch!==row.node_epoch||!store.canAccess(subject,row.project_id))
      deny('Preview project ownership changed',409,'PREVIEW_OWNER_CHANGED');
  }
  function recoveryNode(row){
    const node=nodes.get(row.node_id);
    const subject=store.db.prepare("SELECT epoch FROM subjects WHERE id=? AND tenant_id=? AND role='node' AND revoked_at IS NULL")
      .get(row.node_id,row.tenant_id);
    const owner=store.db.prepare('SELECT node_id,epoch FROM project_owners WHERE tenant_id=? AND project_id=?')
      .get(row.tenant_id,row.project_id);
    if(!node||!subject||node.epoch!==subject.epoch||node.ws.readyState!==WebSocket.OPEN||
      !owner||owner.node_id!==node.nodeId||owner.epoch!==node.epoch||
      !store.canAccess({id:node.nodeId,role:'node'},row.project_id))
      deny('Preview node offline',503,'NODE_OFFLINE');
    // Historical feedback may outlive the preview's original node epoch. A
    // different store identity can read known outcomes, but cannot fence an
    // operation sent to the original store.
    return node;
  }
  async function asset(row, path) {
    const manifest = JSON.parse(row.manifest_json);
    const entry = manifest.files.find(item => item.path === path);
    if (!entry) deny('Preview asset unavailable', 404, 'PREVIEW_NOT_FOUND');
    if (requests.size >= 16) deny('Preview busy', 429, 'PREVIEW_LIMIT');
    const node = activeNode(row), requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new HubError('Preview timeout', 503, 'PREVIEW_TIMEOUT')), 5000); timer.unref?.();
      const finish = (error, bytes) => { if (!requests.has(requestId)) return; requests.delete(requestId); clearTimeout(timer); error ? reject(error) : resolve({ bytes, node }); };
      requests.set(requestId, { node, entry, chunks: [], size: 0, seq: 0, started: false, finish });
      if (node.ws.bufferedAmount > 1_048_576 || node.ws.readyState !== WebSocket.OPEN) finish(new HubError('Preview node busy', 503, 'NODE_OFFLINE'));
      else node.ws.send(JSON.stringify({ type: 'get', v: 1, requestId, previewId: row.preview_id, path }));
    });
  }
  const recordScope=row=>{const m=JSON.parse(row.manifest_json);return {previewId:row.preview_id,
    projectId:row.project_id,taskId:row.task_id,contentVersion:row.content_version,
    artifactDigest:row.artifact_digest,dataStoreId:m.dataStoreId};};
  async function recordFrame(node,frame){
    if(recordRequests.size>=16||node.ws.readyState!==WebSocket.OPEN||node.ws.bufferedAmount>1_048_576)
      deny('Preview record node busy',429,'PREVIEW_LIMIT');
    const requestId=randomUUID();
    return new Promise((resolve,reject)=>{
      const finish=(error,result)=>{if(!recordRequests.has(requestId))return;recordRequests.delete(requestId);
        clearTimeout(timer);error?reject(error):resolve(result);};
      const timer=setTimeout(()=>finish(new HubError('Preview record outcome unknown',503,'PREVIEW_RECORD_UNKNOWN')),5000);
      timer.unref?.();recordRequests.set(requestId,{node,finish,operationId:frame.operation?.operationId});
      node.ws.send(JSON.stringify({v:2,...frame,requestId}));
    });
  }
  async function retestFrame(node,current,previous){
    if(retestRequests.size>=16||node.ws.readyState!==WebSocket.OPEN||node.ws.bufferedAmount>1_048_576)
      deny('Preview retest node busy',429,'PREVIEW_LIMIT');
    const requestId=randomUUID(),connectionGeneration=node.connectionGeneration;
    return new Promise((resolve,reject)=>{
      const finish=(error,result)=>{if(!retestRequests.has(requestId))return;
        retestRequests.delete(requestId);clearTimeout(timer);error?reject(error):resolve(result);};
      const timer=setTimeout(()=>finish(new HubError('Preview retest timed out',503,'PREVIEW_RETEST_UNKNOWN')),5000);
      timer.unref?.();retestRequests.set(requestId,{node,connectionGeneration,finish});
      try{node.ws.send(JSON.stringify({v:1,type:'retest-compare',requestId,current,previous}));}
      catch{finish(new HubError('Preview retest node offline',503,'NODE_OFFLINE'));}
    });
  }
  async function requestFeedback(row, input) {
    const node = activeNode(row);
    if (feedbackRequests.size >= 16 || node.ws.bufferedAmount > 1_048_576)
      deny('Preview node busy', 429, 'PREVIEW_LIMIT');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(new HubError('Feedback confirmation timed out', 503, 'PREVIEW_TASK_TIMEOUT')), 5000);
      timer.unref?.();
      const settle = (error, taskId) => {
        if (!feedbackRequests.has(requestId)) return;
        feedbackRequests.delete(requestId); clearTimeout(timer);
        error ? reject(error) : resolve({ taskId });
      };
      feedbackRequests.set(requestId, { node, settle });
      node.ws.send(JSON.stringify({ type: 'create-feedback', v: 1, requestId, feedback: input }));
    });
  }
  async function reconcileFeedback(row,feedback){
    const node=recoveryNode(row);
    if(feedbackRequests.size>=16||node.ws.bufferedAmount>1_048_576)deny('Preview node busy',429,'PREVIEW_LIMIT');
    const requestId=randomUUID();
    const allowFence=feedback.status==='confirming'&&feedback.protocol_version===2&&node.feedbackRecovery===2&&
      feedback.recovery_store_id&&feedback.recovery_store_id===node.recoveryStoreId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>settle(new HubError('Feedback verification timed out',503,'PREVIEW_TASK_TIMEOUT')),5000);
      timer.unref?.();
      const settle=(error,result)=>{if(!feedbackRequests.has(requestId))return;feedbackRequests.delete(requestId);
        clearTimeout(timer);error?reject(error):resolve(result);};
      feedbackRequests.set(requestId,{node,settle,reconcile:true});
      node.ws.send(JSON.stringify({type:'reconcile-feedback',v:1,requestId,feedback:feedbackInput(row,feedback),
        allowFence:Boolean(allowFence)}));
    });
  }
  function nodeMessage(node, frame) {
    if(frame.v===1&&['retest-result','retest-error'].includes(frame.type)){
      const pending=retestRequests.get(frame.requestId);
      if(!pending||pending.node!==node||pending.connectionGeneration!==node.connectionGeneration)return;
      if(frame.type==='retest-error')pending.finish(new HubError('Preview retest could not be verified',503,
        frame.code==='PREVIEW_RETEST_UNSUPPORTED'?'PREVIEW_RETEST_UNSUPPORTED':
          frame.code==='PREVIEW_RETEST_BUSY'?'PREVIEW_RETEST_BUSY':'PREVIEW_RETEST_UNKNOWN'));
      else pending.finish(null,frame.result);
      return;
    }
    if(frame.v===2&&['records-result','records-error'].includes(frame.type)){
      const pending=recordRequests.get(frame.requestId);
      if(!pending||pending.node!==node)return;
      if(frame.type==='records-error')pending.finish(new HubError('Preview record operation uncertain',503,
        typeof frame.code==='string'&&/^PREVIEW_[A-Z_]+$/.test(frame.code)?frame.code:'PREVIEW_RECORD_UNKNOWN'));
      else pending.finish(null,frame.result);
      return;
    }
    if (frame.type === 'register' || frame.type === 'registration-query') {
      const m = frame.manifest; validateManifest(m);
      if (!store.canAccess({ id: node.nodeId, role: 'node' }, m.projectId)) deny('Project grant required');
      const owner = store.db.prepare('SELECT node_id,epoch FROM project_owners WHERE tenant_id=? AND project_id=?').get(node.tenantId, m.projectId);
      if (!owner || owner.node_id !== node.nodeId || owner.epoch !== node.epoch)
        deny('Preview project owner changed',409,'PREVIEW_VERSION');
      const prior = store.db.prepare('SELECT tenant_id,node_id,node_epoch,project_id,manifest_json FROM preview_builds WHERE preview_id=?').get(m.previewId);
      if(prior && (prior.tenant_id!==node.tenantId||prior.node_id!==node.nodeId||
        prior.node_epoch!==node.epoch||prior.project_id!==m.projectId||prior.manifest_json!==JSON.stringify(m)))
        deny('Preview ID already used',409,'PREVIEW_VERSION');
      if(frame.type==='registration-query'){
        if(!ID.test(frame.requestId))deny('Invalid request ID',400,'PREVIEW_FRAME');
        node.ws.send(JSON.stringify({type:'registration-status',v:1,requestId:frame.requestId,
          previewId:m.previewId,found:Boolean(prior)}));
        return;
      }
      const task = snapshotTask({ node_id: node.nodeId, node_epoch: node.epoch, tenant_id: node.tenantId,
        task_id: m.taskId, project_id: m.projectId });
      if (!prior && (task?.contentVersion !== m.contentVersion ||
        (m.provenance && task?.revision !== m.sourceTaskRevision)))
        deny('Preview must match current task snapshot and project owner', 409, 'PREVIEW_VERSION');
      if (!prior) store.db.prepare('INSERT INTO preview_builds VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(m.previewId, node.tenantId, node.nodeId, node.epoch, m.projectId, m.taskId, m.contentVersion,
          m.artifactDigest, JSON.stringify(m), JSON.stringify(Array.isArray(task.criteria) ? task.criteria : []), now());
      node.ws.send(JSON.stringify({ type: 'registered', v: 1, previewId: m.previewId }));
      return;
    }
    if (!ID.test(frame.requestId)) deny('Invalid request ID', 400, 'PREVIEW_FRAME');
    if (frame.type === 'feedback-created' || frame.type === 'feedback-error') {
      const pendingFeedback = feedbackRequests.get(frame.requestId);
      if (!pendingFeedback || pendingFeedback.node !== node || pendingFeedback.reconcile) return;
      if (frame.type === 'feedback-error') pendingFeedback.settle(new HubError('Feedback task creation failed', 503,
        frame.code === 'PREVIEW_LIMIT' ? 'PREVIEW_LIMIT' : 'PREVIEW_TASK_FAILED'));
      else if (!ID.test(frame.taskId)) deny('Invalid feedback receipt', 400, 'PREVIEW_FRAME');
      else pendingFeedback.settle(null, frame.taskId);
      return;
    }
    if(frame.type==='feedback-reconciled'||frame.type==='feedback-reconcile-error'){
      const pendingFeedback=feedbackRequests.get(frame.requestId);
      if(!pendingFeedback||pendingFeedback.node!==node||!pendingFeedback.reconcile)return;
      if(frame.type==='feedback-reconcile-error')pendingFeedback.settle(new HubError('Feedback verification failed',503,
        frame.code==='PREVIEW_LIMIT'?'PREVIEW_LIMIT':'PREVIEW_TASK_FAILED'));
      else if(!['confirmed','created_unavailable','not_applied','unknown'].includes(frame.status)||
        (['confirmed','created_unavailable'].includes(frame.status)&&!ID.test(frame.taskId)))
        deny('Invalid feedback verification receipt',400,'PREVIEW_FRAME');
      else pendingFeedback.settle(null,{status:frame.status,taskId:frame.taskId});
      return;
    }
    const pending = requests.get(frame.requestId);
    if (!pending || pending.node !== node) return;
    if (frame.type === 'error') {
      pending.finish(frame.code === 'PREVIEW_LIMIT' ? new HubError('Preview node busy', 429, 'PREVIEW_LIMIT') :
        new HubError('Preview asset unavailable', 503, 'PREVIEW_ASSET')); return;
    }
    if (frame.type === 'start') {
      if (pending.started || frame.size !== pending.entry.size || frame.sha256 !== pending.entry.sha256)
        deny('Preview asset changed', 409, 'PREVIEW_CHANGED');
      pending.started = true; return;
    }
    if (frame.type === 'chunk') {
      if (!pending.started || frame.seq !== pending.seq++ || typeof frame.data !== 'string' || frame.data.length > 22000 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) deny('Invalid preview chunk', 400, 'PREVIEW_FRAME');
      const bytes = Buffer.from(frame.data, 'base64');
      if (bytes.toString('base64') !== frame.data || (pending.size += bytes.length) > pending.entry.size) deny('Preview size exceeded', 413, 'PREVIEW_LIMIT');
      pending.chunks.push(bytes); return;
    }
    if (frame.type === 'end') {
      const bytes = Buffer.concat(pending.chunks);
      if (!pending.started || bytes.length !== pending.entry.size || hash(bytes) !== pending.entry.sha256)
        deny('Preview asset changed', 409, 'PREVIEW_CHANGED');
      pending.finish(null, bytes); return;
    }
    deny('Unknown preview frame', 400, 'PREVIEW_FRAME');
  }
  function nodeSocket(ws) {
    let node = null;
    const timer = setTimeout(() => ws.close(4001, 'Auth timeout'), 5000); timer.unref?.();
    ws.on('message', (data, binary) => {
      try {
        if (binary || data.length > 262144) deny('Invalid frame', 400, 'PREVIEW_FRAME');
        const frame = JSON.parse(data.toString());
        if(frame.v!==1&&!(frame.v===2&&['records-result','records-error'].includes(frame.type)))
          deny('Invalid version',400,'PREVIEW_FRAME');
        if (!node) {
          if (frame.type !== 'auth' || !ID.test(frame.nodeId) || typeof frame.token !== 'string') deny('Node auth required', 401, 'UNAUTHORIZED');
          const subject = store.authenticate(frame.token);
          if (subject.role !== 'node' || subject.id !== frame.nodeId) deny('Node auth required', 401, 'UNAUTHORIZED');
          nodes.get(subject.id)?.ws.close(4001, 'Node replaced');
          if(frame.feedbackRecovery!==undefined&&(frame.feedbackRecovery!==2||!ID.test(frame.recoveryStoreId)))
            deny('Invalid feedback recovery identity',400,'PREVIEW_FRAME');
          node = { nodeId: subject.id, tenantId: subject.tenant_id, epoch: subject.epoch, ws,
            connectionGeneration:++nodeConnectionGeneration,
            feedbackRecovery:frame.feedbackRecovery===2?2:1,recoveryStoreId:frame.feedbackRecovery===2?frame.recoveryStoreId:null };
          nodes.set(node.nodeId, node); clearTimeout(timer);
          ws.send(JSON.stringify({ type: 'ready', v: 1, nodeId: node.nodeId, epoch: node.epoch })); return;
        }
        const current = store.db.prepare('SELECT epoch,revoked_at FROM subjects WHERE id=?').get(node.nodeId);
        if (nodes.get(node.nodeId) !== node || !current || current.revoked_at || current.epoch !== node.epoch) deny('Node changed', 403, 'NODE_CHANGED');
        nodeMessage(node, frame);
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', v: 1, code: error.code || 'PREVIEW_FRAME' }));
        ws.close(4003, 'Preview denied');
      }
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (node && nodes.get(node.nodeId) === node) nodes.delete(node.nodeId);
      for (const pending of requests.values()) if (pending.node === node) pending.finish(new HubError('Preview node offline', 503, 'NODE_OFFLINE'));
      for (const pending of feedbackRequests.values()) if (pending.node === node)
        pending.settle(new HubError('Preview node offline', 503, 'NODE_OFFLINE'));
      for(const pending of recordRequests.values())if(pending.node===node)
        pending.finish(new HubError('Preview record node offline',503,'PREVIEW_RECORD_UNKNOWN'));
      for(const pending of retestRequests.values())if(pending.node===node)
        pending.finish(new HubError('Preview retest node offline',503,'NODE_OFFLINE'));
    });
  }
  async function handleHttp({ req, res, method, path, body = {}, send }) {
    if (!path.startsWith('/api/previews')) return false;
    if (closed) deny('Preview Hub closing', 503, 'SHUTTING_DOWN');
    const url = new URL(req.url, 'http://localhost');
    const dataRoute=/^\/api\/previews\/([^/]+)\/data\/records$/.exec(path);
    if(dataRoute){
      const row=rowFor(dataRoute[1]),manifest=JSON.parse(row.manifest_json);
      if(manifest.v!==2||manifest.apiTarget!=='records-v1')deny('Preview data target unavailable',404,'PREVIEW_NOT_FOUND');
      if(method==='OPTIONS'){
        if(req.headers.origin!=='null'||req.headers['access-control-request-method']!=='POST'&&
          req.headers['access-control-request-method']!=='GET'||
          !/^(?:content-type,\s*x-seqivo-preview-data|x-seqivo-preview-data,\s*content-type|x-seqivo-preview-data)$/i
            .test(req.headers['access-control-request-headers']||''))deny('Preview data preflight denied',403,'ORIGIN');
        res.writeHead(204,{'Access-Control-Allow-Origin':'null','Access-Control-Allow-Methods':'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers':'Content-Type, X-Seqivo-Preview-Data','Vary':'Origin','Cache-Control':'no-store'});
        res.end();return true;
      }
      if(req.headers.origin!=='null'||!['GET','POST'].includes(method)||url.search)
        deny('Preview data origin or method denied',403,'ORIGIN');
      const cap=dataCapabilityFor(row,req),node=activeNode(row),scope=recordScope(row);
      if(method==='GET'){
        const result=await recordFrame(node,{type:'records-list',scope});
        if(!result||!Array.isArray(result.records)||result.records.length>200)
          deny('Preview data reply invalid',503,'PREVIEW_RECORD_UNKNOWN');
        if(dataCapabilityFor(row,req).token_hash!==cap.token_hash||activeNode(row)!==node)deny('Preview data changed',403,'PREVIEW_DATA_AUTH');
        res.setHeader('Access-Control-Allow-Origin','null');res.setHeader('Vary','Origin');
        send(200,{records:result.records});return true;
      }
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==2||
        !ID.test(body.clientMutationId)||typeof body.title!=='string')deny('Invalid preview record',400,'PREVIEW_RECORD_INPUT');
      if(cap.write_enabled!==1)deny('Preview data write requires owner',403,'PREVIEW_FORBIDDEN');
      const title=body.title.trim();
      if(!title||!title.isWellFormed()||Array.from(title).length>120||Buffer.byteLength(title)>480||
        /[\p{Cc}\p{Cf}]/u.test(title))deny('Invalid preview title',400,'PREVIEW_RECORD_INPUT');
      const payloadHash=hash(JSON.stringify({title}));
      const admission=sqliteTransaction(store.db,()=>{
        const activeCap=dataCapabilityFor(row,req);
        if(activeCap.token_hash!==cap.token_hash||activeCap.write_enabled!==1||activeNode(row)!==node)
          deny('Preview data changed',403,'PREVIEW_DATA_AUTH');
        const prior=store.db.prepare(`SELECT * FROM preview_record_operations WHERE preview_id=? AND data_store_id=?
          AND tenant_id=? AND user_id=? AND client_mutation_id=?`)
          .get(row.preview_id,scope.dataStoreId,row.tenant_id,cap.user_id,body.clientMutationId);
        if(prior){if(prior.payload_hash!==payloadHash)deny('Mutation payload changed',409,'PREVIEW_RECORD_CONFLICT');
          return {row:prior,inserted:false};}
        if(store.db.prepare(`SELECT 1 FROM preview_record_operations WHERE preview_id=? AND user_id=?
          AND status IN ('admitted','dispatched') LIMIT 1`).get(row.preview_id,cap.user_id))
          deny('Earlier preview write needs verification',409,'PREVIEW_RECORD_UNKNOWN');
        if(store.db.prepare('SELECT count(*) AS n FROM preview_record_operations WHERE preview_id=?')
          .get(row.preview_id).n>=MAX_RECORD_OPERATIONS_PER_PREVIEW||
          store.db.prepare('SELECT count(*) AS n FROM preview_record_operations').get().n>=MAX_RECORD_OPERATIONS_TOTAL)
          deny('Preview operation limit',429,'PREVIEW_RECORD_OPERATION_LIMIT');
        const operationId=randomUUID();
        const sequence=store.db.prepare('SELECT COALESCE(MAX(admission_sequence),0)+1 AS n FROM preview_record_operations').get().n;
        store.db.prepare(`INSERT INTO preview_record_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(operationId,row.preview_id,scope.dataStoreId,row.tenant_id,cap.user_id,cap.session_hash,
            body.clientMutationId,payloadHash,title,node.nodeId,node.epoch,node.connectionGeneration,
            sequence,'admitted',null,now());
        return {row:store.db.prepare('SELECT * FROM preview_record_operations WHERE operation_id=?').get(operationId),inserted:true};
      });
      const admitted=admission.row;
      if(admitted.status==='confirmed'){
        res.setHeader('Access-Control-Allow-Origin','null');res.setHeader('Vary','Origin');
        send(200,{operationId:admitted.operation_id,record:JSON.parse(admitted.record_json)});return true;
      }
      if(!admission.inserted||admitted.status!=='admitted'||admitted.connection_generation!==node.connectionGeneration||
        admitted.node_epoch!==node.epoch)deny('Original write requires verification',503,'PREVIEW_RECORD_UNKNOWN');
      // Only the request that inserted this admission may dispatch it. An exact retry
      // observes an uncertain operation and must use account-authenticated recovery.
      const sent=store.db.prepare("UPDATE preview_record_operations SET status='dispatched' WHERE operation_id=? AND status='admitted'")
        .run(admitted.operation_id);
      if(sent.changes!==1)deny('Original write requires verification',503,'PREVIEW_RECORD_UNKNOWN');
      const operation={operationId:admitted.operation_id,tenantId:admitted.tenant_id,actorUserId:admitted.user_id,
        clientMutationId:admitted.client_mutation_id,payloadHash:admitted.payload_hash,
        admission:{nodeId:admitted.node_id,nodeEpoch:admitted.node_epoch,
          connectionGeneration:admitted.connection_generation,admissionSequence:admitted.admission_sequence},title};
      let result;
      try{result=await recordFrame(node,{type:'records-create',scope,operation});}
      catch{deny('Preview write result unknown',503,'PREVIEW_RECORD_UNKNOWN');}
      if(result?.operation?.id!==admitted.operation_id||result.operation.status!=='confirmed'||
        typeof result.operation.record?.id!=='string')deny('Preview write receipt uncertain',503,'PREVIEW_RECORD_UNKNOWN');
      sqliteTransaction(store.db,()=>{
        const fresh=store.db.prepare('SELECT * FROM preview_record_operations WHERE operation_id=?').get(admitted.operation_id);
        if(fresh?.status==='dispatched')store.db.prepare("UPDATE preview_record_operations SET status='confirmed',record_json=? WHERE operation_id=?")
          .run(JSON.stringify(result.operation.record),admitted.operation_id);
      });
      if(dataCapabilityFor(row,req).token_hash!==cap.token_hash||activeNode(row)!==node)deny('Preview data changed',403,'PREVIEW_DATA_AUTH');
      res.setHeader('Access-Control-Allow-Origin','null');res.setHeader('Vary','Origin');
      send(200,{operationId:admitted.operation_id,record:result.operation.record});return true;
    }
    const recordRecovery=/^\/api\/previews\/([^/]+)\/data\/stores\/([^/]+)\/operations\/by-key\/([^/]+)(?:\/(reconcile))?$/.exec(path);
    if(recordRecovery){
      if(url.search||!ID.test(recordRecovery[2])||!ID.test(recordRecovery[3]))
        deny('Invalid preview recovery key',400,'PREVIEW_RECORD_INPUT');
      const row=rowFor(recordRecovery[1]),scope=recordScope(row),login=authorize(req,row);
      if(scope.dataStoreId!==recordRecovery[2]||JSON.parse(row.manifest_json).apiTarget!=='records-v1')
        deny('Preview data store changed',409,'PREVIEW_VERSION');
      if(method==='POST'){sameOrigin(req);if(!emptyIntentBody(body))deny('Recovery body must be empty',400,'PREVIEW_RECORD_INPUT');}
      else if(method!=='GET'||recordRecovery[4])deny('Recovery method unavailable',405,'METHOD');
      const item=store.db.prepare(`SELECT * FROM preview_record_operations WHERE preview_id=? AND data_store_id=?
        AND tenant_id=? AND user_id=? AND client_mutation_id=?`)
        .get(row.preview_id,scope.dataStoreId,row.tenant_id,login.user.id,recordRecovery[3]);
      // An absent Hub row is not a non-execution proof: a restored backup may
      // have lost the admission while the original Core write still exists.
      if(!item)deny('Original operation is not known',404,'PREVIEW_RECORD_UNKNOWN');
      const publicResult=(value)=>({operation:{id:value.operation_id,clientMutationId:value.client_mutation_id,
        state:value.status==='confirmed'?'confirmed':value.status==='not_applied'?'not_applied':'unknown',
        ...(value.status==='confirmed'&&value.record_json?{recordId:JSON.parse(value.record_json).id}:{})}});
      if(method==='GET'||['confirmed','not_applied'].includes(item.status)){
        send(200,publicResult(item));return true;
      }
      const node=activeNode(row);
      if(node.nodeId!==item.node_id||node.epoch!==item.node_epoch||
        node.connectionGeneration!==item.connection_generation)
        deny('Original node continuity unavailable',503,'PREVIEW_RECORD_UNKNOWN');
      const operation={operationId:item.operation_id,tenantId:item.tenant_id,actorUserId:item.user_id,
        clientMutationId:item.client_mutation_id,payloadHash:item.payload_hash,
        admission:{nodeId:item.node_id,nodeEpoch:item.node_epoch,
          connectionGeneration:item.connection_generation,admissionSequence:item.admission_sequence}};
      let result;
      try{result=await recordFrame(node,{type:'records-reconcile',scope,operation});}
      catch{deny('Original outcome still unknown',503,'PREVIEW_RECORD_UNKNOWN');}
      if(activeNode(row)!==node||authorize(req,row).user.id!==login.user.id)
        deny('Preview authority changed',403,'PREVIEW_FORBIDDEN');
      if(result?.operation?.id!==item.operation_id||
        !['confirmed','not_applied'].includes(result.operation.status))
        deny('Original outcome still unknown',503,'PREVIEW_RECORD_UNKNOWN');
      const updated=sqliteTransaction(store.db,()=>{
        const fresh=store.db.prepare('SELECT * FROM preview_record_operations WHERE operation_id=?').get(item.operation_id);
        if(!fresh||fresh.preview_id!==row.preview_id||fresh.user_id!==login.user.id)
          deny('Original operation changed',503,'PREVIEW_RECORD_UNKNOWN');
        if(!['confirmed','not_applied'].includes(fresh.status))
          store.db.prepare('UPDATE preview_record_operations SET status=?,record_json=? WHERE operation_id=?')
            .run(result.operation.status,result.operation.record?JSON.stringify(result.operation.record):null,item.operation_id);
        return store.db.prepare('SELECT * FROM preview_record_operations WHERE operation_id=?').get(item.operation_id);
      });
      if(authorize(req,row).user.id!==login.user.id)deny('Preview authority changed',403,'PREVIEW_FORBIDDEN');
      send(200,publicResult(updated));return true;
    }
    if (url.search && !((path === '/api/previews' && [...url.searchParams.keys()].every(key => key === 'taskId')) ||
      (/^\/api\/previews\/[^/]+\/retest$/.test(path) && [...url.searchParams.keys()].every(key => key === 'previous'))))
      deny('Query not allowed', 400, 'PREVIEW_QUERY');
    if (method === 'GET' && path === '/api/previews') {
      const taskId = url.searchParams.get('taskId');
      if (!ID.test(taskId) || [...url.searchParams.keys()].some(key => key !== 'taskId')) deny('Task ID required', 400, 'PREVIEW_TASK');
      const login = session(accounts, req, secure);
      const rows = store.db.prepare('SELECT * FROM preview_builds WHERE tenant_id=? AND task_id=? ORDER BY created_at DESC LIMIT 30')
        .all(login.subject.tenant_id, taskId).filter(row => store.canAccess(login.subject, row.project_id));
      send(200, { previews: rows.map(publicManifest) }); return true;
    }
    const site = /^\/api\/previews\/([^/]+)\/site\/([^/]+)\/(.+)$/.exec(path);
    if (method === 'GET' && site) {
      const row = rowFor(site[1]), cap = site[2];
      let assetPath;
      try { assetPath = previewPath(decodeURIComponent(site[3])); } catch { deny('Invalid preview path', 400, 'PREVIEW_PATH'); }
      const capability = capabilityFor(row, cap);
      accessFor(row, capability);
      if (assetPath === 'index.html') {
        const login = authorize(req, row);
        if (login.user.id !== capability.user_id) deny('Preview link belongs to another account');
      }
      const { bytes, node } = await asset(row, assetPath);
      // A capability, account grant, or node may change while the remote asset
      // is in flight. No bytes have been written yet, so repeat every authority
      // check synchronously immediately before the response headers.
      const currentCapability = capabilityFor(row, cap);
      if (currentCapability.user_id !== capability.user_id ||
        currentCapability.session_hash !== capability.session_hash) deny('Preview access changed', 403, 'PREVIEW_FORBIDDEN');
      accessFor(row, currentCapability);
      if (activeNode(row) !== node) deny('Preview node changed', 409, 'PREVIEW_NODE_CHANGED');
      if (assetPath === 'index.html') {
        const login = authorize(req, row);
        if (login.user.id !== currentCapability.user_id)
          deny('Preview link belongs to another account');
      }
      const contentType = mime(assetPath), isHtml = contentType.startsWith('text/html');
      const source = origin(req);
      const dynamic=JSON.parse(row.manifest_json).apiTarget==='records-v1';
      const headers = { 'Content-Type': contentType, 'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin',
        'Referrer-Policy': 'no-referrer' };
      if (req.headers.origin === 'null' && !isHtml) headers['Access-Control-Allow-Origin'] = 'null';
      headers['Content-Security-Policy'] = isHtml
        ? `sandbox allow-scripts allow-forms; default-src 'none'; script-src ${source}; style-src ${source} 'unsafe-inline'; img-src ${source} data:; font-src ${source} data:; connect-src ${dynamic?`${source}/api/previews/${row.preview_id}/data/records`:"'none'"}; frame-ancestors ${source}; base-uri 'none'; form-action 'none'`
        : "sandbox; default-src 'none'; script-src 'none'; connect-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
      if (contentType === 'application/octet-stream') headers['Content-Disposition'] = 'attachment';
      if (isHtml) res.removeHeader('X-Frame-Options');
      res.writeHead(200, headers); res.end(bytes); return true;
    }
    const access = /^\/api\/previews\/([^/]+)\/access-intents(?:\/([^/]+)(?:\/(issue|close))?)?$/.exec(path);
    if (access) {
      const row = rowFor(access[1]);
      if (method === 'POST') sameOrigin(req);
      const login = authorize(req, row);
      if (method === 'POST' && !emptyIntentBody(body)) deny('Invalid preview intent request', 400, 'PREVIEW_ACCESS_BODY');
      if (method === 'POST' && !access[2]) {
        const intent = sqliteTransaction(store.db, () => {
          pruneIntents(login.user.id);
          if (store.db.prepare(`SELECT count(*) AS n FROM preview_access_intents WHERE user_id=?
            AND state IN ('registered','issued') AND expires_at>?`).get(login.user.id, now()).n >= MAX_ACTIVE_INTENTS)
            deny('Too many active preview intents', 429, 'PREVIEW_LIMIT');
          const time = now(), id = newIntentId(), expiresAt = time + INTENT_TTL;
          store.db.prepare('INSERT INTO preview_access_intents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(id, row.preview_id, row.project_id, row.task_id, row.artifact_digest, login.user.id,
              login.tokenHash, 'registered', null, expiresAt, time, time);
          return { id, preview_id: row.preview_id, project_id: row.project_id,
            task_id: row.task_id, expires_at: expiresAt };
        });
        send(200, { intent: publicIntent(intent, 'registered') }); return true;
      }
      const intent = intentFor(row, access[2], login), state = intentState(intent, now());
      if (method === 'GET' && !access[3]) {
        send(200, { intent: publicIntent(intent, state) }); return true;
      }
      if (method === 'POST' && access[3] === 'issue') {
        if (state !== 'registered') deny('Preview intent cannot be issued', 409, 'PREVIEW_ACCESS_ALREADY_ISSUED');
        const token = randomBytes(32).toString('base64url'), tokenHash = hash(token);
        const dynamic=JSON.parse(row.manifest_json).apiTarget==='records-v1';
        const dataToken=dynamic?randomBytes(32).toString('base64url'):null;
        sqliteTransaction(store.db, () => {
          const fresh = intentFor(row, intent.id, login);
          if (intentState(fresh, now()) !== 'registered')
            deny('Preview intent cannot be issued', 409, 'PREVIEW_ACCESS_ALREADY_ISSUED');
          store.db.prepare('DELETE FROM preview_caps WHERE expires_at<=?').run(now());
          store.db.prepare('DELETE FROM preview_data_caps WHERE expires_at<=?').run(now());
          if (store.db.prepare(`SELECT count(*) AS n FROM preview_caps WHERE user_id=? AND revoked_at IS NULL`)
            .get(login.user.id).n >= MAX_ACTIVE_CAPS) deny('Too many active preview links', 429, 'PREVIEW_LIMIT');
          store.db.prepare('INSERT INTO preview_caps VALUES(?,?,?,?,?,NULL)')
            .run(tokenHash, row.preview_id, login.user.id, login.tokenHash, fresh.expires_at);
          if(dataToken)store.db.prepare('INSERT INTO preview_data_caps VALUES(?,?,?,?,?,?,?,NULL)')
            .run(hash(dataToken),row.preview_id,fresh.id,login.user.id,login.tokenHash,
              login.subject.role==='owner'?1:0,fresh.expires_at);
          const updated = store.db.prepare(`UPDATE preview_access_intents SET state='issued',cap_hash=?,updated_at=?
            WHERE id=? AND state='registered'`).run(tokenHash, now(), fresh.id);
          if (updated.changes !== 1) deny('Preview intent changed', 409, 'PREVIEW_ACCESS_ALREADY_ISSUED');
        });
        send(200, { preview: publicManifest(row),
          launchUrl: `/api/previews/${row.preview_id}/site/${token}/index.html`, expiresAt: intent.expires_at,
          ...(dataToken?{dataCapability:dataToken}:{}),
          intent: publicIntent(intent, 'issued') }); return true;
      }
      if (method === 'POST' && access[3] === 'close') {
        const closed = sqliteTransaction(store.db, () => {
          const fresh = intentFor(row, intent.id, login), current = intentState(fresh, now());
          if (current === 'closed' || current === 'expired' || current === 'invalidated') {
            if (fresh.state !== current) store.db.prepare('UPDATE preview_access_intents SET state=?,updated_at=? WHERE id=?')
              .run(current, now(), fresh.id);
            pruneIntents(login.user.id);
            return publicIntent(fresh, current);
          }
          if (current === 'issued') {
            const cap = fresh.cap_hash && store.db.prepare('SELECT * FROM preview_caps WHERE token_hash=?').get(fresh.cap_hash);
            if (!cap || cap.preview_id !== row.preview_id || cap.user_id !== login.user.id ||
              cap.session_hash !== login.tokenHash || cap.expires_at !== fresh.expires_at)
              deny('Preview intent state cannot be verified', 503, 'PREVIEW_ACCESS_UNKNOWN');
            store.db.prepare('UPDATE preview_caps SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL')
              .run(now(), fresh.cap_hash);
            pruneRevokedCaps(login.user.id);
            if(JSON.parse(row.manifest_json).apiTarget==='records-v1'){
              const data=store.db.prepare('SELECT * FROM preview_data_caps WHERE intent_id=?').get(fresh.id);
              if(!data||data.preview_id!==row.preview_id||data.user_id!==login.user.id||
                data.session_hash!==login.tokenHash||data.expires_at!==fresh.expires_at)
                deny('Preview data access cannot be verified',503,'PREVIEW_ACCESS_UNKNOWN');
              store.db.prepare('UPDATE preview_data_caps SET revoked_at=? WHERE intent_id=? AND revoked_at IS NULL')
                .run(now(),fresh.id);
              pruneRevokedDataCaps(login.user.id);
            }
          }
          store.db.prepare("UPDATE preview_access_intents SET state='closed',updated_at=? WHERE id=?")
            .run(now(), fresh.id);
          pruneIntents(login.user.id);
          return publicIntent(fresh, 'closed');
        });
        const unsettled=JSON.parse(row.manifest_json).apiTarget==='records-v1'&&
          store.db.prepare(`SELECT 1 FROM preview_record_operations WHERE preview_id=? AND session_hash=?
            AND status NOT IN ('confirmed','not_applied') LIMIT 1`).get(row.preview_id,login.tokenHash);
        send(200, { intent: closed, inactive: true,
          ...(JSON.parse(row.manifest_json).apiTarget==='records-v1'?{dataWrites:unsettled?'unknown':'settled'}:{}) }); return true;
      }
      deny('Preview intent route unavailable', 404, 'NOT_FOUND');
    }
    const recovery=/^\/api\/previews\/([^/]+)\/feedback\/(?:by-key\/([^/]+)|([^/]+))(?:\/(reconcile))?$/.exec(path);
    if(recovery){
      const row=rowFor(recovery[1]);
      if(method==='POST')sameOrigin(req);
      const login=authorize(req,row,true);
      if(!['GET','POST'].includes(method)||method==='POST'&&(!recovery[4]||!emptyIntentBody(body))||
        method==='GET'&&recovery[4])deny('Invalid feedback recovery request',400,'PREVIEW_FEEDBACK');
      const key=recovery[2],feedbackId=recovery[3];
      if(!ID.test(key||feedbackId))deny('Feedback unavailable',404,'PREVIEW_FEEDBACK');
      const lookup=()=>key?store.db.prepare('SELECT * FROM preview_feedback WHERE preview_id=? AND user_id=? AND idem_key=?')
        .get(row.preview_id,login.user.id,key):store.db.prepare('SELECT * FROM preview_feedback WHERE preview_id=? AND user_id=? AND id=?')
        .get(row.preview_id,login.user.id,feedbackId);
      let feedback=lookup();
      if(!feedback){
        if(!key||method==='GET')deny('Feedback unavailable',404,'PREVIEW_FEEDBACK');
        const result=sqliteTransaction(store.db,()=>{
          feedback=lookup();if(feedback)return feedbackResult(row,feedback);
          const fence=store.db.prepare('SELECT 1 FROM preview_feedback_fences WHERE preview_id=? AND user_id=? AND idem_key=?')
            .get(row.preview_id,login.user.id,key);
          if(!fence){
            const count=store.db.prepare(`SELECT (SELECT count(*) FROM preview_feedback WHERE preview_id=? AND user_id=?) +
              (SELECT count(*) FROM preview_feedback_fences WHERE preview_id=? AND user_id=?) AS n`)
              .get(row.preview_id,login.user.id,row.preview_id,login.user.id).n;
            if(count>=200)deny('Too many preview reports',429,'PREVIEW_LIMIT');
            store.db.prepare('INSERT INTO preview_feedback_fences VALUES(?,?,?,?)').run(row.preview_id,login.user.id,key,now());
          }
          return {feedback:{previewId:row.preview_id,projectId:row.project_id,sourceTaskId:row.task_id,
            contentVersion:row.content_version,status:'not_applied'},verification:{state:'not_applied',checkedAt:now()}};
        });
        send(200,result);return true;
      }
      if(method==='GET'){
        send(200,feedbackResult(row,feedback,feedback.status==='draft'&&feedback.protocol_version===1?'confirming':feedback.status));
        return true;
      }
      if(feedback.status==='draft'&&feedback.protocol_version===0){send(200,feedbackResult(row,feedback));return true;}
      if(feedback.status==='not_applied'){send(200,feedbackResult(row,feedback,'not_applied',null,true));return true;}
      let verified;
      try{
        if(typeof createTask==='function')verified={status:'unknown'};
        else if(recoveryNode(row).feedbackRecovery!==2)verified={status:'unknown'};
        else verified=await reconcileFeedback(row,feedback);
      }catch(error){
        if(['NODE_OFFLINE','PREVIEW_TASK_TIMEOUT','PREVIEW_OWNER_CHANGED'].includes(error.code))verified={status:'unknown'};
        else throw error;
      }
      const contradiction=['confirmed','created_unavailable'].includes(feedback.status)&&verified.status==='not_applied';
      if(!contradiction&&['confirmed','created_unavailable','not_applied'].includes(verified.status))
        store.db.prepare(`UPDATE preview_feedback SET status=?,task_id=?,confirmed_at=COALESCE(confirmed_at,?)
          WHERE id=? AND status IN ('draft','confirming','confirmed')`)
          .run(verified.status,verified.taskId||null,now(),feedback.id);
      const currentLogin=authorize(req,row,true);
      if(currentLogin.user.id!==login.user.id||currentLogin.tokenHash!==login.tokenHash)deny('Preview account changed',409,'PREVIEW_ACTOR_CHANGED');
      feedback=lookup();
      const effective=verified.status==='unknown'&&!['confirmed','created_unavailable','not_applied'].includes(feedback.status)
        ?'confirming':feedback.status;
      send(200,{...feedbackResult(row,feedback,effective,verified.taskId||feedback.task_id,true),
        verification:{state:contradiction||effective==='confirming'?'unknown':effective==='not_applied'?'not_applied':'confirmed',checkedAt:now()}});
      return true;
    }
    const match = /^\/api\/previews\/([^/]+)(?:\/(retest|feedback|revoke)(?:\/([^/]+)\/confirm)?)?$/.exec(path);
    if (!match) deny('Preview route unavailable', 404, 'NOT_FOUND');
    const row = rowFor(match[1]);
    if (method === 'GET' && !match[2]) {
      const login = authorize(req, row);
      if(JSON.parse(row.manifest_json).apiTarget==='records-v1')
        deny('Dynamic preview requires a registered access intent',409,'PREVIEW_ACCESS_REQUIRED');
      store.db.prepare('DELETE FROM preview_caps WHERE expires_at<=?').run(now());
      if (store.db.prepare('SELECT count(*) AS n FROM preview_caps WHERE user_id=? AND revoked_at IS NULL').get(login.user.id).n >= MAX_ACTIVE_CAPS)
        deny('Too many active preview links', 429, 'PREVIEW_LIMIT');
      const token = randomBytes(32).toString('base64url');
      store.db.prepare('INSERT INTO preview_caps VALUES(?,?,?,?,?,NULL)').run(hash(token), row.preview_id, login.user.id,
        login.tokenHash, now() + 10 * 60_000);
      const launchUrl = `/api/previews/${row.preview_id}/site/${token}/index.html`;
      send(200, { preview: publicManifest(row), launchUrl, expiresAt: now() + 10 * 60_000 }); return true;
    }
    if (method === 'POST' && match[2] === 'revoke' && !match[3]) {
      sameOrigin(req);
      const login = authorize(req, row);
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !Object.hasOwn(body, 'capability'))
        deny('Invalid preview revocation', 400, 'PREVIEW_CAPABILITY');
      const cap = capabilityFor(row, body.capability, { allowRevoked: true });
      if (cap.user_id !== login.user.id || cap.session_hash !== login.tokenHash)
        deny('Preview link belongs to another session');
      sqliteTransaction(store.db,()=>{
        store.db.prepare('UPDATE preview_caps SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL')
          .run(now(), cap.token_hash);
        const intent=store.db.prepare('SELECT id FROM preview_access_intents WHERE cap_hash=?').get(cap.token_hash);
        if(intent){store.db.prepare('UPDATE preview_data_caps SET revoked_at=? WHERE intent_id=? AND revoked_at IS NULL')
          .run(now(),intent.id);pruneRevokedDataCaps(login.user.id);}
      });
      // Keep bounded tombstones for normal retries; an evicted link fails closed.
      pruneRevokedCaps(login.user.id);
      send(200, { revoked: true }); return true;
    }
    if (method === 'GET' && match[2] === 'retest' && !match[3]) {
      const login=authorize(req, row);
      const previous = rowFor(url.searchParams.get('previous'));
      authorize(req, previous);
      const pair=retestPair(row,previous),currentIdentity=[row.manifest_json,row.criteria_json],
        previousIdentity=[previous.manifest_json,previous.criteria_json];
      let result,node=null;
      try{
        node=activeNode(row);
        if(activeNode(previous)!==node)deny('Preview node changed',409,'PREVIEW_VERSION');
        result=await retestFrame(node,pair.current,pair.previous);
      }catch(error){
        if(!['NODE_OFFLINE','PREVIEW_RETEST_UNKNOWN','PREVIEW_RETEST_UNSUPPORTED',
          'PREVIEW_RETEST_BUSY','PREVIEW_LIMIT'].includes(error?.code))throw error;
        result=unknownRetestResult(pair.current,pair.previous,pair.criteria,
          error.code==='NODE_OFFLINE'?'node_offline':error.code==='PREVIEW_RETEST_UNSUPPORTED'?
            'node_unsupported':error.code==='PREVIEW_RETEST_BUSY'?'node_busy':'node_timeout');
        if(error.code==='NODE_OFFLINE')node=null;
      }
      const fresh=rowFor(row.preview_id),old=rowFor(previous.preview_id);
      const again=authorize(req,fresh),older=authorize(req,old);
      if(again.user.id!==login.user.id||again.tokenHash!==login.tokenHash||
        older.user.id!==login.user.id||older.tokenHash!==login.tokenHash)
        deny('Preview account changed',409,'PREVIEW_ACTOR_CHANGED');
      if(fresh.manifest_json!==currentIdentity[0]||fresh.criteria_json!==currentIdentity[1]||
        old.manifest_json!==previousIdentity[0]||old.criteria_json!==previousIdentity[1])
        deny('Preview registration changed',409,'PREVIEW_VERSION');
      originalRetestOwner(fresh);originalRetestOwner(old);
      if(node){
        let live;
        try{live=activeNode(fresh);if(activeNode(old)!==live)live=null;}
        catch(error){if(error.code!=='NODE_OFFLINE')throw error;}
        if(live!==node){result=unknownRetestResult(pair.current,pair.previous,pair.criteria,
          live?'authority_changed':'node_offline');}
      }
      send(200,sanitizeRetestResult(result,pair));return true;
    }
    if (method === 'POST' && match[2] === 'feedback' && !match[3]) {
      sameOrigin(req); const login = authorize(req, row, true);
      if (!body || typeof body !== 'object' || Array.isArray(body)) deny('Invalid feedback', 400, 'PREVIEW_FEEDBACK');
      const { pagePath, summary, criterionIds = [], idempotencyKey } = body;
      let pagePathValid=true;try{previewPagePath(pagePath);}catch{pagePathValid=false;}
      if (!pagePathValid || typeof summary !== 'string' || !summary.trim() || summary.length > 4000 ||
        !ID.test(idempotencyKey) || !Array.isArray(criterionIds) || criterionIds.length > 100 ||
        criterionIds.some(id => !ID.test(id)) || new Set(criterionIds).size !== criterionIds.length ||
        criterionIds.some(id => !criteriaFor(row).some(item => item.id === id))) deny('Invalid feedback', 400, 'PREVIEW_FEEDBACK');
      const feedback=sqliteTransaction(store.db,()=>{
        const prior=store.db.prepare('SELECT * FROM preview_feedback WHERE preview_id=? AND user_id=? AND idem_key=?')
          .get(row.preview_id,login.user.id,idempotencyKey);
        if(prior&&(prior.page_path!==pagePath||prior.summary!==summary.trim()||prior.criterion_ids_json!==JSON.stringify(criterionIds)))
          deny('Feedback key reused with different content',409,'PREVIEW_FEEDBACK_CONFLICT');
        if(!prior){
          if(store.db.prepare('SELECT 1 FROM preview_feedback_fences WHERE preview_id=? AND user_id=? AND idem_key=?')
            .get(row.preview_id,login.user.id,idempotencyKey))deny('Feedback key was closed',409,'PREVIEW_FEEDBACK_NOT_APPLIED');
          const count=store.db.prepare(`SELECT (SELECT count(*) FROM preview_feedback WHERE preview_id=? AND user_id=?) +
            (SELECT count(*) FROM preview_feedback_fences WHERE preview_id=? AND user_id=?) AS n`)
            .get(row.preview_id,login.user.id,row.preview_id,login.user.id).n;
          if(count>=200)deny('Too many preview reports',429,'PREVIEW_LIMIT');
          store.db.prepare(`INSERT INTO preview_feedback(id,preview_id,tenant_id,user_id,idem_key,page_path,summary,
            criterion_ids_json,status,task_id,created_at,confirmed_at,protocol_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)`)
            .run(randomUUID(),row.preview_id,row.tenant_id,login.user.id,idempotencyKey,pagePath,summary.trim(),
              JSON.stringify(criterionIds),'draft',null,now(),null);
        }
        return prior||store.db.prepare('SELECT * FROM preview_feedback WHERE preview_id=? AND user_id=? AND idem_key=?')
          .get(row.preview_id,login.user.id,idempotencyKey);
      });
      send(200,feedbackResult(row,feedback));return true;
    }
    if (method === 'POST' && match[2] === 'feedback' && ID.test(match[3])) {
      sameOrigin(req); const login = authorize(req, row, true);
      const feedback = store.db.prepare('SELECT * FROM preview_feedback WHERE id=? AND preview_id=? AND user_id=?')
        .get(match[3], row.preview_id, login.user.id);
      if (!feedback) deny('Feedback unavailable', 404, 'PREVIEW_FEEDBACK');
      if (feedback.status === 'confirmed') { send(200, { ...feedbackResult(row,feedback),
        retest: { items: [], reason: 'awaiting_new_preview' } }); return true; }
      if(['not_applied','created_unavailable'].includes(feedback.status))deny('Feedback cannot be confirmed',409,'PREVIEW_FEEDBACK_CLOSED');
      if (!confirming.has(feedback.id)) {
        if(feedback.status!=='draft'||feedback.protocol_version!==0)
          deny('Feedback confirmation must be verified',409,'PREVIEW_FEEDBACK_UNKNOWN');
        const node=typeof createTask==='function'?null:activeNode(row);
        const protocolVersion=node?.feedbackRecovery===2?2:1;
        const changed=store.db.prepare(`UPDATE preview_feedback SET status='confirming',
          protocol_version=?,recovery_store_id=? WHERE id=? AND status='draft' AND protocol_version=0`)
          .run(protocolVersion,node?.recoveryStoreId||null,feedback.id);
        if(changed.changes!==1)deny('Feedback confirmation must be verified',409,'PREVIEW_FEEDBACK_UNKNOWN');
        const operation = (async () => {
          const input=feedbackInput(row,feedback);
          const result = await (typeof createTask === 'function' ? createTask(input) : requestFeedback(row, input));
          if (!ID.test(result?.taskId)) deny('Task creation receipt invalid', 503, 'PREVIEW_TASK_RECEIPT');
          store.db.prepare("UPDATE preview_feedback SET status='confirmed',task_id=?,confirmed_at=? WHERE id=? AND status='confirming'")
            .run(result.taskId,now(),feedback.id);
          return result.taskId;
        })().finally(() => confirming.delete(feedback.id));
        confirming.set(feedback.id, operation);
      }
      const taskId = await confirming.get(feedback.id);
      const currentLogin=authorize(req,row,true);
      if(currentLogin.user.id!==login.user.id||currentLogin.tokenHash!==login.tokenHash)deny('Preview account changed',409,'PREVIEW_ACTOR_CHANGED');
      const durable=store.db.prepare('SELECT * FROM preview_feedback WHERE id=? AND preview_id=? AND user_id=?')
        .get(feedback.id,row.preview_id,login.user.id);
      if(durable?.status==='not_applied'||durable?.status==='created_unavailable')
        deny('Feedback outcome changed',409,'PREVIEW_FEEDBACK_CLOSED');
      if(durable?.status!=='confirmed'||durable.task_id!==taskId)
        deny('Feedback confirmation is uncertain',503,'PREVIEW_TASK_UNKNOWN');
      send(200, { ...feedbackResult(row,durable),
        retest: { items: [], reason: 'awaiting_new_preview' } }); return true;
    }
    deny('Preview route unavailable', 404, 'NOT_FOUND');
  }
  function handleUpgrade(req, socket, head, { allowedHosts, allowedOrigins } = {}) {
    let path;
    try { const url = new URL(req.url, 'http://localhost'); path = url.pathname; if (url.search || url.hash) deny('Query forbidden', 400, 'PREVIEW_QUERY'); }
    catch { return false; }
    if (path !== '/api/preview/node') return false;
    try {
      if (closed || !(allowedHosts instanceof Set) || !allowedHosts.has(req.headers.host) ||
        req.headers.origin && (!(allowedOrigins instanceof Set) || !allowedOrigins.has(req.headers.origin)) || sockets.size >= 32)
        deny('Preview upgrade denied');
      wss.handleUpgrade(req, socket, head, ws => { sockets.add(ws); ws.once('close', () => sockets.delete(ws)); nodeSocket(ws); });
    } catch (error) { socket.end(`HTTP/1.1 ${error.status || 403} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
    return true;
  }
  function attachServer(httpServer, policy) {
    if (serverListener) throw new Error('Preview Hub already attached');
    server = httpServer; serverListener = (req, socket, head) => { if (!handleUpgrade(req, socket, head, policy)) socket.destroy(); };
    server.on('upgrade', serverListener);
  }
  async function close() {
    if (closed) return; closed = true;
    if (serverListener) server.off('upgrade', serverListener);
    for (const pending of requests.values()) pending.finish(new HubError('Preview Hub closing', 503, 'SHUTTING_DOWN'));
    for (const pending of feedbackRequests.values()) pending.settle(new HubError('Preview Hub closing', 503, 'SHUTTING_DOWN'));
    for (const pending of retestRequests.values()) pending.finish(new HubError('Preview Hub closing',503,'SHUTTING_DOWN'));
    for (const ws of sockets) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    sockets.clear(); nodes.clear(); requests.clear(); feedbackRequests.clear();
  }
  return { handleHttp, handleUpgrade, attachServer, close };
}
