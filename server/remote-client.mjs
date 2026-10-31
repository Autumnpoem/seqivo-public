import { createHmac, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeSnapshot, sanitizeReceiptResult, validateInboxAction, budgetInboxSnapshot } from './hub/projection.mjs';
import { confirmedReviewRejectionCode } from './store.mjs';
import { reviewRejectionResult } from './review-rejection.mjs';

const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const textError = error => error instanceof Error ? error.message : String(error);
const clone = value => structuredClone(value);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);

function baseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid Hub URL'); }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Hub URL must have no credentials, path, query, or fragment');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('HTTPS required outside loopback');
  return url.origin;
}

async function postJson(url, method, body, secret, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method, redirect: 'error', signal: externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal,
      headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const chunks = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_100_000) {
          reader.cancel().catch(() => {});
          throw new Error('Hub response too large');
        }
        chunks.push(Buffer.from(value));
      }
    }
    const raw = Buffer.concat(chunks, size).toString('utf8');
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error('Invalid Hub response'); }
    if (!response.ok) {
      const error = new Error(data.error || `Hub returned ${response.status}`);
      error.status = response.status; error.code = data.code;
      throw error;
    }
    return data;
  } finally { clearTimeout(timer); }
}

export async function createRemoteLink({ dataDir, getState, getConversations, getCreatedTaskReceipt, getReturnedDispositions, request, emit = () => {}, now = Date.now }) {
  if (!dataDir || typeof getState !== 'function' || typeof request !== 'function') throw new TypeError('Remote link requires dataDir, getState, and request');
  const statePath = join(dataDir, 'remote-link.json');
  let saved = { url: null, token: null, nodeId: null, epoch: null, projectIds: [], sequence: 0, pendingSnapshot: null, receipts: {} };
  try { saved = { ...saved, ...JSON.parse(await readFile(statePath, 'utf8')) }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let status = saved.token ? 'connecting' : 'disconnected';
  let lastSyncAt = null;
  let lastError = null;
  let timer = null;
  let closed = false;
  let serial = Promise.resolve();
  let conversationTaskIds = [];
  const activeRequests = new Set();

  async function persist() {
    await mkdir(dataDir, { recursive: true });
    const temp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
    await rename(temp, statePath);
    emit();
  }

  for (const receipt of Object.values(saved.receipts)) {
    if (['received', 'claimed', 'sending'].includes(receipt.phase)) {
      // These two durable phases precede the first possible local callback.
      // A sending marker is deliberately ambiguous, including after restart.
      receipt.preDispatchProven = ['received','claimed'].includes(receipt.phase);
      receipt.phase = 'done'; receipt.status = 'unknown'; receipt.error = 'Node restarted before command outcome was confirmed';
    }
  }
  if (saved.token) await persist();

  function state() {
    return { status, url: saved.url, nodeId: saved.nodeId || undefined, lastSyncAt, lastError,
      projectIds: [...saved.projectIds] };
  }

  function enqueue(fn) {
    const promise = serial.then(() => { if (closed) throw new Error('Remote link closed'); return fn(); });
    serial = promise.catch(() => {});
    return promise;
  }

  function schedule(delay = 2000) {
    if (timer) clearTimeout(timer);
    if (closed || !saved.token) return;
    timer = setTimeout(() => { sync().catch(() => {}); }, delay);
    timer.unref?.();
  }

  async function network(url, method, body, secret) {
    const controller = new AbortController();
    activeRequests.add(controller);
    try { return await postJson(url, method, body, secret, controller.signal); }
    finally { activeRequests.delete(controller); }
  }

  async function api(method, path, body, secret = saved.token) {
    return network(`${saved.url}${path}`, method, body, secret);
  }

  async function session() {
    const result = await api('GET', '/api/node/session');
    if (result.nodeId !== saved.nodeId || !Number.isInteger(result.epoch) || !Array.isArray(result.projectIds)) throw new Error('Hub node identity changed');
    if (result.epoch !== saved.epoch) {
      saved.epoch = result.epoch;
      saved.pendingSnapshot = null;
    }
    const granted = new Set(result.projectIds);
    conversationTaskIds = Array.isArray(result.conversationTaskIds) ? result.conversationTaskIds.filter(validId).slice(0,5) : [];
    saved.projectIds = saved.projectIds.filter(id => granted.has(id));
    await persist();
    return result;
  }

  async function snapshot(grants) {
    if (!saved.pendingSnapshot) {
      const board = await getState();
      if (!isRecord(board) || !Array.isArray(board.projects) || !Array.isArray(board.tasks)) throw new Error('Local board state unavailable');
      const selected = new Set(saved.projectIds.filter(id => grants.includes(id)));
      const projection = budgetInboxSnapshot(sanitizeSnapshot({
        projects: board.projects.filter(item => selected.has(item.id)),
        tasks: board.tasks.filter(item => selected.has(item.projectId)).map(item => {
          const source = item.sourceConversation;
          // The current pairing keeps groups stable across syncs and restarts; re-pairing rotates them.
          return {...item,sourceConversationGroup:source == null ? null : createHmac('sha256',saved.token)
            .update('seqivo:source-conversation-group:v1\0').update(saved.nodeId).update('\0')
            .update(JSON.stringify([source.provider,source.conversationId])).digest('hex')};
        }),
        conversations: typeof getConversations === 'function' ? await getConversations([...selected],conversationTaskIds) : [],
        ...(board.capabilities?.inbox===true ? {inbox:{...board.inbox,items:board.inbox.items.filter(item=>selected.has(item.projectId))}} : {}),
        capabilities: {conversations: typeof getConversations === 'function',inbox:board.capabilities?.inbox===true,
          taskCreation:board.capabilities?.taskCreation===true,taskStart:board.capabilities?.taskStart===true},
      }));
      saved.pendingSnapshot = { epoch: saved.epoch, sequence: saved.sequence + 1, ...projection };
      await persist();
    }
    const response = await api('POST', '/api/node/snapshot', saved.pendingSnapshot);
    if (!response.accepted || response.sequence !== saved.pendingSnapshot.sequence || response.epoch !== saved.epoch) throw new Error('Hub did not acknowledge snapshot sequence');
    saved.sequence = saved.pendingSnapshot.sequence;
    saved.pendingSnapshot = null;
    await persist();
  }

  function actionRoute(command) {
    const id = command.taskId;
    if (!validId(id)) throw new Error('Invalid task ID in Hub command');
    const root = `/api/tasks/${encodeURIComponent(id)}`;
    const expectedRevision = command.expectedRevision;
    if (!Number.isInteger(expectedRevision)) throw new Error('Invalid command revision');
    const allowed = {
      continue: [], pause: [],
      message: ['message'], start_task: ['message'], create_conversation: ['title','message'],
      create_task: ['title','goal','example','summary','approach','criteria'],
      update: ['title', 'goal', 'example', 'summary', 'approach', 'nextStep', 'status', 'criteria', 'blockedReason'],
      evidence: ['summary', 'reference'], review: ['decision', 'summary'],
      inbox_action: ['itemId','expectedItemRevision','action','answer','optionId'],
    }[command.action];
    if (!allowed || !isRecord(command.body) || Object.keys(command.body).some(key => !allowed.includes(key))) throw new Error('Hub command contains forbidden fields');
    switch (command.action) {
      case 'inbox_action': {
        const actor=command.actor;
        if (!validId(command.body.itemId) || !isRecord(actor) || !validId(actor.tenantId) || !validId(actor.subjectId) || actor.role !== 'controller') throw new Error('Hub inbox actor or item missing');
        const {itemId,...input}=command.body;
        return ['POST',`${root}/inbox/${encodeURIComponent(itemId)}/actions`,{...input,expectedRevision,actionId:command.commandId,
          remoteActor:{tenantId:actor.tenantId,subjectId:actor.subjectId,role:'controller'}}];
      }
      case 'create_conversation': return ['POST', '/api/conversations', {projectId:command.projectId,...command.body,commandId:command.commandId}];
      case 'start_task': return ['POST', `${root}/start`, {...command.body,expectedRevision,commandId:command.commandId}];
      case 'create_task': return ['POST', '/api/tasks', {projectId:command.projectId,...command.body,commandId:command.commandId}];
      case 'message': return ['POST', `${root}/message`, {...command.body,expectedRevision,commandId:command.commandId}];
      case 'continue': return ['POST', `${root}/continue`, { expectedRevision, commandId: command.commandId }];
      case 'pause': return ['POST', `${root}/pause`, { expectedRevision }];
      case 'update': return ['PATCH', root, { ...command.body, expectedRevision }];
      case 'evidence': return ['POST', `${root}/evidence`, { ...command.body, expectedRevision }];
      case 'review': {
        const actor = command.actor;
        if (!isRecord(actor) || !validId(actor.tenantId) || !validId(actor.subjectId) || actor.role !== 'controller') throw new Error('Hub review actor missing');
        return ['POST', `${root}/review`, { ...command.body, expectedRevision, remoteActor: { tenantId: actor.tenantId, subjectId: actor.subjectId, role: 'controller' } }];
      }
      default: throw new Error('Hub action not allowlisted');
    }
  }

  async function preflight(command,stage) {
    if (command.nodeId !== saved.nodeId || command.epoch !== saved.epoch) throw new Error('Command node or epoch changed');
    if (Date.parse(command.expiresAt) <= now()) throw new Error('Command expired');
    const freshSession = await session();
    if (freshSession.epoch !== command.epoch || !freshSession.projectIds.includes(command.projectId) || !saved.projectIds.includes(command.projectId)) throw new Error('Project grant or ownership epoch changed');
    const validation = await api('POST', `/api/node/commands/${encodeURIComponent(command.commandId)}/validate`, {});
    if (validation.commandId !== command.commandId || validation.epoch !== command.epoch || validation.projectId !== command.projectId || validation.taskId !== command.taskId || validation.expectedRevision !== command.expectedRevision || validation.action !== command.action) throw new Error('Command changed during validation');
    const board = await getState();
    if (Date.parse(command.expiresAt) <= now()) throw new Error('Command expired');
    if (['create_conversation','create_task'].includes(command.action)) {
      if(command.taskId!==command.commandId||command.expectedRevision!==0||!board.projects?.some(item=>item.id===command.projectId)||
        command.action==='create_task'&&board.capabilities?.taskCreation!==true) throw new Error('Local project changed');
      if(command.action==='create_task' && (validation.actor?.tenantId!==command.actor?.tenantId||
        validation.actor?.subjectId!==command.actor?.subjectId||validation.nodeId!==command.nodeId))
        throw new Error('Task creator binding changed');
      return null;
    }
    const task = board.tasks?.find(item => item.id === command.taskId && item.projectId === command.projectId);
    if (!task) throw new Error('Local task revision changed');
    if(command.action==='start_task'){
      if(board.capabilities?.taskStart!==true)throw new Error('Local task start is unavailable');
      if(stage?.stage==='confirmed-start-turn'){
        if(task.revision!==stage.taskRevision||task.conversationId!==stage.threadId||!stage.threadId)
          throw new Error('Confirmed task session changed');
      }else{
        const gate=task.executionWrite;
        if(task.revision!==command.expectedRevision||task.status!=='planned'||task.conversationId||
          (task.executionProvider||'codex-autocontinue')!=='codex-autocontinue'||
          stage?.stage!=='confirmed-start-session' &&
            (gate?.taskRevision!==task.revision||gate.contentVersion!==task.contentVersion||
             gate.start?.state!=='ready'||gate.v!==1||!gate.bootId||
             !Number.isFinite(Date.parse(gate.observedAt))||
             Math.abs(now()-Date.parse(gate.observedAt))>10000))
          throw new Error('Local task start changed');
      }
    }else if(task.revision !== command.expectedRevision)throw new Error('Local task revision changed');
    if (command.action === 'inbox_action') validateInboxAction(board,task,command.body);
    return task;
  }

  async function report(commandId, receipt) {
    const result = await api('POST', `/api/node/commands/${encodeURIComponent(commandId)}/receipt`, {
      status: receipt.status, result: receipt.result, error: receipt.error,
    });
    receipt.reported = true;
    await persist();
    return result;
  }

  function boundReviewRejection(receipt, command) {
    const binding=receipt?.reviewBinding;
    return receipt?.phase==='done' && receipt.status==='failed' &&
      binding?.commandId===command.commandId && binding.projectId===command.projectId &&
      binding.taskId===command.taskId && binding.epoch===command.epoch && binding.action==='review' &&
      binding.decision==='pass' && (command.body?.decision ?? command.reviewDecision)==='pass' &&
      command.action==='review' && reviewRejectionResult(receipt.result,command.taskId);
  }

  async function handleCommand(command) {
    if (!validId(command.commandId) || !validId(command.projectId) || !validId(command.taskId)) throw new Error('Invalid command identity');
    let receipt = saved.receipts[command.commandId];
    if (receipt) {
      if (receipt.result?.status==='rejected' && !boundReviewRejection(receipt,command)) {
        receipt.phase='done';receipt.status='unknown';receipt.result=null;receipt.error='Review rejection proof is unavailable';
        delete receipt.reviewBinding;
        await persist();
      }
      if (receipt.phase !== 'done') {
        receipt.preDispatchProven = ['received','claimed'].includes(receipt.phase);
        receipt.phase = 'done'; receipt.status = 'unknown'; receipt.error = 'Previous local command outcome is unknown';
        await persist();
      }
      if (!receipt.reported && (['received', 'sending'].includes(command.status) || command.action === 'inbox_action' && command.status === 'unknown' && receipt.status === 'completed')) await report(command.commandId, receipt);
      return;
    }
    if (command.status !== 'queued') {
      // Hub already claimed it, but this node has no durable local receipt.
      saved.receipts[command.commandId] = receipt = { phase: 'done', status: 'unknown', error: 'Claimed command has no local receipt', reported: false };
      await persist();
      if (command.status === 'unknown') return; // Hub already knows; do not execute or invent a final receipt.
      await report(command.commandId, receipt);
      return;
    }
    receipt = { phase: 'received', status: null, reported: false };
    saved.receipts[command.commandId] = receipt;
    await persist();
    let claimed;
    try { claimed = await api('POST', `/api/node/commands/${encodeURIComponent(command.commandId)}/claim`, {}); }
    catch (error) {
      receipt.phase = 'done'; receipt.status = 'unknown'; receipt.preDispatchProven = true; receipt.error = 'Claim acknowledgement unavailable';
      await persist();
      return;
    }
    receipt.phase = 'claimed';
    await persist();
    try { await preflight(claimed); }
    catch (error) {
      receipt.phase = 'done';
      receipt.preDispatchProven = true;
      receipt.status = /expired/i.test(textError(error)) ? 'expired'
        : /Local task revision changed|Project grant or ownership epoch changed|Command node or epoch changed|Command changed during validation/i.test(textError(error)) || [403, 409, 410].includes(error.status) ? 'failed'
          : 'unknown';
      receipt.error = textError(error);
      await persist();
      try { await report(command.commandId, receipt); } catch { /* retry receipt only */ }
      return;
    }
    const [method, path, body] = actionRoute(claimed);
    // This record is durable before the first possible external send.
    receipt.phase = 'sending';
    receipt.dispatchBinding={commandId:claimed.commandId,action:claimed.action,nodeId:claimed.nodeId,epoch:claimed.epoch,
      projectId:claimed.projectId,taskId:claimed.taskId,expectedRevision:claimed.expectedRevision};
    await persist();
    try {
      // Revalidate online after the durable send marker and immediately before
      // the local callback. A lost Hub connection never executes a cached claim.
      await api('POST', `/api/node/commands/${encodeURIComponent(command.commandId)}/sending`, {});
      await preflight(claimed);
      const result = await request(method, path, body, {
        commandId: claimed.commandId, projectId: claimed.projectId, taskId: claimed.taskId, action: claimed.action,
        expectedRevision:claimed.expectedRevision,
        ...(claimed.action==='create_task'?{nodeId:claimed.nodeId,epoch:claimed.epoch,actor:claimed.actor}:{}),
        // Trusted in-process callback; never accepted from a request body.
        // Queues and provider quota checks can outlive the initial preflight.
        revalidate: stage => preflight(claimed,stage),
      });
      receipt.status = claimed.action === 'pause'
        ? result?.status === 'paused' ? 'paused' : result?.status === 'unknown' ? 'unknown' : 'failed'
        : claimed.action === 'inbox_action' ? result?.status === 'completed' ? 'completed' : 'unknown'
        : claimed.action === 'create_task'
          ? validId(result?.taskId) && result.status==='planned' && result.revision===1 ? 'completed' : 'unknown'
        : claimed.action==='start_task'
          ? result?.taskId===claimed.taskId && ['running','completed','submitted','awaiting_approval'].includes(result?.status) ? 'running' : 'unknown'
        : claimed.action==='create_conversation'
          ? ['running','completed','submitted','awaiting_approval'].includes(result?.status) ? 'running' : 'unknown'
          : ['continue','message'].includes(claimed.action)
            ? ['running','created','completed','submitted'].includes(result?.status) ? 'running' : 'unknown'
          : 'running';
      const taskResult=isRecord(result?.task)?result.task:result;
      const taskMutation=['update','evidence','review'].includes(claimed.action);
      const taskMatched=isRecord(taskResult) && taskResult.id===claimed.taskId && typeof taskResult.status==='string' && taskResult.status.length>0;
      if (taskMutation && !taskMatched) receipt.status='unknown';
      receipt.result = sanitizeReceiptResult(result);
      if (taskMutation && taskMatched) receipt.result={...receipt.result,taskId:claimed.taskId};
      if (receipt.status === 'failed') receipt.error = 'Local action was not confirmed';
    } catch (error) {
      const failureCode=claimed.action==='review' && claimed.body?.decision==='pass'?confirmedReviewRejectionCode(error,claimed.taskId):null;
      if (failureCode) {
        receipt.status='failed';
        receipt.result={taskId:claimed.taskId,status:'rejected',failureCode};
        receipt.reviewBinding={commandId:claimed.commandId,projectId:claimed.projectId,taskId:claimed.taskId,epoch:claimed.epoch,action:'review',decision:'pass'};
        receipt.error='Review rejected before change';
      } else {
        receipt.status = 'unknown';
        receipt.error = 'Local action outcome is unknown';
      }
    }
    receipt.phase = 'done';
    await persist();
    try { await report(command.commandId, receipt); } catch { /* retry receipt only */ }
  }

  async function handleRecoveryProbe(probe) {
    if (!validId(probe.commandId) || probe.epoch!==saved.epoch || !saved.projectIds.includes(probe.projectId)) return;
    const receipt=saved.receipts[probe.commandId];
    // A deliberately retired attempt still has an unknown provider outcome.
    // Its original dispatch receipt must not later become a completed result.
    if(receipt?.unknownDisposition)return;
    let evidence={outcome:'unknown',basis:'insufficient_evidence'};
    if(probe.action==='create_task' && typeof getCreatedTaskReceipt==='function' &&
      probe.actor?.tenantId && probe.actor?.subjectId){
      const created=await getCreatedTaskReceipt({...probe,nodeId:saved.nodeId});
      if(created)evidence={outcome:'applied',basis:'durable_receipt',status:'completed',result:created};
    }
    if (probe.action==='review' && boundReviewRejection(receipt,probe)) {
      evidence={outcome:'not_applied',basis:'transaction_rollback',result:receipt.result};
    }
    const result=sanitizeReceiptResult(receipt?.result);
    const confirmed=result && typeof result.status==='string' && result.status && !['unknown','failed','rejected'].includes(result.status) && (
      probe.action==='pause' ? receipt.status==='paused' && result.status==='paused' :
      probe.action==='inbox_action' ? receipt.status==='completed' && result.status==='completed' && result.taskId===probe.taskId && validId(result.itemId) && Number.isSafeInteger(result.itemRevision) :
      probe.action==='create_task' ? receipt.status==='completed' && validId(result.taskId) && result.status==='planned' && result.revision===1 :
      probe.action==='create_conversation' ? receipt.status==='running' && validId(result.taskId) && ['running','submitted','completed','awaiting_approval'].includes(result.status) :
      probe.action==='start_task' ? receipt.status==='running' && result.taskId===probe.taskId && ['running','submitted','completed','awaiting_approval'].includes(result.status) :
      ['continue','message'].includes(probe.action) ? receipt.status==='running' && result.taskId===probe.taskId :
      ['update','evidence','review'].includes(probe.action) && receipt.status==='running');
    if (evidence.basis==='insufficient_evidence' && receipt?.phase==='done' && confirmed) {
      evidence={outcome:'applied',basis:'durable_receipt',status:receipt.status,result};
    } else if (evidence.basis==='insufficient_evidence' && receipt?.phase==='done' && receipt.preDispatchProven===true) {
      evidence={outcome:'not_applied',basis:'pre_dispatch_marker'};
    }
    try { await api('POST',`/api/node/commands/${encodeURIComponent(probe.commandId)}/reconcile`,evidence); }
    catch (error) { if (!['RECOVERY_NOT_PENDING','RECOVERY_CONFLICT'].includes(error.code)) throw error; }
  }

  async function reportReturnedDispositions() {
    if(typeof getReturnedDispositions!=='function')return;
    for(const [commandId,receipt] of Object.entries(saved.receipts)){
      if(!validId(commandId)||receipt.phase!=='done'||!['running','unknown'].includes(receipt.status))continue;
      const identity={nodeId:saved.nodeId,epoch:saved.epoch};
      const records=await getReturnedDispositions({commandId,dispatchBinding:receipt.dispatchBinding||null});
      const pending=receipt.unknownDisposition;
      if(pending&&!pending.acknowledged&&(pending.nodeId!==identity.nodeId||pending.epoch!==identity.epoch||
        !records.some(item=>JSON.stringify(item)===JSON.stringify(pending.payload))))
        throw new Error('Original disposition acknowledgement is pending; wait for the same human return');
      for(const payload of records){
        if(!saved.projectIds.includes(payload.projectId)||saved.nodeId!==identity.nodeId||saved.epoch!==identity.epoch)
          throw new Error('Disposition project or node authorization changed');
        const existing=receipt.unknownDisposition;
        if(existing&&(existing.nodeId!==identity.nodeId||existing.epoch!==identity.epoch||JSON.stringify(existing.payload)!==JSON.stringify(payload)))
          throw new Error('Original disposition binding changed');
        if(existing?.acknowledged)continue;
        if(!existing){receipt.unknownDisposition={...identity,payload:clone(payload),acknowledged:false};await persist();}
        const current=await getReturnedDispositions({commandId,dispatchBinding:receipt.dispatchBinding||null});
        if(!current.some(item=>JSON.stringify(item)===JSON.stringify(payload)))
          throw new Error('Original disposition acknowledgement is pending; human return changed');
        const result=await api('POST',`/api/node/commands/${encodeURIComponent(commandId)}/dispose-unknown`,payload);
        if(result.commandId!==commandId||result.dispositionId!==payload.dispositionId||result.providerOutcome!=='unknown'||result.disposed!==true)
          throw new Error('Invalid original disposition acknowledgement');
        receipt.unknownDisposition.acknowledged=true;
        await persist();
      }
    }
  }

  async function syncWork() {
    if (!saved.token) return state();
    status = 'connecting'; emit();
    try {
      const current = await session();
      await snapshot(current.projectIds);
      // Retry only the exact old resolution before fetching any new work.
      await reportReturnedDispositions();
      const pending = await api('GET', '/api/node/commands');
      if (pending.epoch !== saved.epoch || !Array.isArray(pending.commands)) throw new Error('Hub command epoch changed');
      for (const command of pending.commands) await handleCommand(command);
      if (pending.recoveryProbes!==undefined && !Array.isArray(pending.recoveryProbes)) throw new Error('Invalid Hub recovery probes');
      for (const probe of pending.recoveryProbes||[]) await handleRecoveryProbe(probe);
      if(pending.commands.length) await snapshot(current.projectIds);
      status = 'connected'; lastSyncAt = new Date(now()).toISOString(); lastError = null;
      emit(); schedule(); return state();
    } catch (error) {
      status = error.code === 'REVOKED' ? 'revoked' : error.status === 401 || error.status === 403 ? 'error' : 'offline';
      lastError = textError(error);
      emit(); if (status !== 'revoked') schedule(10000); return state();
    }
  }

  function sync() { return enqueue(syncWork); }

  async function revokeCurrent() {
    if (!saved.token) { status = 'disconnected'; emit(); return true; }
    try { await api('POST', '/api/node/revoke', {}); }
    catch (error) {
      if (error.code !== 'REVOKED') {
        status = 'offline'; lastError = 'Could not revoke node at Hub; ask Hub owner to revoke it before re-pairing';
        emit(); schedule(); return false;
      }
    }
    saved = { url: null, token: null, nodeId: null, epoch: null, projectIds: [], sequence: 0, pendingSnapshot: null, receipts: saved.receipts };
    await persist();
    status = 'disconnected'; lastError = null; emit();
    return true;
  }

  if (saved.token) schedule(0);
  return {
    state,
    // Internal runtime capability only. Never include this in public state or IPC responses.
    terminalCredentials:()=>closed||!saved.token?null:({url:saved.url,token:saved.token,nodeId:saved.nodeId,epoch:saved.epoch}),
    async login({url,username,password,projectIds}) {
      const normalizedUrl=baseUrl(url);
      if(!Array.isArray(projectIds)||!projectIds.length||projectIds.some(id=>!validId(id))) throw new Error('Explicit projectIds required');
      // Passwords are sent only to the chosen HTTPS server and never persisted locally.
      const paired=await network(`${normalizedUrl}/api/auth/node-pairing`,'POST',{username,password,projectIds});
      return this.configure({url:normalizedUrl,pairingCode:paired.code,projectIds});
    },
    async configure({ url, pairingCode, projectIds }) {
      return enqueue(async () => {
        if (!Array.isArray(projectIds) || !projectIds.length || projectIds.some(id => !validId(id))) throw new Error('Explicit projectIds required');
        const normalizedUrl = baseUrl(url);
        if (typeof pairingCode !== 'string' || pairingCode.length < 20) throw new Error('Pairing code required');
        if (saved.token && !(await revokeCurrent())) throw new Error('Existing Hub node is not revoked; ask the Hub owner to revoke it before re-pairing');
        status = 'connecting'; emit();
        const redeemed = await network(`${normalizedUrl}/api/pairings/redeem`, 'POST', { code: pairingCode, projectIds });
        if (redeemed.role !== 'node' || !redeemed.token || !redeemed.nodeId || !Number.isInteger(redeemed.epoch)) throw new Error('Pairing code did not authorize a node');
        const selected = [...new Set(projectIds)];
        if (selected.some(id => !redeemed.projectIds?.includes(id))) throw new Error('Pairing does not grant selected projects');
        saved = { url: normalizedUrl, token: redeemed.token, nodeId: redeemed.nodeId, epoch: redeemed.epoch,
          projectIds: selected, sequence: 0, pendingSnapshot: null, receipts: {} };
        await persist();
        return syncWork();
      });
    },
    sync,
    disconnect() { return enqueue(async () => {
      if (timer) clearTimeout(timer); timer = null;
      await revokeCurrent();
      return state();
    }); },
    close() {
      closed = true; if (timer) clearTimeout(timer); timer = null;
      for (const controller of activeRequests) controller.abort();
      return serial;
    },
  };
}
