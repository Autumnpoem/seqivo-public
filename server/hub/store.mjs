import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeSnapshot, sanitizeReceiptResult, validateInboxAction } from './projection.mjs';
import { reviewRejectionResult } from '../review-rejection.mjs';

export class HubError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST') {
    super(message); this.status = status; this.code = code;
  }
}

const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const stamp = now => new Date(now()).toISOString();
const parse = value => JSON.parse(value);
function requireId(value, name) {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new HubError(`Invalid ${name}`);
  return value;
}
function requireRole(value) {
  if (!['node', 'viewer', 'controller'].includes(value)) throw new HubError('Invalid pairing role');
  return value;
}
function requireProjects(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new HubError('Project grants must contain 1–100 IDs');
  return [...new Set(value.map(item => requireId(item, 'project ID')))];
}
function safeBody(body) {
  if (!isRecord(body)) throw new HubError('Command body must be an object');
  if (Buffer.byteLength(JSON.stringify(body)) > 32000) throw new HubError('Command body too large', 413);
  return body;
}
function validAppliedReceipt(row,status,value,error) {
  if (error != null || !isRecord(value) || typeof value.status!=='string' || !value.status || ['unknown','failed','rejected'].includes(value.status)) throw new HubError('Durable recovery receipt is incomplete');
  if (row.action==='pause') {
    if (status!=='paused' || value.status!=='paused') throw new HubError('Invalid pause recovery receipt');
  } else if (row.action==='inbox_action') {
    const body=parse(row.body_json);
    if (status!=='completed' || value.taskId!==row.task_id || value.itemId!==body.itemId || value.status!=='completed' || !Number.isSafeInteger(value.itemRevision) || value.itemRevision<=body.expectedItemRevision) throw new HubError('Invalid completed inbox receipt');
  } else if (row.action==='create_task') {
    if (status!=='completed' || !validId(value.taskId) || value.taskId===row.task_id || value.status!=='planned' || value.revision!==1)
      throw new HubError('Manual task creation is not confirmed');
  } else if (status!=='running') throw new HubError('Invalid applied recovery status');
  if (row.action==='create_conversation' && (!validId(value.taskId) || !['running','submitted','completed','awaiting_approval'].includes(value.status))) throw new HubError('Conversation creation is not confirmed');
  if (row.action==='start_task' && !['running','submitted','completed','awaiting_approval'].includes(value.status)) throw new HubError('Task start is not confirmed');
  if (['continue','message','start_task'].includes(row.action) && value.taskId!==row.task_id) throw new HubError('Execution receipt does not match task');
}
const validId = value => typeof value === 'string' && idPattern.test(value);

