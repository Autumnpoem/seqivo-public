import {lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

/** Join the three private receipts before sending a resolution to the Hub. */
export function returnedDispositionPayloads({dataDir,store,leases,control,conversations,identity,commandId,dispatchBinding}) {
  if(!identity)return [];
  if(dispatchBinding&&(dispatchBinding.commandId!==commandId||dispatchBinding.nodeId!==identity.nodeId||
    dispatchBinding.epoch!==identity.epoch))return [];
  const binding=conversations.executionBinding(commandId);
  if(!binding&&dispatchBinding?.action!=='continue')return [];
  // Existing start-task journals predate dispatchBinding, but already contain
  // the exact created thread and turn revision. Other old mappings stay fenced.
  if(!dispatchBinding&&binding?.action!=='start_task')return [];
  const returned=control.returnedUnknownDispositions();
  const candidates=leases.dispositions().filter(item=>returned.some(row=>row.id===item.id&&row.taskId===item.taskId&&
    row.commandId===item.commandId&&row.projectId===item.projectId&&row.workspace===item.workspace&&
    row.actorId===item.actorId&&row.profileId===item.profileId&&row.controlGeneration===item.generation));
  if(!candidates.length)return [];
  const path=join(dataDir,'plugins','codex-autocontinue','codex-autocontinue.json'),stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||stat.size>16_000_000)
    throw new Error('Original disposition Host state is unavailable');
  const host=JSON.parse(readFileSync(path,'utf8'));
  return candidates.flatMap(item=>{
    const task=store.getTask(item.taskId),command=host.commands?.[`${item.taskId}:${item.commandId}`];
    if(task.projectId!==item.projectId||task.conversationId!==item.threadId||command?.status!=='unknown'||
      command.taskId!==item.taskId||command.commandId!==item.commandId||command.threadId!==item.threadId||
      command.turnId!==item.turnId||command.workspace!==item.workspace||command.stopProof?.status==='verified'||
      JSON.stringify(command.disposition)!==JSON.stringify(item))return [];
    let sourceTaskId=item.taskId;
    if(binding){
      if(!['create_conversation','start_task','message'].includes(binding.action)||binding.projectId!==item.projectId||
        binding.taskId!==item.taskId||binding.localCommandId!==item.commandId||binding.threadId!==item.threadId)return [];
      if(dispatchBinding){
        if(dispatchBinding.action!==binding.action||dispatchBinding.projectId!==item.projectId||
          binding.action!=='create_conversation'&&dispatchBinding.taskId!==item.taskId)return [];
        sourceTaskId=dispatchBinding.taskId;
      }
    }else if(dispatchBinding.action!=='continue'||dispatchBinding.projectId!==item.projectId||
      dispatchBinding.taskId!==item.taskId||item.commandId!==commandId)return [];
    const handoff=returned.find(row=>row.id===item.id&&row.taskId===item.taskId&&row.commandId===item.commandId);
    return [{v:1,dispositionId:item.id,projectId:item.projectId,taskId:sourceTaskId,localCommandId:item.commandId,
      controlGeneration:item.generation,returnedGeneration:handoff.returnedGeneration,providerOutcome:'unknown'}];
  });
}
