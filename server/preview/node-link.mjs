import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import {previewRetestScope,sameRetestScope} from './retest-contract.mjs';

const LIMIT = 16 * 1024;
const MAX_PENDING = 8;
const MAX_RETEST_ACTIVE = 2;
const RETEST_REPLY_MS = 4500;

/** Outbound, read-only asset link. Call refresh after credentials or registrations change. */
export function createPreviewNodeLink({ registry, credentials, records, recordAuthority, createFeedbackTask, reconcileFeedbackTask,
  recoveryStoreId, compareRetest, retestAuthority, WebSocketImpl = WebSocket } = {}) {
  if (!registry?.read || !registry?.get || !registry?.isRegistered || !registry?.markRegistered || typeof credentials !== 'function') throw new TypeError('Preview link requires registry and credentials');
  let socket = null, closed = false, generation = 0, pending = 0, retestActive = 0,
    ready = false, key = null, retry = null, readyPromise = null;
  const registrations = new Map();
  const registrationQueries = new Map();
  const send = frame => {
    if (socket?.readyState !== WebSocketImpl.OPEN || socket.bufferedAmount > 1_048_576) { socket?.terminate(); return false; }
    const encoded = JSON.stringify({ v: 1, ...frame });
    if (Buffer.byteLength(encoded) > 262144) return false;
    socket.send(encoded); return true;
  };
  async function refresh() {
    if (closed) return;
    clearTimeout(retry); retry = null;
    const identity = credentials();
    if (!identity?.url || !identity?.token || !identity?.nodeId || !Number.isSafeInteger(identity.epoch)) {
      socket?.terminate(); socket = null; key = null; ready = false; return;
    }
    const nextKey = JSON.stringify([identity.url, identity.token, identity.nodeId, identity.epoch]);
    if (key === nextKey && ready && socket?.readyState === WebSocketImpl.OPEN) return;
    if (key === nextKey && socket?.readyState === WebSocketImpl.CONNECTING) return readyPromise;
    if (key === nextKey && socket?.readyState === WebSocketImpl.OPEN) return readyPromise;
    const url = new URL('/api/preview/node', identity.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      throw new Error('Preview link requires HTTPS outside loopback');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    socket?.terminate(); ready = false; key = nextKey;
    const ws = new WebSocketImpl(url, { maxPayload: 262144, perMessageDeflate: false, handshakeTimeout: 5000 });
    socket = ws; const own = ++generation;
    const current = () => !closed && generation === own && socket === ws && credentials()?.token === identity.token;
    const currentRetest = () => {
      const live=credentials();
      return current() && ready && live?.url===identity.url && live?.token===identity.token &&
        live?.nodeId===identity.nodeId && live?.epoch===identity.epoch;
    };
    const timer = setTimeout(() => ws.terminate(), 5000); timer.unref?.();
    let settleReady;
    const authenticated = new Promise((resolve, reject) => { settleReady = { resolve, reject }; });
    readyPromise = authenticated;
    ws.on('open', () => { if (current()) send({ type: 'auth', nodeId: identity.nodeId, token: identity.token,
      ...(typeof recoveryStoreId==='string'?{feedbackRecovery:2,recoveryStoreId}:{}) }); });
    ws.on('message', async (raw, binary) => {
      if (!current()) return;
      try {
        if (binary || raw.length > 65536) throw Error('Invalid preview frame');
        const frame = JSON.parse(raw.toString());
        if (frame.v !== 1 && !(frame.v === 2 && typeof frame.type === 'string' && frame.type.startsWith('records-')))
          throw Error('Preview version mismatch');
        if (frame.type === 'ready') {
          if (frame.nodeId !== identity.nodeId || frame.epoch !== identity.epoch) throw Error('Preview node changed');
          clearTimeout(timer); ready = true; settleReady.resolve();
          return;
        }
        if (frame.type === 'registered' && typeof frame.previewId === 'string') {
          if (registrations.has(frame.previewId)) {
            await registry.markRegistered(frame.previewId);
            registrations.get(frame.previewId)?.resolve(); registrations.delete(frame.previewId);
          }
          return;
        }
        if(frame.type==='registration-status'&&typeof frame.requestId==='string'){
          const query=registrationQueries.get(frame.requestId);
          if(query&&query.socket===ws&&query.previewId===frame.previewId&&typeof frame.found==='boolean'){
            registrationQueries.delete(frame.requestId);query.resolve(frame.found);
          }
          return;
        }
        if (frame.type === 'error') throw Error(frame.code || 'Preview Hub rejected request');
        if (frame.type === 'retest-compare') {
          if(typeof frame.requestId!=='string'||!frame.current||!frame.previous||
            retestActive>=MAX_RETEST_ACTIVE||typeof compareRetest!=='function'||typeof retestAuthority!=='function') {
            if(currentRetest())send({type:'retest-error',requestId:frame.requestId,
              code:typeof compareRetest!=='function'||typeof retestAuthority!=='function'?
                'PREVIEW_RETEST_UNSUPPORTED':retestActive>=MAX_RETEST_ACTIVE?
                  'PREVIEW_RETEST_BUSY':'PREVIEW_RETEST_UNKNOWN'});
            return;
          }
          retestActive++;
          let expired=false;
          const deadline=setTimeout(()=>{
            expired=true;
            if(currentRetest())send({type:'retest-error',requestId:frame.requestId,code:'PREVIEW_RETEST_UNKNOWN'});
          },RETEST_REPLY_MS);
          deadline.unref?.();
          try {
            const getPair=async(original=null)=>{
              const manifests=await Promise.all([registry.get(frame.current.previewId),registry.get(frame.previous.previewId)]);
              if(!currentRetest()||manifests.some((m,i)=>!m||!sameRetestScope(
                previewRetestScope(m),i?frame.previous:frame.current)||
                original&&JSON.stringify(m)!==JSON.stringify(original[i])))throw Error('Retest scope changed');
              if(!await registry.isRegistered(manifests[0].previewId)||
                !await registry.isRegistered(manifests[1].previewId)||!currentRetest())throw Error('Retest registration changed');
              return manifests;
            };
            const manifests=await getPair();
            await retestAuthority(manifests);
            if(!currentRetest())throw Error('Retest link changed');
            const result=await compareRetest(manifests);
            await getPair(manifests);
            await retestAuthority(manifests);
            if(!currentRetest()||expired)return;
            if(!send({type:'retest-result',requestId:frame.requestId,result}))
              throw Error('Retest link changed');
          }catch{if(!expired&&currentRetest())send({type:'retest-error',requestId:frame.requestId,code:'PREVIEW_RETEST_UNKNOWN'});}
          finally{clearTimeout(deadline);retestActive--;}
          return;
        }
        if (frame.v === 2 && ['records-list', 'records-create', 'records-reconcile'].includes(frame.type)) {
          if (!records || typeof recordAuthority !== 'function' || typeof frame.requestId !== 'string' ||
            !frame.scope || pending >= MAX_PENDING) {
            send({v:2,type:'records-error',requestId:frame.requestId,code:'PREVIEW_LIMIT'}); return;
          }
          pending++;
          try {
            const manifest=await registry.get(frame.scope.previewId);
            if (!current() || !manifest || manifest.v!==2 || manifest.apiTarget!=='records-v1' ||
              !await registry.isRegistered(manifest.previewId) ||
              ['previewId','projectId','taskId','contentVersion','artifactDigest','dataStoreId']
                .some(key=>manifest[key]!==frame.scope[key])) throw Error('Preview record scope changed');
            await recordAuthority(manifest);
            if (!current() || !await registry.isRegistered(manifest.previewId) ||
              (await registry.get(manifest.previewId))!==manifest) throw Error('Preview record authority changed');
            await recordAuthority(manifest);
            if(!current())throw Error('Preview node changed');
            const result=frame.type==='records-list'?records.list(frame.scope):
              frame.type==='records-create'?records.createOperation(frame.scope,frame.operation):
                records.reconcileOperation(frame.scope,frame.operation);
            if(current())send({v:2,type:'records-result',requestId:frame.requestId,result});
          } catch(error) {if(current())send({v:2,type:'records-error',requestId:frame.requestId,
            code:error.code||'PREVIEW_RECORD_UNKNOWN'});}
          finally{pending--;}
          return;
        }
        if (frame.type === 'create-feedback') {
          if (typeof frame.requestId !== 'string' || !frame.feedback || typeof createFeedbackTask !== 'function')
            throw Error('Invalid feedback request');
          if (pending >= MAX_PENDING) { send({ type: 'feedback-error', requestId: frame.requestId, code: 'PREVIEW_LIMIT' }); return; }
          pending++;
          try {
            const source = frame.feedback.sourcePreview;
            const manifest = source && await registry.get(source.previewId);
            if (!manifest || !await registry.isRegistered(source.previewId) || manifest.projectId !== frame.feedback.projectId || manifest.taskId !== source.taskId ||
              manifest.contentVersion !== source.contentVersion || manifest.artifactDigest !== source.artifactDigest)
              throw Error('Preview registration changed');
            const result = await createFeedbackTask(frame.feedback);
            if (current()) send({ type: 'feedback-created', requestId: frame.requestId, taskId: result.taskId });
          } catch (error) { if (current()) send({ type: 'feedback-error', requestId: frame.requestId,
            code: error.code || 'PREVIEW_TASK_FAILED' }); }
          finally { pending--; }
          return;
        }
        if (frame.type === 'reconcile-feedback') {
          if(typeof frame.requestId!=='string'||!frame.feedback||typeof reconcileFeedbackTask!=='function')
            throw Error('Invalid feedback recovery request');
          if(pending>=MAX_PENDING){send({type:'feedback-reconcile-error',requestId:frame.requestId,code:'PREVIEW_LIMIT'});return;}
          pending++;
          try{
            const result=await reconcileFeedbackTask(frame.feedback,{allowFence:frame.allowFence===true});
            if(current())send({type:'feedback-reconciled',requestId:frame.requestId,status:result.status,
              ...(result.taskId?{taskId:result.taskId}:{})});
          }catch(error){if(current())send({type:'feedback-reconcile-error',requestId:frame.requestId,
            code:error.code||'PREVIEW_TASK_FAILED'});}
          finally{pending--;}
          return;
        }
        if (frame.type !== 'get' || typeof frame.requestId !== 'string' || typeof frame.previewId !== 'string' ||
          typeof frame.path !== 'string') throw Error('Invalid preview request');
        if (pending >= MAX_PENDING) { send({ type: 'error', requestId: frame.requestId, code: 'PREVIEW_LIMIT' }); return; }
        pending++;
        try {
          if (!await registry.isRegistered(frame.previewId)) throw Error('Preview is not registered');
          const { bytes, entry } = await registry.read(frame.previewId, frame.path);
          if (!current()) return;
          send({ type: 'start', requestId: frame.requestId, size: bytes.length, sha256: entry.sha256 });
          for (let at = 0, seq = 0; at < bytes.length; at += LIMIT, seq++) {
            if (!current() || !send({ type: 'chunk', requestId: frame.requestId, seq, data: bytes.subarray(at, at + LIMIT).toString('base64') })) return;
          }
          send({ type: 'end', requestId: frame.requestId });
        } catch (error) { if (current()) send({ type: 'error', requestId: frame.requestId, code: error.code || 'PREVIEW_UNAVAILABLE' }); }
        finally { pending--; }
      } catch { ws.close(4003, 'Preview protocol rejected'); }
    });
    ws.on('close', () => {
      clearTimeout(timer); ready = false; settleReady.reject(new Error('Preview node link closed'));
      for (const item of registrations.values()) item.reject(new Error('Preview node link closed'));
      registrations.clear();
      for(const [requestId,item] of registrationQueries)if(item.socket===ws){
        registrationQueries.delete(requestId);item.reject(new Error('Preview node link closed'));}
      if (current()) {
        socket = null; key = null; readyPromise = null;
        clearTimeout(retry); retry = setTimeout(() => void refresh().catch(() => {}), 2000); retry.unref?.();
      }
    });
    ws.on('error', () => {});
    return authenticated;
  }
  async function register(previewId,{beforeSend}={}) {
    const manifest = await registry.get(previewId);
    if (!manifest || !ready || socket?.readyState !== WebSocketImpl.OPEN) throw new Error('Preview node link offline');
    if (Buffer.byteLength(JSON.stringify({ type: 'register', v: 1, manifest })) > 262144)
      throw new Error('Preview manifest exceeds transport limit');
    if(beforeSend!==undefined){if(typeof beforeSend!=='function')throw new TypeError('Invalid preview registration guard');
      beforeSend(manifest);}
    const confirmed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { registrations.delete(previewId); reject(new Error('Preview registration timed out')); }, 5000);
      timer.unref?.(); registrations.set(previewId, {
        resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); }
      });
    });
    if (!send({ type: 'register', manifest })) registrations.get(previewId)?.reject(new Error('Preview node link offline'));
    return confirmed;
  }
  async function queryRegistration(previewId,{beforeSend}={}){
    const manifest=await registry.get(previewId);
    if(!manifest||!ready||socket?.readyState!==WebSocketImpl.OPEN)throw new Error('Preview node link offline');
    if(beforeSend!==undefined){if(typeof beforeSend!=='function')throw new TypeError('Invalid preview registration guard');
      beforeSend(manifest);}
    const requestId=randomUUID(),ownSocket=socket;
    const result=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{registrationQueries.delete(requestId);reject(new Error('Preview registration query timed out'));},5000);
      timer.unref?.();registrationQueries.set(requestId,{socket:ownSocket,previewId,
        resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    });
    if(socket!==ownSocket||!send({type:'registration-query',requestId,manifest})){
      const pending=registrationQueries.get(requestId);registrationQueries.delete(requestId);
      pending?.reject(new Error('Preview node link offline'));
    }
    return result;
  }
  async function close() { closed = true; generation++; clearTimeout(retry); socket?.terminate(); socket = null; }
  return { refresh, register, queryRegistration, close };
}
