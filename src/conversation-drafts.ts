export interface ConversationDraft {title:string;message:string}
const prefix='seqivo:conversation-draft:v1:';
const empty=():ConversationDraft=>({title:'',message:''});

export function conversationDraftKey(identity:string,projectId:string,taskId:string):string|null{
  return identity&&projectId?prefix+JSON.stringify([identity,projectId,taskId]):null;
}

export function readConversationDraft(storage:Storage,key:string|null):ConversationDraft{
  if(!key)return empty();
  try{
    const value=JSON.parse(storage.getItem(key)||'null');
    if(!value||typeof value.title!=='string'||value.title.length>240||
      typeof value.message!=='string'||value.message.length>10000)return empty();
    return {title:value.title,message:value.message};
  }catch{return empty();}
}

export function saveConversationDraft(storage:Storage,key:string|null,draft:ConversationDraft):boolean{
  if(!key)return false;
  try{
    if(!draft.title&&!draft.message)storage.removeItem(key);
    else storage.setItem(key,JSON.stringify(draft));
    return true;
  }catch{return false;}
}

export function removeSubmittedConversationDraft(storage:Storage,key:string|null,submitted:ConversationDraft):boolean{
  if(!key)return false;
  const current=readConversationDraft(storage,key);
  if(current.title!==submitted.title||current.message!==submitted.message)return false;
  try{storage.removeItem(key);return true;}catch{return false;}
}

export function clearConversationDrafts(storage:Storage,identity:string):boolean{
  if(!identity)return false;
  try{
    const keys:string[]=[];
    for(let i=0;i<storage.length;i++){
      const key=storage.key(i);
      if(!key?.startsWith(prefix))continue;
      let scope:unknown;
      try{scope=JSON.parse(key.slice(prefix.length));}catch{continue;}
      if(Array.isArray(scope)&&scope.length===3&&scope[0]===identity)keys.push(key);
    }
    for(const key of keys)storage.removeItem(key);
    return true;
  }catch{return false;}
}
