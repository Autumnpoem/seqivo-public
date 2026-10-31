export interface InboxDraft{
  answer:string;
  optionId:string;
  revision:number;
  contentVersion:string|number;
  itemRevision:number;
}

const prefix='seqivo:inbox-draft:v1:';

export function inboxDraftKey(identity:string,projectId:string,taskId:string,itemId:string):string|null{
  return identity&&projectId&&taskId&&itemId?prefix+JSON.stringify([identity,projectId,taskId,itemId]):null;
}

function parseDraft(raw:string|null):InboxDraft|null{
  if(!raw)return null;
  try{
    const draft:unknown=JSON.parse(raw);
    if(!draft||typeof draft!=='object'||Array.isArray(draft))return null;
    const value=draft as Record<string,unknown>;
    if(typeof value.answer!=='string'||typeof value.optionId!=='string'||
      !Number.isSafeInteger(value.revision)||(value.revision as number)<0||
      !(typeof value.contentVersion==='string'&&value.contentVersion.length>0)&&
      !(Number.isSafeInteger(value.contentVersion)&&(value.contentVersion as number)>=0)||
      !Number.isSafeInteger(value.itemRevision)||(value.itemRevision as number)<1)return null;
    return {answer:value.answer,optionId:value.optionId,revision:value.revision as number,
      contentVersion:value.contentVersion as string|number,itemRevision:value.itemRevision as number};
  }catch{return null;}
}

export function readInboxDraft(storage:Storage,key:string|null):InboxDraft|null{
  if(!key)return null;
  try{return parseDraft(storage.getItem(key));}catch{return null;}
}

export function saveInboxDraft(storage:Storage,key:string|null,draft:InboxDraft):boolean{
  if(!key)return false;
  try{storage.setItem(key,JSON.stringify(draft));return true;}catch{return false;}
}

export function removeSubmittedInboxDraft(storage:Storage,key:string|null,submitted:InboxDraft):boolean{
  if(!key)return false;
  try{
    const current=parseDraft(storage.getItem(key));
    if(!current)return true;
    if(current.answer===submitted.answer&&current.optionId===submitted.optionId&&
      current.revision===submitted.revision&&current.contentVersion===submitted.contentVersion&&
      current.itemRevision===submitted.itemRevision)storage.removeItem(key);
    return true;
  }catch{return false;}
}

export function clearInboxDrafts(storage:Storage,identity:string):boolean{
  if(!identity)return false;
  try{
    const keys:string[]=[];
    for(let i=0;i<storage.length;i++){
      const key=storage.key(i);
      if(!key?.startsWith(prefix))continue;
      let scope:unknown;
      try{scope=JSON.parse(key.slice(prefix.length));}catch{continue;}
      if(Array.isArray(scope)&&scope.length===4&&scope[0]===identity)keys.push(key);
    }
    for(const key of keys)storage.removeItem(key);
    return true;
  }catch{return false;}
}

// Keep unresolved command identities on logout while removing the answer
// snapshot copied into this account's session-scoped recovery journal.
export function clearInboxSubmittedDrafts(storage:Storage,identity:string,origin:string):boolean{
  if(!identity||!origin)return false;
  const key=`seqivo-inbox-commands-v1:${origin}:${identity}`;
  try{
    const raw=storage.getItem(key);
    if(!raw)return true;
    const pending:unknown=JSON.parse(raw);
    if(!Array.isArray(pending))return false;
    let changed=false;
    const scrubbed=pending.map(entry=>{
      if(!entry||typeof entry!=='object'||Array.isArray(entry))return entry;
      const copy={...entry} as Record<string,unknown>;
      if(Object.hasOwn(copy,'draftKey')||Object.hasOwn(copy,'submittedDraft')){
        delete copy.draftKey;delete copy.submittedDraft;changed=true;
      }
      return copy;
    });
    if(changed)storage.setItem(key,JSON.stringify(scrubbed));
    return true;
  }catch{return false;}
}

export function confirmedInboxAction(status:string,result:unknown,taskId:string,itemId:string,itemRevision:number):boolean{
  if(status!=='completed'||!result||typeof result!=='object'||Array.isArray(result))return false;
  const value=result as Record<string,unknown>;
  return value.status==='completed'&&value.taskId===taskId&&value.itemId===itemId&&
    Number.isSafeInteger(value.itemRevision)&&(value.itemRevision as number)>itemRevision;
}
