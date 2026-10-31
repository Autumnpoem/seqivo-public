import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { BoardError } from '../store.mjs';

const KEY = 'terminal.control.v1';
const MAX_FILES = 20_000;
const MAX_BYTES = 200 * 1024 * 1024;
const REVIEW_MS = 5 * 60_000;
const PARKED_SCOPE = process.platform === 'linux' ? 'linux-parked-managed-pane-and-visible-writers'
  : 'macos-parked-managed-pane-and-visible-writers';
const fail = (message, code = 'CONTROL_BLOCKED') => { throw new BoardError(message, 409, code); };
const within = (a, b) => { const r = relative(a, b); return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
const overlaps = (a, b) => within(a, b) || within(b, a);
const hash = value => createHash('sha256').update(value).digest('hex');
const safeReviewPath=value=>typeof value==='string'&&value.length>0&&value.length<=240&&
  !/\\|[\x00-\x1f\x7f]/.test(value)&&!isAbsolute(value)&&value!=='..'&&
  !value.startsWith('../')&&!value.startsWith('./')&&!value.split('/').some(part=>!part||part==='.'||part==='..');

/** Bounded snapshot of tracked and nonignored untracked Git files (or a non-Git directory tree). */
export function snapshotWorkspace(directory) {
  const root = realpathSync(directory);
  let names, snapshotScope = 'git-tracked-and-nonignored-untracked';
  try {
    names = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8').split('\0').filter(Boolean);
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (realpathSync(top) !== root) throw new Error('Project directory must be the repository root for handoff');
  } catch (error) {
    // A genuine git error or subdirectory must not silently become a partial scan.
    if (error.message?.includes('Project directory must')) throw error;
    snapshotScope = 'directory-tree-excluding-git-metadata';
    names = [];
    const walk = (dir, prefix = '') => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (item.name === '.git') continue;
        const name = prefix ? `${prefix}/${item.name}` : item.name;
        if (names.length > MAX_FILES) throw new Error('Workspace snapshot exceeds file limit');
        if (item.isDirectory()) walk(join(dir, item.name), name);
        else names.push(name);
      }
    };
    walk(root);
  }
  names = [...new Set(names)].sort();
  if (names.length > MAX_FILES) throw new Error('Workspace snapshot exceeds file limit');
  let total = 0;
  const files = {};
  for (const name of names) {
    const full = join(root, name);
    let info;
    try { info = lstatSync(full); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink()) { files[name] = `link:${hash(readlinkSync(full))}`; continue; }
    if (!info.isFile()) throw new Error(`Unsupported workspace entry: ${name}`);
    total += info.size;
    if (total > MAX_BYTES) throw new Error('Workspace snapshot exceeds byte limit');
    files[name] = hash(readFileSync(full));
  }
  return { directory: root, files, count: names.length, bytes: total, snapshotScope, capturedAt: new Date().toISOString() };
}

function changes(before, after) {
  const names = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  return [...names].sort().flatMap(path => before.files[path] === after.files[path] ? [] : [{ path,
    kind: !(path in before.files) ? 'added' : !(path in after.files) ? 'deleted' : 'modified' }]);
}

/**
 * Persistent fence for one project workspace. `quiesce` must stop the owned
 * executor and return process evidence; `inspectWriters` must inspect external
 * or human background writers. Both callbacks fail closed when unavailable.
 */
