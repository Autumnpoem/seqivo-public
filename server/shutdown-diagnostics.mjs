import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const MAX_PLUGIN_ROWS=64;
const STAGES=new Set(['core','http','ssh','terminal_seal','controlled_preview_builds','plugins','plugin','terminal','preview','conversations','remote','workflow','file_bridge','tick','active_requests']);
const STATUSES=new Set(['started','fulfilled','rejected']);
const CATEGORIES=new Set(['SHUTDOWN_UNCONFIRMED','PLUGIN_TIMEOUT','PLUGIN_UNAVAILABLE','UNKNOWN_RESULT','RPC_TOO_LARGE','UNCLASSIFIED']);

// One private record stream per sidecar process. Diagnostic failures never
// change the Core close result or its unsafe-lock decision.
export function createShutdownStageRecorder({dataDir,elapsedMs}) {
  const runId=randomUUID(),path=join(dataDir,'shutdown-stages.jsonl');
  let pluginRows=0,truncated=false;
  const append=record=>appendFileSync(path,JSON.stringify(record)+'\n',{mode:0o600});
  return event=>{try{
    if(!STAGES.has(event?.stage)||!STATUSES.has(event?.status))return;
    const elapsed=Math.max(0,Math.round(elapsedMs()));
    if(event.stage==='plugin'&&pluginRows>=MAX_PLUGIN_ROWS){
      if(!truncated){
        truncated=true;
        append({runId,stage:'plugin_diagnostics',status:'truncated',limit:MAX_PLUGIN_ROWS,elapsedMs:elapsed});
      }
      return;
    }
    const record={runId,stage:event.stage,status:event.status,elapsedMs:elapsed};
    if(event.stage==='plugin'){
      pluginRows++;
      record.pluginId=typeof event.pluginId==='string'&&/^[-a-z0-9]{1,64}$/.test(event.pluginId)?event.pluginId:'unknown';
      record.phase=event.phase==='startup'?'startup':'close';
      if(event.status==='rejected')record.category=CATEGORIES.has(event.category)?event.category:'UNCLASSIFIED';
    }
    append(record);
  }catch{/* Diagnostics cannot change shutdown behavior. */}};
}
