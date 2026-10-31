import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

const inTree = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const TRACEFS = '/sys/kernel/debug/tracing';
/** lsof's Linux -e uses mount paths. Only exempt the inaccessible tracefs when
 * neither it nor another mount of the same filesystem overlaps the workspace. */
export function linuxTracefsExclusion(root, mountinfo) {
  const mounts = mountinfo.trim().split('\n').map(line => {
    const fields = line.split(' '), separator = fields.indexOf('-');
    if (separator < 6 || fields.length !== separator + 4 || !/^\d+:\d+$/.test(fields[2]) ||
        !fields[4]?.startsWith('/') || /\\(?!040|011|012|134)/.test(fields[4]))
      throw new Error('Linux mount information is incomplete');
    return { device: fields[2], path: fields[4].replace(/\\(040|011|012|134)/g,
      (_, octal) => String.fromCharCode(parseInt(octal, 8))), type: fields[separator + 1] };
  });
  const targets = mounts.filter(mount => mount.path === TRACEFS);
  if (targets.length !== 1 || targets[0].type !== 'tracefs' || mounts.some(mount =>
      mount.device === targets[0].device && (inTree(root, mount.path) || inTree(mount.path, root))))
    return [];
  return ['-e', TRACEFS];
}

/** Parse lsof's NUL-delimited field output; cwd and write-capable FDs are possible writers. */
export function parseLsofWorkspace(output, root, ignorePids = [], { selectedByDirectory = false } = {}) {
  const ignored = new Set(ignorePids);
  const writers = [];
  let pid = null, command = '', file = null, fileCount = 0;
  const flush = () => {
    if (!file) return;
    if (selectedByDirectory && (!Number.isSafeInteger(pid) || pid < 1 || !file.fd || !file.name))
      throw new Error('Incomplete selected lsof file record');
    if (!Number.isInteger(pid) || ignored.has(pid)) return;
    const path = file.name;
    // When our own lsof invocation uses +D, it already selected these files by
    // directory membership. Its printed name may escape Unicode/control bytes,
    // so a second string-prefix filter would silently drop real writers. Names
    // remain display-only: never unescape them into paths for filesystem access.
    if (!selectedByDirectory && (!path || !isAbsolute(path) || !inTree(root, path))) return;
    const cwd = file.fd === 'cwd';
    if (selectedByDirectory && !cwd && !['r', 'w', 'u'].includes(file.access))
      throw new Error('Selected file access mode is unknown');
    const writable = file.access === 'w' || file.access === 'u';
    if (cwd || writable) writers.push({ pid, command, reason: cwd ? 'cwd' : 'write_handle', path });
  };
  for (const part of output.toString('utf8').split('\0')) {
    const field = part.replace(/^\n+/, '');
    if (!field) continue;
    const value = field.slice(1);
    switch (field[0]) {
      case 'p':
        flush();
        if (selectedByDirectory && ((pid !== null && !fileCount) || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))))
          throw new Error('Invalid selected lsof process record');
        pid = Number(value); command = ''; file = null; fileCount = 0; break;
      case 'c': command = value.slice(0, 80); break;
      case 'f':
        flush();
        if (selectedByDirectory && (pid === null || !/^(?:\d+|cwd|rtd|txt|mem|DEL|pd|ltx)$/.test(value)))
          throw new Error('Invalid selected lsof descriptor');
        file = { fd: value, access: '', name: '' }; fileCount++; break;
      case 'a':
        if (selectedByDirectory && (!file || file.hasAccess)) throw new Error('Invalid selected lsof access field');
        if (file) { file.access = value.trim(); file.hasAccess = true; } break;
      case 'n':
        if (selectedByDirectory && (!file || file.hasName || !value)) throw new Error('Invalid selected lsof name field');
        if (file) { file.name = value; file.hasName = true; } break;
      default: if (selectedByDirectory) throw new Error('Unexpected selected lsof field');
    }
  }
  flush();
  if (selectedByDirectory && pid !== null && !fileCount) throw new Error('Missing selected lsof file record');
  return [...new Map(writers.map(item => [`${item.pid}:${item.path}:${item.reason}`, item])).values()];
}