export function createTerminalControl({ store, quiesce, inspectWriters, inspectExisting, inspectDirectories, beforeAcquire = () => {}, parkManaged = async () => {}, sealHuman = async () => {}, snapshot = snapshotWorkspace, now = Date.now } = {}) {
  if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('Store is required');
  const stamp = () => new Date(now()).toISOString();
  const dispositionAuthorizers = new Map();
  const read = () => {
    const row = store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY);
    if (!row) return { version: 1, entries: {} };
    const value = JSON.parse(row.value);
    if (value?.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) fail('控制记录已损坏', 'CONTROL_CORRUPT');
    return value;
  };
  const mutate = fn => store.transaction(() => {
    const image = read();
    const result = fn(image);
    store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify(image));
    return result;
  });
  const project = id => {
    if (typeof id !== 'string' || !id) fail('项目 ID 无效');
    const value = store.getProject(id);
    if (!value.directory || !isAbsolute(value.directory)) fail('项目目录未绑定');
    const directory = realpathSync(value.directory);
    return { id, directory };
  };
  const publicEntry = entry => entry && { projectId: entry.projectId, phase: entry.phase, actorId: entry.actorId,
    generation: entry.generation, since: entry.since, reason: entry.reason || null,
    changes: entry.changes || [], workspace: entry.workspace,
    mode: entry.mode || 'managed', authorizedSessionRefs: entry.phase==='human' ? entry.sessionRefs || [] : [],
    snapshotScope: entry.snapshotScope || (entry.baseline ? entry.baseline.snapshotScope || 'legacy-unspecified' : null),
    ...(entry.phase==='return_review'&&entry.returnReview?{returnReview:entry.returnReview.public}: {}) };
  const reviewDigest = value => hash(JSON.stringify(value));
  const reviewDirectories = (result, entry) => {
    if(entry.mode==='existing'&&result?.verified===true&&result?.allOriginalSessionsRetired===true&&
      Array.isArray(result.directories)&&result.directories.length===0)return [];
    if(result?.verified!==true||!Array.isArray(result.directories)||
      result.directories.length!==(entry.sessionRefs||[]).length||result.directories.length>16)
      throw new Error('会话实际当前目录未能核实');
    const seen=new Set();
    return result.directories.map(item=>{
      if(!validManagedRef(item?.sessionRef)||!entry.sessionRefs.some(ref=>sameRef(ref,item.sessionRef))||
        seen.has(refKey(item.sessionRef))||typeof item.path!=='string'||item.path.length>240||
        !(item.path==='.'||safeReviewPath(item.path)))
        throw new Error('会话实际当前目录未能核实');
      seen.add(refKey(item.sessionRef));
      return {sessionRef:item.sessionRef,path:item.path};
    }).sort((a,b)=>refKey(a.sessionRef).localeCompare(refKey(b.sessionRef)));
  };
  const state = () => Object.values(read().entries).map(publicEntry);
  const refKey = ref => JSON.stringify([ref?.serverName,ref?.instanceId,ref?.sessionId]);
  const validManagedRef = ref => ref && typeof ref === 'object' &&
    typeof ref.serverName === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(ref.serverName) &&
    typeof ref.instanceId === 'string' && /^[a-f0-9]{64}$/.test(ref.instanceId) &&
    typeof ref.sessionId === 'string' && /^\$(0|[1-9]\d*)$/.test(ref.sessionId);
  const completeManagedEvidence = entry => entry?.mode === 'managed' &&
    typeof entry.profileId === 'string' && Array.isArray(entry.sessionRefs) &&
    entry.sessionRefs.length > 0 && entry.sessionRefs.length <= 16 &&
    Array.isArray(entry.sessionEvidence) && entry.sessionRefs.length === entry.sessionEvidence.length &&
    entry.sessionRefs.every(validManagedRef) &&
    entry.sessionEvidence.every(item => validManagedRef(item?.sessionRef)) &&
    new Set(entry.sessionRefs.map(refKey)).size === entry.sessionRefs.length &&
    new Set(entry.sessionEvidence.map(item => refKey(item?.sessionRef))).size === entry.sessionEvidence.length &&
    entry.sessionRefs.every(ref => entry.sessionEvidence.some(item => sameRef(item.sessionRef, ref)));
  const parkedReturnEvidence = entry => entry?.managedParkedReturn?.version === 1 &&
    entry.managedParkedReturn.generation === entry.generation &&
    entry.managedParkedReturn.workspace === entry.workspace &&
    entry.managedParkedReturn.profileId === entry.profileId &&
    entry.managedParkedReturn.sessionEvidenceDigest === evidenceDigest(entry) &&
    entry.managedParkedReturn.scope === PARKED_SCOPE &&
    entry.returnEvidence?.scope === entry.managedParkedReturn.scope;
  const evidenceDigest = entry => hash(JSON.stringify(entry.sessionEvidence));
  function retirementHandoff(projectId, expectedGeneration) {
    const entry = read().entries[projectId];
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1 ||
        !completeManagedEvidence(entry) || project(projectId).directory !== entry.workspace) return null;
    if (entry.phase === 'ai_ready' && entry.generation === expectedGeneration && parkedReturnEvidence(entry))
      return { generation: expectedGeneration, currentGeneration:entry.generation, workspace: entry.workspace, profileId: entry.profileId,
        sessionRefs: entry.sessionRefs, sessionEvidenceDigest: evidenceDigest(entry), phase: 'ai_ready' };
    const origin = entry.parkedHandoffOrigin;
    if (!['stopping', 'unknown'].includes(entry.phase) || !origin ||
        origin.generation !== expectedGeneration || entry.generation <= origin.generation ||
        origin.workspace !== entry.workspace ||
        origin.profileId !== entry.profileId || origin.sessionEvidenceDigest !== evidenceDigest(entry) ||
        !Array.isArray(origin.sessionRefs) || origin.sessionRefs.length !== entry.sessionRefs.length ||
        origin.sessionRefs.some(ref => !entry.sessionRefs.some(item => sameRef(item, ref)))) return null;
    return { ...origin, currentGeneration:entry.generation, phase: entry.phase };
  }
  const hasManagedSessionRefs = projectId => {
    const entry = read().entries[projectId];
    return entry?.mode === 'managed' && Boolean(entry.profileId || entry.sessionRefs || entry.sessionEvidence);
  };
  function handoffForProject(projectId) {
    const entry = read().entries[projectId];
    if (entry?.phase !== 'ai_ready' || !Number.isSafeInteger(entry.generation)) return null;
    // A project rebound to another directory must not inherit the old handoff.
    try { if (project(projectId).directory !== entry.workspace) return null; }
    catch { return null; }
    const all = Array.isArray(entry.changes) ? entry.changes : [];
    return { generation: entry.generation, returnedAt: entry.since,
      snapshotScope: entry.snapshotScope || 'legacy-unspecified',
      changes: all.slice(0, 80).map(item => ({ path: String(item.path || '').slice(0, 240), kind: String(item.kind || '').slice(0, 16) })),
      omittedChanges: Math.max(0, all.length - 80), notes: String(entry.notes || '').slice(0, 2000) };
  }
  function assertMayStart(projectId, additionalWorkspaces = []) {
    const p = project(projectId);
    if (!Array.isArray(additionalWorkspaces) || additionalWorkspaces.some(path => typeof path !== 'string' || !isAbsolute(path)))
      fail('执行目录无法核验', 'CONTROL_WORKSPACE_CHANGED');
    const directories = [p.directory, ...additionalWorkspaces.map(path => realpathSync(path))];
    for (const entry of Object.values(read().entries)) {
      if (entry.phase !== 'ai_ready' && directories.some(directory => overlaps(entry.workspace, directory)))
        fail('人工接管或执行现场待核实，暂不能开始此操作', 'CONTROL_BUSY');
    }
    return true;
  }
  function assertHuman({ projectId, token }) {
    const entry = read().entries[projectId];
    if (!entry || entry.phase !== 'human' || entry.token !== token) fail('人工控制权无效或已冻结', 'CONTROL_STALE');
    if (project(projectId).directory !== entry.workspace) fail('项目目录已变化', 'CONTROL_WORKSPACE_CHANGED');
    return true;
  }
  function assertReturn({projectId,token,generation}) {
    const entry=read().entries[projectId];
    if(!entry||entry.phase!=='return_check'||entry.token!==token||entry.generation!==generation||
      project(projectId).directory!==entry.workspace)fail('交还代次已变化','CONTROL_STALE');
    return {projectId,workspace:entry.workspace,mode:entry.mode,profileId:entry.profileId,
      sessionRefs:entry.sessionRefs||[],generation:entry.generation};
  }
  /** Freeze only the exact managed controller that began a now-uncertain
   * creation. A stale caller cannot overwrite a newer controller. */
  function markManagedUnknown({ projectId, token, generation }) {
    return mutate(image => {
      const entry = image.entries[projectId];
      if (entry?.token !== token || entry.generation !== generation || entry.mode !== 'managed')
        fail('受管控制代次已变化', 'CONTROL_STALE');
      delete entry.parkedHandoffOrigin;
      if (entry.phase !== 'unknown') {
        entry.phase = 'unknown'; entry.reason = '受管会话启动或身份未核实，请在本机检查原会话'; entry.since = stamp();
      }
      return publicEntry(entry);
    });
  }
  const sameRef=(a,b)=>a?.serverName===b?.serverName&&a?.instanceId===b?.instanceId&&a?.sessionId===b?.sessionId;
  function assertExistingSession({projectId,token,sessionRef}){
    assertHuman({projectId,token});
    const entry=read().entries[projectId];
    if(entry.mode!=='existing'||!entry.sessionRefs?.some(ref=>sameRef(ref,sessionRef)))fail('此会话未纳入已有会话授权','SESSION_NOT_AUTHORIZED');
    return true;
  }
  function assertManagedSession({projectId,token,profileId,sessionRef}){
    assertHuman({projectId,token});
    const entry=read().entries[projectId];
    if(entry.mode!=='managed'||entry.profileId!==profileId||!entry.sessionRefs?.some(ref=>sameRef(ref,sessionRef)))
      fail('此会话未纳入受管会话授权','SESSION_NOT_AUTHORIZED');
    return true;
  }
  function selectedRefs(refs){
    if(!Array.isArray(refs)||!refs.length||refs.length>16||refs.some(ref=>!ref||typeof ref!=='object'||
      typeof ref.serverName!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(ref.serverName)||
      typeof ref.instanceId!=='string'||!/^[a-f0-9]{64}$/.test(ref.instanceId)||
      typeof ref.sessionId!=='string'||!/^\$(0|[1-9]\d*)$/.test(ref.sessionId))||
      refs.some(ref=>ref.serverName!==refs[0].serverName||ref.instanceId!==refs[0].instanceId)||
      new Set(refs.map(ref=>ref.sessionId)).size!==refs.length)fail('已有会话授权范围无效','INVALID_SESSION_REF');
    return refs.map(ref=>({serverName:ref.serverName,instanceId:ref.instanceId,sessionId:ref.sessionId}));
  }
  function proof(result, label) {
    if (result?.verified !== true || result?.quiescent !== true || result?.unknown !== false || !Array.isArray(result.livePids) || result.livePids.length || !result.scope) {
      throw new Error(`${label}未证明相关写入进程已停止`);
    }
    return { scope: result.scope, checkedAt: result.checkedAt || stamp() };
  }
  function existingProof(result){
    if(result?.verified!==true||result?.authorized!==true||result?.unknown!==false||
      !Array.isArray(result.unownedWriters)||result.unownedWriters.length||
      !Array.isArray(result.sessionEvidence)||!result.sessionEvidence.length||!result.scope)throw new Error(result?.reason||'已有会话进程归属或其他写入者未核实');
    return {scope:result.scope,checkedAt:result.checkedAt||stamp(),sessionEvidence:result.sessionEvidence,
      retiredSessionRefs:result.retiredSessionRefs||[]};
  }
  async function verifyExistingSession({projectId,token,sessionRef}){
    assertExistingSession({projectId,token,sessionRef});
    const entry=read().entries[projectId];
    if(typeof inspectExisting!=='function')fail('已有会话进程核验不可用','PROCESS_PROOF_UNAVAILABLE');
    let result;
    try{result=existingProof(await inspectExisting({projectId,workspace:entry.workspace,profileId:entry.profileId,
      sessionRefs:entry.sessionRefs,previousEvidence:entry.sessionEvidence||null}));}
    catch(error){fail(error.message||'已有会话进程核验失败','PROCESS_PROOF_UNAVAILABLE');}
    assertExistingSession({projectId,token,sessionRef});
    return result;
  }
  async function verifyManagedSession({projectId,token,profileId,sessionRef}){
    assertManagedSession({projectId,token,profileId,sessionRef});
    const entry=read().entries[projectId];
    if(typeof inspectExisting!=='function')fail('会话进程核验不可用','PROCESS_PROOF_UNAVAILABLE');
    let result;
    try{result=existingProof(await inspectExisting({projectId,workspace:entry.workspace,profileId,
      sessionRefs:entry.sessionRefs,previousEvidence:entry.sessionEvidence||null}));}
    catch(error){fail(error.message||'会话进程核验失败','PROCESS_PROOF_UNAVAILABLE');}
    assertManagedSession({projectId,token,profileId,sessionRef});
    return result;
  }
  /** Only a session just created by the current managed controller may be added. */
  async function registerManagedSession({projectId,token,actorId,profileId,sessionRef}){
    const ref=selectedRefs([sessionRef])[0];
    assertHuman({projectId,token});
    const entry=read().entries[projectId];
    if(entry.mode!=='managed'||entry.actorId!==actorId||entry.profileId&&entry.profileId!==profileId)
      fail('受管会话控制权已变化','CONTROL_STALE');
    const refs=selectedRefs([...(entry.sessionRefs||[]),ref]);
    const generation=entry.generation;
    mutate(image=>{const current=image.entries[projectId];
      if(current?.token!==token||current.phase!=='human'||current.generation!==generation)fail('控制代次已变化','CONTROL_STALE');
      current.phase='stopping';current.since=stamp();
    });
    try{
      if(typeof inspectExisting!=='function')throw new Error('会话进程核验不可用');
      const result=existingProof(await inspectExisting({projectId,workspace:entry.workspace,profileId,
        sessionRefs:refs,previousEvidence:entry.sessionEvidence||null}));
      return mutate(image=>{const current=image.entries[projectId];
        if(current?.token!==token||current.phase!=='stopping'||current.generation!==generation)
          fail('控制代次已变化','CONTROL_STALE');
        current.profileId=profileId;current.sessionRefs=refs;current.sessionEvidence=result.sessionEvidence;
        current.phase='human';current.since=stamp();current.reason=null;delete current.parkedHandoffOrigin;
        return publicEntry(current);
      });
    }catch(error){
      mutate(image=>{const current=image.entries[projectId];if(current?.token===token&&current.phase==='stopping'&&current.generation===generation){
        current.phase='unknown';current.reason=error.message||String(error);current.since=stamp();
      }});
      throw error;
    }
  }
  function currentStopping(projectId, token) {
    const entry = read().entries[projectId];
    if (!entry || entry.token !== token || entry.phase !== 'stopping') fail('接管代次已变化', 'CONTROL_STALE');
    return entry;
  }
  function unknownDispositionConsent(projectId) {
    const consent=read().entries[projectId]?.unknownDispositionConsent;
    return consent?structuredClone(consent):null;
  }
  function authorizeUnknownDisposition({projectId,consentId,taskId,commandId}) {
    const entry=read().entries[projectId],consent=entry?.unknownDispositionConsent;
    const authorize=dispositionAuthorizers.get(consentId);
    if(entry?.phase!=='stopping'||!consent||consent.id!==consentId||
      consent.projectId!==projectId||consent.token!==entry.token||consent.generation!==entry.generation||
      consent.actorId!==entry.actorId||consent.profileId!==entry.profileId||
      consent.workspace!==entry.workspace||project(projectId).directory!==entry.workspace||
      !consent.commands.some(item=>item.taskId===taskId&&item.commandId===commandId)||
      typeof authorize!=='function')fail('结束旧轮次的确认已失效，请重新核对','CONTROL_STALE');
    authorize();
    return structuredClone(consent);
  }
  // This is an internal Node capability, not part of the public control frame.
  function returnedUnknownDispositions() {
    return Object.values(read().entries).flatMap(entry=>entry.phase==='ai_ready'&&
      project(entry.projectId).directory===entry.workspace
      ? (entry.returnedUnknownDispositions||[]).filter(item=>item.workspace===entry.workspace).map(item=>structuredClone(item)) : []);
  }
  async function stopAndGrant(projectId, token) {
    const entry = currentStopping(projectId, token);
    try {
      if (typeof quiesce !== 'function' || typeof inspectWriters !== 'function'||(entry.mode==='existing'||entry.sessionRefs?.length)&&typeof inspectExisting!=='function') throw new Error('进程核验能力不可用');
      // Recovery from a previous human phase must also close its old input path.
      if (entry.baseline) await sealHuman({ projectId, token, reason: 'takeover-recovery' });
      currentStopping(projectId, token);
      const consent=entry.unknownDispositionConsent;
      const stopped=await quiesce({ projectId, workspace: entry.workspace,
        ...(consent?{unknownDispositionConsent:{id:consent.id,projectId}}:{}) });
      const owned = proof(stopped, '受管执行器');
      const dispositions=stopped.dispositions||[];
      if(!Array.isArray(dispositions)||dispositions.length>16||dispositions.some(item=>
        !consent||item.id!==consent.id||!consent.commands.some(selected=>selected.taskId===item.taskId&&selected.commandId===item.commandId)))
        fail('旧轮次处理收据与本次确认不符','CONTROL_STALE');
      if(dispositions.length)mutate(image=>{
        const current=image.entries[projectId];
        if(current?.token!==token||current.phase!=='stopping')fail('接管代次已变化','CONTROL_STALE');
        current.disposedUnknownCommands=dispositions.map(item=>({id:item.id,taskId:item.taskId,commandId:item.commandId}));
      });
      currentStopping(projectId, token);
      const writers = entry.mode==='existing'||entry.sessionRefs?.length
        ? existingProof(await inspectExisting({projectId,workspace:entry.workspace,profileId:entry.profileId,
            sessionRefs:entry.sessionRefs,previousEvidence:entry.sessionEvidence||null}))
        : proof(await inspectWriters({ projectId, workspace: entry.workspace }), '其他写入者');
      currentStopping(projectId, token);
      const baseline = await snapshot(entry.workspace);
      if(consent?.token===token)dispositionAuthorizers.get(consent.id)?.();
      return mutate(image => {
        const current = image.entries[projectId];
        if (current?.token !== token || current.phase !== 'stopping') fail('接管代次已变化', 'CONTROL_STALE');
        current.phase = 'human'; current.since = stamp(); current.reason = null;
        delete current.parkedHandoffOrigin;
        // A recovered handoff must retain the snapshot from before the first
        // human edit, including edits made before app restart or device loss.
        current.baseline ||= baseline; current.snapshotScope = current.baseline.snapshotScope || 'legacy-unspecified';
        if(writers.sessionEvidence)current.sessionEvidence=writers.sessionEvidence;
        current.evidence = { owned, writers };
        return { ...publicEntry(current), token };
      });
    } catch (error) {
      mutate(image => { const current = image.entries[projectId]; if (current?.token === token && current.phase === 'stopping') {
        current.phase = 'unknown'; current.reason = error.message || String(error); current.since = stamp();
      } });
      return publicEntry(read().entries[projectId]);
    }
  }
  async function acquire({ projectId, actorId, profileId, endUnknownCommands, authorize }) {
    if (typeof actorId !== 'string' || !actorId.trim() || actorId.length > 200) fail('接管身份无效');
    if(endUnknownCommands!==undefined&&(!Array.isArray(endUnknownCommands)||!endUnknownCommands.length||endUnknownCommands.length>16||
      endUnknownCommands.some(item=>!item||Object.keys(item).some(key=>!['taskId','commandId'].includes(key))||
        typeof item.taskId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(item.taskId)||
        typeof item.commandId!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/.test(item.commandId))||
      new Set(endUnknownCommands.map(item=>JSON.stringify([item.taskId,item.commandId]))).size!==endUnknownCommands.length||
      typeof profileId!=='string'||!profileId||typeof authorize!=='function'))fail('请选择当前需要结束的旧轮次','CONTROL_STALE');
    const p = project(projectId);
    const token = randomBytes(32).toString('hex');
    const consentId=endUnknownCommands?randomUUID():null;
    if(consentId)authorize();
    mutate(image => {
      // Check the persistent Git-operation fence in the same transaction that
      // takes control. Saving a review version must not race a new human writer.
      beforeAcquire(projectId);
      for (const entry of Object.values(image.entries)) if (entry.phase !== 'ai_ready' && overlaps(entry.workspace, p.directory)) fail('此工作区已有控制权或未知现场', 'CONTROL_BUSY');
      const previous = image.entries[projectId];
      if(consentId&&previous?.sessionRefs?.length&&previous.profileId!==profileId)
        fail('原终端配置已变化','CONTROL_STALE');
      image.entries[projectId] = { projectId, workspace: p.directory, actorId, token,
        ...(profileId?{profileId}:{}),
        mode:'managed',phase: 'stopping', generation: (previous?.generation || 0) + 1, since: stamp(), reason: null,
        ...(previous?.workspace===p.directory&&previous.returnedUnknownDispositions
          ?{returnedUnknownDispositions:previous.returnedUnknownDispositions}:{}),
        ...(consentId?{unknownDispositionConsent:{version:1,id:consentId,projectId,workspace:p.directory,profileId,actorId,token,
          generation:(previous?.generation||0)+1,commands:structuredClone(endUnknownCommands),createdAt:stamp()}}:{}),
        ...(previous?.phase === 'ai_ready' && completeManagedEvidence(previous) && parkedReturnEvidence(previous) &&
          previous.workspace === p.directory ? { parkedHandoffOrigin: {
            generation: previous.generation, workspace: previous.workspace, profileId: previous.profileId,
            sessionRefs: previous.sessionRefs, sessionEvidenceDigest: evidenceDigest(previous) } } : {}),
        ...(previous?.phase==='ai_ready'&&previous.mode==='managed'&&previous.workspace===p.directory&&previous.sessionRefs?.length
          ?{profileId:previous.profileId,sessionRefs:previous.sessionRefs,sessionEvidence:previous.sessionEvidence}:{} ) };
    });
    if(consentId)dispositionAuthorizers.set(consentId,authorize);
    try{return await stopAndGrant(projectId, token);}
    finally{if(consentId)dispositionAuthorizers.delete(consentId);}
  }
  async function acquireExisting({projectId,actorId,profileId,sessionRefs,trustedOwner=false}){
    if(typeof actorId!=='string'||!actorId.trim()||actorId.length>200||typeof profileId!=='string'||!profileId)fail('接管身份无效');
    const refs=selectedRefs(sessionRefs),p=project(projectId),token=randomBytes(32).toString('hex');
    mutate(image=>{
      beforeAcquire(projectId);
      for(const entry of Object.values(image.entries))if(entry.projectId!==projectId&&entry.phase!=='ai_ready'&&overlaps(entry.workspace,p.directory))fail('此工作区已有控制权','CONTROL_BUSY');
      const previous=image.entries[projectId];
      if(previous&&previous.phase!=='ai_ready'&&!(previous.phase==='unknown'&&(previous.actorId===actorId||trustedOwner===true)))fail('已有控制权尚未交还','CONTROL_BUSY');
      image.entries[projectId]={projectId,workspace:p.directory,actorId,token,profileId,sessionRefs:refs,mode:'existing',
        phase:'stopping',generation:(previous?.generation||0)+1,since:stamp(),reason:null,
        ...(previous?.workspace===p.directory&&previous.returnedUnknownDispositions
          ?{returnedUnknownDispositions:previous.returnedUnknownDispositions}:{}),
        ...(previous?.baseline?{baseline:previous.baseline}:{}),
        ...(previous?.mode==='existing'&&previous?.sessionEvidence?{sessionEvidence:previous.sessionEvidence}:{})};
    });
    return stopAndGrant(projectId,token);
  }
  /** Recover a fully retired managed client without releasing the persistent AI fence. */
  async function reclaimManaged({projectId,actorId,token,profileId,sessionRef=null}){
    if(typeof actorId!=='string'||!actorId.trim()||actorId.length>200)fail('接管身份无效');
    const selected=sessionRef===null?null:selectedRefs([sessionRef]);
    if(selected&&typeof profileId!=='string')fail('终端配置无效','CONTROL_STALE');
    const nextToken=randomBytes(32).toString('hex');
    mutate(image=>{
      const entry=image.entries[projectId];
      if(!entry||entry.phase!=='human'||entry.mode!=='managed'||entry.actorId!==actorId||entry.token!==token||
        project(projectId).directory!==entry.workspace)fail('原受管控制权已变化','CONTROL_STALE');
      if(selected&&(entry.profileId!==profileId||!entry.sessionRefs?.some(ref=>sameRef(ref,selected[0]))))
        fail('原受管会话未获授权','SESSION_NOT_AUTHORIZED');
      entry.phase='stopping';entry.token=nextToken;entry.generation++;entry.since=stamp();entry.reason=null;
      delete entry.parkedHandoffOrigin;
    });
    return stopAndGrant(projectId,nextToken);
  }
  /** A retired client's explicit selection may discard only proved-ended managed refs. */
  async function reclaimManagedSelection({projectId,actorId,token,profileId,sessionRef,liveSessionRefs}){
    if(typeof actorId!=='string'||!actorId.trim()||actorId.length>200||typeof profileId!=='string'||!profileId)
      fail('接管身份无效');
    const selected=selectedRefs([sessionRef])[0],live=selectedRefs(liveSessionRefs);
    if(!live.some(ref=>sameRef(ref,selected)))fail('所选会话已结束','SESSION_NOT_AUTHORIZED');
    const nextToken=randomBytes(32).toString('hex');
    let previous,retired,generation;
    mutate(image=>{
      const entry=image.entries[projectId];
      if(!entry||entry.phase!=='human'||entry.mode!=='managed'||entry.actorId!==actorId||entry.token!==token||
        entry.profileId!==profileId||project(projectId).directory!==entry.workspace)
        fail('原受管控制权已变化','CONTROL_STALE');
      if(!entry.sessionRefs?.some(ref=>sameRef(ref,selected))||
        live.some(ref=>!entry.sessionRefs.some(authorized=>sameRef(authorized,ref))))
        fail('原受管会话未获授权','SESSION_NOT_AUTHORIZED');
      if(!Array.isArray(entry.sessionEvidence)||
        entry.sessionRefs.some(ref=>!entry.sessionEvidence.some(item=>sameRef(item.sessionRef,ref))))
        fail('原会话缺少完整进程证据','PROCESS_PROOF_UNAVAILABLE');
      previous=entry.sessionEvidence;
      retired=entry.sessionRefs.filter(ref=>!live.some(item=>sameRef(item,ref)));
      generation=entry.generation+1;
      entry.phase='stopping';entry.token=nextToken;entry.generation=generation;entry.since=stamp();entry.reason=null;
      delete entry.parkedHandoffOrigin;
    });
    try{
      if(typeof inspectExisting!=='function')throw new Error('会话进程核验不可用');
      const entry=read().entries[projectId];
      const result=existingProof(await inspectExisting({projectId,workspace:entry.workspace,profileId,
        sessionRefs:live,retiredSessionRefs:retired,previousEvidence:previous}));
      if(retired.length&&(!Array.isArray(result.retiredSessionRefs)||
        retired.some(ref=>!result.retiredSessionRefs.some(item=>sameRef(item,ref)))))
        throw new Error('已结束会话身份未获核实');
      mutate(image=>{const current=image.entries[projectId];
        if(current?.phase!=='stopping'||current.token!==nextToken||current.generation!==generation)
          fail('控制代次已变化','CONTROL_STALE');
        current.sessionRefs=live;current.sessionEvidence=result.sessionEvidence;
        delete current.parkedHandoffOrigin;
      });
      return stopAndGrant(projectId,nextToken);
    }catch(error){
      mutate(image=>{const current=image.entries[projectId];
        if(current?.phase==='stopping'&&current.token===nextToken&&current.generation===generation){
          current.phase='unknown';current.reason=error.message||String(error);current.since=stamp();
        }
      });
      return publicEntry(read().entries[projectId]);
    }
  }
  async function extendExisting({projectId,token,sessionRefs}){
    assertHuman({projectId,token});
    const added=selectedRefs(sessionRefs),nextToken=randomBytes(32).toString('hex');
    mutate(image=>{const entry=image.entries[projectId];
      if(entry?.phase!=='human'||entry.token!==token||entry.mode!=='existing')fail('已有会话控制权无效','CONTROL_STALE');
      if(added.some(ref=>ref.serverName!==entry.sessionRefs[0].serverName||ref.instanceId!==entry.sessionRefs[0].instanceId))fail('会话不属于同一 tmux server','INVALID_SESSION_REF');
      const union=[...entry.sessionRefs];for(const ref of added)if(!union.some(existing=>sameRef(existing,ref)))union.push(ref);
      entry.sessionRefs=selectedRefs(union);entry.phase='stopping';entry.token=nextToken;entry.generation++;entry.since=stamp();entry.reason=null;
    });
    return stopAndGrant(projectId,nextToken);
  }
  async function observeReturn(projectId, token, {verifyOwned=false}={}) {
      let entry=read().entries[projectId];
      if(entry?.token!==token||entry.phase!=='return_check')fail('交还代次已变化','CONTROL_STALE');
      const generation=entry.generation;
      if(entry.mode==='managed'&&entry.sessionRefs?.length){
        await parkManaged({projectId,token,generation,workspace:entry.workspace,
          profileId:entry.profileId,sessionRefs:entry.sessionRefs});
        assertReturn({projectId,token,generation});
      }
      await sealHuman({ projectId, token });
      const currentReturn=()=>{const current=read().entries[projectId];
        if(current?.token!==token||current.phase!=='return_check')fail('交还代次已变化','CONTROL_STALE');
        return current;};
      entry=currentReturn();
      if(verifyOwned){
        if(typeof quiesce!=='function')throw new Error('受管执行器核验能力不可用');
        proof(await quiesce({projectId,workspace:entry.workspace}),'受管执行器');
        entry=currentReturn();
      }
      if (typeof inspectWriters !== 'function') throw new Error('写入进程核验能力不可用');
      const writers = proof(await inspectWriters({ projectId, workspace: entry.workspace,
        parked:entry.mode==='managed'&&!!entry.sessionRefs?.length,
        profileId:entry.profileId,sessionRefs:entry.sessionRefs||[],token,generation }), '交还现场');
      currentReturn();
      const after = await snapshot(entry.workspace);
      currentReturn();
      if(typeof inspectDirectories!=='function')throw new Error('会话实际当前目录核验能力不可用');
      const directories=reviewDirectories(await inspectDirectories({projectId,workspace:entry.workspace,
        profileId:entry.profileId,sessionRefs:entry.sessionRefs||[],previousEvidence:entry.sessionEvidence||[],token,generation}),entry);
      entry=currentReturn();
      // Directory inspection can be slow. The last asynchronous operation is
      // a fresh complete writer proof; the binding and durable phase change
      // below have no await between that proof and their final identity guard.
      const second=proof(await inspectWriters({projectId,workspace:entry.workspace,
        parked:entry.mode==='managed'&&!!entry.sessionRefs?.length,
        profileId:entry.profileId,sessionRefs:entry.sessionRefs||[],token,generation}),'交还现场');
      if(second.scope!==writers.scope)throw new Error('交还现场核验范围已变化');
      entry=currentReturn();
      if (entry.baseline.snapshotScope && after.snapshotScope !== entry.baseline.snapshotScope) throw new Error('工作区快照覆盖范围已变化，无法确认交还差异');
      const changed = changes(entry.baseline, after);
      const binding={projectId,workspace:entry.workspace,mode:entry.mode,profileId:entry.profileId,
        sessionRefs:entry.sessionRefs||[],sessionEvidenceDigest:Array.isArray(entry.sessionEvidence)?evidenceDigest(entry):null,
        generation,actorId:entry.actorId,writerScope:writers.scope,snapshotScope:after.snapshotScope,
        files:after.files,changes:changed,directories};
      return {writers,after,changed,directories,bindingDigest:reviewDigest(binding),generation};
  }
  async function prepareReturn(projectId,token,{verifyOwned=false}={}){
    try{
      const observed=await observeReturn(projectId,token,{verifyOwned});
      return mutate(image=>{
        const current = image.entries[projectId];
        if(current?.token!==token||current.phase!=='return_check'||current.generation!==observed.generation||
          project(projectId).directory!==current.workspace)fail('交还代次已变化','CONTROL_STALE');
        const reviewId=randomBytes(32).toString('hex'),expiresAt=now()+REVIEW_MS;
        const displayed=observed.changed.filter(item=>safeReviewPath(item.path)).slice(0,80).map(({path,kind})=>({path,kind}));
        current.returnReview={version:1,id:reviewId,expiresAt,bindingDigest:observed.bindingDigest,
          public:{reviewId,expiresAt,generation:current.generation,workspaceRelativeDirectories:observed.directories,
            changes:displayed,totalChanges:observed.changed.length,omittedChanges:observed.changed.length-displayed.length,
            snapshotScope:observed.after.snapshotScope,parkedManagedSessions:current.mode==='managed'?current.sessionRefs?.length||0:0,
            unownedWorkspaceWriters:0,notes:current.notes||''}};
        current.phase='return_review';current.since=stamp();current.reason=null;
        return {...publicEntry(current),token:current.token};
      });
    }catch(error){
      mutate(image=>{const current=image.entries[projectId];if(current?.token===token&&current.phase==='return_check'){
        current.phase='unknown';current.reason=error.message||String(error);current.since=stamp();delete current.returnReview;
      }});
      return publicEntry(read().entries[projectId]);
    }
  }
  async function confirmReturn({projectId,token,actorId,profileId,reviewId,expectedGeneration,authorize=()=>{}}){
    if(typeof reviewId!=='string'||!/^[a-f0-9]{64}$/.test(reviewId)||
      !Number.isSafeInteger(expectedGeneration)||expectedGeneration<1)fail('交还核对请求无效','CONTROL_STALE');
    const initial=read().entries[projectId];
    if(initial?.phase!=='return_review'||initial.token!==token||initial.actorId!==actorId||initial.profileId!==profileId||
      initial.generation!==expectedGeneration||initial.returnReview?.id!==reviewId||
      initial.returnReview.version!==1)fail('交还核对已失效','CONTROL_STALE');
    if(now()>=initial.returnReview.expiresAt) {
      mutate(image=>{const current=image.entries[projectId];if(current?.phase==='return_review'&&
        current.token===token&&current.returnReview?.id===reviewId){current.phase='unknown';current.reason='交还核对已过期';
          current.since=stamp();delete current.returnReview;}});
      fail('交还核对已过期','CONTROL_STALE');
    }
    // Durable freeze remains in force while the second independent observation runs.
    mutate(image=>{const current=image.entries[projectId];if(current?.phase!=='return_review'||current.token!==token||
      current.actorId!==actorId||current.generation!==expectedGeneration||current.returnReview?.id!==reviewId)
      fail('交还核对已失效','CONTROL_STALE');current.phase='return_check';current.since=stamp();});
    try{
      const observed=await observeReturn(projectId,token);
      authorize();
      return mutate(image=>{
        const current=image.entries[projectId],review=current?.returnReview;
        if(current?.phase!=='return_check'||current.token!==token||current.actorId!==actorId||current.profileId!==profileId||
          current.generation!==expectedGeneration||review?.id!==reviewId||now()>=review.expiresAt||
          review.bindingDigest!==observed.bindingDigest||project(projectId).directory!==current.workspace)
          fail('交还核对现场已变化','CONTROL_STALE');
        current.phase='ai_ready';current.since=stamp();current.reason=null;
        delete current.parkedHandoffOrigin;
        current.changes=observed.changed;current.returnEvidence=observed.writers;current.after=observed.after;
        const consent=current.unknownDispositionConsent;
        if(consent&&current.disposedUnknownCommands?.length){
          const history=current.returnedUnknownDispositions||[];
          for(const item of current.disposedUnknownCommands)if(!history.some(old=>old.id===item.id&&old.taskId===item.taskId&&old.commandId===item.commandId))
            history.push({...item,projectId,workspace:current.workspace,profileId:consent.profileId,actorId:consent.actorId,
              controlGeneration:consent.generation,returnedGeneration:current.generation,returnedAt:current.since});
          current.returnedUnknownDispositions=history;
        }
        if(completeManagedEvidence(current)&&observed.writers.scope===PARKED_SCOPE)
          current.managedParkedReturn={version:1,generation:current.generation,workspace:current.workspace,
            profileId:current.profileId,sessionEvidenceDigest:evidenceDigest(current),scope:observed.writers.scope};
        else delete current.managedParkedReturn;
        delete current.token;delete current.baseline;delete current.returnReview;
        return {...publicEntry(current),notes:current.notes};
      });
    }catch(error){
      mutate(image=>{const current=image.entries[projectId];if(current?.phase==='return_check'&&
        current.token===token&&current.returnReview?.id===reviewId){
        current.phase='unknown';current.reason=error.message||String(error);current.since=stamp();delete current.returnReview;
      }});
      return publicEntry(read().entries[projectId]);
    }
  }
  function cancelReturn({projectId,token,actorId,profileId,reviewId,expectedGeneration}){
    return mutate(image=>{const current=image.entries[projectId];if(current?.phase!=='return_review'||
      current.token!==token||current.actorId!==actorId||current.profileId!==profileId||current.generation!==expectedGeneration||
      current.returnReview?.id!==reviewId)fail('交还核对已失效','CONTROL_STALE');
      current.phase='unknown';current.reason='本次交还已取消，需重新核对控制权和现场';
      current.since=stamp();delete current.returnReview;return publicEntry(current);
    });
  }
  function invalidateReturnReview({projectId,token,generation,reason='交还连接已断开，需重新核对'}){
    return mutate(image=>{const current=image.entries[projectId];
      if(current?.token!==token||current.generation!==generation||
        !['return_check','return_review'].includes(current.phase))return publicEntry(current);
      current.phase='unknown';current.reason=reason;current.since=stamp();delete current.returnReview;
      return publicEntry(current);
    });
  }
  async function release({ projectId, token, profileId, notes = '' }) {
    assertHuman({ projectId, token });
    if (typeof notes !== 'string' || notes.length > 2000) fail('交还说明过长');
    mutate(image => { const entry = image.entries[projectId]; if (entry.token !== token || entry.phase !== 'human') fail('控制代次已变化', 'CONTROL_STALE');
      if(profileId!==undefined){if(entry.profileId&&entry.profileId!==profileId)fail('交还终端配置已变化','CONTROL_STALE');
        if(entry.mode==='managed'&&!entry.profileId)entry.profileId=profileId;}
      entry.phase = 'return_check'; entry.since = stamp(); entry.notes = notes;
    });
    return prepareReturn(projectId, token);
  }
  async function reconcile({ projectId, actorId, token, action = 'acquire', trustedOwner = false, managedSelection = null, profileId = undefined }) {
    const entry = read().entries[projectId];
    if (typeof actorId !== 'string' || !actorId.trim() || actorId.length > 200) fail('接管身份无效');
    const ownerRecovery = trustedOwner === true && action === 'acquire' && ['human', 'unknown'].includes(entry?.phase);
    const ownerReturn = trustedOwner === true && action === 'release' && ['human','unknown'].includes(entry?.phase) && !!entry.baseline;
    if (!entry || (!ownerRecovery && !ownerReturn && (entry.phase !== 'unknown' || entry.actorId !== actorId))) fail('没有可核对的控制权', 'CONTROL_STALE');
    if (project(projectId).directory !== entry.workspace) fail('项目目录已变化', 'CONTROL_WORKSPACE_CHANGED');
    if (action === 'acquire') {
      let surviving = null, retired = null, selected = null;
      if (ownerRecovery && entry.mode === 'managed' && managedSelection) {
        if (managedSelection.profileId !== entry.profileId || !Array.isArray(managedSelection.availableSessionRefs) ||
          managedSelection.availableSessionRefs.length > 256 || !Array.isArray(entry.sessionRefs) ||
          !entry.sessionRefs.length || !Array.isArray(entry.sessionEvidence) ||
          entry.sessionRefs.some(ref => !entry.sessionEvidence.some(item => sameRef(item.sessionRef, ref))))
          fail('原受管会话缺少完整身份或进程证据', 'PROCESS_PROOF_UNAVAILABLE');
        const available = managedSelection.availableSessionRefs.map(ref => selectedRefs([ref])[0]);
        if (new Set(available.map(ref => JSON.stringify(ref))).size !== available.length)
          fail('受管会话列表重复', 'PROCESS_PROOF_UNAVAILABLE');
        surviving = entry.sessionRefs.filter(ref => available.some(item => sameRef(item, ref)));
        retired = entry.sessionRefs.filter(ref => !surviving.some(item => sameRef(item, ref)));
        selected = managedSelection.sessionRef == null
          ? surviving.length === 1 ? surviving[0] : null
          : selectedRefs([managedSelection.sessionRef])[0];
        if (!selected || !surviving.some(ref => sameRef(ref, selected)))
          fail('请选择仍存在的原授权会话', 'SESSION_NOT_AUTHORIZED');
      }
      const nextToken = randomBytes(32).toString('hex');
      const nextGeneration = entry.generation + 1;
      mutate(image => { const current = image.entries[projectId];
        if (!current || (ownerRecovery
          ? !['human', 'unknown'].includes(current.phase) || current.token !== entry.token || current.generation !== entry.generation
          : current.phase !== 'unknown' || current.actorId !== actorId || current.token !== entry.token || current.generation !== entry.generation)) fail('控制代次已变化', 'CONTROL_STALE');
        const preserveOrigin = current.phase === 'unknown' &&
          completeManagedEvidence(current) && current.parkedHandoffOrigin &&
          Number.isSafeInteger(current.parkedHandoffOrigin.generation) &&
          current.generation > current.parkedHandoffOrigin.generation &&
          current.parkedHandoffOrigin.workspace === current.workspace &&
          current.parkedHandoffOrigin.profileId === current.profileId &&
          current.parkedHandoffOrigin.sessionEvidenceDigest === evidenceDigest(current) &&
          current.parkedHandoffOrigin.sessionRefs?.length === current.sessionRefs.length &&
          current.parkedHandoffOrigin.sessionRefs.every(ref => current.sessionRefs.some(item => sameRef(item,ref)));
        if (!preserveOrigin) delete current.parkedHandoffOrigin;
        current.phase = 'stopping'; current.actorId = actorId; current.token = nextToken; current.generation++; current.since = stamp(); current.reason = null;
      });
      if (retired?.length) {
        try {
          if (typeof inspectExisting !== 'function') throw new Error('受管会话进程核验不可用');
          const result = existingProof(await inspectExisting({ projectId, workspace: entry.workspace,
            profileId: entry.profileId, sessionRefs: surviving, retiredSessionRefs: retired,
            previousEvidence: entry.sessionEvidence }));
          if (!Array.isArray(result.retiredSessionRefs) ||
            retired.some(ref => !result.retiredSessionRefs.some(item => sameRef(item, ref))) ||
            result.sessionEvidence.length !== surviving.length ||
            surviving.some(ref => !result.sessionEvidence.some(item => sameRef(item.sessionRef, ref))))
            throw new Error('已结束会话或幸存会话身份未获核实');
          mutate(image => { const current = image.entries[projectId];
            if (!current || current.phase !== 'stopping' || current.token !== nextToken ||
              current.generation !== nextGeneration) fail('控制代次已变化', 'CONTROL_STALE');
            current.sessionRefs = surviving; current.sessionEvidence = result.sessionEvidence;
            delete current.parkedHandoffOrigin;
          });
        } catch (error) {
          mutate(image => { const current = image.entries[projectId];
            if (current?.phase === 'stopping' && current.token === nextToken && current.generation === nextGeneration) {
              current.phase = 'unknown'; current.reason = error.message || String(error); current.since = stamp();
            }
          });
          return publicEntry(read().entries[projectId]);
        }
      }
      return stopAndGrant(projectId, nextToken);
    }
    if(ownerReturn){
      const nextToken=randomBytes(32).toString('hex');
      mutate(image=>{const current=image.entries[projectId];
        if(!current||!['human','unknown'].includes(current.phase)||current.token!==entry.token||current.generation!==entry.generation||!current.baseline)
          fail('控制代次已变化','CONTROL_STALE');
        current.phase='return_check';current.actorId=actorId;current.token=nextToken;current.generation++;
        if(profileId!==undefined){if(current.profileId&&current.profileId!==profileId)fail('交还终端配置已变化','CONTROL_STALE');
          if(current.mode==='managed'&&!current.profileId)current.profileId=profileId;}
        current.since=stamp();current.reason=null;delete current.parkedHandoffOrigin;
      });
      return prepareReturn(projectId,nextToken,{verifyOwned:true});
    }
    if (action === 'release' && token === entry.token && entry.baseline) {
      mutate(image => { const current = image.entries[projectId]; if (current?.phase !== 'unknown' || current.token !== token) fail('控制代次已变化', 'CONTROL_STALE');
        if(profileId!==undefined){if(current.profileId&&current.profileId!==profileId)fail('交还终端配置已变化','CONTROL_STALE');
          if(current.mode==='managed'&&!current.profileId)current.profileId=profileId;}
        current.phase = 'return_check'; current.since = stamp(); current.reason = null;
        delete current.parkedHandoffOrigin;
      });
      return prepareReturn(projectId, token);
    }
    fail('核对操作或控制凭据无效', 'CONTROL_STALE');
  }
  /** Move an existing human fence between authenticated connections, never via ai_ready. */
  function beginTransfer({projectId,token,actorId,targetActorId,targetConnectionId,profileId,expectedGeneration,transferId,expiresAt}){
    if(![actorId,targetActorId,targetConnectionId,profileId,transferId].every(value=>typeof value==='string'&&value.length>0&&value.length<=200)||
      !Number.isSafeInteger(expectedGeneration)||expectedGeneration<1||expectedGeneration>=Number.MAX_SAFE_INTEGER||
      !Number.isSafeInteger(expiresAt)||expiresAt<=now()||expiresAt>now()+60_000)
      fail('控制权转移请求无效','CONTROL_STALE');
    return mutate(image=>{
      const entry=image.entries[projectId];
      if(!entry||entry.phase!=='human'||entry.token!==token||entry.actorId!==actorId||
        entry.profileId!==profileId||entry.generation!==expectedGeneration||
        project(projectId).directory!==entry.workspace||!entry.sessionRefs?.length)
        fail('人工控制权或会话身份已变化','CONTROL_STALE');
      entry.phase='transfer_pending';entry.token=randomBytes(32).toString('hex');entry.generation++;
      entry.since=stamp();entry.reason=null;delete entry.parkedHandoffOrigin;
      entry.transfer={id:transferId,targetActorId,targetConnectionId,profileId,expiresAt};
      return publicEntry(entry);
    });
  }
  function acceptTransfer({projectId,transferId,targetActorId,targetConnectionId,profileId}){
    return mutate(image=>{
      const entry=image.entries[projectId],pending=entry?.transfer;
      if(entry?.phase!=='transfer_pending'||!pending||pending.id!==transferId||
        pending.targetActorId!==targetActorId||pending.targetConnectionId!==targetConnectionId||
        pending.profileId!==profileId||project(projectId).directory!==entry.workspace)
        fail('控制权转移已失效','CONTROL_STALE');
      if(now()>=pending.expiresAt){entry.phase='unknown';entry.reason='控制权转移确认已过期';delete entry.transfer;return publicEntry(entry);}
      entry.actorId=targetActorId;entry.phase='human';entry.since=stamp();entry.reason=null;
      delete entry.parkedHandoffOrigin;
      delete entry.transfer;
      return {...publicEntry(entry),token:entry.token};
    });
  }
  function failTransfer({projectId,transferId,reason='控制权转移未完成'}){
    return mutate(image=>{
      const entry=image.entries[projectId];
      if(entry?.phase!=='transfer_pending'||entry.transfer?.id!==transferId)return publicEntry(entry);
      entry.phase='unknown';entry.reason=String(reason).slice(0,240);entry.since=stamp();
      delete entry.transfer;
      return publicEntry(entry);
    });
  }
  // A recovered human or transition state has no valid live input connection.
  mutate(image => { for (const entry of Object.values(image.entries)) if (['stopping', 'human', 'return_check', 'return_review','transfer_pending'].includes(entry.phase)) {
    entry.phase = 'unknown'; entry.reason = '应用重启后需重新核对控制权与进程'; entry.since = stamp();delete entry.transfer;delete entry.returnReview;
  } });
  return { acquire, acquireExisting, reclaimManaged, reclaimManagedSelection, registerManagedSession, extendExisting, release, reconcile,confirmReturn,cancelReturn,invalidateReturnReview,
    beginTransfer,acceptTransfer,failTransfer,assertMayStart, assertHuman, assertReturn, assertExistingSession, assertManagedSession,
    verifyExistingSession, verifyManagedSession, markManagedUnknown, hasManagedSessionRefs, state, handoffForProject,
    retirementHandoff,unknownDispositionConsent,authorizeUnknownDisposition,returnedUnknownDispositions };
}