export class HubStore {
  constructor(dataDir, { now = Date.now } = {}) {
    this.now = now;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.dataDir = dataDir;
    this.db = new DatabaseSync(join(dataDir, 'hub.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subjects(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),role TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,epoch INTEGER NOT NULL DEFAULT 1,revoked_at TEXT,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS subjects_tenant ON subjects(tenant_id);
      CREATE TABLE IF NOT EXISTS grants(subject_id TEXT NOT NULL REFERENCES subjects(id),project_id TEXT NOT NULL,PRIMARY KEY(subject_id,project_id));
      CREATE TABLE IF NOT EXISTS pairings(code_hash TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),role TEXT NOT NULL,projects_json TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(node_id TEXT PRIMARY KEY REFERENCES subjects(id),tenant_id TEXT NOT NULL,epoch INTEGER NOT NULL,sequence INTEGER NOT NULL,digest TEXT NOT NULL,received_at INTEGER NOT NULL,data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_owners(tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,node_id TEXT NOT NULL REFERENCES subjects(id),epoch INTEGER NOT NULL,PRIMARY KEY(tenant_id,project_id));
      CREATE TABLE IF NOT EXISTS commands(tenant_id TEXT NOT NULL,id TEXT NOT NULL,node_id TEXT NOT NULL,created_by TEXT NOT NULL,project_id TEXT NOT NULL,task_id TEXT NOT NULL,action TEXT NOT NULL,body_json TEXT NOT NULL,digest TEXT NOT NULL,expected_revision INTEGER NOT NULL,expires_at INTEGER NOT NULL,epoch INTEGER NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,claimed_at INTEGER,updated_at INTEGER NOT NULL,result_json TEXT,error TEXT,PRIMARY KEY(tenant_id,id));
      CREATE INDEX IF NOT EXISTS commands_node ON commands(node_id,status,created_at);
      CREATE TABLE IF NOT EXISTS command_recovery(tenant_id TEXT NOT NULL,command_id TEXT NOT NULL,requested_at INTEGER NOT NULL,checked_at INTEGER,outcome TEXT NOT NULL,basis TEXT,PRIMARY KEY(tenant_id,command_id));
      CREATE TABLE IF NOT EXISTS command_dispositions(tenant_id TEXT NOT NULL,command_id TEXT NOT NULL,disposition_id TEXT NOT NULL,project_id TEXT NOT NULL,task_id TEXT NOT NULL,local_command_id TEXT NOT NULL,control_generation INTEGER NOT NULL,returned_generation INTEGER NOT NULL,provider_outcome TEXT NOT NULL,payload_hash TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,command_id),FOREIGN KEY(tenant_id,command_id) REFERENCES commands(tenant_id,id));
      CREATE TABLE IF NOT EXISTS continue_leases(tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,task_id TEXT NOT NULL,command_id TEXT NOT NULL,node_id TEXT NOT NULL,epoch INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,project_id,task_id));
      CREATE TABLE IF NOT EXISTS lease_reconciliations(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,task_id TEXT NOT NULL,command_id TEXT NOT NULL,old_node_id TEXT NOT NULL,owner_id TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_watches(tenant_id TEXT NOT NULL,subject_id TEXT NOT NULL,task_id TEXT NOT NULL,project_id TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,subject_id,task_id));
    `);
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  bootstrap(tenantId) {
    requireId(tenantId, 'tenant ID');
    const ownerId = randomUUID();
    const secret = token();
    const tokenPath = join(this.dataDir, `${tenantId}-owner-${ownerId}.token`);
    writeFileSync(tokenPath, `${secret}\n`, { mode: 0o600, flag: 'wx' });
    try {
      this.tx(() => {
        if (this.db.prepare('SELECT 1 FROM tenants WHERE id=?').get(tenantId)) throw new HubError('Tenant already exists', 409, 'TENANT_EXISTS');
        this.db.prepare('INSERT INTO tenants VALUES(?,?)').run(tenantId, stamp(this.now));
        this.db.prepare('INSERT INTO subjects(id,tenant_id,role,token_hash,epoch,created_at) VALUES(?,?,?,?,?,?)')
          .run(ownerId, tenantId, 'owner', hash(secret), 1, stamp(this.now));
      });
    } catch (error) { try { unlinkSync(tokenPath); } catch { /* unreachable owner secret stays unregistered */ } throw error; }
    return { tenantId, ownerId, tokenPath };
  }

  authenticate(secret) {
    if (typeof secret !== 'string' || secret.length < 20 || secret.length > 200) throw new HubError('Authentication required', 401, 'UNAUTHORIZED');
    const subject = this.db.prepare('SELECT * FROM subjects WHERE token_hash=?').get(hash(secret));
    if (!subject) throw new HubError('Authentication required', 401, 'UNAUTHORIZED');
    if (subject.revoked_at) throw new HubError('Access revoked', 401, 'REVOKED');
    return subject;
  }

  grants(subjectId) {
    return this.db.prepare('SELECT project_id FROM grants WHERE subject_id=? ORDER BY project_id').all(subjectId).map(row => row.project_id);
  }

  canAccess(subject, projectId) {
    return subject.role === 'owner' || Boolean(this.db.prepare('SELECT 1 FROM grants WHERE subject_id=? AND project_id=?').get(subject.id, projectId));
  }

  createPairing(owner, { role, projectIds, ttlSeconds = 600 }) {
    this.requireOwner(owner);
    requireRole(role); const grants = requireProjects(projectIds);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 3600) throw new HubError('Pairing TTL must be 30–3600 seconds');
    const code = token();
    const expiresAt = this.now() + ttlSeconds * 1000;
    this.db.prepare('INSERT INTO pairings VALUES(?,?,?,?,?,?,?)')
      .run(hash(code), owner.tenant_id, role, JSON.stringify(grants), expiresAt, null, stamp(this.now));
    return { code, role, projectIds: grants, expiresAt: new Date(expiresAt).toISOString() };
  }

  redeem(code, requestedProjectIds) {
    if (typeof code !== 'string' || code.length < 20 || code.length > 200) throw new HubError('Invalid pairing code', 400, 'INVALID_CODE');
    return this.tx(() => {
      const pairing = this.db.prepare('SELECT * FROM pairings WHERE code_hash=?').get(hash(code));
      if (!pairing || pairing.used_at || pairing.expires_at <= this.now()) throw new HubError('Pairing code unavailable', 410, 'CODE_UNAVAILABLE');
      const grants = parse(pairing.projects_json);
      if (requestedProjectIds !== undefined && (pairing.role !== 'node' || requireProjects(requestedProjectIds).some(id => !grants.includes(id)))) {
        throw new HubError('Pairing does not grant selected projects', 403, 'GRANT_REQUIRED');
      }
      const subjectId = randomUUID();
      const secret = token();
      const projects = requestedProjectIds ? requireProjects(requestedProjectIds) : grants;
      this.db.prepare('UPDATE pairings SET used_at=? WHERE code_hash=?').run(this.now(), pairing.code_hash);
      this.db.prepare('INSERT INTO subjects(id,tenant_id,role,token_hash,epoch,created_at) VALUES(?,?,?,?,?,?)')
        .run(subjectId, pairing.tenant_id, pairing.role, hash(secret), 1, stamp(this.now));
      const grant = this.db.prepare('INSERT INTO grants VALUES(?,?)');
      for (const projectId of projects) grant.run(subjectId, projectId);
      return { token: secret, subjectId, nodeId: pairing.role === 'node' ? subjectId : undefined, role: pairing.role, epoch: 1, projectIds: projects };
    });
  }

  requireOwner(subject) { if (subject.role !== 'owner') throw new HubError('Owner role required', 403, 'FORBIDDEN'); }
  requireRole(subject, role) { if (subject.role !== role) throw new HubError(`${role} role required`, 403, 'FORBIDDEN'); }
  subject(owner, subjectId) {
    this.requireOwner(owner);
    const subject = this.db.prepare('SELECT * FROM subjects WHERE id=? AND tenant_id=?').get(requireId(subjectId, 'subject ID'), owner.tenant_id);
    if (!subject) throw new HubError('Subject not found', 404, 'NOT_FOUND');
    return subject;
  }

  listSubjects(owner) {
    this.requireOwner(owner);
    return this.db.prepare('SELECT id,role,epoch,revoked_at,created_at FROM subjects WHERE tenant_id=? ORDER BY created_at').all(owner.tenant_id)
      .map(item => ({ ...item, projectIds: this.grants(item.id) }));
  }

  setGrant(owner, subjectId, projectId, enabled) {
    requireId(projectId, 'project ID');
    const subject = this.subject(owner, subjectId);
    if (subject.role === 'owner' || subject.revoked_at) throw new HubError('Subject cannot be granted', 409, 'GRANT_CONFLICT');
    return this.tx(() => {
      if (enabled) this.db.prepare('INSERT OR IGNORE INTO grants VALUES(?,?)').run(subject.id, projectId);
      else this.db.prepare('DELETE FROM grants WHERE subject_id=? AND project_id=?').run(subject.id, projectId);
      if (subject.role === 'node') {
        this.db.prepare('UPDATE subjects SET epoch=epoch+1 WHERE id=?').run(subject.id);
        this.db.prepare('DELETE FROM project_owners WHERE node_id=?').run(subject.id);
        this.db.prepare("UPDATE commands SET status='expired',error='Node epoch changed',updated_at=? WHERE node_id=? AND status='queued'").run(this.now(), subject.id);
        this.db.prepare("DELETE FROM continue_leases WHERE node_id=? AND command_id IN (SELECT id FROM commands WHERE node_id=? AND status='expired' AND action IN ('continue','message','start_task'))").run(subject.id, subject.id);
      }
      if (!enabled) this.cancelQueued(subject.id, projectId);
      return { subjectId: subject.id, projectId, enabled, epoch: this.db.prepare('SELECT epoch FROM subjects WHERE id=?').get(subject.id).epoch };
    });
  }

  revoke(owner, subjectId) {
    const subject = this.subject(owner, subjectId);
    if (subject.role === 'owner') throw new HubError('Owner cannot revoke self here', 403, 'FORBIDDEN');
    return this.revokeSubject(subject);
  }

  revokeSelf(node) {
    this.requireRole(node, 'node');
    return this.revokeSubject(node);
  }

  revokeSubject(subject) {
    return this.tx(() => {
      if (!subject.revoked_at) {
        this.db.prepare('UPDATE subjects SET revoked_at=?,epoch=epoch+1 WHERE id=?').run(stamp(this.now), subject.id);
        this.db.prepare('DELETE FROM project_owners WHERE node_id=?').run(subject.id);
        this.cancelQueued(subject.id);
        this.db.prepare("UPDATE commands SET status='unknown',error='Subject revoked while command was claimed',updated_at=? WHERE status IN ('received','sending','running') AND (node_id=? OR created_by=?)")
          .run(this.now(), subject.id, subject.id);
      }
      return { subjectId: subject.id, revoked: true };
    });
  }

  reconcileLease(owner, input) {
    this.requireOwner(owner);
    if (!isRecord(input) || input.confirmStopped !== true) throw new HubError('Explicit confirmStopped is required', 400, 'CONFIRM_REQUIRED');
    const projectId = requireId(input.projectId, 'project ID');
    const taskId = requireId(input.taskId, 'task ID');
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
    if (!reason) throw new HubError('Reconciliation reason required', 400, 'REASON_REQUIRED');
    return this.tx(() => {
      const lease = this.db.prepare('SELECT * FROM continue_leases WHERE tenant_id=? AND project_id=? AND task_id=?').get(owner.tenant_id, projectId, taskId);
      if (!lease) throw new HubError('No continue lease found', 404, 'NOT_FOUND');
      const node = this.db.prepare('SELECT revoked_at FROM subjects WHERE id=? AND tenant_id=?').get(lease.node_id, owner.tenant_id);
      const command = this.db.prepare('SELECT status FROM commands WHERE tenant_id=? AND id=?').get(owner.tenant_id, lease.command_id);
      if (!node?.revoked_at || command?.status !== 'unknown') throw new HubError('Only an unknown command from a revoked node can be reconciled', 409, 'LEASE_ACTIVE');
      this.db.prepare('INSERT INTO lease_reconciliations VALUES(?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), owner.tenant_id, projectId, taskId, lease.command_id, lease.node_id, owner.id, reason, stamp(this.now));
      this.db.prepare('DELETE FROM continue_leases WHERE tenant_id=? AND project_id=? AND task_id=? AND command_id=?')
        .run(owner.tenant_id, projectId, taskId, lease.command_id);
      return { projectId, taskId, previousCommandId: lease.command_id, reconciled: true };
    });
  }

  cancelQueued(subjectId, projectId = null) {
    const tenantId = this.db.prepare('SELECT tenant_id FROM subjects WHERE id=?').get(subjectId)?.tenant_id;
    if (!tenantId) return;
    const conditions = projectId ? ' AND project_id=?' : '';
    const args = projectId ? [this.now(), tenantId, subjectId, subjectId, projectId] : [this.now(), tenantId, subjectId, subjectId];
    this.db.prepare(`UPDATE commands SET status='expired',error='Grant or subject revoked',updated_at=? WHERE tenant_id=? AND status='queued' AND (node_id=? OR created_by=?)${conditions}`).run(...args);
    this.db.prepare("DELETE FROM continue_leases WHERE tenant_id=? AND command_id IN (SELECT id FROM commands WHERE tenant_id=? AND status='expired' AND action IN ('continue','message','start_task'))").run(tenantId, tenantId);
  }

  nodeSession(node) {
    this.requireRole(node, 'node');
    this.db.prepare('DELETE FROM conversation_watches WHERE expires_at<=?').run(this.now());
    const watches = this.db.prepare(`SELECT w.*,s.role,s.revoked_at FROM conversation_watches w
      JOIN subjects s ON s.id=w.subject_id AND s.tenant_id=w.tenant_id
      JOIN project_owners p ON p.tenant_id=w.tenant_id AND p.project_id=w.project_id
      WHERE w.tenant_id=? AND p.node_id=? AND p.epoch=? ORDER BY w.expires_at DESC`).all(node.tenant_id,node.id,node.epoch);
    const conversationTaskIds = [...new Set(watches.filter(w => !w.revoked_at && ['owner','controller'].includes(w.role) && this.canAccess({id:w.subject_id,role:w.role},w.project_id) && this.canAccess(node,w.project_id)).map(w=>w.task_id))].slice(0,5);
    return { nodeId: node.id, epoch: node.epoch, projectIds: this.grants(node.id), conversationTaskIds };
  }

  conversation(subject, taskId) {
    if (!['owner','controller'].includes(subject.role)) throw new HubError('对话内容需要“查看和操作”权限；仅查看连接可查看任务进度',403,'CONVERSATION_FORBIDDEN');
    requireId(taskId,'task ID');
    const board = this.state(subject), task = board.tasks.find(t=>t.id===taskId);
    if (!task) throw new HubError('Task not found',404,'TASK_NOT_FOUND');
    this.db.prepare('DELETE FROM conversation_watches WHERE expires_at<=?').run(this.now());
    const count = this.db.prepare('SELECT count(*) AS n FROM conversation_watches WHERE tenant_id=? AND subject_id=? AND task_id<>?').get(subject.tenant_id,subject.id,taskId).n;
    if(count>=5) throw new HubError('Too many active conversations',429,'WATCH_LIMIT');
    this.db.prepare('INSERT OR REPLACE INTO conversation_watches VALUES(?,?,?,?,?)').run(subject.tenant_id,subject.id,taskId,task.projectId,this.now()+60000);
    const row=this.db.prepare(`SELECT s.data_json,s.received_at FROM snapshots s JOIN project_owners p ON p.node_id=s.node_id AND p.tenant_id=s.tenant_id AND p.epoch=s.epoch
      WHERE p.tenant_id=? AND p.project_id=?`).get(subject.tenant_id,task.projectId);
    if(!row || !parse(row.data_json).capabilities?.conversations) throw new HubError('请更新项目电脑上的序程，以启用远程对话',409,'NODE_UPDATE_REQUIRED');
    const conversation = row && parse(row.data_json).conversations?.find(c=>c.taskId===taskId&&c.projectId===task.projectId);
    return conversation || {taskId,projectId:task.projectId,status:'loading',messages:[],updatedAt:null,truncated:false};
  }

  createConversation(subject,input) {
    if (!isRecord(input) || Object.keys(input).some(k=>!['projectId','title','message','commandId'].includes(k))) throw new HubError('Invalid conversation request');
    requireId(input.commandId,'command ID');
    return this.command(subject,{commandId:input.commandId,taskId:input.commandId,projectId:input.projectId,
      action:'create_conversation',expectedRevision:0,expiresAt:new Date(this.db.prepare('SELECT expires_at FROM commands WHERE tenant_id=? AND id=?').get(subject.tenant_id,input.commandId)?.expires_at ?? this.now()+300000).toISOString(),body:{title:input.title,message:input.message}});
  }

  snapshot(node, input) {
    this.requireRole(node, 'node');
    if (!isRecord(input) || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || input.epoch !== node.epoch || !Array.isArray(input.projects) || !Array.isArray(input.tasks)) {
      throw new HubError('Snapshot sequence or epoch invalid', 409, 'SNAPSHOT_CONFLICT');
    }
    if (input.projects.length > 100 || input.tasks.length > 10000 || Buffer.byteLength(JSON.stringify(input)) > 2_000_000) throw new HubError('Snapshot too large', 413);
    const allowed = new Set(this.grants(node.id));
    const projectIds = new Set();
    for (const project of input.projects) {
      if (!isRecord(project) || !allowed.has(project.id) || projectIds.has(project.id)) throw new HubError('Project not granted or duplicated', 403, 'GRANT_REQUIRED');
      projectIds.add(project.id);
    }
    for (const task of input.tasks) {
      if (!isRecord(task) || !projectIds.has(task.projectId) || typeof task.id !== 'string' || !Number.isInteger(task.revision)) throw new HubError('Task does not belong to granted snapshot project');
    }
    const sanitized = sanitizeSnapshot(input);
    const digest = hash(JSON.stringify(sanitized));
    return this.tx(() => {
      const previous = this.db.prepare('SELECT * FROM snapshots WHERE node_id=?').get(node.id);
      if (previous && input.sequence <= previous.sequence) {
        if (input.sequence === previous.sequence && digest === previous.digest && input.epoch === previous.epoch) return { accepted: true, sequence: previous.sequence, epoch: node.epoch, duplicate: true };
        throw new HubError('Stale or changed snapshot sequence', 409, 'STALE_SNAPSHOT');
      }
      for (const projectId of projectIds) {
        const existing = this.db.prepare('SELECT node_id FROM project_owners WHERE tenant_id=? AND project_id=?').get(node.tenant_id, projectId);
        if (existing && existing.node_id !== node.id) {
          const other = this.db.prepare('SELECT revoked_at FROM subjects WHERE id=?').get(existing.node_id);
          if (other && !other.revoked_at) throw new HubError('Project already owned by another active node', 409, 'OWNERSHIP_CONFLICT');
        }
      }
      this.db.prepare('DELETE FROM project_owners WHERE node_id=?').run(node.id);
      const putOwner = this.db.prepare('INSERT OR REPLACE INTO project_owners VALUES(?,?,?,?)');
      for (const projectId of projectIds) putOwner.run(node.tenant_id, projectId, node.id, node.epoch);
      this.db.prepare('INSERT OR REPLACE INTO snapshots VALUES(?,?,?,?,?,?,?)')
        .run(node.id, node.tenant_id, node.epoch, input.sequence, digest, this.now(), JSON.stringify(sanitized));
      for (const task of sanitized.tasks) {
        if (['submitted', 'failed', 'cancelled', 'paused'].includes(task.status)) {
          this.db.prepare(`DELETE FROM continue_leases WHERE tenant_id=? AND project_id=? AND task_id=? AND node_id=? AND epoch=?
            AND command_id IN (SELECT id FROM commands WHERE tenant_id=? AND status='running' AND expected_revision<?)`)
            .run(node.tenant_id, task.projectId, task.id, node.id, node.epoch,node.tenant_id,task.revision);
        }
      }
      return { accepted: true, sequence: input.sequence, epoch: node.epoch, duplicate: false };
    });
  }

  state(subject) {
    if (!['viewer', 'controller', 'owner'].includes(subject.role)) throw new HubError('Phone role required', 403, 'FORBIDDEN');
    const grants = subject.role === 'owner' ? null : new Set(this.grants(subject.id));
    const owners = this.db.prepare('SELECT * FROM project_owners WHERE tenant_id=?').all(subject.tenant_id);
    const projects = [], tasks = [], inboxItems = [], omitted = [], seen = new Set();
    let inboxAvailable = false,taskStartAvailable = false;
    let lastSeen = null, offline = false;
    for (const owner of owners) {
      if (grants && !grants.has(owner.project_id)) continue;
      const snapshot = this.db.prepare('SELECT * FROM snapshots WHERE node_id=? AND tenant_id=?').get(owner.node_id, subject.tenant_id);
      if (!snapshot || snapshot.epoch !== owner.epoch) continue;
      const data = parse(snapshot.data_json);
      const project = data.projects.find(item => item.id === owner.project_id);
      if (!project || seen.has(project.id)) continue;
      seen.add(project.id); projects.push({...project,inboxAvailable:data.capabilities?.inbox===true,
        taskCreationAvailable:data.capabilities?.taskCreation===true,taskStartAvailable:data.capabilities?.taskStart===true});
      inboxAvailable ||= data.capabilities?.inbox === true;
      taskStartAvailable ||= data.capabilities?.taskStart === true;
      tasks.push(...data.tasks.filter(item => item.projectId === project.id));
      inboxItems.push(...(data.inbox?.items || []).filter(item => item.projectId === project.id));
      omitted.push(...(data.inbox?.omitted || []).filter(item => item.projectId === project.id));
      lastSeen = Math.max(lastSeen || 0, snapshot.received_at);
      if (this.now() - snapshot.received_at > 60000) offline = true;
    }
    // Lost command acknowledgements are visible without publishing command bodies,
    // provider output, or items from another space/project. A missing result is not success.
    const unresolved = this.db.prepare("SELECT * FROM commands WHERE tenant_id=? AND status IN ('received','sending','unknown')").all(subject.tenant_id);
    for (const row of unresolved) {
      if (!seen.has(row.project_id)) continue;
      this.expire(row);
      const current = this.db.prepare('SELECT status,updated_at FROM commands WHERE tenant_id=? AND id=?').get(subject.tenant_id,row.id);
      if (current.status !== 'unknown') continue;
      const task = tasks.find(task => task.id === row.task_id && task.projectId === row.project_id);
      if ((!task && !['create_conversation','create_task'].includes(row.action)) || inboxItems.some(item => item.kind === 'unknown' && [row.id,hash(JSON.stringify(row.id))].includes(item.source?.id) && ['open','acknowledged'].includes(item.state))) continue;
      const recovery=this.db.prepare('SELECT requested_at,checked_at FROM command_recovery WHERE tenant_id=? AND command_id=?').get(row.tenant_id,row.id);
      inboxItems.push({id:`hub-${row.id}`,projectId:row.project_id,taskId:row.task_id,kind:'unknown',state:'open',
        itemRevision:1,sourceRevision:task?.revision??1,contentVersion:task?.contentVersion??1,source:{type:'hub.command',id:row.id},
        dedupKey:`hub-${row.id}`,priority:100,title:'远程操作结果尚未确认',
        summary:recovery?.checked_at!=null?'项目电脑已核查原命令，但仍缺少足够证据确认结果。':recovery?.requested_at!=null?'原命令核查请求已提交，等待项目电脑报告。':'请求已交给项目电脑，但服务器尚未收到明确结果。',impact:'重复提交可能重复修改任务或启动执行。',
        recommendedAction:'核对原命令回执及关联任务；结果未知时请勿重复提交。',
        createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(current.updated_at).toISOString(),resolvedAt:null,resolution:null,shareWithRemote:true,readOnly:true});
    }
    return {
      projects, tasks, settings: { theme: 'system' }, events: [],
      inbox: {items:inboxItems,...(omitted.length?{omitted}:{}),updatedAt:inboxItems.reduce((last,item)=>item.updatedAt>last?item.updatedAt:last,'1970-01-01T00:00:00.000Z')},
      plugin: { id: 'codex-autocontinue', name: 'Codex Auto Continue', version: '0.1.0', enabled: false, available: false, status: 'remote', lastError: null, upstream: null, quota: null, config: {}, policies: [], capabilities: [] },
      capabilities: { desktop: false, remote: true, role: subject.role, inbox:inboxAvailable,taskStart:taskStartAvailable },
      connection: { mode: 'hub', updatedAt: stamp(this.now), lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null, offline },
    };
  }

  command(subject, input) {
    if (!['controller','owner'].includes(subject.role)) throw new HubError('Control permission required',403,'FORBIDDEN');
    if (!isRecord(input)) throw new HubError('Command must be an object');
    const id = requireId(input.commandId, 'command ID');
    const projectId = requireId(input.projectId, 'project ID');
    const taskId = requireId(input.taskId, 'task ID');
    if (!this.canAccess(subject, projectId)) throw new HubError('Project grant required', 403, 'GRANT_REQUIRED');
    if (!['continue', 'pause', 'update', 'evidence', 'review', 'message', 'start_task', 'create_conversation','create_task','inbox_action'].includes(input.action)) throw new HubError('Action not allowed', 400, 'ACTION_NOT_ALLOWED');
    const creating = ['create_conversation','create_task'].includes(input.action);
    if (creating ? input.expectedRevision !== 0 || taskId !== id : !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new HubError('Task revision required');
    const body = this.commandBody(input.action, safeBody(input.body || {}));
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new HubError('Valid expiresAt required');
    const queueOffline = input.queueOffline === true;
    if (input.action === 'inbox_action' && queueOffline) throw new HubError('待处理事项必须在线确认，不能离线排队',400,'OFFLINE_NOT_ALLOWED');
    if (['create_task','start_task'].includes(input.action) && queueOffline) throw new HubError(input.action==='create_task'?'新建任务必须在线确认，不能离线排队':'启动任务必须在线确认，不能离线排队',400,'OFFLINE_NOT_ALLOWED');
    const normalized = { commandId: id, projectId, taskId, action: input.action, expectedRevision: input.expectedRevision, expiresAt, queueOffline, body };
    const digest = hash(JSON.stringify(normalized));
    return this.tx(() => {
      const duplicate = this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=?').get(subject.tenant_id, id);
      if (duplicate) {
        if (duplicate.digest !== digest || duplicate.created_by !== subject.id) throw new HubError('Command ID used for different payload or subject', 409, 'COMMAND_CONFLICT');
        return this.commandView(duplicate);
      }
      if (expiresAt <= this.now() || expiresAt > this.now() + 3600_000) throw new HubError('Command expiry must be within one hour', 400, 'INVALID_EXPIRY');
      const owner = this.db.prepare('SELECT * FROM project_owners WHERE tenant_id=? AND project_id=?').get(subject.tenant_id, projectId);
      if (!owner) throw new HubError('No node owns this project', 503, 'NODE_OFFLINE');
      const node = this.db.prepare('SELECT * FROM subjects WHERE id=? AND tenant_id=?').get(owner.node_id, subject.tenant_id);
      if (!node || node.revoked_at || !this.canAccess(node, projectId) || owner.epoch !== node.epoch) throw new HubError('Node grant unavailable', 403, 'GRANT_REQUIRED');
      const snapshot = this.db.prepare('SELECT * FROM snapshots WHERE node_id=? AND tenant_id=?').get(node.id, subject.tenant_id);
      if (!snapshot || snapshot.epoch !== node.epoch) throw new HubError('Node snapshot is unavailable', 503, 'NODE_OFFLINE');
      const snapshotData=parse(snapshot.data_json);
      if ((input.action==='create_conversation' || input.action==='message') && !snapshotData.capabilities?.conversations) throw new HubError('请更新项目电脑上的序程，以启用远程对话',409,'NODE_UPDATE_REQUIRED');
      if (input.action==='create_task' && (!snapshotData.capabilities?.taskCreation || !snapshotData.projects.some(item=>item.id===projectId)))
        throw new HubError('项目电脑尚未开放此项目的远程新建任务',409,'NODE_UPDATE_REQUIRED');
      if (input.action==='start_task' && !snapshotData.capabilities?.taskStart)
        throw new HubError('请更新项目电脑上的序程，以启用远程启动任务',409,'NODE_UPDATE_REQUIRED');
      if (this.now() - snapshot.received_at > 60000 && (!queueOffline || expiresAt > this.now() + 300000)) {
        throw new HubError('Node snapshot is offline or stale; explicit queueOffline and short expiry required', 503, 'NODE_OFFLINE');
      }
      const task = snapshotData.tasks.find(item => item.id === taskId && item.projectId === projectId);
      if (!creating && !task) throw new HubError('Task not in current project snapshot', 404, 'TASK_NOT_FOUND');
      if (!creating && task.revision !== input.expectedRevision) throw new HubError('Task revision changed', 409, 'REVISION_CONFLICT');
      if (['message','continue','create_conversation','start_task'].includes(input.action)) {
        const current=this.now(),gate=creating
          ?snapshotData.projects.find(item=>item.id===projectId)?.conversationStart
          :task.executionWrite;
        const action=creating?gate:gate?.[input.action==='start_task'?'start':input.action];
        const observed=Date.parse(gate?.observedAt);
        if(queueOffline || !gate || !action || gate.v!==1 ||
          !gate.bootId || !Number.isFinite(observed) ||
          current-snapshot.received_at>10000 || snapshot.received_at-current>2000 ||
          current-observed>10000 || observed-current>2000 ||
          !creating && (gate.taskRevision!==task.revision || gate.contentVersion!==task.contentVersion))
          throw new HubError('执行状态尚未确认，请刷新后再试；草稿不会自动发送。',409,'EXECUTION_GATE_UNAVAILABLE');
        if(action.state!=='ready')throw new HubError('此任务暂不能继续，请先核对电脑上的执行状态。',409,'EXECUTION_WRITE_BLOCKED');
      }
      if (input.action === 'inbox_action') validateInboxAction(snapshotData,task,body);
      if (input.action !== 'pause') {
        for (const stale of this.db.prepare("SELECT * FROM commands WHERE tenant_id=? AND project_id=? AND status='queued' AND expires_at<=?").all(subject.tenant_id,projectId,this.now())) this.expire(stale);
        const conflict = this.db.prepare("SELECT c.id FROM commands c WHERE c.tenant_id=? AND c.project_id=? AND c.task_id=? AND c.status IN ('queued','received','sending','unknown') AND NOT EXISTS (SELECT 1 FROM command_dispositions d WHERE d.tenant_id=c.tenant_id AND d.command_id=c.id) LIMIT 1")
          .get(subject.tenant_id, projectId, taskId);
        if (conflict) throw new HubError('An earlier task command needs an outcome before another write', 409, 'COMMAND_FENCED');
        if (creating) {
          const pendingCreate = this.db.prepare("SELECT c.id FROM commands c WHERE c.tenant_id=? AND c.project_id=? AND c.action IN ('create_conversation','create_task') AND c.status IN ('queued','received','sending','unknown') AND NOT EXISTS (SELECT 1 FROM command_dispositions d WHERE d.tenant_id=c.tenant_id AND d.command_id=c.id) LIMIT 1").get(subject.tenant_id,projectId);
          if (pendingCreate) throw new HubError('An earlier task creation needs an outcome',409,'CREATE_FENCED');
        }
      }
      if (input.action === 'pause') {
        this.db.prepare("UPDATE commands SET status='expired',error='Cancelled by queued pause',updated_at=? WHERE tenant_id=? AND project_id=? AND task_id=? AND action IN ('continue','message','start_task') AND status='queued'")
          .run(this.now(), subject.tenant_id, projectId, taskId);
        this.db.prepare("DELETE FROM continue_leases WHERE tenant_id=? AND project_id=? AND task_id=? AND command_id IN (SELECT id FROM commands WHERE tenant_id=? AND status='expired' AND action IN ('continue','message','start_task'))")
          .run(subject.tenant_id, projectId, taskId, subject.tenant_id);
      }
      if (['continue','message','start_task'].includes(input.action)) {
        const lease = this.db.prepare('SELECT * FROM continue_leases WHERE tenant_id=? AND project_id=? AND task_id=?').get(subject.tenant_id, projectId, taskId);
        if (lease) throw new HubError('Another continue is already queued, running, or unknown', 409, 'CONTINUE_LEASE');
        this.db.prepare('INSERT INTO continue_leases VALUES(?,?,?,?,?,?,?)').run(subject.tenant_id, projectId, taskId, id, node.id, node.epoch, this.now());
      }
      const queued = this.db.prepare("SELECT count(*) AS n FROM commands WHERE node_id=? AND status='queued'").get(node.id).n;
      if (queued >= 100) throw new HubError('Node command queue full', 429, 'QUEUE_FULL');
      this.db.prepare('INSERT INTO commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(subject.tenant_id, id, node.id, subject.id, projectId, taskId, input.action, JSON.stringify(body), digest, input.expectedRevision, expiresAt, node.epoch, 'queued', this.now(), null, this.now(), null, null);
      return this.commandView(this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=?').get(subject.tenant_id, id));
    });
  }

  commandBody(action, body) {
    const allowed = {
      continue: [], pause: [],
      message: ['message'], start_task: ['message'], create_conversation: ['title','message'],
      create_task: ['title','goal','example','summary','approach','criteria'],
      update: ['title', 'goal', 'example', 'summary', 'approach', 'nextStep', 'status', 'criteria', 'blockedReason'],
      evidence: ['summary', 'reference'], review: ['decision', 'summary'],
      inbox_action: ['itemId','expectedItemRevision','action','answer','optionId'],
    }[action];
    if (!allowed || Object.keys(body).some(key => !allowed.includes(key))) throw new HubError('Command body contains forbidden fields', 400, 'BODY_FORBIDDEN');
    if (action === 'review' && !['pass', 'fail'].includes(body.decision)) throw new HubError('Review decision required');
    if (action === 'evidence' && (typeof body.summary !== 'string' || typeof body.reference !== 'string')) throw new HubError('Evidence summary and reference required');
    if (['message','start_task','create_conversation'].includes(action) && (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 10000)) throw new HubError('Message must contain 1–10000 characters');
    if (action === 'create_conversation' && (typeof body.title !== 'string' || !body.title.trim() || body.title.length>240)) throw new HubError('Title must contain 1–240 characters');
    if (action === 'create_task' && (typeof body.title!=='string' || !body.title.trim() || body.title.length>240 ||
        ['goal','example','summary','approach'].some(field=>body[field]!==undefined && (typeof body[field]!=='string' || body[field].length>10000)) ||
        !Array.isArray(body.criteria) || !body.criteria.length || body.criteria.length>100 ||
        body.criteria.some(value=>typeof value!=='string' || !value.trim() || value.length>2000)))
      throw new HubError('Invalid manual task fields');
    if (action === 'inbox_action') {
      requireId(body.itemId,'inbox item ID');
      if (!Number.isSafeInteger(body.expectedItemRevision) || body.expectedItemRevision < 1 || !['acknowledge','answer','supplement'].includes(body.action)) throw new HubError('Invalid inbox action');
      if (body.answer !== undefined && (typeof body.answer !== 'string' || !body.answer.trim() || body.answer.length>5000)) throw new HubError('Answer must contain 1–5000 characters');
      if (body.optionId !== undefined) requireId(body.optionId,'decision option ID');
      if (body.action === 'answer' && !body.answer && !body.optionId || body.action === 'supplement' && !body.answer) throw new HubError('Answer required');
      if (body.action === 'acknowledge' && (body.answer !== undefined || body.optionId !== undefined) || body.action === 'supplement' && body.optionId !== undefined) throw new HubError('Unexpected inbox action fields');
    }
    return body;
  }

  commandView(row) {
    const recovery = this.db.prepare('SELECT * FROM command_recovery WHERE tenant_id=? AND command_id=?').get(row.tenant_id,row.id);
    return { commandId: row.id, status: row.status, action: row.action, projectId: row.project_id, taskId: row.task_id,
      expectedRevision: row.expected_revision, expiresAt: new Date(row.expires_at).toISOString(), epoch: row.epoch,
      result: row.result_json ? parse(row.result_json) : null, error: row.error || null,
      recovery: recovery ? {outcome:recovery.outcome,requestedAt:new Date(recovery.requested_at).toISOString(),
        ...(recovery.checked_at==null?{}:{checkedAt:new Date(recovery.checked_at).toISOString()}),...(recovery.basis?{basis:recovery.basis}:{})} : {outcome:'unknown'} };
  }

  requestRecovery(subject, commandId) {
    if (!['controller','owner'].includes(subject.role)) throw new HubError('Control permission required',403,'FORBIDDEN');
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=?').get(subject.tenant_id,requireId(commandId,'command ID'));
      if (!row || subject.role !== 'owner' && row.created_by !== subject.id) throw new HubError('Command not found',404,'NOT_FOUND');
      if (!this.canAccess(subject,row.project_id)) throw new HubError('Project grant required',403,'GRANT_REQUIRED');
      this.expire(row);
      const current=this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=?').get(subject.tenant_id,row.id);
      if (current.status!=='unknown') throw new HubError('Only unknown commands can be checked',409,'RECOVERY_NOT_ELIGIBLE');
      const node=this.db.prepare('SELECT * FROM subjects WHERE id=? AND tenant_id=?').get(row.node_id,row.tenant_id);
      if (!node || node.revoked_at || node.epoch!==row.epoch || !this.deliverable(node,current)) throw new HubError('Original node authorization is unavailable',409,'RECOVERY_NODE_UNAVAILABLE');
      this.db.prepare('INSERT INTO command_recovery(tenant_id,command_id,requested_at,checked_at,outcome,basis) VALUES(?,?,?,NULL,?,NULL) ON CONFLICT(tenant_id,command_id) DO UPDATE SET requested_at=excluded.requested_at,checked_at=NULL,outcome=excluded.outcome,basis=NULL')
        .run(row.tenant_id,row.id,this.now(),'unknown');
      return this.commandView(current);
    });
  }

  commandStatus(subject, commandId) {
    const row = this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=?').get(subject.tenant_id, requireId(commandId, 'command ID'));
    if (!row || (subject.role !== 'owner' && row.created_by !== subject.id)) throw new HubError('Command not found', 404, 'NOT_FOUND');
    if (!this.canAccess(subject, row.project_id)) throw new HubError('Project grant required', 403, 'GRANT_REQUIRED');
    this.expire(row);
    return this.commandView(this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=?').get(subject.tenant_id, row.id));
  }

  expire(row) {
    if (row.status === 'queued' && row.expires_at <= this.now()) {
      this.db.prepare("UPDATE commands SET status='expired',error='Command expired before claim',updated_at=? WHERE tenant_id=? AND id=? AND status='queued'").run(this.now(), row.tenant_id, row.id);
      if (['continue','message','start_task'].includes(row.action)) this.db.prepare('DELETE FROM continue_leases WHERE tenant_id=? AND command_id=?').run(row.tenant_id, row.id);
    }
    if (['received', 'sending'].includes(row.status) && row.claimed_at && this.now() - row.claimed_at > 300000) this.db.prepare("UPDATE commands SET status='unknown',error='Node did not report an outcome',updated_at=? WHERE tenant_id=? AND id=? AND status IN ('received','sending')").run(this.now(), row.tenant_id, row.id);
  }

  nodeCommands(node) {
    this.requireRole(node, 'node');
    const rows = this.db.prepare("SELECT * FROM commands WHERE node_id=? AND tenant_id=? AND (status IN ('queued','received','sending') OR (status='unknown' AND action='inbox_action')) ORDER BY CASE WHEN status='unknown' THEN 1 ELSE 0 END,created_at LIMIT 100").all(node.id, node.tenant_id);
    const commands = [];
    for (const row of rows) {
      this.expire(row);
      const current = this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=?').get(node.tenant_id, row.id);
      if (!['queued', 'received', 'sending'].includes(current.status) && !(current.status==='unknown' && current.action==='inbox_action')) continue;
      if (!this.deliverable(node, current)) {
        this.db.prepare("UPDATE commands SET status='expired',error='Grant or epoch changed',updated_at=? WHERE tenant_id=? AND id=? AND status='queued'").run(this.now(), node.tenant_id, row.id);
        if (['continue','message','start_task'].includes(current.action) && current.status === 'queued') this.db.prepare('DELETE FROM continue_leases WHERE tenant_id=? AND command_id=?').run(node.tenant_id, row.id);
        continue;
      }
      commands.push({ ...this.commandView(current), body: parse(current.body_json), nodeId: node.id, actor: { tenantId: node.tenant_id, subjectId: current.created_by, role: 'controller' } });
    }
    const recoveryProbes = this.db.prepare(`SELECT c.* FROM command_recovery r JOIN commands c ON c.tenant_id=r.tenant_id AND c.id=r.command_id
      WHERE c.tenant_id=? AND c.node_id=? AND c.status='unknown' AND r.checked_at IS NULL ORDER BY r.requested_at LIMIT 100`).all(node.tenant_id,node.id)
      .filter(row=>this.deliverable(node,row)).map(row=>({commandId:row.id,projectId:row.project_id,taskId:row.task_id,action:row.action,epoch:row.epoch,
        ...(row.action==='create_task'?{actor:{tenantId:row.tenant_id,subjectId:row.created_by,role:'controller'}}:{}),
        ...(row.action==='review'?{reviewDecision:parse(row.body_json)?.decision}:{})}));
    return { epoch: node.epoch, commands, recoveryProbes };
  }

  disposeUnknown(node, commandId, input) {
    this.requireRole(node, 'node');
    const rootId = requireId(commandId, 'command ID');
    const allowed = ['v','dispositionId','projectId','taskId','localCommandId','controlGeneration','returnedGeneration','providerOutcome'];
    if (!isRecord(input) || Object.keys(input).length !== allowed.length || Object.keys(input).some(key => !allowed.includes(key)) || input.v !== 1) {
      throw new HubError('Invalid unknown disposition');
    }
    const dispositionId = requireId(input.dispositionId, 'disposition ID');
    const projectId = requireId(input.projectId, 'project ID');
    const taskId = requireId(input.taskId, 'task ID');
    if (typeof input.localCommandId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(input.localCommandId)) throw new HubError('Invalid local command ID');
    if (!Number.isSafeInteger(input.controlGeneration) || input.controlGeneration < 1 ||
        !Number.isSafeInteger(input.returnedGeneration) || input.returnedGeneration < input.controlGeneration) {
      throw new HubError('Invalid control generation');
    }
    if (input.providerOutcome !== 'unknown') throw new HubError('Provider outcome must remain unknown');
    const payloadHash = hash(JSON.stringify([input.v, dispositionId, projectId, taskId, input.localCommandId,
      input.controlGeneration, input.returnedGeneration, input.providerOutcome]));

    return this.tx(() => {
      const currentNode = this.db.prepare('SELECT * FROM subjects WHERE id=? AND tenant_id=?').get(node.id, node.tenant_id);
      if (!currentNode || currentNode.role !== 'node' || currentNode.revoked_at || currentNode.epoch !== node.epoch) {
        throw new HubError('Node authorization changed', 403, 'GRANT_REQUIRED');
      }
      const row = this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=?').get(currentNode.tenant_id, rootId);
      if (!row || row.node_id !== currentNode.id) throw new HubError('Command not found', 404, 'NOT_FOUND');
      if (row.project_id !== projectId || row.task_id !== taskId || row.epoch !== currentNode.epoch) {
        throw new HubError('Disposition does not match original command', 409, 'DISPOSITION_MISMATCH');
      }
      if (!this.deliverable(currentNode, row)) throw new HubError('Original controller or project authorization is unavailable', 403, 'GRANT_REQUIRED');
      if (!['create_conversation','start_task','message','continue'].includes(row.action) ||
          !['running','unknown','sending','received'].includes(row.status)) {
        throw new HubError('Command is not eligible for unknown disposition', 409, 'DISPOSITION_NOT_ELIGIBLE');
      }

      const existing = this.db.prepare('SELECT * FROM command_dispositions WHERE tenant_id=? AND command_id=?')
        .get(row.tenant_id, row.id);
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new HubError('Disposition receipt conflicts with the original', 409, 'DISPOSITION_CONFLICT');
        return { commandId: row.id, dispositionId: existing.disposition_id, providerOutcome: 'unknown', disposed: true };
      }
      const lease = this.db.prepare('SELECT * FROM continue_leases WHERE tenant_id=? AND project_id=? AND task_id=?')
        .get(row.tenant_id, row.project_id, row.task_id);
      if (['start_task','message','continue'].includes(row.action)) {
        if (!lease || lease.command_id !== row.id || lease.node_id !== currentNode.id || lease.epoch !== row.epoch) {
          throw new HubError('Original continue lease does not match command', 409, 'CONTINUE_LEASE');
        }
      } else if (lease && (lease.command_id !== row.id || lease.node_id !== currentNode.id || lease.epoch !== row.epoch)) {
        throw new HubError('Another continue lease owns this task', 409, 'CONTINUE_LEASE');
      }

      this.db.prepare('INSERT INTO command_dispositions(tenant_id,command_id,disposition_id,project_id,task_id,local_command_id,control_generation,returned_generation,provider_outcome,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(row.tenant_id, row.id, dispositionId, projectId, taskId, input.localCommandId, input.controlGeneration,
          input.returnedGeneration, 'unknown', payloadHash, this.now());
      if (lease?.command_id === row.id) {
        this.db.prepare('DELETE FROM continue_leases WHERE tenant_id=? AND project_id=? AND task_id=? AND command_id=? AND node_id=? AND epoch=?')
          .run(row.tenant_id, row.project_id, row.task_id, row.id, currentNode.id, row.epoch);
      }
      return { commandId: row.id, dispositionId, providerOutcome: 'unknown', disposed: true };
    });
  }

  reportRecovery(node,commandId,input) {
    this.requireRole(node,'node');
    if (!isRecord(input) || !['applied','not_applied','unknown'].includes(input.outcome) ||
      !['durable_receipt','pre_dispatch_marker','insufficient_evidence','transaction_rollback'].includes(input.basis)) throw new HubError('Invalid recovery evidence');
    if (input.outcome==='applied' && input.basis!=='durable_receipt' || input.outcome==='not_applied' && !['pre_dispatch_marker','transaction_rollback'].includes(input.basis) ||
      input.outcome==='unknown' && input.basis!=='insufficient_evidence') throw new HubError('Recovery evidence does not match outcome');
    if (input.result !== undefined && Buffer.byteLength(JSON.stringify(input.result))>20000) throw new HubError('Recovery result too large',413);
    return this.tx(()=>{
      const row=this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=? AND node_id=?').get(node.tenant_id,requireId(commandId,'command ID'),node.id);
      if (!row) throw new HubError('Command not found',404,'NOT_FOUND');
      const recovery=this.db.prepare('SELECT * FROM command_recovery WHERE tenant_id=? AND command_id=?').get(node.tenant_id,row.id);
      if (!recovery) throw new HubError('Recovery is not pending',409,'RECOVERY_NOT_PENDING');
      if (row.epoch!==node.epoch || !this.deliverable(node,row)) throw new HubError('Original node authorization is unavailable',403,'GRANT_REQUIRED');
      if (input.basis==='transaction_rollback' && (input.outcome!=='not_applied' || row.action!=='review' || parse(row.body_json)?.decision!=='pass' || !reviewRejectionResult(input.result,row.task_id)) ||
        input.outcome==='not_applied' && !['pre_dispatch_marker','transaction_rollback'].includes(input.basis) ||
        input.basis==='pre_dispatch_marker' && input.result!==undefined) throw new HubError('Invalid rollback recovery evidence');
      if (recovery.checked_at!=null) return this.commandView(row);
      if (row.status!=='unknown') {
        // A normal receipt won the race; never replace its result.
        if (['running','paused','completed'].includes(row.status)) this.db.prepare("UPDATE command_recovery SET outcome='applied',basis='durable_receipt',checked_at=? WHERE tenant_id=? AND command_id=?").run(this.now(),node.tenant_id,row.id);
        else throw new HubError('Command outcome already changed',409,'RECOVERY_CONFLICT');
        return this.commandView(row);
      }
      if (input.outcome==='applied') {
        const result=sanitizeReceiptResult(input.result);
        validAppliedReceipt(row,input.status,result,input.error);
        this.db.prepare('UPDATE commands SET status=?,result_json=?,error=NULL,updated_at=? WHERE tenant_id=? AND id=? AND status=\'unknown\'')
          .run(input.status,JSON.stringify(result),this.now(),node.tenant_id,row.id);
        if (row.action==='pause' && input.status==='paused') this.applyVerifiedPause(row);
      } else if (input.outcome==='not_applied') {
        this.db.prepare("UPDATE commands SET status='failed',result_json=?,error=?,updated_at=? WHERE tenant_id=? AND id=? AND status='unknown'")
          .run(input.basis==='transaction_rollback'?JSON.stringify(input.result):null,input.basis==='transaction_rollback'?'Review rejected before change':'Original action was not sent',this.now(),node.tenant_id,row.id);
        if (['continue','message','start_task'].includes(row.action)) this.db.prepare('DELETE FROM continue_leases WHERE tenant_id=? AND command_id=?').run(node.tenant_id,row.id);
      }
      this.db.prepare('UPDATE command_recovery SET outcome=?,basis=?,checked_at=? WHERE tenant_id=? AND command_id=?')
        .run(input.outcome,input.basis,Math.max(this.now(),recovery.requested_at),node.tenant_id,row.id);
      return this.commandView(this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=?').get(node.tenant_id,row.id));
    });
  }

  deliverable(node, row) {
    if (row.node_id !== node.id || row.tenant_id !== node.tenant_id || row.epoch !== node.epoch || !this.canAccess(node, row.project_id)) return false;
    const controller = this.db.prepare('SELECT * FROM subjects WHERE id=? AND tenant_id=?').get(row.created_by, node.tenant_id);
    if (!controller || controller.revoked_at || !this.canAccess(controller, row.project_id)) return false;
    const owner = this.db.prepare('SELECT * FROM project_owners WHERE tenant_id=? AND project_id=?').get(node.tenant_id, row.project_id);
    return Boolean(owner && owner.node_id === node.id && owner.epoch === node.epoch);
  }

  claim(node, commandId) {
    this.requireRole(node, 'node');
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=? AND node_id=?').get(node.tenant_id, requireId(commandId, 'command ID'), node.id);
      if (!row) throw new HubError('Command not found', 404, 'NOT_FOUND');
      this.expire(row);
      const current = this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=?').get(node.tenant_id, row.id);
      if (current.status !== 'queued') throw new HubError('Command is not claimable', 409, 'COMMAND_NOT_QUEUED');
      if (!this.deliverable(node, current)) throw new HubError('Project grant or ownership changed', 403, 'GRANT_REQUIRED');
      const snapshot = this.db.prepare('SELECT received_at,epoch FROM snapshots WHERE node_id=? AND tenant_id=?').get(node.id, node.tenant_id);
      if (!snapshot || snapshot.epoch !== node.epoch || this.now() - snapshot.received_at > 60000) throw new HubError('Node snapshot is stale at claim', 503, 'NODE_OFFLINE');
      if (['continue','message','start_task'].includes(current.action)) {
        const lease = this.db.prepare('SELECT command_id FROM continue_leases WHERE tenant_id=? AND project_id=? AND task_id=?').get(node.tenant_id, current.project_id, current.task_id);
        if (lease?.command_id !== current.id) throw new HubError('Continue lease changed', 409, 'CONTINUE_LEASE');
      }
      this.db.prepare("UPDATE commands SET status='received',claimed_at=?,updated_at=? WHERE tenant_id=? AND id=? AND status='queued'")
        .run(this.now(), this.now(), node.tenant_id, row.id);
      return { ...this.commandView(this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=?').get(node.tenant_id, row.id)), body: parse(row.body_json), nodeId: node.id, actor: { tenantId: node.tenant_id, subjectId: row.created_by, role: 'controller' } };
    });
  }

  validate(node, commandId) {
    this.requireRole(node, 'node');
    const row = this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=? AND node_id=?').get(node.tenant_id, requireId(commandId, 'command ID'), node.id);
    if (!row) throw new HubError('Command not found', 404, 'NOT_FOUND');
    if (!['received', 'sending'].includes(row.status) || row.result_json || row.error) throw new HubError('Command no longer executable', 409, 'COMMAND_NOT_RUNNING');
    if (row.expires_at <= this.now()) throw new HubError('Command expired', 410, 'COMMAND_EXPIRED');
    if (!this.deliverable(node, row)) throw new HubError('Grant or ownership changed', 403, 'GRANT_REQUIRED');
    const snapshot = this.db.prepare('SELECT received_at,epoch,data_json FROM snapshots WHERE node_id=? AND tenant_id=?').get(node.id, node.tenant_id);
    if (!snapshot || snapshot.epoch !== node.epoch || this.now() - snapshot.received_at > 60000) throw new HubError('Node snapshot is stale', 503, 'NODE_OFFLINE');
    if (row.action === 'create_task') {
      const data=parse(snapshot.data_json);
      if (!data.capabilities?.taskCreation || !data.projects.some(project=>project.id===row.project_id))
        throw new HubError('Project is no longer available for remote task creation',409,'NODE_UPDATE_REQUIRED');
    }
    if (row.action === 'inbox_action') {
      const data=parse(snapshot.data_json), task=data.tasks.find(task=>task.id===row.task_id&&task.projectId===row.project_id);
      if (!task || task.revision !== row.expected_revision) throw new HubError('Task revision changed',409,'REVISION_CONFLICT');
      validateInboxAction(data,task,parse(row.body_json));
    }
    if (['continue','message','start_task'].includes(row.action)) {
      const lease = this.db.prepare('SELECT command_id FROM continue_leases WHERE tenant_id=? AND project_id=? AND task_id=?').get(node.tenant_id, row.project_id, row.task_id);
      if (lease?.command_id !== row.id) throw new HubError('Continue lease changed', 409, 'CONTINUE_LEASE');
    }
    return { ...this.commandView(row), body: parse(row.body_json), nodeId: node.id, actor: { tenantId: node.tenant_id, subjectId: row.created_by, role: 'controller' } };
  }

  markSending(node, commandId) {
    return this.tx(() => {
      const command = this.validate(node, commandId);
      if (command.status === 'received') this.db.prepare("UPDATE commands SET status='sending',updated_at=? WHERE tenant_id=? AND id=? AND status='received'").run(this.now(), node.tenant_id, command.commandId);
      return { ...command, status: 'sending' };
    });
  }

  applyVerifiedPause(row) {
    this.db.prepare("UPDATE commands SET status='paused',error='Paused by verified node command',updated_at=? WHERE tenant_id=? AND project_id=? AND task_id=? AND action IN ('continue','message','start_task') AND status='running'")
      .run(this.now(), row.tenant_id, row.project_id, row.task_id);
    this.db.prepare("UPDATE commands SET status='unknown',error='Pause confirmed; original action outcome remains unknown',updated_at=? WHERE tenant_id=? AND project_id=? AND task_id=? AND action IN ('continue','message','start_task') AND status IN ('received','sending','unknown')")
      .run(this.now(), row.tenant_id, row.project_id, row.task_id);
    this.db.prepare('DELETE FROM continue_leases WHERE tenant_id=? AND project_id=? AND task_id=?')
      .run(row.tenant_id, row.project_id, row.task_id);
  }

  receipt(node, commandId, input) {
    this.requireRole(node, 'node');
    if (!isRecord(input) || !['running', 'paused', 'unknown', 'expired', 'failed','completed'].includes(input.status)) throw new HubError('Invalid command receipt');
    if (input.result !== undefined && Buffer.byteLength(JSON.stringify(input.result)) > 20000) throw new HubError('Receipt too large', 413);
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=? AND node_id=?').get(node.tenant_id, requireId(commandId, 'command ID'), node.id);
      if (!row) throw new HubError('Command not found', 404, 'NOT_FOUND');
      if (input.status === 'completed' && !['inbox_action','create_task'].includes(row.action)) throw new HubError('Completed receipt only applies to inbox actions and manual task creation');
      const claimedRejection=isRecord(input.result) && (input.result.status==='rejected' || Object.hasOwn(input.result,'failureCode'));
      if (claimedRejection && (row.action!=='review' || parse(row.body_json)?.decision!=='pass' || input.status!=='failed' || !reviewRejectionResult(input.result,row.task_id))) throw new HubError('Invalid review rejection receipt');
      const sanitizedResult=claimedRejection?{...input.result}:sanitizeReceiptResult(input.result);
      const result = JSON.stringify(sanitizedResult);
      const error = claimedRejection?'Review rejected before change':input.error == null ? null : input.status === 'unknown' ? 'Local command outcome is unknown' : 'Local command failed';
      const recovery=this.db.prepare('SELECT * FROM command_recovery WHERE tenant_id=? AND command_id=?').get(node.tenant_id,row.id);
      const lateInboxResult = row.status==='unknown' && row.action==='inbox_action' && input.status==='completed';
      const lateRecoveredResult = row.status==='unknown' && recovery?.outcome==='unknown' && ['running','paused','completed'].includes(input.status);
      if (input.status==='completed') validAppliedReceipt(row,input.status,sanitizedResult,input.error);
      if (row.action==='start_task' && input.status==='running') validAppliedReceipt(row,input.status,sanitizedResult,input.error);
      if (lateRecoveredResult) validAppliedReceipt(row,input.status,sanitizedResult,input.error);
      if (!lateInboxResult && !lateRecoveredResult && (!['received', 'sending'].includes(row.status) || row.result_json || row.error)) {
        if (row.status === input.status && row.result_json === result && row.error === error) return this.commandView(row);
        throw new HubError('Receipt conflicts with existing outcome', 409, 'RECEIPT_CONFLICT');
      }
      if (row.epoch !== node.epoch || !this.canAccess(node, row.project_id) || (lateInboxResult || lateRecoveredResult || claimedRejection) && !this.deliverable(node,row)) throw new HubError('Node epoch or grant changed', 403, 'GRANT_REQUIRED');
      this.db.prepare('UPDATE commands SET status=?,result_json=?,error=?,updated_at=? WHERE tenant_id=? AND id=?')
        .run(input.status, result, error, this.now(), node.tenant_id, row.id);
      if (['running','paused','completed'].includes(input.status) && recovery?.outcome==='unknown') this.db.prepare("UPDATE command_recovery SET outcome='applied',basis='durable_receipt',checked_at=? WHERE tenant_id=? AND command_id=?")
        .run(Math.max(this.now(),recovery.requested_at),node.tenant_id,row.id);
      if (['continue','message','start_task'].includes(row.action) && ['failed', 'expired'].includes(input.status)) {
        this.db.prepare('DELETE FROM continue_leases WHERE tenant_id=? AND command_id=?').run(node.tenant_id, row.id);
      }
      if (row.action === 'pause' && input.status === 'paused') {
        this.applyVerifiedPause(row);
      }
      return this.commandView(this.db.prepare('SELECT * FROM commands WHERE tenant_id=? AND id=?').get(node.tenant_id, row.id));
    });
  }

  close() { this.db.close(); }
}
