import { inspectWorkspaceWriters } from './process-inspection.mjs';

const SCOPE = 'linux-original-managed-pane-and-current-visible-workspace-writers';
const MAX_SELECTED = 128, MAX_DEPTH = 32;
const sameRef = (a,b) => a?.serverName === b?.serverName && a?.instanceId === b?.instanceId && a?.sessionId === b?.sessionId;
const sameRow = (a,b) => Boolean(a && b && a.kind === 'linux-proc' && b.kind === 'linux-proc' &&
  ['pid','ppid','pgid','euid','ruid','bootId','startTicks'].every(key => a[key] === b[key]));
const sameBirth = (a,b) => Boolean(a && b && a.kind === 'linux-proc' && b.kind === 'linux-proc' &&
  ['pid','pgid','euid','ruid','bootId','startTicks'].every(key => a[key] === b[key]));
const writerKeys = writers => writers.map(row => `${row.pid}:${row.reason}:${row.path}`).sort();
const unavailable = reason => ({verified:false,authorized:false,unknown:true,livePids:[],unownedWriters:[],scope:SCOPE,reason});

/** Current visible writers only. This does not prove retirement, absence of all
 * processes, or permission to return control to AI. */
export async function inspectLinuxManagedWriters({workspace,sessions,proofs,previousEvidence=null,selectedIdentities,
  inspectWriters=inspectWorkspaceWriters}={}) {
  if (!Array.isArray(sessions) || !sessions.length || sessions.length !== proofs?.length ||
      typeof selectedIdentities !== 'function') return unavailable('Managed session selection is incomplete');
  const roots = new Map(), shellRoots = new Set(), exactInfrastructure = new Set(), evidence = [];
  for (let index=0; index<sessions.length; index++) {
    const session=sessions[index], proof=proofs[index], relay=proof?.identities?.relay;
    if (!sameRef(session.sessionRef,proof?.sessionRef) || session.panes?.length !== 1 ||
        session.panes[0].paneId !== proof.relayPaneId || session.panes[0].pid !== proof.relayPanePid ||
        relay?.kind !== 'linux-proc' || relay.pid !== proof.relayPanePid)
      return unavailable('Original managed pane identity is incomplete');
    for (const row of [proof.identities.supervisor,proof.identities.shell,relay]) {
      if (row?.kind !== 'linux-proc' || !Number.isSafeInteger(row.pid) || row.pid < 2 ||
          roots.has(row.pid) && !sameBirth(roots.get(row.pid),row))
        return unavailable('Original managed process identity is incomplete');
      roots.set(row.pid,row);
    }
    shellRoots.add(proof.identities.shell.pid);
    exactInfrastructure.add(proof.identities.supervisor.pid);
    exactInfrastructure.add(relay.pid);
    const pane = {kind:'linux-proc',paneId:session.panes[0].paneId,pid:relay.pid,
      bootId:relay.bootId,startTicks:relay.startTicks};
    const prior=previousEvidence?.find(item=>sameRef(item.sessionRef,session.sessionRef));
    if (prior && (prior.panes?.length !== 1 || JSON.stringify(prior.panes[0]) !== JSON.stringify(pane)))
      return unavailable('Previously authorized managed pane changed');
    evidence.push({sessionRef:session.sessionRef,panes:[pane]});
  }
  if (roots.size > MAX_SELECTED) return unavailable('Managed process scope exceeds selected PID limit');

  try {
    const readSelected=async pids=>{
      const rows=new Map();
      for (let index=0; index<pids.length; index+=8)
        for (const [pid,row] of await selectedIdentities(pids.slice(index,index+8))) rows.set(pid,row);
      return rows;
    };
    const firstWriters=await inspectWriters({workspace,platform:'linux'});
    if (firstWriters?.verified !== true || firstWriters.unknown !== false || !Array.isArray(firstWriters.writers))
      return unavailable('Workspace writer inspection is incomplete');
    const selected=new Set(roots.keys());
    const chains=new Map(), discovered=new Map();
    for (const writer of firstWriters.writers) {
      if (!Number.isSafeInteger(writer.pid) || writer.pid < 2) return unavailable('Writer PID is invalid');
      const chain=[];let pid=writer.pid;
      while (pid > 1 && !chain.includes(pid)) {
        if (chain.length >= MAX_DEPTH || selected.size >= MAX_SELECTED && !selected.has(pid))
          return unavailable('Writer ancestry exceeds selected PID limit');
        selected.add(pid);
        const row=(await selectedIdentities([pid])).get(pid);
        if (!row || row.kind !== 'linux-proc') return unavailable('Writer ancestry is incomplete');
        discovered.set(pid,row);
        chain.push(pid);
        if (roots.has(pid)) break;
        pid=row.ppid;
      }
      chains.set(writer.pid,chain);
    }
    const pids=[...selected].sort((a,b)=>a-b);
    const before=await readSelected(pids);
    for (const [pid,row] of discovered) if (!sameRow(row,before.get(pid)))
      return unavailable('Writer ancestry changed during inspection');
    const secondWriters=await inspectWriters({workspace,platform:'linux'});
    if (secondWriters?.verified !== true || secondWriters.unknown !== false ||
        !Array.isArray(secondWriters.writers) || JSON.stringify(writerKeys(firstWriters.writers)) !== JSON.stringify(writerKeys(secondWriters.writers)))
      return unavailable('Workspace writer set changed during inspection');
    const after=await readSelected(pids);
    for (const pid of pids) if (!sameRow(before.get(pid),after.get(pid)))
      return unavailable('Selected process identity changed during inspection');
    for (const [pid,original] of roots) if (!sameBirth(before.get(pid),original))
      return unavailable('Original managed process identity changed');
    const unownedWriters=firstWriters.writers.filter(writer=>{
      const chain=chains.get(writer.pid);
      if (!chain?.some(pid=>shellRoots.has(pid)) && !exactInfrastructure.has(writer.pid)) return true;
      return chain.some((pid,index)=>index+1<chain.length && before.get(pid)?.ppid !== chain[index+1]);
    });
    return {verified:true,authorized:unownedWriters.length===0,unknown:false,
      livePids:[...new Set(firstWriters.writers.map(row=>row.pid))],writers:firstWriters.writers,
      unownedWriters,sessionEvidence:evidence,scope:SCOPE,checkedAt:new Date().toISOString()};
  } catch { return unavailable('Selected process or workspace writer identity is unconfirmed'); }
}