/** Current user-visible open handles and cwd, not future or OS-wide exclusivity. */
export async function inspectWorkspaceWriters({ workspace, platform = process.platform, lsofPath = platform === 'linux' ? '/usr/bin/lsof' : '/usr/sbin/lsof', timeoutMs = 15_000, ignorePids = [process.pid] } = {}) {
  if (!['darwin', 'linux'].includes(platform)) return { verified: false, quiescent: false, unknown: true, livePids: [], scope: 'unsupported-platform', reason: 'Workspace process inspection is only implemented on macOS and Linux' };
  const system = platform === 'darwin' ? 'macos' : 'linux';
  let root;
  try { root = realpathSync(workspace); }
  catch (error) { return { verified: false, quiescent: false, unknown: true, livePids: [], scope: `${system}-lsof`, reason: error.message }; }
  let exemptions = [];
  if (platform === 'linux') {
    try { statSync(TRACEFS); }
    catch (error) {
      if (error.code === 'EACCES') {
        try { exemptions = linuxTracefsExclusion(root, readFileSync('/proc/self/mountinfo', 'utf8')); }
        catch (cause) { return { verified: false, quiescent: false, unknown: true, livePids: [], scope: 'linux-lsof', reason: cause.message }; }
      } else if (error.code !== 'ENOENT') {
        return { verified: false, quiescent: false, unknown: true, livePids: [], scope: 'linux-lsof', reason: error.message };
      }
    }
  }
  const outcome = await new Promise(resolve => {
    execFile(lsofPath, [...exemptions, '-nP', '-F0pfcna', '+D', root], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      ...(platform === 'linux' ? { cwd: '/' } : {}),
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  const { error, stdout, stderr } = outcome;
  if (stderr?.trim() || (error && error.code !== 1)) {
    return { verified: false, quiescent: false, unknown: true, livePids: [], scope: `${system}-lsof`, reason: String(error?.message || stderr || 'lsof failed') };
  }
  let writers;
  try { writers = parseLsofWorkspace(stdout || '', root, ignorePids, { selectedByDirectory: true }); }
  catch (cause) { return { verified: false, quiescent: false, unknown: true, livePids: [], scope: `${system}-lsof`, reason: cause.message }; }
  return { verified: true, quiescent: writers.length === 0, unknown: false,
    livePids: [...new Set(writers.map(item => item.pid))], writers,
    scope: `${system}-current-visible-cwd-and-write-handles`, checkedAt: new Date().toISOString() };
}

const sameRef=(a,b)=>a?.serverName===b?.serverName&&a?.instanceId===b?.instanceId&&a?.sessionId===b?.sessionId;
// lstart is a display field. Fix its locale and validate it before comparing;
// arbitrary/localized text must never count as proof that an old PID is gone.
export function canonicalPsStart(value){
  if(typeof value!=='string')return null;
  const normalized=value.trim().replace(/\s+/g,' ');
  return /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/.test(normalized)?normalized:null;
}
const evidenceKey=p=>`${p.paneId}:${p.pid}:${canonicalPsStart(p.startedAt)}`;

/** Mac process identities for tmux pane roots and their current descendants. */
export async function inspectSessionWriters({workspace,sessions,previousEvidence=null,platform=process.platform,psPath='/bin/ps',timeoutMs=15_000}={}){
  const scope='macos-tmux-pane-process-tree-and-current-lsof-writers';
  const unavailable=reason=>({verified:false,authorized:false,unknown:true,livePids:[],scope,reason});
  if(platform!=='darwin')return unavailable('tmux process provenance is only implemented on macOS');
  if(!Array.isArray(sessions)||!sessions.length||sessions.length>16||sessions.some(s=>!Array.isArray(s.panes)||!s.panes.length||s.panes.length>64))return unavailable('Invalid selected session panes');
  let processRows;
  const readProcesses=async()=>{
    const result=await new Promise(resolve=>execFile(psPath,['-axo','pid=,ppid=,lstart='],{timeout:timeoutMs,maxBuffer:4*1024*1024,env:{...process.env,LC_ALL:'C',LANG:'C'}},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
    if(result.error||result.stderr?.trim())throw new Error(result.error?.message||result.stderr||'ps failed');
    const rows=new Map();
    for(const line of result.stdout.split('\n')){
      if(!line.trim())continue;
      const match=/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      const pid=match&&Number(match[1]),ppid=match&&Number(match[2]),startedAt=match&&canonicalPsStart(match[3]);
      if(!match||!Number.isSafeInteger(pid)||pid<1||!Number.isSafeInteger(ppid)||ppid<0||!startedAt||rows.has(pid))throw new Error('Invalid ps process row');
      rows.set(pid,{pid,ppid,startedAt});
    }
    return rows;
  };
  try{processRows=await readProcesses();}catch(error){return unavailable(error.message);}
  const evidence=[];const roots=[];
  for(const session of sessions){
    const panes=[];
    for(const pane of session.panes){
      const row=processRows.get(pane.pid);
      if(!row||!/^%\d+$/.test(pane.paneId))return unavailable('A selected tmux pane process has disappeared');
      panes.push({paneId:pane.paneId,pid:pane.pid,startedAt:row.startedAt});roots.push(pane.pid);
    }
    panes.sort((a,b)=>a.paneId.localeCompare(b.paneId));
    const prior=previousEvidence?.find(item=>sameRef(item.sessionRef,session.sessionRef));
    if(prior && (!Array.isArray(prior.panes)||prior.panes.some(pane=>!canonicalPsStart(pane.startedAt))||prior.panes.map(evidenceKey).sort().join('|')!==panes.map(evidenceKey).sort().join('|')))
      return unavailable('A previously authorized tmux pane identity changed');
    evidence.push({sessionRef:session.sessionRef,panes});
  }
  const ownersFor=rows=>{
    const owners=new Map(roots.map(pid=>[pid,pid]));
    let changed=true;
    for(let pass=0;pass<rows.size&&changed;pass++){
      changed=false;
      for(const row of rows.values())if(!owners.has(row.pid)&&owners.has(row.ppid)){owners.set(row.pid,owners.get(row.ppid));changed=true;}
    }
    return owners;
  };
  const beforeOwners=ownersFor(processRows);
  const writers=await inspectWorkspaceWriters({workspace,platform});
  if(!writers.verified||writers.unknown)return unavailable(writers.reason||'lsof inspection failed');
  let after;
  try{after=await readProcesses();}catch(error){return unavailable(error.message);}
  for(const pid of new Set([...roots,...writers.livePids])){
    if(processRows.get(pid)?.startedAt!==after.get(pid)?.startedAt)return unavailable('Process identity changed during writer inspection');
  }
  const afterOwners=ownersFor(after);
  const unownedWriters=writers.writers.filter(item=>!beforeOwners.has(item.pid)||!afterOwners.has(item.pid));
  return {verified:true,authorized:unownedWriters.length===0,unknown:false,
    livePids:writers.livePids,writers:writers.writers,unownedWriters,sessionEvidence:evidence,
    scope,checkedAt:new Date().toISOString()};
}
